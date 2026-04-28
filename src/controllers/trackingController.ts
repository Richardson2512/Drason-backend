/**
 * Tracking Controller
 *
 * Open pixel, click redirect, and unsubscribe handling.
 * These endpoints are PUBLIC (no auth) — tracking must work without login.
 *
 * Every URL carries an HMAC-signed token (see utils/trackingToken.ts) produced
 * at send-time by trackingService. Incoming requests must pass verification
 * before we increment any counter, perform a redirect, or mutate a lead.
 * Forged or expired tokens get a benign response (a pixel / 404) so we never
 * leak validity information to a probe.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { verifyTrackingToken, TrackingPayload } from '../utils/trackingToken';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function sendPixel(res: Response): Response {
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    return res.send(PIXEL);
}

function verifyOrNull(token: string): TrackingPayload | null {
    const payload = verifyTrackingToken(token);
    if (!payload) {
        // Intentionally log-only. Responses stay benign so we don't leak validity info.
        logger.warn('[TRACKING] Rejected unsigned/invalid/expired token');
    }
    return payload;
}

/**
 * Increment a lifetime engagement counter on the Mailbox that originally sent
 * the email being tracked. Looks up the most recent SendEvent for (campaign,
 * recipient) to identify the sending mailbox — this is the sequencer-lane
 * analog of how eventQueue.processBounceEvent updates mailbox counters for
 * platform-webhook events. Without this, the Protection Mailboxes + Domains
 * pages show 0 opens / clicks for everything the native sequencer dispatched.
 *
 * Fire-and-forget: if we can't find the mailbox (e.g. a tracking pixel from a
 * deleted send), silently skip. Never throws.
 */
async function bumpMailboxEngagementCounter(
    campaignId: string,
    recipientEmail: string,
    field: 'open_count_lifetime' | 'click_count_lifetime' | 'reply_count_lifetime',
): Promise<{ mailboxId: string; lastSentAt: Date } | null> {
    try {
        const lastSend = await prisma.sendEvent.findFirst({
            where: { campaign_id: campaignId, recipient_email: recipientEmail },
            orderBy: { sent_at: 'desc' },
            select: { mailbox_id: true, sent_at: true },
        });
        if (!lastSend?.mailbox_id) return null;
        await prisma.mailbox.update({
            where: { id: lastSend.mailbox_id },
            data: { [field]: { increment: 1 }, last_activity_at: new Date() },
        });
        return { mailboxId: lastSend.mailbox_id, lastSentAt: lastSend.sent_at };
    } catch (err) {
        logger.warn(`[TRACKING] Failed to bump Mailbox.${field}`, { error: (err as Error).message });
        return null;
    }
}

/**
 * Insert a per-event row into the EmailOpenEvent / EmailClickEvent log used
 * by the Cold Call List scoring engine. We pre-compute `ms_since_send` here
 * (rather than at score time) so the scoring SQL can apply the MPP/scanner
 * filter without an extra join. Fire-and-forget; never throws.
 */
async function recordEngagementEvent(args: {
    kind: 'open' | 'click';
    organizationId: string;
    campaignId: string;
    campaignLeadId: string;
    leadId: string | null;
    recipientEmail: string;
    sentAt: Date | null;
    url?: string | null;
}): Promise<void> {
    try {
        const msSinceSend = args.sentAt
            ? Math.max(0, Date.now() - args.sentAt.getTime())
            : null;
        if (args.kind === 'open') {
            await prisma.emailOpenEvent.create({
                data: {
                    organization_id: args.organizationId,
                    campaign_id: args.campaignId,
                    campaign_lead_id: args.campaignLeadId,
                    lead_id: args.leadId,
                    recipient_email: args.recipientEmail,
                    ms_since_send: msSinceSend,
                },
            });
        } else {
            await prisma.emailClickEvent.create({
                data: {
                    organization_id: args.organizationId,
                    campaign_id: args.campaignId,
                    campaign_lead_id: args.campaignLeadId,
                    lead_id: args.leadId,
                    recipient_email: args.recipientEmail,
                    url: args.url ? args.url.slice(0, 1024) : null,
                    ms_since_send: msSinceSend,
                },
            });
        }
    } catch (err) {
        logger.warn(`[TRACKING] Failed to record EmailEvent (${args.kind})`, {
            error: (err as Error).message,
        });
    }
}

/**
 * GET /t/o/:token
 * Track email open — return 1x1 transparent GIF regardless of verification
 * so email clients never render a broken image. Counters only fire on verify.
 */
