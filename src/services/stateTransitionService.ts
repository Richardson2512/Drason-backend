/**
 * State Transition Service
 * 
 * Implements explicit state machine transitions with validation, cooldown logic,
 * and full history tracking as per Section 8 of the Infrastructure Audit.
 * 
 * Key principles:
 * - All state transitions must be validated before execution
 * - State history is recorded for audit and debugging
 * - Cooldown periods are enforced for recovering entities
 * - Transitions are atomic and logged
 */

import { prisma } from '../index';
import {
    MailboxState,
    DomainState,
    LeadState,
    EntityType,
    TriggerType,
    STATE_TRANSITIONS,
    MONITORING_THRESHOLDS
} from '../types';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';
import { logger } from './observabilityService';

// ============================================================================
// TYPES
// ============================================================================

interface TransitionRequest {
    organizationId: string;
    entityType: EntityType;
    entityId: string;
    fromState: string;
    toState: string;
    reason: string;
    triggeredBy: TriggerType;
    metadata?: Record<string, any>;
}

interface TransitionResult {
    success: boolean;
    previousState: string;
    newState: string;
    error?: string;
    cooldownUntil?: Date;
}

interface CooldownInfo {
    isInCooldown: boolean;
    cooldownUntil: Date | null;
    remainingMs: number;
}

// ============================================================================
// STATE VALIDATION
// ============================================================================

/**
 * Validate if a state transition is allowed according to the state machine rules.
 */
export function isValidTransition(
    entityType: 'mailbox' | 'domain' | 'lead',
    fromState: string,
    toState: string
): boolean {
    const transitions = STATE_TRANSITIONS[entityType];
    if (!transitions) {
        logger.error(`[STATE] Unknown entity type: ${entityType}`);
        return false;
    }

    const allowedTransitions = transitions[fromState as keyof typeof transitions];
    if (!allowedTransitions) {
        logger.error(`[STATE] Unknown state ${fromState} for ${entityType}`);
        return false;
    }

    return (allowedTransitions as readonly string[]).includes(toState);
}

/**
 * Get all valid next states for a given entity and current state.
 */
export function getValidNextStates(
    entityType: 'mailbox' | 'domain' | 'lead',
    currentState: string
): string[] {
    const transitions = STATE_TRANSITIONS[entityType];
    if (!transitions) return [];

    const allowedTransitions = transitions[currentState as keyof typeof transitions];
    if (!allowedTransitions) return [];

    return [...allowedTransitions] as string[];
}

// ============================================================================
// COOLDOWN LOGIC
// ============================================================================

/**
 * Calculate cooldown duration based on consecutive pauses.
 * Implements exponential backoff with a minimum cooldown.
 */
export function calculateCooldownDuration(consecutivePauses: number): number {
    const baseCooldown = MONITORING_THRESHOLDS.COOLDOWN_MINIMUM_MS;
    const multiplier = MONITORING_THRESHOLDS.COOLDOWN_MULTIPLIER;

    // Exponential backoff: base * (multiplier ^ consecutivePauses)
    // Cap at 24 hours (86400000 ms)
    const cooldownMs = Math.min(
        baseCooldown * Math.pow(multiplier, consecutivePauses),
        86400000
    );

    return Math.floor(cooldownMs);
}

/**
 * Check if an entity is currently in cooldown.
 */
export async function checkCooldown(
    entityType: EntityType,
    entityId: string
): Promise<CooldownInfo> {
    const now = new Date();

    if (entityType === EntityType.MAILBOX) {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: entityId },
            select: { cooldown_until: true }
        });

        if (mailbox?.cooldown_until && mailbox.cooldown_until > now) {
            return {
                isInCooldown: true,
                cooldownUntil: mailbox.cooldown_until,
                remainingMs: mailbox.cooldown_until.getTime() - now.getTime()
            };
        }
    } else if (entityType === EntityType.DOMAIN) {
        const domain = await prisma.domain.findUnique({
            where: { id: entityId },
            select: { cooldown_until: true }
        });

        if (domain?.cooldown_until && domain.cooldown_until > now) {
            return {
                isInCooldown: true,
                cooldownUntil: domain.cooldown_until,
                remainingMs: domain.cooldown_until.getTime() - now.getTime()
            };
        }
    }

    return {
        isInCooldown: false,
        cooldownUntil: null,
        remainingMs: 0
    };
}

