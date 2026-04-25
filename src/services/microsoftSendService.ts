/**
 * Microsoft OAuth Service (for connecting Outlook / Microsoft 365 mailboxes to Sequencer)
 *
 * Uses Microsoft Graph API (not SMTP XOAUTH2) for send + read operations.
 * Graph API bypasses tenant Security Defaults that block SMTP AUTH.
 *
 * Uses MSAL Node v5 with ConfidentialClientApplication + common tenant (multi-tenant + personal accounts).
 */

import { ConfidentialClientApplication, LogLevel } from '@azure/msal-node';
import crypto from 'crypto';
import { logger } from './observabilityService';

// Scopes for Graph API (delegated, user-level)
const SCOPES = [
    'offline_access',
    'openid',
    'profile',
    'email',
    'User.Read',
    'Mail.Send',
    'Mail.Read',
];

const AUTHORITY = 'https://login.microsoftonline.com/common';

function getMsalApp(): ConfidentialClientApplication {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set in environment');
    }

    return new ConfidentialClientApplication({
        auth: {
            clientId,
            clientSecret,
            authority: AUTHORITY,
        },
        system: {
            loggerOptions: {
                loggerCallback: () => { /* silent */ },
                piiLoggingEnabled: false,
                logLevel: LogLevel.Warning,
            },
        },
    });
}

function getRedirectUri(): string {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
    return `${backendUrl}/api/sequencer/accounts/microsoft/callback`;
}

export async function getMicrosoftAuthorizationUrl(orgId: string): Promise<string> {
    const app = getMsalApp();

    const nonce = crypto.randomBytes(16).toString('hex');
    const statePayload = JSON.stringify({ orgId, nonce, provider: 'microsoft' });
    const state = Buffer.from(statePayload).toString('base64url');

    const url = await app.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri: getRedirectUri(),
        state,
        prompt: 'select_account', // Let user pick account if multiple
    });

    return url;
}

export function parseMicrosoftState(state: string): { orgId: string; nonce: string } | null {
    try {
        const decoded = Buffer.from(state, 'base64url').toString('utf8');
        const payload = JSON.parse(decoded);
        if (payload.orgId && payload.nonce && payload.provider === 'microsoft') return payload;
        return null;
    } catch {
        return null;
    }
}