export const trackOpen = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const payload = verifyOrNull(String(req.params.id));
        if (!payload) return sendPixel(res);

        const trackingId = payload.lid;

        // Fire-and-forget: CampaignLead → SendCampaign → Protection-layer Lead.
        prisma.campaignLead
            .update({
                where: { id: trackingId },
                data: { opened_count: { increment: 1 } },
                include: { campaign: { select: { organization_id: true } } },
            })
            .then(async (lead) => {
                const now = new Date();
                await prisma.campaign.update({
                    where: { id: lead.campaign_id },
                    data: { open_count: { increment: 1 } },
                }).catch((err) => {
                    logger.error('[TRACKING] Failed to increment Campaign.open_count', err instanceof Error ? err : new Error(String(err)));
                });
                // Mirror open to Protection-layer Lead and capture the matched
                // lead.id so the EmailOpenEvent row links both sides.
                let protectionLeadId: string | null = null;
                try {
                    const matched = await prisma.lead.findFirst({
                        where: {
                            organization_id: lead.campaign.organization_id,
                            email: lead.email,
                        },
                        select: { id: true },
                    });
                    protectionLeadId = matched?.id ?? null;
                    await prisma.lead.updateMany({
                        where: {
                            organization_id: lead.campaign.organization_id,
                            email: lead.email,
                        },
                        data: { emails_opened: { increment: 1 }, last_activity_at: now },
                    });
                } catch (err) {
                    logger.error('[TRACKING] Failed to mirror open to Lead.emails_opened', err instanceof Error ? err : new Error(String(err)));
                }
                // Bump the sending Mailbox AND retrieve send context for event log.
                const sendCtx = await bumpMailboxEngagementCounter(lead.campaign_id, lead.email, 'open_count_lifetime');
                // Cold Call List scoring log.
                await recordEngagementEvent({
                    kind: 'open',
                    organizationId: lead.campaign.organization_id,
                    campaignId: lead.campaign_id,
                    campaignLeadId: lead.id,
                    leadId: protectionLeadId,
                    recipientEmail: lead.email,
                    sentAt: sendCtx?.lastSentAt ?? null,
                });
            })
            .catch((err) => {
                logger.error('[TRACKING] Failed to record open', err instanceof Error ? err : new Error(String(err)));
            });

        return sendPixel(res);
    } catch (_error: unknown) {
        return sendPixel(res);
    }
};

/**
 * GET /t/c/:token
 * Track click — verify token, then redirect to its signed `url`. A tampered
 * or expired token returns 404 (no redirect) to avoid open-redirect abuse.
 */
export const trackClick = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const payload = verifyOrNull(String(req.params.id));
        if (!payload || !payload.u) {
            return res.status(404).json({ success: false, error: 'Invalid or expired tracking link' });
        }

        const leadId = payload.lid;
        const url = payload.u;

        // Fire-and-forget: CampaignLead → SendCampaign → Protection-layer Lead.
        prisma.campaignLead
            .update({
                where: { id: leadId },
                data: { clicked_count: { increment: 1 } },
                include: { campaign: { select: { organization_id: true } } },
            })
            .then(async (lead) => {
                const now = new Date();
                await prisma.campaign.update({
                    where: { id: lead.campaign_id },
                    data: { click_count: { increment: 1 } },
                }).catch((err) => {
                    logger.error('[TRACKING] Failed to increment Campaign.click_count', err instanceof Error ? err : new Error(String(err)));
                });
                let protectionLeadId: string | null = null;
                try {
                    const matched = await prisma.lead.findFirst({
                        where: {
                            organization_id: lead.campaign.organization_id,
                            email: lead.email,
                        },
                        select: { id: true },
                    });
                    protectionLeadId = matched?.id ?? null;
                    await prisma.lead.updateMany({
                        where: {
                            organization_id: lead.campaign.organization_id,
                            email: lead.email,
                        },
                        data: { emails_clicked: { increment: 1 }, last_activity_at: now },
                    });
                } catch (err) {
                    logger.error('[TRACKING] Failed to mirror click to Lead.emails_clicked', err instanceof Error ? err : new Error(String(err)));
                }
                const sendCtx = await bumpMailboxEngagementCounter(lead.campaign_id, lead.email, 'click_count_lifetime');
                await recordEngagementEvent({
                    kind: 'click',
                    organizationId: lead.campaign.organization_id,
                    campaignId: lead.campaign_id,
                    campaignLeadId: lead.id,
                    leadId: protectionLeadId,
                    recipientEmail: lead.email,
                    sentAt: sendCtx?.lastSentAt ?? null,
                    url,
                });
            })
            .catch((err) => {
                logger.error('[TRACKING] Failed to record click', err instanceof Error ? err : new Error(String(err)));
            });

        // Token payload.u is trusted because HMAC verified — safe to redirect.
        res.redirect(302, url);
    } catch (error: unknown) {
        logger.error('[TRACKING] Failed to track click', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Tracking error' });
    }
};

