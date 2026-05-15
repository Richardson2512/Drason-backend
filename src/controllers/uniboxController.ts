/**
 * Unibox Controller
 *
 * Unified inbox API - list threads, get conversation, send reply,
 * mark read/unread, star/unstar, archive.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { sendEmail } from '../services/emailSendAdapters';

/**
 * GET /api/unibox/threads
 * List email threads with filters and pagination.
 */
export const listThreads = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 30;
        const status = (req.query.status as string) || undefined;
        const accountId = (req.query.account as string) || undefined;
        const campaignId = (req.query.campaign as string) || undefined;
        const starred = req.query.starred === 'true' ? true : undefined;
        const unread = req.query.unread === 'true' ? true : undefined;
        const search = (req.query.search as string) || undefined;
        // `view` selects which slice of Unibox the user is looking at:
        //   'inbox'  (default) - threads where a reply has been received (i.e. needs
        //                        attention). Excludes send-only threads.
        //   'sent'             - every thread we initiated (one entry per contact per
        //                        campaign), regardless of whether they replied.
        //   'all'              - no direction discrimination (inbox + sent merged).
        const view = (req.query.view as string) || 'inbox';
        // Reply-quality filter - comma-separated class names. Shows threads
        // whose latest inbound message has a quality_class in the set. The
        // canonical column (quality_class) is kept in sync with the AI verdict
        // by the worker, so this filter sees the final answer either way.
        // Allowlist to the known classes so a crafted query param (e.g.
        // `__proto__`) can't reach the Prisma query and so a typo doesn't
        // silently return zero rows without a hint to the operator.
        const VALID_QUALITY_CLASSES = new Set([
            'positive', 'qualified', 'objection', 'referral',
            'soft_no', 'hard_no', 'angry', 'auto', 'unclassified',
        ]);
        const qualityClassRaw = (req.query.quality_class as string) || '';
        const qualityClasses = qualityClassRaw
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(s => s && VALID_QUALITY_CLASSES.has(s));

        // Hard rule: Unibox surfaces only campaign-originated conversations. Warmup
        // traffic, vendor broadcasts, newsletter noise, and cold inbound to the mailbox
        // have no CampaignLead match and so carry campaign_id = null; those must never
        // appear here. (imapReplyWorker now skips creating orphan threads in the first
        // place - this filter also covers any legacy threads created before that fix.)
        const where: any = {
            organization_id: orgId,
            campaign_id: { not: null },
        };
        if (status && status !== 'all') where.status = status;
        if (accountId) where.account_id = accountId;
        if (campaignId) where.campaign_id = campaignId;
        if (starred) where.is_starred = true;
        if (unread) where.is_read = false;
        if (search) {
            where.OR = [
                { contact_email: { contains: search, mode: 'insensitive' } },
                { contact_name: { contains: search, mode: 'insensitive' } },
                { subject: { contains: search, mode: 'insensitive' } },
            ];
        }
        // View discrimination:
        //   inbox → require at least one inbound message on the thread
        //   sent  → require at least one outbound message (which is basically all of
        //           them post-fix, since every thread starts from a sequencer send)
        //   all   → no message-direction filter
        if (view === 'inbox') {
            where.messages = { some: { direction: 'inbound' } };
        } else if (view === 'sent') {
            where.messages = { some: { direction: 'outbound' } };
        }

        // Quality-class filter - applies on top of the direction filter so
        // "Sent" tab never gets accidentally narrowed by it. Empty class list
        // is a no-op so the unibox renders identically to before for users
        // who haven't enabled any chips.
        if (qualityClasses.length > 0) {
            const inboundQuality = { direction: 'inbound', quality_class: { in: qualityClasses } };
            // Merge with any existing `some` predicate set by view filter
            // above. Prisma's `some` accepts AND semantics inside one object.
            if (where.messages?.some) {
                where.messages = { some: { ...where.messages.some, ...inboundQuality } };
            } else {
                where.messages = { some: inboundQuality };
            }
        }

        const [threads, total] = await Promise.all([
            prisma.emailThread.findMany({
                where,
                orderBy: { last_message_at: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    account: { select: { email: true, display_name: true, provider: true } },
                },
            }),
            prisma.emailThread.count({ where }),
        ]);

        // Unread count always reflects the Inbox slice (threads waiting on the user) -
        // the Sent tab's "unread" concept isn't meaningful, so don't let view=sent
        // wipe the badge.
        const unreadCount = await prisma.emailThread.count({
            where: {
                organization_id: orgId,
                is_read: false,
                campaign_id: { not: null },
                messages: { some: { direction: 'inbound' } },
            },
        });

        return res.json({
            success: true,
            data: threads,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit), unreadCount },
        });
    } catch (error: any) {
        logger.error('[UNIBOX] Failed to list threads', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list threads' });
    }
};