/**
 * Set cooldown for an entity when entering PAUSED state.
 */
async function setCooldown(
    entityType: EntityType,
    entityId: string,
    cooldownMs: number
): Promise<Date> {
    const cooldownUntil = new Date(Date.now() + cooldownMs);

    if (entityType === EntityType.MAILBOX) {
        await prisma.mailbox.update({
            where: { id: entityId },
            data: {
                cooldown_until: cooldownUntil,
                last_pause_at: new Date(),
                consecutive_pauses: { increment: 1 }
            }
        });
    } else if (entityType === EntityType.DOMAIN) {
        await prisma.domain.update({
            where: { id: entityId },
            data: {
                cooldown_until: cooldownUntil,
                last_pause_at: new Date(),
                consecutive_pauses: { increment: 1 }
            }
        });
    }

    return cooldownUntil;
}

/**
 * Clear cooldown and reset consecutive pauses when fully recovered.
 */
async function clearCooldown(
    entityType: EntityType,
    entityId: string
): Promise<void> {
    if (entityType === EntityType.MAILBOX) {
        await prisma.mailbox.update({
            where: { id: entityId },
            data: {
                cooldown_until: null,
                consecutive_pauses: 0
            }
        });
    } else if (entityType === EntityType.DOMAIN) {
        await prisma.domain.update({
            where: { id: entityId },
            data: {
                cooldown_until: null,
                consecutive_pauses: 0
            }
        });
    }
}

// ============================================================================
// STATE TRANSITIONS
// ============================================================================

/**
 * Execute a state transition with full validation and history tracking.
 */
