/**
 * Gmail OAuth Service (for connecting Gmail / Google Workspace mailboxes to Sequencer)
 *
 * Flow:
 * 1. User clicks "Connect Google" → frontend redirects to /api/sequencer/accounts/google/authorize
 * 2. Backend builds OAuth consent URL with state (orgId + random nonce), redirects to Google
 * 3. User grants permission on Google's consent screen
 * 4. Google redirects to /api/sequencer/accounts/google/callback?code=...&state=...
 * 5. Backend exchanges code for tokens, fetches user email, creates ConnectedAccount
 * 6. Redirects back to /dashboard/sequencer/accounts?connected=google
 */

import { google } from 'googleapis';
import crypto from 'crypto';
import { logger } from './observabilityService';

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
];

function getOAuthClient() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';

    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in environment');
    }

    return new google.auth.OAuth2(
        clientId,
        clientSecret,
        `${backendUrl}/api/sequencer/accounts/google/callback`
    );
}

export function getGoogleAuthorizationUrl(orgId: string, loginHint?: string): string {
    const oauth2Client = getOAuthClient();

    const nonce = crypto.randomBytes(16).toString('hex');
    const statePayload = JSON.stringify({ orgId, nonce, provider: 'google' });
    const state = Buffer.from(statePayload).toString('base64url');

    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // Force consent to guarantee refresh token
        scope: SCOPES,
        state,
        // login_hint pre-selects the right Google account on the consent screen.
        // Used by Zapmail bulk-import flow so the user just clicks "Allow" instead
        // of picking the right inbox out of many signed-in Google accounts.
        ...(loginHint ? { login_hint: loginHint } : {}),
    });
}

export function parseGoogleState(state: string): { orgId: string; nonce: string } | null {
    try {
        const decoded = Buffer.from(state, 'base64url').toString('utf8');
        const payload = JSON.parse(decoded);
        if (payload.orgId && payload.nonce && payload.provider === 'google') return payload;
        return null;
    } catch {
        return null;
    }
}

export async function exchangeGoogleCodeForTokens(code: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    email: string;
    name?: string;
}> {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
        throw new Error('No access_token received from Google');
    }
    if (!tokens.refresh_token) {
        throw new Error('No refresh_token received. Re-authorize with prompt=consent.');
    }

    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    if (!userInfo.data.email) {
        throw new Error('Could not fetch user email from Google');
    }

    return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000),
        email: userInfo.data.email.toLowerCase(),
        name: userInfo.data.name || undefined,
    };
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<{
    access_token: string;
    expires_at: Date;
}> {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        if (!credentials.access_token) {
            throw new Error('No access_token returned from refresh');
        }
        return {
            access_token: credentials.access_token,
            expires_at: credentials.expiry_date ? new Date(credentials.expiry_date) : new Date(Date.now() + 3600 * 1000),
        };
    } catch (err: any) {
        logger.error('[GOOGLE_OAUTH] Failed to refresh token', err);
        throw new Error(`Google token refresh failed: ${err.message}`);
    }
}

