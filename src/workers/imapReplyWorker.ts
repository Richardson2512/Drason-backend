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
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { decrypt, encrypt, isEncrypted } from '../utils/encryption';
import { fetchGmailReplies, refreshGoogleAccessToken } from '../services/gmailSendService';
import { fetchMicrosoftReplies, refreshMicrosoftAccessToken } from '../services/microsoftSendService';
import { tryProcessBounce } from '../services/bounceParserService';
import * as webhookBus from '../services/webhookEventBus';
import { classifyReply } from '../services/replyClassifierService';
import { parseDsn, isPermanentBounce } from '../services/dsnParser';
import { dispatchEmail } from '../services/emailTemplates/dispatcher';
import { mailboxOAuthDisconnectedEmail } from '../services/emailTemplates/operationalAlerts';
import { buildFrontendUrl } from '../services/emailTemplates/requesterContext';

/**
 * Notify org admins when a connected mailbox loses authentication so they
 * can reconnect before campaigns assigned to it stall. Idempotent on the
 * mailbox + auth-error class so successive failures while it's still
 * disconnected don't spam.
 */
async function notifyMailboxDisconnected(
    accountId: string,
    errorClass: 'oauth_revoked' | 'imap_auth' | 'unknown',
    rawError: string,
): Promise<void> {
    try {
        const account = await prisma.connectedAccount.findUnique({
            where: { id: accountId },
            select: { organization_id: true, email: true, provider: true },
        });
        if (!account) return;
        void dispatchEmail({
            rendered: mailboxOAuthDisconnectedEmail({
                organizationName: 'Your account',
                mailboxEmail: account.email,
                provider: account.provider,
                providerError: rawError.slice(0, 240),
                detectedAt: new Date(),
                reconnectUrl: buildFrontendUrl('/dashboard/sequencer/accounts'),
            }),
            audience: { kind: 'org-admins', organizationId: account.organization_id },
            category: 'integration',
            eventKind: 'mailbox_oauth_disconnected',
            // Per (mailbox, error-class) — the same disconnection won't
            // re-notify on every poll. A NEW class of failure (e.g. imap
            // auth after oauth revoke is fixed) WILL re-notify.
            idempotencyKey: `mailbox-disconnected:${accountId}:${errorClass}`,
        });
    } catch (err) {
        logger.warn('[IMAP-REPLY-WORKER] Failed to dispatch disconnect email', { accountId, error: String(err) });
    }
}
import * as monitoringService from '../services/monitoringService';
import { SlackAlertService } from '../services/SlackAlertService';

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
    /** Raw RFC 5322 source — used by the DSN parser when this message is a
     *  delivery-status notification. Optional because some IMAP fetches don't
     *  retain the full source. */
    raw?: string;
}

// ─── Helper: Process an async DSN bounce ─────────────────────────────────────

/**
 * Process an asynchronous RFC 3464 bounce that arrived in the sending
 * mailbox. Looks up the campaign that sent to this recipient, then runs the
 * standard Protection-layer bounce pipeline. Idempotent: if a BounceEvent
 * already exists for this (mailbox, recipient) pair within the last 5 min,
 * we just annotate it with DSN fields rather than creating a duplicate.
 */
async function handleAsyncBounce(
    accountId: string,
    organizationId: string,
    dsn: ReturnType<typeof parseDsn>,
    email: IncomingEmail,
): Promise<void> {
    const recipient = (dsn.originalRecipient || '').trim().toLowerCase();
    if (!recipient) return;

    // Find the campaign + lead this DSN refers to
    const lead = await prisma.campaignLead.findFirst({
        where: {
            email: recipient,
            campaign: { organization_id: organizationId },
        },
        include: { campaign: true },
        orderBy: { last_sent_at: 'desc' },
    });

    const campaignId = lead?.campaign_id || '';
    const errorMsg = dsn.diagnosticCode || `${dsn.status || ''} ${dsn.action || ''}`.trim();
    const smtpCode = dsn.status; // RFC 3463 enhanced status, e.g. "5.7.1"
    const smtpResponse = dsn.diagnosticCode?.slice(0, 1024);

    try {
        await monitoringService.recordBounce(accountId, campaignId, errorMsg, recipient);
        await prisma.bounceEvent.updateMany({
            where: {
                mailbox_id: accountId,
                email_address: recipient,
                bounced_at: { gte: new Date(Date.now() - 5 * 60 * 1000) },
            },
            data: {
                smtp_code: smtpCode,
                smtp_response: smtpResponse,
                bounce_source: 'dsn',
            },
        }).catch(() => { /* annotation best-effort */ });
        logger.info(`[${LOG_TAG}] Async DSN bounce processed: ${recipient} (${smtpCode || 'no-status'})`);
    } catch (err: any) {
        logger.error(`[${LOG_TAG}] Failed to process async DSN bounce for ${recipient}`, err);
    }

    // Mark the CampaignLead as bounced so the dispatcher stops sending to it
    if (lead && !lead.bounced_at) {
        await prisma.campaignLead.update({
            where: { id: lead.id },
            data: { bounced_at: new Date(), status: 'bounced' },
        }).catch(() => { /* state-update best-effort */ });
    }
}

