/**
 * Entity State Service — THE SINGLE AUTHORITY for all status changes.
 *
 * RULE: No service, controller, or worker may write `status` on Lead, Mailbox,
 *       or Domain via raw prisma.update(). ALL status changes MUST go through
 *       this service. This guarantees:
 *
 *       1. Every transition is validated against the state machine
 *       2. Every transition is recorded in StateTransition history
 *       3. Every transition is audit-logged
 *       4. Notifications are sent for significant state changes
 *       5. Cooldown logic is enforced for paused entities
 *
 * USAGE:
 *   import { transitionLead, transitionMailbox, transitionDomain } from './entityStateService';
 *
 *   await transitionLead(orgId, leadId, LeadState.ACTIVE, 'Push to Smartlead succeeded', TriggerType.SYSTEM);
 *   await transitionMailbox(orgId, mailboxId, MailboxState.PAUSED, 'Bounce rate exceeded 3%', TriggerType.THRESHOLD_BREACH);
 *
 * If you need to set status on entity CREATION (upsert/create), use setInitialStatus()
 * which bypasses transition validation but still logs the action.
 */

import { prisma } from '../index';
import {
    MailboxState,
    DomainState,
    LeadState,
    EntityType,
    TriggerType,
} from '../types';
import * as stateTransitionService from './stateTransitionService';
import * as auditLogService from './auditLogService';
import { logger } from './observabilityService';
import * as webhookBus from './webhookEventBus';

// ============================================================================
// RE-EXPORT STATE TRANSITION FUNCTIONS AS THE CANONICAL API
// ============================================================================

/**
 * Transition a lead to a new state with full validation, history, and audit.
 * Returns { success, previousState, newState, error? }
 */
export async function transitionLead(
    organizationId: string,
    leadId: string,
    toState: LeadState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
) {
    const result = await stateTransitionService.transitionLead(
        organizationId,
        leadId,
        toState,
        reason,
        triggeredBy
    );

    if (!result.success) {
        logger.warn(`[EntityState] Lead transition DENIED: ${leadId} → ${toState}`, {
            organizationId,
            error: result.error,
            previousState: result.previousState,
        });
    }

    return result;
}

/**
 * Transition a mailbox to a new state with full validation, history, and audit.
 * Returns { success, previousState, newState, error? }
 */
export async function transitionMailbox(
    organizationId: string,
    mailboxId: string,
    toState: MailboxState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
) {
    const result = await stateTransitionService.transitionMailbox(
        organizationId,
        mailboxId,
        toState,
        reason,
        triggeredBy
    );

    if (!result.success) {
        logger.warn(`[EntityState] Mailbox transition DENIED: ${mailboxId} → ${toState}`, {
            organizationId,
            error: result.error,
            previousState: result.previousState,
        });
        return result;
    }

    // Outbound webhook fan-out — fire-and-forget. The bus maps state pairs to
    // the right event type (mailbox.paused / mailbox.healed) and skips when
    // the transition isn't webhook-worthy on its own.
    try {
        const mb = await prisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: { id: true, email: true },
        });
        if (mb) {
            webhookBus.emitMailboxStateChange(
                organizationId,
                mb,
                String(result.previousState ?? ''),
                String(toState),
                reason,
            );
        }
    } catch (err) {
        logger.error('[EntityState] webhook bus emit failed (mailbox)', err instanceof Error ? err : new Error(String(err)));
    }

    return result;
}

/**
 * Transition a domain to a new state with full validation, history, and audit.
 * Returns { success, previousState, newState, error? }
 */
export async function transitionDomain(
    organizationId: string,
    domainId: string,
    toState: DomainState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
) {
    const result = await stateTransitionService.transitionDomain(
        organizationId,
        domainId,
        toState,
        reason,
        triggeredBy
    );

    if (!result.success) {
        logger.warn(`[EntityState] Domain transition DENIED: ${domainId} → ${toState}`, {
            organizationId,
            error: result.error,
            previousState: result.previousState,
        });
        return result;
    }

    // Outbound webhook fan-out for DNSBL / DNS-failure transitions.
    try {
        const dom = await prisma.domain.findUnique({
            where: { id: domainId },
            select: { id: true, domain: true },
        });
        if (dom) {
            webhookBus.emitDomainStateChange(
                organizationId,
                dom,
                String(result.previousState ?? ''),
                String(toState),
                reason,
            );
        }
    } catch (err) {
        logger.error('[EntityState] webhook bus emit failed (domain)', err instanceof Error ? err : new Error(String(err)));
    }

    return result;
}

// ============================================================================
// INITIAL STATE (for entity creation — bypasses transition validation)
// ============================================================================

/**
 * Set/override status bypassing transition validation. Use ONLY in:
 * - Entity creation (no previous state)
 * - Infrastructure assessment (batch reassessment overrides)
 * Still logs to audit trail and state history for traceability.
 */
export async function setInitialLeadStatus(
    organizationId: string,
    leadId: string,
    status: LeadState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
): Promise<void> {
    await prisma.lead.update({
        where: { id: leadId },
        data: { status },
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'lead',
        entityId: leadId,
        trigger: triggeredBy,
        action: `initial_status_${status}`,
        details: reason,
    });

    logger.info(`[EntityState] Lead initial status set: ${leadId} → ${status}`, {
        organizationId,
        reason,
    });
}

export async function setInitialMailboxStatus(
    organizationId: string,
    mailboxId: string,
    status: MailboxState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
): Promise<void> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { status: true }
    });
    const fromState = mailbox?.status || 'unknown';

    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: { status },
    });

    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: 'mailbox',
            entity_id: mailboxId,
            from_state: fromState,
            to_state: status,
            reason,
            triggered_by: triggeredBy,
        }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: triggeredBy,
        action: `set_status_${status}`,
        details: reason,
    });

    logger.info(`[EntityState] Mailbox status set: ${mailboxId} ${fromState} → ${status}`, {
        organizationId,
        reason,
    });
}

export async function setInitialDomainStatus(
    organizationId: string,
    domainId: string,
    status: DomainState,
    reason: string,
    triggeredBy: TriggerType = TriggerType.SYSTEM
): Promise<void> {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        select: { status: true }
    });
    const fromState = domain?.status || 'unknown';

    await prisma.domain.update({
        where: { id: domainId },
        data: { status },
    });

    await prisma.stateTransition.create({
        data: {
            organization_id: organizationId,
            entity_type: 'domain',
            entity_id: domainId,
            from_state: fromState,
            to_state: status,
            reason,
            triggered_by: triggeredBy,
        }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'domain',
        entityId: domainId,
        trigger: triggeredBy,
        action: `set_status_${status}`,
        details: reason,
    });

    logger.info(`[EntityState] Domain status set: ${domainId} ${fromState} → ${status}`, {
        organizationId,
        reason,
    });
}
