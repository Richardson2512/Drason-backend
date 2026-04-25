/**
 * IMAP Reply Detection Worker
 *
 * Polls connected accounts via IMAP for new inbound replies.
 * Uses imapflow (modern promise-based IMAP client).
 *
 * Flow per account:
 * 1. Connect to IMAP server with account credentials
 * 2. Open INBOX, search for UNSEEN messages since last check
 * 3. Fetch each message's headers + body
 * 4. Match sender to CampaignLead by email
 * 5. Update lead status to 'replied', stop sequence if configured
 * 6. Create/update EmailThread + EmailMessage in Unibox
 * 7. Mark messages as SEEN so they aren't re-processed
 */

import { ImapFlow } from 'imapflow';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { decrypt, encrypt } from '../utils/encryption';
import { fetchGmailReplies, refreshGoogleAccessToken } from '../services/gmailSendService';
import { fetchMicrosoftReplies, refreshMicrosoftAccessToken } from '../services/microsoftSendService';
import { tryProcessBounce } from '../services/bounceParserService';
import * as webhookBus from '../services/webhookEventBus';
import { classifyReply } from '../services/replyClassifierService';

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const LOG_TAG = 'IMAP-REPLY-WORKER';
const CONNECTION_TIMEOUT = 15_000; // 15 seconds

// Track last check time per account to avoid re-fetching
const lastCheckMap = new Map<string, Date>();

// ─── Types ───────────────────────────────────────────────────────────────────

interface IncomingEmail {
    from: string;
    fromName?: string;
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    messageId: string;
    inReplyTo?: string;
    references?: string;
    receivedAt: Date;
    hasAttachments: boolean;
}

// ─── Helper: Process a single reply ──────────────────────────────────────────

async function processReply(
    accountId: string,
    organizationId: string,
    email: IncomingEmail
): Promise<void> {
    const senderEmail = email.from.toLowerCase();

    try {
        // 0. Top-of-function message dedup: relying on Gmail's `is:unread` to gate
        //    fetches caused replies to be missed once the user opened Gmail. We
        //    now fetch every message in the time window and dedupe by message_id
        //    here, BEFORE any counter increments — so re-fetching is safe.
        if (email.messageId) {
            const existingMessage = await prisma.emailMessage.findFirst({
                where: { message_id: email.messageId },
                select: { id: true },
            });
            if (existingMessage) return;
        }

        // 1. Find CampaignLead(s) matching this sender — any status. Replies that come
        //    in after a lead finishes its sequence (status=completed) or from leads
        //    already marked 'replied' should still surface in the Unibox and analytics.
        const matchingLeads = await prisma.campaignLead.findMany({
            where: {
                email: senderEmail,
                campaign: {
                    organization_id: organizationId,
                    status: { notIn: ['archived'] },
                },
            },
            include: { campaign: true },
        });

        if (matchingLeads.length === 0) {
            // Non-campaign inbound: warmup traffic, vendor broadcasts, newsletter noise,
            // cold inbound that isn't tied to any sequence we sent. The Unibox is a
            // campaign-conversation tool — polluting it with these creates pressure on
            // the user to triage emails that aren't theirs to action. Log for
            // diagnostics and skip thread creation entirely.
            logger.info(`[${LOG_TAG}] Skipping non-campaign inbound from ${senderEmail} (no matching CampaignLead)`);
            return;
        }

        for (const lead of matchingLeads) {
            // 2. Update lead: replied, stop sequence (idempotent — safe to re-run).
            //    `replied_at` is set ONCE on the first reply (gated by `lead.replied_at ||`)
            //    so it represents the first-reply timestamp; counter increments below
            //    happen on every reply message so the displayed "Replies: N" reflects
            //    actual messages received, matching user expectation.
            await prisma.campaignLead.update({
                where: { id: lead.id },
                data: {
                    status: lead.status === 'completed' ? 'completed' : 'replied',
                    replied_at: lead.replied_at || new Date(),
                    next_send_at: null,
                },
            });

            // 3. Increment reply counters on EVERY reply message.
            //    Counters surfaced in UI:
            //      - Campaign.reply_count  (sequencer analytics — total reply messages)
            //      - Lead.emails_replied   (Protection lead row — total inbound from this lead)
            //      - Mailbox.reply_count_lifetime (Protection mailbox/domain dashboards).
            //        accountId === Mailbox.id via the shadow-mailbox mapping established
            //        in mailboxProvisioningService, so we update the mailbox directly. The
            //        Domain.total_replies aggregate catches up within 60s via metricsWorker.
            //    For "reply rate" (unique repliers / sends), compute downstream from
            //    CampaignLead.replied_at IS NOT NULL — never derive from reply_count.
            await prisma.campaign.update({
                where: { id: lead.campaign_id },
                data: { reply_count: { increment: 1 } },
            });
            await prisma.lead.updateMany({
                where: { organization_id: organizationId, email: senderEmail },
                data: { emails_replied: { increment: 1 }, last_activity_at: new Date() },
            });
            await prisma.mailbox.update({
                where: { id: accountId },
                data: {
                    reply_count_lifetime: { increment: 1 },
                    last_activity_at: new Date(),
                },
            }).catch((err) => {
                logger.warn(`[${LOG_TAG}] Failed to increment Mailbox.reply_count_lifetime`, { accountId, error: err?.message });
            });

            // 4. Create ReplyEvent for analytics (one row per reply message)
            await prisma.replyEvent.create({
                data: {
                    organization_id: organizationId,
                    mailbox_id: accountId,
                    campaign_id: lead.campaign_id,
                    recipient_email: senderEmail,
                    replied_at: email.receivedAt,
                },
            });

            // 5. Create/update EmailThread + EmailMessage
            await createOrUpdateThread(
                accountId,
                organizationId,
                email,
                lead.campaign_id,
                lead.id
            );

            if (lead.campaign.stop_on_reply) {
                logger.info(`[${LOG_TAG}] Stopped sequence for lead ${lead.id} (stop_on_reply=true)`);
            }

            logger.info(`[${LOG_TAG}] Processed reply from ${senderEmail}`, {
                leadId: lead.id,
                campaignId: lead.campaign_id,
            });
        }
    } catch (err: any) {
        logger.error(`[${LOG_TAG}] Error processing reply from ${senderEmail}`, err);
    }
}

