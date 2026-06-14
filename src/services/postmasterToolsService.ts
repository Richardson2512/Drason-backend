/**
 * Google Postmaster Tools integration.
 *
 * Authoritative sender-reputation signals from Google for every domain the
 * org's connected Google account has verified in Postmaster Tools. Replaces
 * the platform-mode webhook reputation signals we lost when middleware was
 * removed.
 *
 * OAuth flow:
 *   1. POST /api/postmaster/connect → returns Google authorize URL
 *   2. User consents → Google redirects to /oauth/callback/postmaster?code=…
 *   3. Callback exchanges code for refresh + access tokens, encrypts both,
 *      stores on Organization
 *   4. Daily worker uses refresh token to fetch reputation per domain
 *
 * Re-uses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (same OAuth client as
 * sequencer Gmail OAuth - different scope).
 *
 * Postmaster Tools API reference:
 *   https://developers.google.com/gmail/postmaster
 */

import axios from 'axios';
import { prisma } from '../index';
import { logger } from './observabilityService';
import { encrypt, decrypt, isEncrypted } from '../utils/encryption';
import { revokeGoogleToken, verifyGrantedScopes } from '../utils/googleOAuth';
import { createState, consumeState } from './oauthStateService';
import { getPublicBackendUrl } from '../utils/publicBackendUrl';

const POSTMASTER_SCOPE = 'https://www.googleapis.com/auth/postmaster.readonly';
const POSTMASTER_REQUIRED_SCOPES = [POSTMASTER_SCOPE];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const POSTMASTER_API = 'https://gmailpostmastertools.googleapis.com/v1';

/** OAuth callback path appended to BACKEND_URL. Must match the redirect URI
 *  registered in Google Cloud Console for the OAuth client. */
const CALLBACK_PATH = '/oauth/callback/postmaster';

function callbackUrl(): string {
    return `${getPublicBackendUrl()}${CALLBACK_PATH}`;
}

function clientCreds(): { clientId: string; clientSecret: string } {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
    }
    return { clientId, clientSecret };
}

/**
 * Build the Google OAuth authorize URL. The `state` param is a one-time
 * cryptographic nonce stored server-side keyed to this org - replaces the
 * earlier scheme of stuffing orgId into state, which was CSRF-vulnerable
 * because orgId is semi-public (UUIDs leak via JWTs, logs, URLs).
 */
export async function buildAuthorizeUrl(orgId: string): Promise<string> {
    const { clientId } = clientCreds();
    const state = await createState({ purpose: 'postmaster_oauth', organizationId: orgId });
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl(),
        response_type: 'code',
        scope: POSTMASTER_SCOPE,
        access_type: 'offline',
        prompt: 'consent',  // forces refresh_token return even for repeat auth
        include_granted_scopes: 'true',  // future-proof for incremental scope additions
        state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Verify a callback `state` and return the org it was minted for, or null
 * if the state is missing/expired/CSRF. Caller must abort on null.
 */
export async function consumePostmasterState(state: string): Promise<string | null> {
    const result = await consumeState(state, 'postmaster_oauth');
    return result?.organizationId ?? null;
}

/**
 * Exchange an authorization code for refresh + access tokens.
 * Stores both encrypted on the Organization row.
 */
export async function completeAuthorization(orgId: string, code: string): Promise<void> {
    const { clientId, clientSecret } = clientCreds();

    const res = await axios.post(TOKEN_URL, new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl(),
        grant_type: 'authorization_code',
    }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15_000,
    });

    const { access_token, refresh_token, expires_in, scope: returnedScope } = res.data as {
        access_token: string; refresh_token?: string; expires_in: number; scope?: string;
    };

    // Per Google's OAuth 2.0 web-server doc step 6, we MUST verify the user
    // didn't deselect any required scope on the granular consent screen.
    // Silently storing tokens for a partial grant produces 403s at runtime
    // and a half-broken connection in the UI.
    const missing = verifyGrantedScopes(returnedScope, POSTMASTER_REQUIRED_SCOPES);
    if (missing.length > 0) {
        throw new Error(
            `Google did not grant required scope(s): ${missing.join(', ')}. ` +
            `Please retry and grant all requested permissions on the consent screen.`,
        );
    }

    if (!refresh_token) {
        // We pass prompt=consent so Google should return a refresh_token. The
        // common cause when this still misses is: the user previously connected
        // this same Google account to another OAuth flow under the same Cloud
        // project, and Google considers it already-consented at the project
        // level. Tell the user how to recover.
        throw new Error(
            'Google did not return a refresh_token. This usually means this Google ' +
            'account already granted access via another flow. Visit ' +
            'myaccount.google.com → Security → Third-party apps, remove the ' +
            'existing grant for this app, then retry.',
        );
    }

    const expiresAt = new Date(Date.now() + expires_in * 1000);
    await prisma.organization.update({
        where: { id: orgId },
        data: {
            postmaster_access_token: encrypt(access_token),
            postmaster_refresh_token: encrypt(refresh_token),
            postmaster_token_expires_at: expiresAt,
            postmaster_connected_at: new Date(),
            postmaster_last_error: null,
        },
    });
    logger.info('[POSTMASTER] OAuth completed', { orgId, expiresAt });
}

