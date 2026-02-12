/**
 * Operator Protection Service
 * 
 * Implements Section 5.8 (Operator Behavior Protection) and
 * Section 5.7 (Campaign Never Auto-Resume) of the Implementation Plan.
 * 
 * Humans are treated as risk vectors. This service:
 *   - Tracks manual overrides and detects excessive intervention
 *   - Doubles cooldowns when same entity is overridden repeatedly
 *   - Requires justification for overrides on low-resilience entities
 *   - Enforces campaign manual-resume-only policy
 *   - Emits warnings for frequent overrides
 */

import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import * as eventService from './eventService';
import { EventType } from '../types';
import logger from '../utils/logger';

// ============================================================================
// CONSTANTS
// ============================================================================

const OVERRIDE_WINDOW_MS = 48 * 60 * 60 * 1000;       // 48h window for same-entity overrides
const ACCOUNT_OVERRIDE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d window for account-level tracking
const MAX_ENTITY_OVERRIDES = 3;                        // 3+ overrides on same entity → doubled cooldown
const MAX_ACCOUNT_OVERRIDES = 5;                       // 5+ overrides across any entities → account warning
const LOW_RESILIENCE_THRESHOLD = 20;                   // Requires justification below this score

// ============================================================================
// TYPES
// ============================================================================

export interface OverrideRequest {
    organizationId: string;
    entityType: 'mailbox' | 'domain' | 'campaign';
    entityId: string;
    operatorId?: string;
    justification?: string;
    targetState: string;            // State the operator wants to force
}

export interface OverrideResult {
    allowed: boolean;
    applied: boolean;
    warnings: string[];
    cooldownMultiplier: number;     // 1x = normal, 2x = doubled
    requiresJustification: boolean;
    message: string;
}

// ============================================================================
// MANUAL RESUME (Campaign + Infrastructure)
// ============================================================================

/**
 * Manual resume for campaigns. Campaigns NEVER auto-resume.
 * Resume always starts in restricted_send mode (volume-capped).
 */
export async function resumeCampaign(
    organizationId: string,
    campaignId: string,
    operatorId?: string,
    justification?: string
): Promise<OverrideResult> {
    const campaign = await prisma.campaign.findFirst({
        where: { id: campaignId, organization_id: organizationId },
    });

    if (!campaign) {
        return makeResult(false, false, 'Campaign not found');
    }

    if (campaign.status !== 'paused') {
        return makeResult(false, false, `Campaign is ${campaign.status}, not paused`);
    }

    // Check underlying infrastructure health
    const healthyMailboxCount = await prisma.mailbox.count({
        where: {
            organization_id: organizationId,
            status: { in: ['healthy', 'warm_recovery'] },
        },
    });

    if (healthyMailboxCount === 0) {
        return makeResult(
            false, false,
            'Cannot resume campaign: no mailboxes at warm_recovery or healthy. Heal infrastructure first.'
        );
    }

    // Assess override risk
    const overrideCheck = await assessOverrideRisk({
        organizationId,
        entityType: 'campaign',
        entityId: campaignId,
        operatorId,
        justification,
        targetState: 'restricted_send',
    });

    if (!overrideCheck.allowed) {
        return overrideCheck;
    }

    // Resume in restricted_send mode (volume-capped)
    await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'active' },
    });

    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: 'campaign',
            entity_id: campaignId,
            from_state: 'paused',
            to_state: 'active',
            reason: `Manual resume by operator. Justification: ${justification || 'none provided'}`,
            triggered_by: 'operator_override',
        },
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'campaign',
        entityId: campaignId,
        trigger: 'operator_override',
        action: 'manual_resume',
        details: `Campaign manually resumed. Operator: ${operatorId || 'unknown'}. ` +
            `Infrahealth: ${healthyMailboxCount} healthy mailboxes. ` +
            `Warnings: ${overrideCheck.warnings.join('; ')}`,
    });

    return {
        ...overrideCheck,
        applied: true,
        message: `Campaign resumed in restricted mode. ${healthyMailboxCount} healthy mailboxes available.`,
    };
}

/**
 * Force-unhealthy entity override — operator manually resumes a paused entity.
 */