// ─── Helper: Create or Update EmailThread + EmailMessage ─────────────────────

async function createOrUpdateThread(
    accountId: string,
    organizationId: string,
    email: IncomingEmail,
    campaignId: string | null,
    leadId: string | null
): Promise<void> {
    try {
        // Try to find existing thread by In-Reply-To or contact email + account
        let thread = null;

        // First try matching by In-Reply-To header — most reliable for threading
        if (email.inReplyTo) {
            const referencedMessage = await prisma.emailMessage.findFirst({
                where: { message_id: email.inReplyTo },
                select: { thread_id: true },
            });
            if (referencedMessage) {
                thread = await prisma.emailThread.findUnique({
                    where: { id: referencedMessage.thread_id },
                });
            }
        }

        // Fallback: match by contact email + account
        if (!thread) {
            thread = await prisma.emailThread.findFirst({
                where: {
                    organization_id: organizationId,
                    account_id: accountId,
                    contact_email: email.from.toLowerCase(),
                },
                orderBy: { last_message_at: 'desc' },
            });
        }

        const snippet = (email.bodyText || email.bodyHtml || '').replace(/<[^>]*>/g, '').substring(0, 120);

        if (thread) {
            thread = await prisma.emailThread.update({
                where: { id: thread.id },
                data: {
                    status: 'replied',
                    is_read: false,
                    last_message_at: email.receivedAt,
                    message_count: { increment: 1 },
                    snippet,
                    ...(campaignId && !thread.campaign_id ? { campaign_id: campaignId } : {}),
                    ...(leadId && !thread.lead_id ? { lead_id: leadId } : {}),
                },
            });
        } else {
            // Determine campaign_name for denormalized display
            let campaignName: string | null = null;
            if (campaignId) {
                const camp = await prisma.campaign.findUnique({
                    where: { id: campaignId },
                    select: { name: true },
                });
                campaignName = camp?.name || null;
            }

            thread = await prisma.emailThread.create({
                data: {
                    organization_id: organizationId,
                    account_id: accountId,
                    contact_email: email.from.toLowerCase(),
                    contact_name: email.fromName || null,
                    subject: email.subject.replace(/^Re:\s*/i, ''),
                    campaign_id: campaignId,
                    campaign_name: campaignName,
                    lead_id: leadId,
                    status: 'replied',
                    is_read: false,
                    last_message_at: email.receivedAt,
                    message_count: 1,
                    snippet,
                },
            });
        }

        // Check for duplicate message (by message_id)
        if (email.messageId) {
            const existing = await prisma.emailMessage.findFirst({
                where: { message_id: email.messageId },
            });
            if (existing) return; // Already processed
        }

        // Run rule-based classification BEFORE the insert so the row lands
        // already-tagged. Pure function, sub-millisecond — adding it inline is
        // fine on the IMAP hot path.
        const quality = classifyReply({
            subject: email.subject,
            body_text: email.bodyText || null,
            body_html: email.bodyHtml,
        });

        await prisma.emailMessage.create({
            data: {
                thread_id: thread.id,
                direction: 'inbound',
                from_email: email.from,
                from_name: email.fromName || null,
                to_email: email.to,
                subject: email.subject,
                body_html: email.bodyHtml,
                body_text: email.bodyText || null,
                message_id: email.messageId,
                in_reply_to: email.inReplyTo || null,
                references: email.references || null,
                has_attachments: email.hasAttachments,
                is_read: false,
                sent_at: email.receivedAt,
                quality_class: quality.class,
                quality_confidence: quality.confidence,
                quality_signals: quality.signals,
                quality_classified_at: new Date(),
            },
        });

        // Outbound webhook fan-out — fires both reply.received and lead.replied.
        webhookBus.emitReplyReceived(organizationId, {
            thread_id: thread.id,
            campaign_id: thread.campaign_id,
            mailbox_id: accountId,
            mailbox_email: email.to,
            contact_email: email.from,
            contact_name: email.fromName || null,
            subject: email.subject,
            snippet,
        });
    } catch (err: any) {
        logger.error(`[${LOG_TAG}] Error creating thread/message for ${email.from}`, err);
    }
}