/**
 * Get a valid access token, refreshing via the stored refresh token if needed.
 * Returns null if the org is not connected.
 */
export async function getValidAccessToken(orgId: string): Promise<string | null> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            postmaster_access_token: true,
            postmaster_refresh_token: true,
            postmaster_token_expires_at: true,
        },
    });
    if (!org?.postmaster_refresh_token) return null;

    const refreshToken = isEncrypted(org.postmaster_refresh_token)
        ? decrypt(org.postmaster_refresh_token)
        : org.postmaster_refresh_token;

    const expiresAt = org.postmaster_token_expires_at;
    // 60s safety window - refresh if token expires within the next minute.
    if (org.postmaster_access_token && expiresAt && expiresAt.getTime() - Date.now() > 60_000) {
        const access = isEncrypted(org.postmaster_access_token)
            ? decrypt(org.postmaster_access_token)
            : org.postmaster_access_token;
        return access;
    }

    // Refresh
    const { clientId, clientSecret } = clientCreds();
    try {
        const res = await axios.post(TOKEN_URL, new URLSearchParams({
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15_000,
        });
        const { access_token, expires_in, refresh_token: rotatedRefresh } = res.data as {
            access_token: string; expires_in: number; refresh_token?: string;
        };
        const newExpiresAt = new Date(Date.now() + expires_in * 1000);
        // Google occasionally rotates refresh tokens (rare, but documented).
        // If we ignore the new one, the old token stops working on the next
        // refresh and the user has to reconnect. Always capture if present.
        const updateData: any = {
            postmaster_access_token: encrypt(access_token),
            postmaster_token_expires_at: newExpiresAt,
            postmaster_last_error: null,
        };
        if (rotatedRefresh) {
            updateData.postmaster_refresh_token = encrypt(rotatedRefresh);
        }
        await prisma.organization.update({ where: { id: orgId }, data: updateData });
        return access_token;
    } catch (err: any) {
        logger.error('[POSTMASTER] Token refresh failed', err, { orgId });
        await prisma.organization.update({
            where: { id: orgId },
            data: { postmaster_last_error: `Token refresh failed: ${err.message?.slice(0, 200)}` },
        }).catch(() => {});
        return null;
    }
}

/**
 * Disconnect: revoke the grant on Google's side, then clear stored tokens.
 *
 * Per Google best-practices: "Revoke tokens as soon as they are no longer
 * needed and delete them permanently from your systems." We do BOTH -
 * revoke first (so Google kills the grant even if the DB row leaks later),
 * then clear locally.
 *
 * Revoking the refresh_token invalidates ALL access tokens issued for that
 * grant, immediately. We never raise on revoke failure - best-effort, log
 * it, and proceed to clear locally so the user always sees an honest UI.
 */
