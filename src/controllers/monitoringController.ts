/**
 * Monitoring Controller
 *
 * Manual trigger + read endpoints for mailbox health. Used by tests, admin
 * tooling, and the dashboard. Inbound bounce/sent events are now generated
 * directly from the native send pipeline (sendQueueService → SMTP transcript
 * capture → BounceEvent / SendEvent), not from external webhooks.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import * as monitoringService from '../services/monitoringService';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';

/**
 * Manually trigger a monitoring event.
 * POST /api/monitor/event
 */
export const triggerEvent = async (req: Request, res: Response) => {
    const { eventType, mailboxId, campaignId } = req.body;

    if (!eventType || !mailboxId) {
        return res.status(400).json({ success: false, error: 'Missing required fields: eventType, mailboxId' });
    }

    try {
        if (eventType === 'bounce') {
            await monitoringService.recordBounce(mailboxId, campaignId || '');
            res.json({ success: true, message: 'Bounce recorded', mailboxId });
        } else if (eventType === 'sent') {
            await monitoringService.recordSent(mailboxId, campaignId || '');
            res.json({ success: true, message: 'Send recorded', mailboxId });
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
