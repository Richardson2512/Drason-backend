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
import { RecoveryPhase } from '../types';

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
        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
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
        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
    }
};

/**
 * POST /api/healing/clear-manual-intervention
 * Clear the manual-intervention flag on a mailbox or domain.
 * Body: { entityType: 'mailbox' | 'domain', entityId: string, note: string }
 *
 * The note is required and audit-logged so operator decisions are traceable.
 */
export const clearManualIntervention = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const { entityType, entityId, note } = req.body as { entityType?: string; entityId?: string; note?: string };

        if (!entityType || (entityType !== 'mailbox' && entityType !== 'domain')) {
            res.status(400).json({ success: false, error: 'entityType must be "mailbox" or "domain"' });
            return;
        }
        if (!entityId || typeof entityId !== 'string') {
            res.status(400).json({ success: false, error: 'entityId is required' });
            return;
        }
        if (!note || typeof note !== 'string' || note.trim().length < 5) {
            res.status(400).json({ success: false, error: 'note is required (min 5 chars) — explain what was reviewed and resolved' });
            return;
        }

        const result = await healingService.clearManualIntervention(orgId, entityType, entityId, note.trim());

        if (!result.success) {
            res.status(400).json({ success: false, error: result.error });
            return;
        }

        res.json({ success: true, message: 'Manual intervention flag cleared. Entity will re-enter the graduation pipeline on the next worker tick.' });
    } catch (e: any) {
        logger.error('Failed to clear manual intervention', e);
        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
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
                    manual_intervention_required: true,
                    manual_intervention_reason: true,
                    manual_intervention_set_at: true,
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
                    manual_intervention_required: true,
                    manual_intervention_reason: true,
                    manual_intervention_set_at: true,
                    dns_check_failure_count: true,
                    last_dns_check_attempt_at: true,
                },
                orderBy: { phase_entered_at: 'desc' },
            }),
        ]);

        // Add volume limits for each entity
        const mailboxesWithLimits = recoveringMailboxes.map(mb => ({
            ...mb,
            volumeLimit: healingService.getPhaseVolumeLimit(
                mb.recovery_phase as RecoveryPhase,
                mb.resilience_score
            ),
        }));

        const domainsWithLimits = recoveringDomains.map(d => ({
            ...d,
            volumeLimit: healingService.getPhaseVolumeLimit(
                d.recovery_phase as RecoveryPhase,
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
        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
    }
};