export async function disconnect(orgId: string): Promise<void> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { postmaster_refresh_token: true },
    });
    if (org?.postmaster_refresh_token) {
        const refresh = isEncrypted(org.postmaster_refresh_token)
            ? decrypt(org.postmaster_refresh_token)
            : org.postmaster_refresh_token;
        const result = await revokeGoogleToken(refresh);
        logger.info('[POSTMASTER] Revoke outcome', { orgId, revoked: result.revoked, status: result.status });
    }
    await prisma.organization.update({
        where: { id: orgId },
        data: {
            postmaster_access_token: null,
            postmaster_refresh_token: null,
            postmaster_token_expires_at: null,
            postmaster_connected_at: null,
            postmaster_last_fetch_at: null,
            postmaster_last_error: null,
        },
    });
    logger.info('[POSTMASTER] Disconnected', { orgId });
}

// ─── Postmaster API client ───────────────────────────────────────────────────

interface PostmasterDomain {
    name: string;          // resource path "domains/{domainName}"
    createTime?: string;
    permission?: string;
}

interface PostmasterTrafficStats {
    name: string;          // "domains/{domainName}/trafficStats/{date}"
    userReportedSpamRatio?: number;
    spfSuccessRatio?: number;
    dkimSuccessRatio?: number;
    dmarcSuccessRatio?: number;
    inboundEncryptionRatio?: number;
    outboundEncryptionRatio?: number;
    domainReputation?: 'HIGH' | 'MEDIUM' | 'LOW' | 'BAD' | 'REPUTATION_CATEGORY_UNSPECIFIED';
    ipReputations?: Array<{ reputation: string; ipCount: string; sampleIps?: string[] }>;
    deliveryErrors?: Array<{ errorType: string; errorClass: string; errorRatio: number }>;
}

/** List all domains the connected Google account can see in Postmaster. */
export async function listDomains(orgId: string): Promise<PostmasterDomain[]> {
    const token = await getValidAccessToken(orgId);
    if (!token) return [];
    const res = await axios.get(`${POSTMASTER_API}/domains`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
    });
    return res.data.domains || [];
}

/**
 * Fetch traffic stats for a specific domain on a specific date (YYYY-MM-DD).
 * Postmaster reports with a 24-48h delay so most callers should query
 * yesterday's date.
 */
export async function getTrafficStats(
    orgId: string,
    domainName: string,
    date: string,  // YYYY-MM-DD
): Promise<PostmasterTrafficStats | null> {
    const token = await getValidAccessToken(orgId);
    if (!token) return null;
    try {
        const res = await axios.get(
            `${POSTMASTER_API}/domains/${encodeURIComponent(domainName)}/trafficStats/${date}`,
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 15_000,
            },
        );
        return res.data as PostmasterTrafficStats;
    } catch (err: any) {
        // 404 = no data for that date (legitimate - happens when the domain
        // didn't send any mail Google could measure). 400 = malformed date.
        if (err.response?.status === 404) return null;
        throw err;
    }
}

/**
 * Persist a Postmaster traffic-stats reading for a domain on a date.
 * Idempotent via the (domain_id, source, date) unique constraint.
 */
