/**
 * Monitoring Controller
 *
 * Manual trigger + read endpoints for mailbox health. Used by tests, admin
 * tooling, and the dashboard. Inbound bounce/sent events are now generated
 * directly from the native send pipeline (sendQueueService → SMTP transcript
 * capture → BounceEvent / SendEvent), not from external webhooks.
 */

import { Request, Response } from 'express';
import { prisma } from '../prisma';
import * as monitoringService from '../services/monitoringService';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import { recordSecurityEvent, EVENT_TYPES } from '../services/securityAuditLog';

/**
 * Manually trigger a monitoring event.
 * POST /api/monitor/event
 *
 * Pre-fix (Super Protect audit SP1, CRITICAL): this handler accepted
 * `mailboxId` from the request body and forwarded to
 * `monitoringService.recordBounce/recordSent` WITHOUT verifying the
 * caller's org owns that mailbox. The downstream service then looked
 * the mailbox up by id and used `mailbox.organization_id` as if it
 * were authoritative - so a user authenticated to Org A could POST
 * `{ eventType: 'bounce', mailboxId: '<Org B's mailbox UUID> }` and
 * inject fake bounces against Org B's mailbox. 5 fake bounces is
 * enough to trigger auto-pause; Org B's sending could be incapacitated
 * by any authenticated user in any org who could obtain a mailbox UUID
 * (and mailbox UUIDs appear in many surfaces: dashboards, exports,
 * webhook payloads). Cross-tenant integrity attack on the platform's
 * core safety system.
 *
 * Post-fix: verify ownership at the controller layer before invoking
 * the service. 404 on mismatch (don't reveal whether the UUID exists
 * in some other org).
 */
export const triggerEvent = async (req: Request, res: Response) => {
    const { eventType, mailboxId, campaignId } = req.body;

    if (!eventType || !mailboxId) {
        return res.status(400).json({ success: false, error: 'Missing required fields: eventType, mailboxId' });
    }

    try {
        const orgId = getOrgId(req);
        // Ownership gate: the caller's org MUST own the mailboxId.
        // findFirst (not findUnique) lets us combine id + organization_id
        // into a single predicate so a UUID belonging to another org
        // returns null exactly the same as a nonexistent UUID would.
        const mailbox = await prisma.mailbox.findFirst({
            where: { id: String(mailboxId), organization_id: orgId },
            select: { id: true },
        });
        if (!mailbox) {
            logger.warn('[MONITOR] triggerEvent: mailbox ownership check failed', {
                orgId,
                requestedMailboxId: String(mailboxId),
            });
            // Record the attempt to the durable audit log. A repeated
            // pattern of these from a single org is a strong signal that
            // a compromised account is probing the platform's safety
            // system; ops needs the trail to investigate.
            void recordSecurityEvent({
                organizationId: orgId,
                actorKind: 'user',
                actorId: req.orgContext?.userId ?? null,
                eventType: EVENT_TYPES.CROSS_TENANT_MAILBOX_ACCESS_DENIED,
                target: String(mailboxId),
                metadata: { event_type: eventType, route: '/api/monitor/event' },
                req,
            });
            return res.status(404).json({ success: false, error: 'Mailbox not found' });
        }

        if (eventType === 'bounce') {
            await monitoringService.recordBounce(mailbox.id, campaignId || '');
            res.json({ success: true, message: 'Bounce recorded', mailboxId: mailbox.id });
        } else if (eventType === 'sent') {
            await monitoringService.recordSent(mailbox.id, campaignId || '');
            res.json({ success: true, message: 'Send recorded', mailboxId: mailbox.id });
        } else {
            res.status(400).json({ success: false, error: 'Invalid eventType. Use: bounce, sent' });
        }
    } catch (error) {
        logger.error('[MONITOR] Error processing event:', error as Error);
        res.status(500).json({ success: false, error: 'Failed to process monitoring event' });
    }
};

/**
 * Get mailbox health status and metrics.
 * GET /api/monitor/mailbox/:id
 */
export const getMailboxHealth = async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
        const orgId = getOrgId(req);

        const mailbox = await prisma.mailbox.findFirst({
            where: {
                id: id as string,
                organization_id: orgId
            },
            include: {
                domain: true,
                metrics: true
            }
        });

        if (!mailbox) {
            return res.status(404).json({ success: false, error: 'Mailbox not found' });
        }

        const recentTransitions = await prisma.stateTransition.findMany({
            where: {
                organization_id: orgId,
                entity_type: 'mailbox',
                entity_id: id as string
            },
            orderBy: { created_at: 'desc' },
            take: 10
        });

        res.json({
            success: true,
            data: {
                mailbox,
                recentTransitions,
                health: {
                    status: mailbox.status,
                    windowBounceRate: mailbox.window_sent_count > 0
                        ? (mailbox.window_bounce_count / mailbox.window_sent_count * 100).toFixed(2) + '%'
                        : '0%',
                    inCooldown: mailbox.cooldown_until && mailbox.cooldown_until > new Date(),
                    cooldownRemaining: mailbox.cooldown_until
                        ? Math.max(0, mailbox.cooldown_until.getTime() - Date.now())
                        : 0
                }
            }
        });
    } catch (error) {
        logger.error('[MONITOR] Error getting mailbox health:', error as Error);
        res.status(500).json({ success: false, error: 'Failed to get mailbox health' });
    }
};