/**
 * GET /api/unibox/threads/:id
 * Get a single thread with all messages.
 */
export const getThread = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const threadId = String(req.params.id);

        const thread = await prisma.emailThread.findFirst({
            where: { id: threadId, organization_id: orgId },
            include: {
                account: { select: { email: true, display_name: true, provider: true } },
                messages: { orderBy: { sent_at: 'asc' } },
            },
        });

        if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

        // Auto-mark as read
        if (!thread.is_read) {
            await prisma.emailThread.update({ where: { id: threadId }, data: { is_read: true } });
        }

        // Get lead context if linked to a campaign
        let leadContext: any = null;
        if (thread.campaign_id && thread.contact_email) {
            const campaignLead = await prisma.campaignLead.findFirst({
                where: { campaign_id: thread.campaign_id, email: thread.contact_email },
                select: {
                    email: true, first_name: true, last_name: true, company: true, title: true,
                    status: true, current_step: true, esp_bucket: true, validation_status: true,
                    opened_count: true, clicked_count: true, replied_at: true,
                },
            });
            if (campaignLead) leadContext = campaignLead;
        }
        // Resolve the canonical Lead.id (UUID in the org-wide Lead table) so
        // the unibox right-panel can deep-link to the contact detail page.
        // CampaignLead is a per-campaign join; the master record lives on Lead.
        if (thread.contact_email && thread.organization_id) {
            const lead = await prisma.lead.findFirst({
                where: { organization_id: thread.organization_id, email: thread.contact_email, status: { not: 'erased' } },
                select: { id: true },
            });
            if (lead) {
                leadContext = { ...(leadContext || { email: thread.contact_email }), lead_id: lead.id };
            }
        }

        // Nest leadContext inside `data` - apiClient auto-unwraps `data`, so
        // siblings at the top level get stripped by the frontend.
        return res.json({ success: true, data: { ...thread, is_read: true, leadContext } });
    } catch (error: any) {
        logger.error('[UNIBOX] Failed to get thread', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get thread' });
    }
};

/**
 * POST /api/unibox/threads/:id/reply
 * Send a reply - actually sends via SMTP, then records in DB.
 */