export async function recordReputation(args: {
    organizationId: string;
    domainId: string;
    domainName: string;
    date: string;            // YYYY-MM-DD
    stats: PostmasterTrafficStats;
}): Promise<void> {
    const { organizationId, domainId, date, stats } = args;
    const reputationVal = stats.domainReputation && stats.domainReputation !== 'REPUTATION_CATEGORY_UNSPECIFIED'
        ? stats.domainReputation
        : null;
    await prisma.domainReputation.upsert({
        where: {
            domain_id_source_date: {
                domain_id: domainId,
                source: 'postmaster_tools',
                date: new Date(`${date}T00:00:00Z`),
            },
        },
        create: {
            organization_id: organizationId,
            domain_id: domainId,
            source: 'postmaster_tools',
            fetched_at: new Date(),
            date: new Date(`${date}T00:00:00Z`),
            reputation: reputationVal,
            spam_rate: stats.userReportedSpamRatio ?? null,
            authentication_dkim_pass_rate: stats.dkimSuccessRatio ?? null,
            authentication_spf_pass_rate: stats.spfSuccessRatio ?? null,
            authentication_dmarc_pass_rate: stats.dmarcSuccessRatio ?? null,
            encryption_outbound_rate: stats.outboundEncryptionRatio ?? null,
            delivery_errors_jsonb: stats.deliveryErrors ? JSON.parse(JSON.stringify(stats.deliveryErrors)) : null,
            raw_payload: JSON.parse(JSON.stringify(stats)),
        },
        update: {
            fetched_at: new Date(),
            reputation: reputationVal,
            spam_rate: stats.userReportedSpamRatio ?? null,
            authentication_dkim_pass_rate: stats.dkimSuccessRatio ?? null,
            authentication_spf_pass_rate: stats.spfSuccessRatio ?? null,
            authentication_dmarc_pass_rate: stats.dmarcSuccessRatio ?? null,
            encryption_outbound_rate: stats.outboundEncryptionRatio ?? null,
            delivery_errors_jsonb: stats.deliveryErrors ? JSON.parse(JSON.stringify(stats.deliveryErrors)) : null,
            raw_payload: JSON.parse(JSON.stringify(stats)),
        },
    });
}

/**
 * Fetch yesterday's traffic stats for every domain this org has connected
 * to Postmaster Tools, persisting one DomainReputation row per domain.
 * Matches Postmaster domains to local Domain rows by name.
 *
 * Returns counts so the worker can report progress.
 */
export async function fetchAllForOrg(orgId: string): Promise<{
    domainsFound: number;
    rowsWritten: number;
    errors: number;
}> {
    let domainsFound = 0;
    let rowsWritten = 0;
    let errors = 0;

    let pmDomains: PostmasterDomain[] = [];
    try {
        pmDomains = await listDomains(orgId);
    } catch (err: any) {
        logger.error('[POSTMASTER] listDomains failed', err, { orgId });
        await prisma.organization.update({
            where: { id: orgId },
            data: { postmaster_last_error: `listDomains failed: ${err.message?.slice(0, 200)}` },
        }).catch(() => {});
        return { domainsFound: 0, rowsWritten: 0, errors: 1 };
    }
    domainsFound = pmDomains.length;

    // Postmaster has 24-48h delay - yesterday is the freshest reliable date.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateStr = yesterday.toISOString().slice(0, 10);

    for (const pmDomain of pmDomains) {
        // Postmaster names format: "domains/example.com"
        const domainName = pmDomain.name.replace(/^domains\//, '');
        // Match to a local Domain row by name (case-insensitive).
        const localDomain = await prisma.domain.findFirst({
            where: {
                organization_id: orgId,
                domain: { equals: domainName, mode: 'insensitive' },
            },
            select: { id: true },
        });
        if (!localDomain) continue;  // domain isn't tracked locally; skip

        try {
            const stats = await getTrafficStats(orgId, domainName, dateStr);
            if (!stats) continue;
            await recordReputation({
                organizationId: orgId,
                domainId: localDomain.id,
                domainName,
                date: dateStr,
                stats,
            });
            rowsWritten++;
        } catch (err: any) {
            errors++;
            logger.warn('[POSTMASTER] getTrafficStats failed', { orgId, domainName, error: err.message });
        }
    }

    await prisma.organization.update({
        where: { id: orgId },
        data: { postmaster_last_fetch_at: new Date(), postmaster_last_error: errors > 0 ? `Partial: ${errors} domain fetches errored` : null },
    }).catch(() => {});

    return { domainsFound, rowsWritten, errors };
}