export async function exchangeMicrosoftCodeForTokens(code: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    email: string;
    name?: string;
}> {
    const app = getMsalApp();

    const result = await app.acquireTokenByCode({
        code,
        scopes: SCOPES,
        redirectUri: getRedirectUri(),
    });

    if (!result || !result.accessToken) {
        throw new Error('No access_token received from Microsoft');
    }

    // MSAL doesn't expose refresh token directly on the result. We need to get it from the token cache.
    const tokenCache = app.getTokenCache();
    const serialized = tokenCache.serialize();
    const cacheData = JSON.parse(serialized);

    let refreshToken: string | undefined;
    if (cacheData.RefreshToken) {
        const rtKeys = Object.keys(cacheData.RefreshToken);
        if (rtKeys.length > 0) {
            refreshToken = cacheData.RefreshToken[rtKeys[0]].secret;
        }
    }

    if (!refreshToken) {
        throw new Error('No refresh_token received. Ensure offline_access scope is requested.');
    }

    // Fetch user email via Graph
    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${result.accessToken}` },
    });
    if (!graphRes.ok) {
        throw new Error(`Failed to fetch user info: ${graphRes.status}`);
    }
    const profile = await graphRes.json() as { mail?: string; userPrincipalName?: string; displayName?: string };

    const email = (profile.mail || profile.userPrincipalName || '').toLowerCase();
    if (!email) {
        throw new Error('Could not determine user email from Microsoft Graph');
    }

    return {
        access_token: result.accessToken,
        refresh_token: refreshToken,
        expires_at: result.expiresOn || new Date(Date.now() + 3600 * 1000),
        email,
        name: profile.displayName,
    };
}

export async function refreshMicrosoftAccessToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;  // Microsoft rotates refresh tokens
    expires_at: Date;
}> {
    const app = getMsalApp();

    try {
        const result = await app.acquireTokenByRefreshToken({
            refreshToken,
            scopes: SCOPES,
        });

        if (!result || !result.accessToken) {
            throw new Error('No access_token returned from refresh');
        }

        // Get new refresh token (Microsoft rotates them)
        const tokenCache = app.getTokenCache();
        const serialized = tokenCache.serialize();
        const cacheData = JSON.parse(serialized);

        let newRefreshToken = refreshToken; // Fallback to old if new one isn't available
        if (cacheData.RefreshToken) {
            const rtKeys = Object.keys(cacheData.RefreshToken);
            if (rtKeys.length > 0) {
                newRefreshToken = cacheData.RefreshToken[rtKeys[0]].secret;
            }
        }

        return {
            access_token: result.accessToken,
            refresh_token: newRefreshToken,
            expires_at: result.expiresOn || new Date(Date.now() + 3600 * 1000),
        };
    } catch (err: any) {
        logger.error('[MICROSOFT_OAUTH] Failed to refresh token', err);
        throw new Error(`Microsoft token refresh failed: ${err.message}`);
    }
}

/**
 * Send an email via Microsoft Graph (POST /me/sendMail).
 */
export async function sendEmailViaGraph(
    accessToken: string,
    from: string,
    to: string,
    subject: string,
    bodyHtml: string,
    options?: { inReplyTo?: string | null; references?: string | null }
): Promise<{ messageId: string }> {
    const messageId = `<${crypto.randomUUID()}@superkabe.com>`;

    // Graph requires In-Reply-To / References to be set via internetMessageHeaders
    // so the recipient's mail client threads the reply correctly.
    const internetMessageHeaders: Array<{ name: string; value: string }> = [];
    if (options?.inReplyTo) internetMessageHeaders.push({ name: 'In-Reply-To', value: options.inReplyTo });
    if (options?.references) internetMessageHeaders.push({ name: 'References', value: options.references });

    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            message: {
                subject,
                body: {
                    contentType: 'HTML',
                    content: bodyHtml,
                },
                toRecipients: [{ emailAddress: { address: to } }],
                internetMessageId: messageId,
                ...(internetMessageHeaders.length > 0 ? { internetMessageHeaders } : {}),
            },
            saveToSentItems: true,
        }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        throw new Error(`Graph sendMail failed (${res.status}): ${errText}`);
    }

    return { messageId };
}

/**
 * Fetch unread messages from Outlook inbox via Graph API for reply detection.
 */
export async function fetchMicrosoftReplies(
    accessToken: string,
    sinceDate: Date
): Promise<Array<{
    from: string;
    fromName?: string;
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText: string;
    messageId: string;
    inReplyTo?: string;
    references?: string;
    receivedAt: Date;
    hasAttachments: boolean;
}>> {
    const isoSince = sinceDate.toISOString();
    const filter = `isRead eq false and receivedDateTime ge ${isoSince}`;
    const url = `https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$filter=${encodeURIComponent(filter)}&$top=50&$select=id,internetMessageId,subject,from,toRecipients,body,receivedDateTime,hasAttachments,internetMessageHeaders`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
        throw new Error(`Graph list messages failed (${res.status})`);
    }

    const data = await res.json() as { value?: any[] };
    if (!data.value || data.value.length === 0) return [];

    const results: any[] = [];
    for (const msg of data.value) {
        try {
            const fromEmail = msg.from?.emailAddress?.address?.toLowerCase() || '';
            const fromName = msg.from?.emailAddress?.name;
            const toEmail = msg.toRecipients?.[0]?.emailAddress?.address?.toLowerCase() || '';

            // Find In-Reply-To and References headers
            const headers = msg.internetMessageHeaders || [];
            const getHeader = (name: string) =>
                headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
            const inReplyTo = getHeader('In-Reply-To');
            const references = getHeader('References');

            const bodyHtml = msg.body?.contentType === 'html' ? msg.body.content : '';
            const bodyText = msg.body?.contentType === 'text' ? msg.body.content : (bodyHtml ? bodyHtml.replace(/<[^>]*>/g, '') : '');

            results.push({
                from: fromEmail,
                fromName,
                to: toEmail,
                subject: msg.subject || '(no subject)',
                bodyHtml,
                bodyText,
                messageId: msg.internetMessageId || `graph-${msg.id}`,
                inReplyTo: inReplyTo || undefined,
                references: references || undefined,
                receivedAt: new Date(msg.receivedDateTime),
                hasAttachments: !!msg.hasAttachments,
            });

            // Mark as read
            await fetch(`https://graph.microsoft.com/v1.0/me/messages/${msg.id}`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ isRead: true }),
            });
        } catch (err: any) {
            logger.error(`[MICROSOFT_OAUTH] Error processing message ${msg.id}`, err);
        }
    }

    return results;
}
