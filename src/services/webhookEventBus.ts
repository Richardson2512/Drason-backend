/**
 * Webhook Event Bus
 *
 * A thin, type-safe layer between the state-machine services and
 * `webhookService.dispatchEvent`. Each emit* function:
 *   1. Maps the domain change → the correct event type from WEBHOOK_EVENTS
 *   2. Builds a consistent payload shape every event of that type uses
 *   3. Fires-and-forgets — never throws, never blocks the caller
 *
 * Why a layer? It keeps payload shapes uniform across the codebase. If
 * `mailbox.paused` should always carry { mailbox_id, mailbox_email,
 * previous_state, reason }, that contract lives here once instead of
 * being re-constructed at every dispatch site.
 *
 * Service files that need to fire events should import only emit*
 * functions from here and never touch dispatchEvent / WEBHOOK_EVENTS
 * directly. That keeps service files free of webhook detail.
 */

import { dispatchEvent, WEBHOOK_EVENTS, type WebhookEventType } from './webhookService';
import { logger } from './observabilityService';

// ────────────────────────────────────────────────────────────────────
// Internal: never-throws wrapper
// ────────────────────────────────────────────────────────────────────

function safeFire(orgId: string, eventType: WebhookEventType, payload: Record<string, unknown>): void {
    dispatchEvent(orgId, eventType, payload).catch(err => {
        logger.error(
            `[WEBHOOK_BUS] dispatchEvent for ${eventType} failed (org=${orgId})`,
            err instanceof Error ? err : new Error(String(err))
        );
    });
}

// ────────────────────────────────────────────────────────────────────
// Mailbox state transitions (entityStateService.transitionMailbox)
// ────────────────────────────────────────────────────────────────────

interface MailboxLite {
    id: string;
    email: string;
}

/**
 * Emit when a mailbox successfully transitions status (HEALTHY ↔ paused/etc.).
 * Maps the new status to either `mailbox.paused` or `mailbox.healed`.
 *
 * Phase transitions (quarantine/restricted_send/warm_recovery) come from
 * `emitMailboxPhaseChange` instead — those fire from healingService.
 */
export function emitMailboxStateChange(
    orgId: string,
    mailbox: MailboxLite,
    fromState: string,
    toState: string,
    reason: string,
): void {
    let eventType: WebhookEventType | null = null;

    if (toState === 'paused' && fromState !== 'paused') {
        eventType = 'mailbox.paused';
    } else if ((toState === 'healthy' || toState === 'active') && fromState !== 'healthy' && fromState !== 'active') {
        eventType = 'mailbox.healed';
    }

    if (!eventType) return;

    safeFire(orgId, eventType, {
        mailbox_id: mailbox.id,
        mailbox_email: mailbox.email,
        previous_state: fromState,
        new_state: toState,
        reason,
    });
}

// ────────────────────────────────────────────────────────────────────
// Mailbox phase transitions (healingService.transitionPhase)
// ────────────────────────────────────────────────────────────────────

const PHASE_TO_EVENT: Record<string, WebhookEventType | null> = {
    quarantine: 'mailbox.entered_quarantine',
    restricted_send: 'mailbox.entered_restricted_send',
    warm_recovery: 'mailbox.entered_warm_recovery',
    healthy: 'mailbox.healed',
    paused: null,    // covered by emitMailboxStateChange
    warning: null,   // not webhook-worthy on its own
};

export function emitMailboxPhaseChange(
    orgId: string,
    mailbox: MailboxLite,
    fromPhase: string,
    toPhase: string,
    reason: string,
): void {
    const eventType = PHASE_TO_EVENT[toPhase];
    if (!eventType) return;

    safeFire(orgId, eventType, {
        mailbox_id: mailbox.id,
        mailbox_email: mailbox.email,
        previous_phase: fromPhase,
        new_phase: toPhase,
        reason,
    });
}

// ────────────────────────────────────────────────────────────────────
// Domain transitions
// ────────────────────────────────────────────────────────────────────

interface DomainLite {
    id: string;
    domain: string;
}

export function emitDomainStateChange(
    orgId: string,
    domain: DomainLite,
    fromState: string,
    toState: string,
    reason: string,
): void {
    // Domain status transitions don't all map to webhook events — only
    // dnsbl listing/clearing and DNS failures do. The state change itself
    // is intentionally a no-op here unless those specific reasons apply.
    if (/dnsbl/i.test(reason) && /list/i.test(reason)) {
        safeFire(orgId, 'domain.dnsbl_listed', {
            domain_id: domain.id,
            domain: domain.domain,
            previous_state: fromState,
            new_state: toState,
            reason,
        });
    } else if (/dnsbl/i.test(reason) && /clear/i.test(reason)) {
        safeFire(orgId, 'domain.dnsbl_cleared', {
            domain_id: domain.id,
            domain: domain.domain,
            previous_state: fromState,
            new_state: toState,
            reason,
        });
    } else if (/spf|dkim|dmarc|dns/i.test(reason) && (toState === 'paused' || toState === 'warning')) {
        safeFire(orgId, 'domain.dns_failed', {
            domain_id: domain.id,
            domain: domain.domain,
            previous_state: fromState,
            new_state: toState,
            reason,
        });
    }
    // Other domain transitions (e.g. healthy → warning for bounce) are
    // covered by mailbox-level events; no domain-level webhook required.
}