/**
 * GET /t/u/:token
 * Show unsubscribe confirmation page. Invalid tokens get a generic "link
 * expired" message — same response as a legitimately expired lookup, so a
 * probe cannot distinguish "token forged" from "token too old".
 */
export const unsubscribe = async (req: Request, res: Response): Promise<Response> => {
    try {
        const payload = verifyOrNull(String(req.params.id));
        if (!payload) return res.status(404).send('<html><body><h1>Link expired</h1></body></html>');

        const trackingId = payload.lid;

        const lead = await prisma.campaignLead.findUnique({
            where: { id: trackingId },
            select: { email: true, status: true },
        });

        if (!lead) return res.status(404).send('<html><body><h1>Link expired</h1></body></html>');

        if (lead.status === 'unsubscribed') {
            return res.send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
                    <h1>Already Unsubscribed</h1>
                    <p>${lead.email} has already been unsubscribed.</p>
                </body></html>
            `);
        }

        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
                <h1>Unsubscribe</h1>
                <p>Click below to unsubscribe <strong>${lead.email}</strong> from future emails.</p>
                <form method="POST" action="/t/u/${String(req.params.id)}">
                    <button type="submit" style="padding:12px 24px;font-size:16px;cursor:pointer;background:#dc2626;color:white;border:none;border-radius:6px;">
                        Unsubscribe
                    </button>
                </form>
            </body></html>
        `);
    } catch (error: unknown) {
        logger.error('[TRACKING] Failed to show unsubscribe page', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).send('<html><body><h1>Something went wrong</h1></body></html>');
    }
};

/**
 * POST /t/u/:token
 * Process unsubscribe — mark lead as unsubscribed only after token verification.
 */
export const processUnsubscribe = async (req: Request, res: Response): Promise<Response> => {
    try {
        const payload = verifyOrNull(String(req.params.id));
        if (!payload) return res.status(404).send('<html><body><h1>Link expired</h1></body></html>');

        const trackingId = payload.lid;

        const campaignLead = await prisma.campaignLead.findUnique({
            where: { id: trackingId },
            select: {
                id: true,
                campaign_id: true,
                email: true,
                status: true,
                campaign: { select: { organization_id: true } },
            },
        });

        if (!campaignLead) return res.status(404).send('<html><body><h1>Link expired</h1></body></html>');

        const orgId = campaignLead.campaign.organization_id;
        const recipientEmail = campaignLead.email.toLowerCase();
        const now = new Date();

        // Org-wide suppression — required by CAN-SPAM § 5(a)(4)(A), CASL § 11(3),
        // and GDPR Art. 21. Once a recipient unsubscribes, we must NEVER send to
        // them again from any campaign in this org. Three layers in one transaction:
        //
        //   1. Lead row (org-scoped identity) — sets status + timestamp + reason.
        //      Future enrollments check this and refuse to add the lead.
        //   2. CampaignLead rows for ALL of this lead's campaigns in the org — every
        //      active membership becomes 'unsubscribed' so the dispatcher won't send.
        //   3. Increment unsubscribed_count on the campaign that surfaced the link.
        try {
            await prisma.$transaction([
                // Layer 1 — org-wide Lead suppression (idempotent: updateMany handles
                // the case where the Lead row doesn't exist for sequencer-only contacts)
                prisma.lead.updateMany({
                    where: { organization_id: orgId, email: recipientEmail },
                    data: {
                        status: 'unsubscribed',
                        unsubscribed_at: now,
                        unsubscribed_reason: 'recipient_request',
                    },
                }),
                // Layer 2 — every CampaignLead for this email across the org
                prisma.campaignLead.updateMany({
                    where: {
                        email: recipientEmail,
                        campaign: { organization_id: orgId },
                        status: { not: 'unsubscribed' },
                    },
                    data: { status: 'unsubscribed', unsubscribed_at: now },
                }),
                // Layer 3 — analytics counter on the originating campaign
                prisma.campaign.update({
                    where: { id: campaignLead.campaign_id },
                    data: { unsubscribed_count: { increment: 1 } },
                }),
            ]);
        } catch (txErr) {
            logger.error(
                '[TRACKING] Org-wide unsubscribe transaction failed',
                txErr instanceof Error ? txErr : new Error(String(txErr)),
                { orgId, recipientEmail },
            );
            // Fall through — even if the cascade fails, return success to the
            // recipient (we'll have to remediate via a sweep job rather than
            // tell the recipient their click didn't work).
        }

        return res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px;">
                <h1>Unsubscribed</h1>
                <p>You have been successfully unsubscribed. You will no longer receive any emails from this sender.</p>
            </body></html>
        `);
    } catch (error: unknown) {
        logger.error('[TRACKING] Failed to process unsubscribe', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).send('<html><body><h1>Something went wrong</h1></body></html>');
    }
};