// ─── Helper: Parse email address from header ─────────────────────────────────

function parseEmailAddress(header: string): { email: string; name?: string } {
    // "John Smith <john@example.com>" → { email: "john@example.com", name: "John Smith" }
    const match = header.match(/<([^>]+)>/);
    if (match) {
        const name = header.slice(0, header.indexOf('<')).trim().replace(/^["']|["']$/g, '');
        return { email: match[1].toLowerCase(), name: name || undefined };
    }
    return { email: header.toLowerCase().trim() };
}

// ─── Helper: Fetch emails from one IMAP account ─────────────────────────────

// ─── Helper: Ensure OAuth access token is fresh ─────────────────────────────

async function ensureFreshAccessTokenForWorker(account: {
    id: string;
    email: string;
    provider: string;
    access_token: string | null;
    refresh_token: string | null;
    token_expires_at: Date | null;
}): Promise<string> {
    if (!account.access_token || !account.refresh_token) {
        throw new Error('No OAuth tokens');
    }

    const decryptedRefresh = decrypt(account.refresh_token);

    if (account.token_expires_at && account.token_expires_at.getTime() > Date.now() + 2 * 60 * 1000) {
        return decrypt(account.access_token);
    }

    if (account.provider === 'google') {
        const { access_token, expires_at } = await refreshGoogleAccessToken(decryptedRefresh);
        await prisma.connectedAccount.update({
            where: { id: account.id },
            data: { access_token: encrypt(access_token), token_expires_at: expires_at },
        });
        return access_token;
    } else if (account.provider === 'microsoft') {
        const { access_token, refresh_token: newRefresh, expires_at } = await refreshMicrosoftAccessToken(decryptedRefresh);
        await prisma.connectedAccount.update({
            where: { id: account.id },
            data: {
                access_token: encrypt(access_token),
                refresh_token: encrypt(newRefresh),
                token_expires_at: expires_at,
            },
        });
        return access_token;
    }

    return decrypt(account.access_token);
}

// ─── Helper: Fetch replies from an OAuth account (Gmail API or Graph API) ───

async function fetchRepliesFromOAuthAccount(account: {
    id: string;
    email: string;
    organization_id: string;
    provider: string;
    access_token: string | null;
    refresh_token: string | null;
    token_expires_at: Date | null;
}): Promise<number> {
    try {
        const accessToken = await ensureFreshAccessTokenForWorker(account);
        const sinceDate = lastCheckMap.get(account.id) || new Date(Date.now() - 24 * 60 * 60 * 1000);

        let replies;
        if (account.provider === 'google') {
            replies = await fetchGmailReplies(accessToken, sinceDate);
        } else if (account.provider === 'microsoft') {
            replies = await fetchMicrosoftReplies(accessToken, sinceDate);
        } else {
            return 0;
        }

        for (const r of replies) {
            // Skip our own outbound echoes
            if (r.from === account.email.toLowerCase()) continue;

            const email = {
                from: r.from,
                fromName: r.fromName,
                to: r.to,
                subject: r.subject,
                bodyHtml: r.bodyHtml,
                bodyText: r.bodyText,
                messageId: r.messageId,
                inReplyTo: r.inReplyTo,
                references: r.references,
                receivedAt: r.receivedAt,
                hasAttachments: r.hasAttachments,
            };

            // Check if this is a bounce notification (DSN/NDR) first — if so,
            // route to Protection pipeline, don't treat as a normal reply.
            const isBounce = await tryProcessBounce(account.id, account.organization_id, email);
            if (isBounce) continue;

            await processReply(account.id, account.organization_id, email);
        }

        lastCheckMap.set(account.id, new Date());
        return replies.length;
    } catch (err: any) {
        if (err.message?.includes('invalid_grant') || err.message?.includes('AADSTS')) {
            await prisma.connectedAccount.update({
                where: { id: account.id },
                data: { connection_status: 'error', last_error: 'OAuth token expired or revoked — reconnect the mailbox' },
            }).catch(() => {});
        }
        logger.error(`[${LOG_TAG}] OAuth fetch failed for ${account.email}`, err);
        return 0;
    }
}

async function fetchRepliesFromAccount(account: {
    id: string;
    email: string;
    organization_id: string;
    smtp_username: string | null;
    smtp_password: string | null;
    imap_host: string | null;
    imap_port: number | null;
}): Promise<number> {
    if (!account.imap_host || !account.smtp_password) {
        return 0;
    }

    const client = new ImapFlow({
        host: account.imap_host,
        port: account.imap_port || 993,
        secure: true,
        auth: {
            user: account.smtp_username || account.email,
            pass: account.smtp_password,
        },
        logger: false, // Suppress imapflow's own logging
        tls: {
            rejectUnauthorized: false, // Accept self-signed certs from infra providers
        },
    });

    let fetchedCount = 0;

    try {
        await Promise.race([
            client.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('IMAP connection timeout')), CONNECTION_TIMEOUT)),
        ]);

        const lock = await client.getMailboxLock('INBOX');

        try {
            // Search for UNSEEN messages since last check (or last 24 hours)
            const lastCheck = lastCheckMap.get(account.id) || new Date(Date.now() - 24 * 60 * 60 * 1000);
            const messages = client.fetch(
                { seen: false, since: lastCheck } as any,
                {
                    envelope: true,
                    bodyStructure: true,
                    source: true,
                    flags: true,
                }
            );

            for await (const msg of messages) {
                try {
                    const envelope = msg.envelope;
                    if (!envelope || !envelope.from || envelope.from.length === 0) continue;

                    const sender = envelope.from[0];
                    const senderEmail = `${sender.address}`.toLowerCase();
                    const senderName = sender.name || undefined;

                    // Skip messages from our own account (outbound that we see in INBOX)
                    if (senderEmail === account.email.toLowerCase()) continue;

                    const recipientAddr = envelope.to?.[0]?.address || account.email;

                    // Parse body from source
                    let bodyHtml = '';
                    let bodyText = '';
                    if (msg.source) {
                        const source = msg.source.toString();
                        // Extract text/plain
                        const textMatch = source.match(/Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:.*\r?\n)*?\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\.\r?\n|$)/i);
                        if (textMatch) bodyText = textMatch[1].trim();
                        // Extract text/html
                        const htmlMatch = source.match(/Content-Type:\s*text\/html[^\r\n]*\r?\n(?:.*\r?\n)*?\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\.\r?\n|$)/i);
                        if (htmlMatch) bodyHtml = htmlMatch[1].trim();
                        // Fallback: if no html, use text
                        if (!bodyHtml && bodyText) bodyHtml = `<p>${bodyText.replace(/\n/g, '<br/>')}</p>`;
                        if (!bodyText && bodyHtml) bodyText = bodyHtml.replace(/<[^>]*>/g, '');
                    }

                    const incoming: IncomingEmail = {
                        from: senderEmail,
                        fromName: senderName,
                        to: recipientAddr,
                        subject: envelope.subject || '(no subject)',
                        bodyHtml,
                        bodyText,
                        messageId: envelope.messageId || `unknown-${Date.now()}-${fetchedCount}`,
                        inReplyTo: envelope.inReplyTo || undefined,
                        references: undefined, // imapflow doesn't expose References directly from envelope
                        receivedAt: envelope.date || new Date(),
                        hasAttachments: (msg.bodyStructure?.childNodes?.length || 0) > 1,
                    };

                    // Check if this is a bounce NDR first — if so, route to Protection pipeline
                    const isBounce = await tryProcessBounce(account.id, account.organization_id, incoming);
                    if (!isBounce) {
                        await processReply(account.id, account.organization_id, incoming);
                    }
                    fetchedCount++;

                    // Mark as SEEN so we don't re-process
                    await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
                } catch (msgErr: any) {
                    logger.error(`[${LOG_TAG}] Error processing message for ${account.email}`, msgErr);
                }
            }
        } finally {
            lock.release();
        }

        lastCheckMap.set(account.id, new Date());
    } catch (err: any) {
        // Update account status on auth failure
        if (err.authenticationFailed || err.message?.includes('auth') || err.message?.includes('AUTH')) {
            await prisma.connectedAccount.update({
                where: { id: account.id },
                data: { connection_status: 'error', last_error: 'IMAP authentication failed — check credentials' },
            }).catch(() => {});
            logger.error(`[${LOG_TAG}] Auth failed for ${account.email}`, err);
        } else if (err.message?.includes('timeout')) {
            logger.warn(`[${LOG_TAG}] Connection timeout for ${account.email} (${account.imap_host})`);
        } else {
            logger.error(`[${LOG_TAG}] IMAP error for ${account.email}`, err);
        }
    } finally {
        try { await client.logout(); } catch { /* ignore */ }
    }

    return fetchedCount;
}