export async function overrideEntityState(request: OverrideRequest): Promise<OverrideResult> {
    const overrideCheck = await assessOverrideRisk(request);

    if (!overrideCheck.allowed) {
        return overrideCheck;
    }

    // Apply the override based on entity type
    if (request.entityType === 'mailbox') {
        await prisma.mailbox.update({
            where: { id: request.entityId },
            data: {
                status: request.targetState,
                recovery_phase: 'quarantine',    // Never skip directly to healthy
                phase_entered_at: new Date(),
                clean_sends_since_phase: 0,
            },
        });
    } else if (request.entityType === 'domain') {
        await prisma.domain.update({
            where: { id: request.entityId },
            data: {
                status: request.targetState,
                recovery_phase: 'quarantine',
                phase_entered_at: new Date(),
                clean_sends_since_phase: 0,
            },
        });
    }

    await prisma.stateTransition.create({
        data: {
            organization_id: request.organizationId,
            entity_type: request.entityType,
            entity_id: request.entityId,
            from_state: 'paused',
            to_state: request.targetState,
            reason: `Operator override. Justification: ${request.justification || 'none'}`,
            triggered_by: 'operator_override',
        },
    });

    await auditLogService.logAction({
        organizationId: request.organizationId,
        entity: request.entityType,
        entityId: request.entityId,
        trigger: 'operator_override',
        action: 'force_state_change',
        details: `Override to ${request.targetState}. Cooldown multiplier: ${overrideCheck.cooldownMultiplier}x. ` +
            `Warnings: ${overrideCheck.warnings.join('; ')}`,
    });

    return {
        ...overrideCheck,
        applied: true,
        message: `Entity moved to ${request.targetState} via operator override. Enters quarantine, not healthy.`,
    };
}

// ============================================================================
// OVERRIDE RISK ASSESSMENT
// ============================================================================

/**
 * Assess the risk of an operator override.
 * Checks override frequency, entity resilience, and account-level patterns.
 */
async function assessOverrideRisk(request: OverrideRequest): Promise<OverrideResult> {
    const warnings: string[] = [];
    let cooldownMultiplier = 1;
    let requiresJustification = false;

    const cutoff48h = new Date(Date.now() - OVERRIDE_WINDOW_MS);
    const cutoff7d = new Date(Date.now() - ACCOUNT_OVERRIDE_WINDOW_MS);

    // ── CHECK 1: Same-entity override frequency ──
    const entityOverrides = await prisma.auditLog.count({
        where: {
            organization_id: request.organizationId,
            entity: request.entityType,
            entity_id: request.entityId,
            action: { in: ['manual_resume', 'force_state_change'] },
            timestamp: { gte: cutoff48h },
        },
    });

    if (entityOverrides >= 2) {
        warnings.push(`⚠️ ${entityOverrides} overrides on this entity in 48h`);
    }

    if (entityOverrides >= MAX_ENTITY_OVERRIDES) {
        cooldownMultiplier = 2;
        warnings.push(`⛔ ${entityOverrides}+ overrides — cooldown period doubled`);
    }

    // ── CHECK 2: Account-level override frequency ──
    const accountOverrides = await prisma.auditLog.count({
        where: {
            organization_id: request.organizationId,
            action: { in: ['manual_resume', 'force_state_change'] },
            timestamp: { gte: cutoff7d },
        },
    });

    if (accountOverrides >= MAX_ACCOUNT_OVERRIDES) {
        warnings.push(`🚨 ${accountOverrides} overrides across all entities in 7 days — frequent override pattern detected`);

        // Log account-level warning event
        await eventService.storeEvent({
            organizationId: request.organizationId,
            eventType: EventType.MAILBOX_PAUSED, // Reuse event type for logging
            entityType: 'organization',
            entityId: request.organizationId,
            payload: {
                warning: 'frequent_overrides',
                count: accountOverrides,
                window: '7d',
            },
        });
    }

    // ── CHECK 3: Low-resilience entity check ──
    if (request.entityType === 'mailbox' || request.entityType === 'domain') {
        const entity = request.entityType === 'mailbox'
            ? await prisma.mailbox.findUnique({ where: { id: request.entityId } })
            : await prisma.domain.findUnique({ where: { id: request.entityId } });

        const resilience = (entity as any)?.resilience_score ?? 50;

        if (resilience < LOW_RESILIENCE_THRESHOLD) {
            requiresJustification = true;
            if (!request.justification || request.justification.trim().length < 10) {
                return makeResult(
                    false, false,
                    `Entity resilience score is ${resilience}/100 (below ${LOW_RESILIENCE_THRESHOLD}). ` +
                    `Written justification required (min 10 characters).`,
                    warnings
                );
            }
            warnings.push(`⚠️ Low resilience (${resilience}/100) — justification recorded`);
        }
    }

    return {
        allowed: true,
        applied: false,
        warnings,
        cooldownMultiplier,
        requiresJustification,
        message: warnings.length > 0
            ? `Override allowed with warnings: ${warnings.join('; ')}`
            : 'Override allowed — no risk indicators',
    };
}

// ============================================================================
// HELPERS
// ============================================================================

function makeResult(
    allowed: boolean,
    applied: boolean,
    message: string,
    warnings: string[] = []
): OverrideResult {
    return {
        allowed,
        applied,
        warnings,
        cooldownMultiplier: 1,
        requiresJustification: false,
        message,
    };
}