export async function executeTransition(
    request: TransitionRequest
): Promise<TransitionResult> {
    const {
        organizationId,
        entityType,
        entityId,
        fromState,
        toState,
        reason,
        triggeredBy,
        metadata
    } = request;

    const entityTypeName = entityType.toLowerCase() as 'mailbox' | 'domain' | 'lead';

    // 1. Validate the transition is allowed
    if (!isValidTransition(entityTypeName, fromState, toState)) {
        logger.info(`[STATE] Invalid transition: ${entityTypeName} ${entityId} ${fromState} -> ${toState}`);
        return {
            success: false,
            previousState: fromState,
            newState: fromState,
            error: `Invalid transition from ${fromState} to ${toState} for ${entityTypeName}`
        };
    }

    // 2. Check cooldown for recovering entities
    if (toState === MailboxState.RECOVERING || toState === DomainState.RECOVERING) {
        const cooldownInfo = await checkCooldown(entityType, entityId);
        if (cooldownInfo.isInCooldown) {
            logger.info(`[STATE] Entity ${entityId} is in cooldown until ${cooldownInfo.cooldownUntil}`);
            return {
                success: false,
                previousState: fromState,
                newState: fromState,
                error: `Entity is in cooldown for ${Math.floor(cooldownInfo.remainingMs / 1000)}s`,
                cooldownUntil: cooldownInfo.cooldownUntil!
            };
        }
    }

    try {
        // 3. Update entity state
        await updateEntityState(entityType, entityId, toState);

        // 4. Handle cooldown logic
        let cooldownUntil: Date | undefined;
        if (toState === MailboxState.PAUSED || toState === DomainState.PAUSED) {
            // Get consecutive pauses for exponential backoff
            const consecutivePauses = await getConsecutivePauses(entityType, entityId);
            const cooldownMs = calculateCooldownDuration(consecutivePauses);
            cooldownUntil = await setCooldown(entityType, entityId, cooldownMs);
            logger.info(`[STATE] Set cooldown for ${entityId}: ${cooldownMs}ms (until ${cooldownUntil})`);
        } else if (toState === MailboxState.HEALTHY || toState === DomainState.HEALTHY) {
            // Clear cooldown when fully recovered
            await clearCooldown(entityType, entityId);
            logger.info(`[STATE] Cleared cooldown for ${entityId}`);
        }

        // 5. Record state transition in history
        await recordTransition(
            organizationId,
            entityTypeName,
            entityId,
            fromState,
            toState,
            reason,
            triggeredBy
        );

        // 6. Log to audit trail
        await auditLogService.logAction({
            organizationId,
            entity: entityTypeName,
            entityId,
            trigger: triggeredBy,
            action: `state_transition_${fromState}_to_${toState}`,
            details: JSON.stringify({ reason, metadata })
        });

        logger.info(`[STATE] Transition complete: ${entityTypeName} ${entityId} ${fromState} -> ${toState}`);

        // Notify user of significant state transitions
        try {
            if (toState === MailboxState.PAUSED || toState === DomainState.PAUSED) {
                await notificationService.createNotification(organizationId, {
                    type: 'ERROR',
                    title: `${entityTypeName === 'mailbox' ? 'Mailbox' : 'Domain'} Paused`,
                    message: `A ${entityTypeName} has been paused due to health issues. Reason: ${reason}`,
                });
            } else if (toState === MailboxState.HEALTHY || toState === DomainState.HEALTHY) {
                await notificationService.createNotification(organizationId, {
                    type: 'SUCCESS',
                    title: `${entityTypeName === 'mailbox' ? 'Mailbox' : 'Domain'} Recovered`,
                    message: `A ${entityTypeName} has fully recovered and is now healthy.`,
                });
            }
        } catch (notifError) {
            logger.warn('Failed to create state transition notification', { entityId });
        }

        return {
            success: true,
            previousState: fromState,
            newState: toState,
            cooldownUntil
        };
    } catch (error) {
        logger.error(`[STATE] Transition failed:`, error as Error);
        return {
            success: false,
            previousState: fromState,
            newState: fromState,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Update entity state in the database.
 */
async function updateEntityState(
    entityType: EntityType,
    entityId: string,
    newState: string
): Promise<void> {
    switch (entityType) {
        case EntityType.MAILBOX:
            await prisma.mailbox.update({
                where: { id: entityId },
                data: { status: newState }
            });
            break;
        case EntityType.DOMAIN:
            await prisma.domain.update({
                where: { id: entityId },
                data: { status: newState }
            });
            break;
        case EntityType.LEAD:
            await prisma.lead.update({
                where: { id: entityId },
                data: { status: newState }
            });
            break;
        default:
            throw new Error(`Unknown entity type: ${entityType}`);
    }
}

/**
 * Get consecutive pause count for cooldown calculation.
 */
async function getConsecutivePauses(
    entityType: EntityType,
    entityId: string
): Promise<number> {
    if (entityType === EntityType.MAILBOX) {
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: entityId },
            select: { consecutive_pauses: true }
        });
        return mailbox?.consecutive_pauses || 0;
    } else if (entityType === EntityType.DOMAIN) {
        const domain = await prisma.domain.findUnique({
            where: { id: entityId },
            select: { consecutive_pauses: true }
        });
        return domain?.consecutive_pauses || 0;
    }
    return 0;
}

/**
 * Record a state transition in the history table.
 */
async function recordTransition(
    organizationId: string,
    entityType: string,
    entityId: string,
    fromState: string,
    toState: string,
    reason: string,
    triggeredBy: TriggerType
): Promise<void> {
    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: entityType,
            entity_id: entityId,
            from_state: fromState,
            to_state: toState,
            reason,
            triggered_by: triggeredBy
        }
    });
}

// ============================================================================
// STATE HISTORY
// ============================================================================

/**
 * Get state transition history for an entity.
 */
export async function getStateHistory(
    organizationId: string,
    entityType: string,
    entityId: string,
    limit: number = 50
): Promise<any[]> {
    return prisma.stateTransition.findMany({
        where: {
            organization_id: organizationId,
            entity_type: entityType,
            entity_id: entityId
        },
        orderBy: { created_at: 'desc' },
        take: limit
    });
}

/**
 * Get recent state transitions across all entities for an organization.
 */