// ─── Main: Check Replies ─────────────────────────────────────────────────────

export async function checkReplies(): Promise<void> {
    const startTime = Date.now();
    logger.info(`[${LOG_TAG}] Starting reply check`);

    try {
        // Get all active connected accounts — either IMAP or OAuth
        const accounts = await prisma.connectedAccount.findMany({
            where: {
                connection_status: 'active',
                OR: [
                    { imap_host: { not: null } },
                    { access_token: { not: null } },
                ],
            },
            select: {
                id: true,
                email: true,
                organization_id: true,
                provider: true,
                smtp_username: true,
                smtp_password: true,
                imap_host: true,
                imap_port: true,
                access_token: true,
                refresh_token: true,
                token_expires_at: true,
            },
        });

        if (accounts.length === 0) {
            logger.info(`[${LOG_TAG}] No accounts to check`);
            return;
        }

        logger.info(`[${LOG_TAG}] Checking ${accounts.length} accounts for replies`);

        let totalFetched = 0;
        let accountsChecked = 0;
        let accountsFailed = 0;

        const BATCH_SIZE = 5;
        for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
            const batch = accounts.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(account => {
                    // Route to OAuth fetch for google/microsoft with tokens, else IMAP
                    if ((account.provider === 'google' || account.provider === 'microsoft') && account.access_token) {
                        return fetchRepliesFromOAuthAccount(account as any);
                    }
                    return fetchRepliesFromAccount(account as any);
                })
            );

            for (const result of results) {
                if (result.status === 'fulfilled') {
                    totalFetched += result.value;
                    accountsChecked++;
                } else {
                    accountsFailed++;
                }
            }
        }

        const elapsed = Date.now() - startTime;
        logger.info(`[${LOG_TAG}] Reply check complete`, {
            accountsChecked,
            accountsFailed,
            repliesFetched: totalFetched,
            elapsedMs: elapsed,
        });
    } catch (err: any) {
        logger.error(`[${LOG_TAG}] Reply check failed`, err);
    }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function scheduleImapPolling(): NodeJS.Timeout {
    logger.info(`[${LOG_TAG}] Scheduling IMAP reply polling (every ${POLL_INTERVAL_MS / 1000}s)`);

    setTimeout(() => {
        checkReplies().catch(error => {
            logger.error(`[${LOG_TAG}] Initial run failed`, error);
        });
    }, 45_000);

    const interval = setInterval(() => {
        checkReplies().catch(error => {
            logger.error(`[${LOG_TAG}] Scheduled run failed`, error);
        });
    }, POLL_INTERVAL_MS);

    return interval;
}

export { processReply };