/**
 * Direct DNSBL events when bypass-paths emit them (e.g. dnsblService finds
 * a fresh listing without going through the entity state machine).
 */
export function emitDomainDnsblListed(orgId: string, domain: DomainLite, lists: string[]): void {
    safeFire(orgId, 'domain.dnsbl_listed', {
        domain_id: domain.id,
        domain: domain.domain,
        listed_on: lists,
    });
}

export function emitDomainDnsblCleared(orgId: string, domain: DomainLite, clearedFrom: string[]): void {
    safeFire(orgId, 'domain.dnsbl_cleared', {
        domain_id: domain.id,
        domain: domain.domain,
        cleared_from: clearedFrom,
    });
}

// ────────────────────────────────────────────────────────────────────
// Lead transitions
// ────────────────────────────────────────────────────────────────────

interface LeadLite {
    id: string;
    email: string;
    persona?: string | null;
    company?: string | null;
}

export function emitLeadCreated(orgId: string, lead: LeadLite, source: string): void {
    safeFire(orgId, 'lead.created', {
        lead_id: lead.id,
        email: lead.email,
        persona: lead.persona,
        company: lead.company,
        source,
    });
}

export function emitLeadValidated(orgId: string, lead: LeadLite, validation: { status: string; score: number; is_catch_all: boolean; is_disposable: boolean }): void {
    safeFire(orgId, 'lead.validated', {
        lead_id: lead.id,
        email: lead.email,
        validation_status: validation.status,
        validation_score: validation.score,
        is_catch_all: validation.is_catch_all,
        is_disposable: validation.is_disposable,
    });
}

export function emitLeadHealthChanged(orgId: string, lead: LeadLite, fromClassification: string, toClassification: string): void {
    safeFire(orgId, 'lead.health_changed', {
        lead_id: lead.id,
        email: lead.email,
        previous_classification: fromClassification,
        new_classification: toClassification,
    });
}

// ────────────────────────────────────────────────────────────────────
// Campaign transitions
// ────────────────────────────────────────────────────────────────────

interface CampaignLite {
    id: string;
    name: string;
}

export function emitCampaignLaunched(orgId: string, campaign: CampaignLite, totals: { leads: number; steps: number }): void {
    safeFire(orgId, 'campaign.launched', {
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        total_leads: totals.leads,
        total_steps: totals.steps,
    });
}

export function emitCampaignPaused(orgId: string, campaign: CampaignLite, reason: string): void {
    safeFire(orgId, 'campaign.paused', {
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        reason,
    });
}

export function emitCampaignCompleted(orgId: string, campaign: CampaignLite, totals: { sent: number; replied: number; bounced: number }): void {
    safeFire(orgId, 'campaign.completed', {
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        total_sent: totals.sent,
        total_replied: totals.replied,
        total_bounced: totals.bounced,
    });
}

// ────────────────────────────────────────────────────────────────────
// Send + engagement events
// ────────────────────────────────────────────────────────────────────

interface SendContext extends Record<string, unknown> {
    campaign_id?: string | null;
    mailbox_id?: string | null;
    mailbox_email?: string | null;
    recipient_email: string;
    lead_id?: string | null;
}

export function emitEmailSent(orgId: string, ctx: SendContext, sendId: string): void {
    safeFire(orgId, 'email.sent', { ...ctx, send_id: sendId });
}

export function emitEmailBounced(orgId: string, ctx: SendContext, bounce: { type: string; smtp_response?: string | null }): void {
    safeFire(orgId, 'email.bounced', { ...ctx, bounce_type: bounce.type, smtp_response: bounce.smtp_response });
}

export function emitEmailOpened(orgId: string, ctx: SendContext): void {
    safeFire(orgId, 'email.opened', ctx);
}

export function emitEmailClicked(orgId: string, ctx: SendContext, link: string): void {
    safeFire(orgId, 'email.clicked', { ...ctx, link });
}

// ────────────────────────────────────────────────────────────────────
// Reply events
// ────────────────────────────────────────────────────────────────────

interface ReplyContext extends Record<string, unknown> {
    thread_id: string;
    campaign_id?: string | null;
    mailbox_id?: string | null;
    mailbox_email?: string | null;
    contact_email: string;
    contact_name?: string | null;
    subject: string;
    snippet?: string | null;
}

export function emitReplyReceived(orgId: string, reply: ReplyContext): void {
    safeFire(orgId, 'reply.received', reply);
    // A reply also implies the lead engaged — fire `lead.replied` so
    // subscribers that only care about lead state machine state changes
    // don't have to listen to both event types.
    safeFire(orgId, 'lead.replied', {
        thread_id: reply.thread_id,
        contact_email: reply.contact_email,
        campaign_id: reply.campaign_id,
    });
}

// ────────────────────────────────────────────────────────────────────
// Re-export the event constants for any callers that need them
// (e.g. the REST endpoint that lists valid event types for the UI).
// ────────────────────────────────────────────────────────────────────

export { WEBHOOK_EVENTS };
