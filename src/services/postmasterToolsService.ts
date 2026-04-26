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
 * sequencer Gmail OAuth — different scope).
 *
 * Postmaster Tools API reference:
 *   https://developers.google.com/gmail/postmaster
 */

import axios from 'axios';
import { prisma } from '../index';
import { logger } from './observabilityService';
import { encrypt, decrypt, isEncrypted } from '../utils/encryption';

const POSTMASTER_SCOPE = 'https://www.googleapis.com/auth/postmaster.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const POSTMASTER_API = 'https://gmailpostmastertools.googleapis.com/v1';

/** OAuth callback path appended to BACKEND_URL. Must match the redirect URI
 *  registered in Google Cloud Console for the OAuth client. */
const CALLBACK_PATH = '/oauth/callback/postmaster';

function callbackUrl(): string {
    const base = (process.env.BACKEND_URL || process.env.BASE_URL || '').replace(/\/+$/, '');
    if (!base) throw new Error('BACKEND_URL is not configured — cannot construct OAuth callback URL');
    return `${base}${CALLBACK_PATH}`;
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
 * Build the Google OAuth authorize URL. The `state` param carries the
 * organization_id through Google's redirect so the callback knows which
 * org to attach the tokens to.
 */
export function buildAuthorizeUrl(orgId: string): string {
    const { clientId } = clientCreds();
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl(),
        response_type: 'code',
        scope: POSTMASTER_SCOPE,
        access_type: 'offline',
        prompt: 'consent',  // forces refresh_token return even for repeat auth
        state: orgId,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
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

    const { access_token, refresh_token, expires_in } = res.data as {
        access_token: string; refresh_token?: string; expires_in: number;
    };

    if (!refresh_token) {
        // Google only returns refresh_token on first consent OR when prompt=consent.
        // We always pass prompt=consent so this should always populate.
        throw new Error('Google did not return a refresh_token. Re-try with prompt=consent.');
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
    // 60s safety window — refresh if token expires within the next minute.
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
        const { access_token, expires_in } = res.data as { access_token: string; expires_in: number };
        const newExpiresAt = new Date(Date.now() + expires_in * 1000);
        await prisma.organization.update({
            where: { id: orgId },
            data: {
                postmaster_access_token: encrypt(access_token),
                postmaster_token_expires_at: newExpiresAt,
                postmaster_last_error: null,
            },
        });
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
 * Disconnect: clear stored tokens. Postmaster API access stops on next
 * worker tick. Token revocation on Google's side requires a separate
 * revoke call which we'll add when needed.
 */
export async function disconnect(orgId: string): Promise<void> {
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
        // 404 = no data for that date (legitimate — happens when the domain
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

    // Postmaster has 24-48h delay — yesterday is the freshest reliable date.
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