export async function sendEmailViaGmailApi(
    accessToken: string,
    from: string,
    to: string,
    subject: string,
    bodyHtml: string,
    options?: { inReplyTo?: string | null; references?: string | null }
): Promise<{ messageId: string }> {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const messageId = `<${crypto.randomUUID()}@superkabe.com>`;

    // Build MIME headers — include In-Reply-To / References for RFC-compliant threading
    // on the recipient side. Without these headers the message appears as a new thread.
    const headerLines: string[] = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Message-ID: ${messageId}`,
    ];
    if (options?.inReplyTo) headerLines.push(`In-Reply-To: ${options.inReplyTo}`);
    if (options?.references) headerLines.push(`References: ${options.references}`);
    headerLines.push('MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8');

    const mime = [...headerLines, '', bodyHtml].join('\r\n');
    const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    // If replying, look up the threadId of the original message so Gmail clusters the
    // outbound in the sender's own "Sent" folder too (In-Reply-To alone does NOT group
    // in Gmail's UI on the sender side — it needs threadId).
    let threadId: string | undefined;
    if (options?.inReplyTo) {
        try {
            const listRes = await gmail.users.messages.list({
                userId: 'me',
                q: `rfc822msgid:${options.inReplyTo.replace(/[<>]/g, '')}`,
                maxResults: 1,
            });
            const match = listRes.data.messages?.[0];
            if (match?.threadId) threadId = match.threadId;
        } catch { /* fall through — headers alone still thread on recipient side */ }
    }

    const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: threadId ? { raw, threadId } : { raw },
    });

    return { messageId: response.data.id || messageId };
}

export async function fetchGmailReplies(
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
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const afterTimestamp = Math.floor(sinceDate.getTime() / 1000);

    // Drop `is:unread` from the query: once a user opens Gmail and reads a thread
    // those messages no longer match, and any subsequent replies they trigger from
    // sequencer-side leads would be silently missed. Server-side dedup happens
    // downstream by message_id in processReply, so re-fetching the same message
    // is harmless. Stick to a time-window + folder filter.
    const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: `in:inbox after:${afterTimestamp}`,
        maxResults: 50,
    });

    if (!listRes.data.messages || listRes.data.messages.length === 0) return [];

    const results: any[] = [];
    for (const msgRef of listRes.data.messages) {
        try {
            const msgRes = await gmail.users.messages.get({
                userId: 'me',
                id: msgRef.id!,
                format: 'full',
            });
            const msg = msgRes.data;
            if (!msg.payload) continue;

            const headers = msg.payload.headers || [];
            const getHeader = (name: string) =>
                headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

            const fromHeader = getHeader('From');
            const toHeader = getHeader('To');
            const subject = getHeader('Subject') || '(no subject)';
            const messageIdHeader = getHeader('Message-ID') || `gmail-${msg.id}`;
            const inReplyTo = getHeader('In-Reply-To');
            const references = getHeader('References');
            const dateHeader = getHeader('Date');

            const parseAddr = (h: string) => {
                const m = h.match(/<([^>]+)>/);
                if (m) {
                    const name = h.slice(0, h.indexOf('<')).trim().replace(/^["']|["']$/g, '');
                    return { email: m[1].toLowerCase(), name: name || undefined };
                }
                return { email: h.toLowerCase().trim() };
            };

            const fromParsed = parseAddr(fromHeader);
            const toParsed = parseAddr(toHeader);

            let bodyHtml = '';
            let bodyText = '';
            const extractBody = (parts: any[]): void => {
                for (const part of parts) {
                    if (part.mimeType === 'text/html' && part.body?.data) {
                        bodyHtml = Buffer.from(part.body.data, 'base64url').toString('utf8');
                    } else if (part.mimeType === 'text/plain' && part.body?.data) {
                        bodyText = Buffer.from(part.body.data, 'base64url').toString('utf8');
                    } else if (part.parts) {
                        extractBody(part.parts);
                    }
                }
            };

            if (msg.payload.parts) {
                extractBody(msg.payload.parts);
            } else if (msg.payload.body?.data) {
                const content = Buffer.from(msg.payload.body.data, 'base64url').toString('utf8');
                if (msg.payload.mimeType === 'text/html') bodyHtml = content;
                else bodyText = content;
            }

            if (!bodyHtml && bodyText) bodyHtml = `<p>${bodyText.replace(/\n/g, '<br/>')}</p>`;
            if (!bodyText && bodyHtml) bodyText = bodyHtml.replace(/<[^>]*>/g, '');

            const hasAttachments = (msg.payload.parts || []).some((p: any) => p.filename && p.filename.length > 0);

            results.push({
                from: fromParsed.email,
                fromName: fromParsed.name,
                to: toParsed.email,
                subject,
                bodyHtml,
                bodyText,
                messageId: messageIdHeader,
                inReplyTo: inReplyTo || undefined,
                references: references || undefined,
                receivedAt: dateHeader ? new Date(dateHeader) : new Date(),
                hasAttachments,
            });

            // Mark as read so we don't re-process
            await gmail.users.messages.modify({
                userId: 'me',
                id: msg.id!,
                requestBody: { removeLabelIds: ['UNREAD'] },
            });
        } catch (err: any) {
            logger.error(`[GOOGLE_OAUTH] Error fetching message ${msgRef.id}`, err);
        }
    }

    return results;
}
