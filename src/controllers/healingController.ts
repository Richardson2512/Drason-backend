/**
 * Healing Controller
 * 
 * API endpoints for the graduated healing system.
 * Provides transition gate status, acknowledgment, and entity recovery details.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import * as healingService from '../services/healingService';
import * as operatorProtection from '../services/operatorProtectionService';
import { logger } from '../services/observabilityService';

/**
 * GET /api/healing/transition-gate
 * Check Phase 0 → Phase 1 transition gate status.
 */
export const getTransitionGate = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const result = await healingService.checkTransitionGate(orgId);
        res.json({ success: true, data: result });
    } catch (e: any) {
        logger.error('Failed to check transition gate', e);
        res.status(500).json({ error: e.message });
    }
};

/**
 * POST /api/healing/acknowledge-transition
 * Acknowledge low-score assessment to proceed with operations.
 */
export const acknowledgeTransition = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const acknowledged = await healingService.acknowledgeTransition(orgId);

        if (!acknowledged) {
            res.status(400).json({
                success: false,
                error: 'No acknowledgment needed — either score is above threshold or already acknowledged'
            });
            return;
        }

        res.json({
            success: true,
            message: 'Transition acknowledged. System will now operate with current infrastructure.'
        });
    } catch (e: any) {
        logger.error('Failed to acknowledge transition', e);
        res.status(500).json({ error: e.message });
    }
};

/**
 * GET /api/healing/recovery-status
 * Get all entities currently in recovery phases with their progress.
 */
export const getRecoveryStatus = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);

        const [recoveringMailboxes, recoveringDomains] = await Promise.all([
            prisma.mailbox.findMany({
                where: {
                    organization_id: orgId,
                    recovery_phase: { not: 'healthy' },
                },
                select: {
                    id: true,
                    email: true,
                    status: true,
                    recovery_phase: true,
                    healing_origin: true,
                    phase_entered_at: true,
                    clean_sends_since_phase: true,
                    resilience_score: true,
                    relapse_count: true,
                    trend_state: true,
                    cooldown_until: true,
                    consecutive_pauses: true,
                    hard_bounce_count: true,
                    total_sent_count: true,
                },
                orderBy: { phase_entered_at: 'desc' },
            }),
            prisma.domain.findMany({
                where: {
                    organization_id: orgId,
                    recovery_phase: { not: 'healthy' },
                },
                select: {
                    id: true,
                    domain: true,
                    status: true,
                    recovery_phase: true,
                    healing_origin: true,
                    phase_entered_at: true,
                    clean_sends_since_phase: true,
                    resilience_score: true,
                    relapse_count: true,
                    trend_state: true,
                    cooldown_until: true,
                    consecutive_pauses: true,
                },
                orderBy: { phase_entered_at: 'desc' },
            }),
        ]);

        // Add volume limits for each entity
        const mailboxesWithLimits = recoveringMailboxes.map(mb => ({
            ...mb,
            volumeLimit: healingService.getPhaseVolumeLimit(
                mb.recovery_phase as any,
                mb.resilience_score
            ),
        }));

        const domainsWithLimits = recoveringDomains.map(d => ({
            ...d,
            volumeLimit: healingService.getPhaseVolumeLimit(
                d.recovery_phase as any,
                d.resilience_score
            ),
        }));

        res.json({
            success: true,
            data: {
                mailboxes: mailboxesWithLimits,
                domains: domainsWithLimits,
                summary: {
                    totalRecovering: recoveringMailboxes.length + recoveringDomains.length,
                    mailboxCount: recoveringMailboxes.length,
                    domainCount: recoveringDomains.length,
                }
            }
        });
    } catch (e: any) {
        logger.error('Failed to fetch recovery status', e);
        res.status(500).json({ error: e.message });
    }
};