export const sendReply = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const threadId = String(req.params.id);
        const { bodyHtml, bodyText } = req.body;

        if (!bodyHtml) return res.status(400).json({ success: false, error: 'Reply body is required' });

        // Load thread with full account credentials for sending
        const thread = await prisma.emailThread.findFirst({
            where: { id: threadId, organization_id: orgId },
            include: { account: true },
        });

        if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

        const account = thread.account;
        if (account.connection_status !== 'active') {
            return res.status(400).json({ success: false, error: 'Mailbox is not active. Reconnect it before sending.' });
        }

        // Threading headers per RFC 5322 §3.6.4:
        //   In-Reply-To = the immediate parent message's Message-ID
        //   References  = the full chain root → ... → parent
        //
        // Reading the latest inbound for In-Reply-To is correct (parent =
        // what the operator is replying to). But the prior References
        // implementation just concatenated `[lastInbound.references,
        // lastInbound.message_id]` which (a) trusts the inbound mailer to
        // have set References correctly (often empty or malformed), and
        // (b) can create circular chains on multi-fork threads.
        //
        // We anchor References on the ORIGINAL outbound (oldest message in
        // the thread) so even a corrupted inbound chain still threads back
        // to the campaign-side starting point. Cap the chain at 10 entries
        // per RFC 5322 §3.6.4 guidance.
        const [lastInbound, firstOutbound] = await Promise.all([
            prisma.emailMessage.findFirst({
                where: { thread_id: threadId, direction: 'inbound' },
                orderBy: { sent_at: 'desc' },
                select: { message_id: true, references: true },
            }),
            prisma.emailMessage.findFirst({
                where: { thread_id: threadId, direction: 'outbound' },
                orderBy: { sent_at: 'asc' },
                select: { message_id: true },
            }),
        ]);

        const subjectBase = thread.subject.replace(/^Re:\s*/i, '');
        const subject = `Re: ${subjectBase}`;

        const inReplyTo = lastInbound?.message_id || null;
        const chainSeen = new Set<string>();
        const chain: string[] = [];
        const pushId = (id: string | null | undefined) => {
            if (!id || chainSeen.has(id)) return;
            chainSeen.add(id);
            chain.push(id);
        };
        pushId(firstOutbound?.message_id);
        // Splice inbound's References (whitespace-separated message-ids) into
        // the chain so any intermediate parties' clients have the same
        // reference graph as the recipient.
        for (const ref of (lastInbound?.references || '').split(/\s+/)) {
            pushId(ref.trim() || null);
        }
        pushId(lastInbound?.message_id);
        const references = chain.length > 0 ? chain.slice(-10).join(' ') : null;

        // Pre-generate a stable RFC 5322 Message-ID so the DB row written
        // BEFORE the SMTP send and the outbound MIME header agree. This
        // fixes the lost-reply-after-SMTP-success-but-DB-fail race where
        // operators would resend the same message after a 500. The header
        // domain mirrors the sender's address so DKIM alignment isn't
        // disturbed.
        const domainPart = account.email.split('@')[1] || 'drason.local';
        const stableMessageId = `<${crypto.randomUUID()}@${domainPart}>`;

        // Insert a 'pending' message row BEFORE the SMTP send so we have
        // durable proof the operator clicked Send. If SMTP succeeds but the
        // DB write below fails, we still have a record of the message and
        // its Message-ID - re-submitting won't fire a duplicate because the
        // unique-on-message_id constraint kicks in.
        const message = await prisma.emailMessage.create({
            data: {
                thread_id: threadId,
                direction: 'outbound',
                from_email: account.email,
                from_name: account.display_name || account.email,
                to_email: thread.contact_email,
                to_name: thread.contact_name,
                subject,
                body_html: bodyHtml,
                body_text: bodyText || '',
                message_id: stableMessageId,
                in_reply_to: inReplyTo,
                references,
                send_status: 'pending',
            },
        });

        // Send the email - provider adapter injects In-Reply-To / References into the
        // outgoing MIME (SMTP via nodemailer, Gmail via MIME headers + threadId lookup,
        // Graph via internetMessageHeaders).
        const sendResult = await sendEmail(account, thread.contact_email, subject, bodyHtml, {
            inReplyTo,
            references,
            messageId: stableMessageId,
        });

        if (!sendResult.success) {
            // Mark the row as failed so the FE can show a retry affordance
            // and so the unique Message-ID is still reserved for the
            // eventual successful send.
            await prisma.emailMessage.update({
                where: { id: message.id },
                data: { send_status: 'failed', send_error: sendResult.error?.slice(0, 500) || 'unknown' },
            }).catch(() => {});
            logger.error('[UNIBOX] Send failed', new Error(`${sendResult.error} (thread: ${threadId})`));
            return res.status(502).json({ success: false, error: `Failed to send email: ${sendResult.error}` });
        }

        // Flip the row to 'sent' now that the provider confirmed delivery.
        // If this update fails the message still exists with status='pending'
        // - a retention worker / manual reconcile can correct it later.
        await prisma.emailMessage.update({
            where: { id: message.id },
            data: { send_status: 'sent' },
        }).catch((err) => {
            logger.warn('[UNIBOX] Failed to flip send_status to sent', { messageId: message.id, error: err?.message });
        });

        // Update thread metadata
        await prisma.emailThread.update({
            where: { id: threadId },
            data: {
                status: 'replied',
                last_message_at: new Date(),
                message_count: { increment: 1 },
                snippet: (bodyText || bodyHtml).replace(/<[^>]*>/g, '').slice(0, 120),
            },
        });

        // SendCampaign.total_sent deliberately NOT incremented here. total_sent
        // represents campaign-sequence emails dispatched (automated step sends
        // from sendQueueService), not every outbound message. A Unibox reply is
        // the user responding inside an existing thread - it must not inflate
        // campaign-level sent analytics. Mailbox-level + SendEvent tracking
        // below DOES still fire because ESP reputation and mailbox sends_today
        // care about every real SMTP/API send the mailbox performed, reply or
        // not.
        //
        // (Historical note: before this change, Unibox replies incremented
        //  total_sent, which is why a single-step campaign with replies could
        //  show total_sent > total_leads.)

        // Create SendEvent for ESP performance tracking + mailbox-level sent counters.
        await prisma.sendEvent.create({
            data: {
                organization_id: orgId,
                mailbox_id: account.id,
                campaign_id: thread.campaign_id,
                recipient_email: thread.contact_email,
                sent_at: new Date(),
            },
        }).catch(() => {}); // Non-critical

        // Bump mailbox + connected account send counters (matches sequencer send pipeline)
        await prisma.connectedAccount.update({
            where: { id: account.id },
            data: { sends_today: { increment: 1 } },
        }).catch(() => {});
        await prisma.mailbox.updateMany({
            where: { connected_account_id: account.id },
            data: {
                total_sent_count: { increment: 1 },
                window_sent_count: { increment: 1 },
                last_activity_at: new Date(),
            },
        }).catch(() => {});

        logger.info('[UNIBOX] Reply sent', {
            threadId,
            from: account.email,
            to: thread.contact_email,
            messageId: sendResult.messageId,
        });

        return res.json({ success: true, data: message });
    } catch (error: any) {
        logger.error('[UNIBOX] Failed to send reply', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to send reply' });
    }
};