export async function getRecentTransitions(
    organizationId: string,
    limit: number = 100
): Promise<any[]> {
    return prisma.stateTransition.findMany({
        where: { organization_id: organizationId },
        orderBy: { created_at: 'desc' },
        take: limit
    });
}

/**
 * Get transition statistics for an entity.
 */
export async function getTransitionStats(
    organizationId: string,
    entityType: string,
    entityId: string
): Promise<{
    totalTransitions: number;
    lastTransition: Date | null;
    pauseCount: number;
    averageRecoveryTimeMs: number;
}> {
    const transitions = await prisma.stateTransition.findMany({
        where: {
            organization_id: organizationId,
            entity_type: entityType,
            entity_id: entityId
        },
        orderBy: { created_at: 'asc' }
    });

    const pauseCount = transitions.filter(t =>
        t.to_state === MailboxState.PAUSED || t.to_state === DomainState.PAUSED
    ).length;

    // Calculate average recovery time
    let totalRecoveryTimeMs = 0;
    let recoveryCount = 0;

    for (let i = 0; i < transitions.length - 1; i++) {
        const current = transitions[i];
        const next = transitions[i + 1];

        if ((current.to_state === MailboxState.PAUSED || current.to_state === DomainState.PAUSED) &&
            (next.to_state === MailboxState.RECOVERING || next.to_state === DomainState.RECOVERING ||
                next.to_state === MailboxState.HEALTHY || next.to_state === DomainState.HEALTHY)) {
            totalRecoveryTimeMs += next.created_at.getTime() - current.created_at.getTime();
            recoveryCount++;
        }
    }

    return {
        totalTransitions: transitions.length,
        lastTransition: transitions.length > 0 ? transitions[transitions.length - 1].created_at : null,
        pauseCount,
        averageRecoveryTimeMs: recoveryCount > 0 ? totalRecoveryTimeMs / recoveryCount : 0
    };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Transition a mailbox to a new state with validation.
 */
export async function transitionMailbox(
    organizationId: string,
    mailboxId: string,
    toState: MailboxState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
): Promise<TransitionResult> {
    // Get current state
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { status: true }
    });

    if (!mailbox) {
        return {
            success: false,
            previousState: 'unknown',
            newState: 'unknown',
            error: 'Mailbox not found'
        };
    }

    return executeTransition({
        organizationId,
        entityType: EntityType.MAILBOX,
        entityId: mailboxId,
        fromState: mailbox.status,
        toState,
        reason,
        triggeredBy
    });
}

/**
 * Transition a domain to a new state with validation.
 */
export async function transitionDomain(
    organizationId: string,
    domainId: string,
    toState: DomainState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
): Promise<TransitionResult> {
    // Get current state
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        select: { status: true }
    });

    if (!domain) {
        return {
            success: false,
            previousState: 'unknown',
            newState: 'unknown',
            error: 'Domain not found'
        };
    }

    return executeTransition({
        organizationId,
        entityType: EntityType.DOMAIN,
        entityId: domainId,
        fromState: domain.status,
        toState,
        reason,
        triggeredBy
    });
}

/**
 * Transition a lead to a new state with validation.
 */
export async function transitionLead(
    organizationId: string,
    leadId: string,
    toState: LeadState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
): Promise<TransitionResult> {
    // Get current state
    const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { status: true }
    });

    if (!lead) {
        return {
            success: false,
            previousState: 'unknown',
            newState: 'unknown',
            error: 'Lead not found'
        };
    }

    return executeTransition({
        organizationId,
        entityType: EntityType.LEAD,
        entityId: leadId,
        fromState: lead.status,
        toState,
        reason,
        triggeredBy
    });
}

/**
 * Check if a mailbox can be recovered (cooldown expired).
 */
export async function canRecoverMailbox(mailboxId: string): Promise<boolean> {
    const cooldownInfo = await checkCooldown(EntityType.MAILBOX, mailboxId);
    return !cooldownInfo.isInCooldown;
}

/**
 * Check if a domain can be recovered (cooldown expired).
 */
export async function canRecoverDomain(domainId: string): Promise<boolean> {
    const cooldownInfo = await checkCooldown(EntityType.DOMAIN, domainId);
    return !cooldownInfo.isInCooldown;
}