// ─── Helper: Process a single reply ──────────────────────────────────────────

async function processReply(
    accountId: string,
    organizationId: string,
    email: IncomingEmail
): Promise<void> {
    const senderEmail = email.from.toLowerCase();

    try {
        // 0a. DSN detection — RFC 3464 delivery-status notifications. When the
        //     sending mailbox receives an asynchronous bounce, it arrives as a
        //     multipart/report message we must NOT thread into the Unibox.
        //     Parse, record a BounceEvent, and skip the reply pipeline.
        if (email.raw) {
            const dsn = parseDsn(email.raw);
            if (dsn.isDsn) {
                if (isPermanentBounce(dsn) && dsn.originalRecipient) {
                    await handleAsyncBounce(accountId, organizationId, dsn, email);
                } else {
                    logger.info(`[${LOG_TAG}] Non-permanent DSN: action=${dsn.action} status=${dsn.status} recipient=${dsn.originalRecipient}`);
                }
                return; // never thread DSNs into the Unibox
            }
        }

        // 0b. Top-of-function message dedup: relying on Gmail's `is:unread` to gate
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

        // Update each matching CampaignLead's status + per-lead counters.
        // The thread + EmailMessage are created ONCE per inbound message
        // (outside this loop) — same person in multiple campaigns lands
        // in one shared thread, and message_count must only bump once.
        // Before this refactor, createOrUpdateThread fired per-lead which
        // double-incremented EmailThread.message_count whenever the same
        // address replied to two simultaneous campaigns.
        for (const lead of matchingLeads) {
            const wasFirstReply = !lead.replied_at;

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

            // 4. Create ReplyEvent for analytics (one row per reply message
            //    per campaign — multi-campaign replies create one event per
            //    campaign so per-campaign reply analytics stay accurate).
            await prisma.replyEvent.create({
                data: {
                    organization_id: organizationId,
                    mailbox_id: accountId,
                    campaign_id: lead.campaign_id,
                    recipient_email: senderEmail,
                    replied_at: email.receivedAt,
                },
            });

            if (lead.campaign.stop_on_reply) {
                logger.info(`[${LOG_TAG}] Stopped sequence for lead ${lead.id} (stop_on_reply=true)`);
            }

            logger.info(`[${LOG_TAG}] Processed reply from ${senderEmail}`, {
                leadId: lead.id,
                campaignId: lead.campaign_id,
            });

            const campaignName = lead.campaign.name;
            SlackAlertService.sendAlert({
                organizationId,
                eventType: 'reply.received',
                entityId: lead.id,
                severity: 'info',
                title: '💬 Reply received',
                message: `Reply from \`${senderEmail}\` on campaign *${campaignName}*.`,
            }).catch((err) => logger.warn(`[${LOG_TAG}] Slack alert failed (reply.received)`, { error: err?.message }));

            if (wasFirstReply) {
                SlackAlertService.sendAlert({
                    organizationId,
                    eventType: 'campaign.first_reply',
                    entityId: lead.campaign_id,
                    severity: 'info',
                    title: '🎉 First reply on campaign',
                    message: `*${campaignName}* received its first reply — from \`${senderEmail}\`.`,
                }).catch((err) => logger.warn(`[${LOG_TAG}] Slack alert failed (campaign.first_reply)`, { error: err?.message }));
            }
        }

        // 5. Create/update EmailThread + EmailMessage — ONCE per inbound
        //    message regardless of how many campaigns the sender is in.
        //    Pick the first matching lead's (campaign_id, lead_id) for
        //    thread attribution; subsequent multi-campaign matches are
        //    visible via ReplyEvent rows + CampaignLead status updates above.
        //    Awaited (not fire-and-forget) so enrichment + auto-actions
        //    complete before the worker tick ends. Without the await, a
        //    worker shutdown mid-flight orphaned the AI classification +
        //    cross-channel suppression.
        const primaryLead = matchingLeads[0];
        await createOrUpdateThread(
            accountId,
            organizationId,
            email,
            primaryLead.campaign_id,
            primaryLead.id,
        );
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

        // Insert the row first with the rule output; AI re-classification +
        // OOO extraction + action firing run AFTER the row exists so a slow
        // Gemini call can't block the unibox from showing the new reply.
        const messageRow = await prisma.emailMessage.create({
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

        // Second-pass enrichment — AI re-classification, OOO date extraction,
        // and auto-action execution. AWAITED (the prior fire-and-forget
        // pattern orphaned the AI verdict + cross-channel suppression when
        // the worker shut down mid-flight; replies that should have paused
        // LinkedIn enrollments silently didn't). Per-account batching upstream
        // means one ~500ms Gemini call per reply doesn't block other accounts.
        // Errors are caught so a Gemini outage / missing API key doesn't
        // break the thread/message creation that already succeeded.
        try {
            await processReplyEnrichment({
                messageRowId: messageRow.id,
                ruleQuality: quality,
                organizationId,
                threadId: thread.id,
                campaignId: thread.campaign_id ?? null,
                contactEmail: email.from,
                subject: email.subject,
                bodyText: email.bodyText || '',
                bodyHtml: email.bodyHtml || '',
            });
        } catch (err) {
            logger.warn(`[${LOG_TAG}] enrichment failed (non-fatal)`, {
                err: err instanceof Error ? err.message : String(err),
            });
        }
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
        const { access_token, expires_at, rotated_refresh_token } = await refreshGoogleAccessToken(decryptedRefresh);
        const updateData: any = { access_token: encrypt(access_token), token_expires_at: expires_at };
        if (rotated_refresh_token) updateData.refresh_token = encrypt(rotated_refresh_token);
        await prisma.connectedAccount.update({ where: { id: account.id }, data: updateData });
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
            void notifyMailboxDisconnected(account.id, 'oauth_revoked', err.message || 'invalid_grant');
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

    // smtp_password may be encrypted (new code path) or plaintext (legacy).
    // isEncrypted() probes the format; decrypt only if it matches the
    // AES-256-GCM ciphertext shape.
    const passPlaintext = isEncrypted(account.smtp_password)
        ? decrypt(account.smtp_password)
        : account.smtp_password;

    const client = new ImapFlow({
        host: account.imap_host,
        port: account.imap_port || 993,
        secure: true,
        auth: {
            user: account.smtp_username || account.email,
            pass: passPlaintext,
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

                    // ── Warmup-pool isolation guard ────────────────────────
                    // Messages carrying the signed X-Superkabe-Warmup header
                    // belong to the warmup pool — they're handled by
                    // workers/warmupRecipientWorker.ts and MUST NOT enter
                    // the unibox / reply-classification / bounce pipelines.
                    // Detection is a header substring scan against the raw
                    // source; HMAC verification happens in the warmup worker.
                    if (msg.source) {
                        const sourceStr = msg.source.toString();
                        // Cap the search to the first 8 KB — header section
                        // is always at the top, no need to scan body bytes.
                        const headerSection = sourceStr.slice(0, 8 * 1024);
                        if (/^x-superkabe-warmup:/im.test(headerSection)) continue;
                    }

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
            void notifyMailboxDisconnected(account.id, 'imap_auth', err.message || 'IMAP auth failed');
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
                    // Route priority must mirror emailSendAdapters: prefer IMAP
                    // when SMTP/IMAP credentials are present, fall back to API
                    // for legacy OAuth-only accounts. Mailbox resellers (Zapmail
                    // etc.) populate smtp_password via bulk import — those
                    // accounts may also have access_token from a stale OAuth
                    // flow but should NEVER route to the API path because the
                    // new OAuth scopes (openid+email+profile only) lack the
                    // gmail.modify / Mail.Read permission.
                    if (account.imap_host && account.smtp_password) {
                        return fetchRepliesFromAccount(account as any);
                    }
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

/**
 * Reply enrichment — runs detached from the IMAP hot path.
 *
 *   1. If rule output is unclassified/low, ask Gemini Flash for a
 *      second opinion. Update the EmailMessage row with the AI verdict.
 *   2. If the final class is 'auto', try to parse an OOO return date
 *      (regex first, Gemini fallback). Stamp CampaignLead.ooo_until so
 *      the dispatcher can hold sends until the contact is back.
 *   3. Apply per-org auto-actions (suppress/pause/alert) for the
 *      final class.
 */
async function processReplyEnrichment(input: {
    messageRowId: string;
    ruleQuality: { class: string; confidence: 'high' | 'medium' | 'low'; signals: string[]; evidence?: string };
    organizationId: string;
    threadId: string;
    campaignId: string | null;
    contactEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
}): Promise<void> {
    const { shouldAiReclassify, aiReclassify, extractOooDate } = await import('../services/replyIntelligenceService');
    const { applyReplyActions } = await import('../services/replyActionService');

    // 1. AI re-classification.
    let finalClass = input.ruleQuality.class;
    let finalConfidence: 'high' | 'medium' | 'low' = input.ruleQuality.confidence;
    const rulePass = {
        class: input.ruleQuality.class as never,
        confidence: input.ruleQuality.confidence,
        signals: input.ruleQuality.signals,
        evidence: input.ruleQuality.evidence,
    };
    if (shouldAiReclassify(rulePass)) {
        const ai = await aiReclassify({
            subject: input.subject,
            body: input.bodyText || input.bodyHtml,
            ruleClass: rulePass.class,
            ruleConfidence: rulePass.confidence,
        });
        if (ai) {
            // Trust the AI verdict — that's the whole point of escalation —
            // but keep the original rule signals on the row so we never
            // lose the audit trail. The 'ai_reclassified' marker signals to
            // analytics that this row was second-passed.
            finalClass = ai.class;
            finalConfidence = ai.confidence;
            await prisma.emailMessage.update({
                where: { id: input.messageRowId },
                data: {
                    ai_class: ai.class,
                    ai_confidence: ai.confidence,
                    ai_reasoning: ai.reasoning,
                    ai_classified_at: new Date(),
                    // Mirror the AI verdict into the canonical column so
                    // downstream queries (unibox filter, analytics) see one
                    // class field with the best available answer.
                    quality_class: ai.class,
                    quality_confidence: ai.confidence,
                    quality_signals: [...(input.ruleQuality.signals || []), 'ai_reclassified'],
                },
            });
            logger.info('[REPLY_AI] Reclassified', {
                messageRowId: input.messageRowId,
                from: input.ruleQuality.class, to: ai.class,
            });
        }
    }

    // 2. OOO date extraction — only when the final class is 'auto'.
    if (finalClass === 'auto' && input.campaignId) {
        const oooDate = await extractOooDate({ subject: input.subject, body: input.bodyText || input.bodyHtml });
        if (oooDate) {
            await prisma.emailMessage.update({
                where: { id: input.messageRowId },
                data: { ooo_return_date: oooDate },
            });
            // Mirror onto the CampaignLead so the dispatcher honors the hold.
            await prisma.campaignLead.updateMany({
                where: { campaign_id: input.campaignId, email: input.contactEmail },
                data: { ooo_until: oooDate },
            });
            logger.info('[REPLY_AI] OOO hold applied', {
                campaignId: input.campaignId,
                email: input.contactEmail,
                until: oooDate.toISOString(),
            });
        }
    } else if (input.campaignId) {
        // Only clear an active OOO hold when the new reply is a clear,
        // confident signal that the contact is back at the desk. The
        // prior implementation cleared on EVERY non-auto class, which
        // included things like "objection" / "soft_no" — those can fire
        // from an auto-responder's footer ("I'm out of office until Friday,
        // but please contact my colleague who handles outsourcing pitches
        // — no thanks for now"). Treating that as "they're back" resumed
        // sequence sends mid-OOO and burned cold-call goodwill.
        //
        // Whitelist of classes that DEFINITELY came from a human:
        //   positive / qualified / hard_no / angry / referral
        // 'objection' / 'soft_no' / 'unclassified' stay conservative —
        // we preserve the OOO hold until the configured ooo_until passes
        // on its own.
        const HUMAN_REPLY_CLASSES = new Set(['positive', 'qualified', 'hard_no', 'angry', 'referral']);
        if (HUMAN_REPLY_CLASSES.has(finalClass)) {
            await prisma.campaignLead.updateMany({
                where: { campaign_id: input.campaignId, email: input.contactEmail, ooo_until: { not: null } },
                data: { ooo_until: null },
            });
        }
    }
    void finalConfidence;

    // 3. Auto-actions.
    await applyReplyActions({
        organizationId: input.organizationId,
        threadId: input.threadId,
        contactEmail: input.contactEmail,
        replyClass: finalClass,
        campaignId: input.campaignId,
    });
}

export { processReply };