/**
 * PATCH /api/unibox/threads/:id
 * Update thread - mark read/unread, star/unstar, archive.
 */
export const updateThread = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const threadId = String(req.params.id);
        const { is_read, is_starred, status } = req.body;

        const thread = await prisma.emailThread.findFirst({
            where: { id: threadId, organization_id: orgId },
        });
        if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

        const data: any = {};
        if (typeof is_read === 'boolean') data.is_read = is_read;
        if (typeof is_starred === 'boolean') data.is_starred = is_starred;
        if (status) data.status = status;

        const updated = await prisma.emailThread.update({ where: { id: threadId }, data });
        return res.json({ success: true, data: updated });
    } catch (error: any) {
        logger.error('[UNIBOX] Failed to update thread', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update thread' });
    }
};

/**
 * PATCH /api/unibox/threads/bulk
 * Bulk update - mark multiple threads read/unread/archived.
 */
export const bulkUpdateThreads = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { threadIds, is_read, is_starred, status } = req.body;

        if (!threadIds || !Array.isArray(threadIds)) {
            return res.status(400).json({ success: false, error: 'threadIds array required' });
        }

        const data: any = {};
        if (typeof is_read === 'boolean') data.is_read = is_read;
        if (typeof is_starred === 'boolean') data.is_starred = is_starred;
        if (status) data.status = status;

        // updateMany returns the actual affected row count - surface it so
        // the FE can detect partial success (e.g. some threadIds didn't
        // belong to this org and were silently filtered out by the
        // organization_id scope). The old `updated: threadIds.length` lied
        // about success even when zero rows changed.
        const result = await prisma.emailThread.updateMany({
            where: { id: { in: threadIds }, organization_id: orgId },
            data,
        });

        return res.json({ success: true, updated: result.count, requested: threadIds.length });
    } catch (error: any) {
        logger.error('[UNIBOX] Bulk update failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Bulk update failed' });
    }
};
