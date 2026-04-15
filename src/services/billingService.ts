/**
 * Billing Service
 *
 * Handles subscription lifecycle, webhook processing, and usage tracking.
 * Implements idempotent webhook processing and usage-based feature gates.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as notificationService from './notificationService';
import * as auditLogService from './auditLogService';
import { TIER_LIMITS } from './polarClient';

// ============================================================================
// TYPES
// ============================================================================

export interface WebhookEvent {
    id: string;
    type: string;
    data: any;
    created_at: string;
}

export interface UsageCounts {
    leads: number;
    domains: number;
    mailboxes: number;
    emailsValidated: number;
}

// ============================================================================
// WEBHOOK PROCESSING
// ============================================================================

/**
 * Process a Polar webhook event.
 * Implements idempotency using polar_event_id.
 */
export async function processWebhook(event: WebhookEvent): Promise<void> {
    // Idempotency check + record in a single transaction to prevent race conditions
    try {
        await prisma.subscriptionEvent.create({
            data: {
                organization_id: event.data?.metadata?.organization_id || 'unknown',
                event_type: event.type,
                polar_event_id: event.id,
                new_tier: event.data?.metadata?.tier || null,
                payload: event.data
            }
        });
    } catch (err: unknown) {
        // Unique constraint violation = duplicate event, safe to skip
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'P2002') {
            logger.info('[BILLING] Duplicate webhook event, skipping', { eventId: event.id });
            return;
        }
        throw err;
    }

    // Process based on event type
    switch (event.type) {
        case 'subscription.created':
            await handleSubscriptionCreated(event);
            break;
        case 'subscription.updated':
            await handleSubscriptionUpdated(event);
            break;
        case 'subscription.canceled':
            await handleSubscriptionCanceled(event);
            break;
        case 'invoice.paid':
            await handleInvoicePaid(event);
            break;
        case 'invoice.payment_failed':
            await handlePaymentFailed(event);
            break;
        default:
            logger.warn('[BILLING] Unknown webhook event type', { type: event.type });
    }

    logger.info('[BILLING] Webhook processed successfully', { eventType: event.type, eventId: event.id });
}

// ============================================================================
// WEBHOOK HANDLERS
// ============================================================================

/**
 * Handle subscription.created event.
 * Activates subscription and ends trial.
 */
async function handleSubscriptionCreated(event: WebhookEvent): Promise<void> {
    const { customer_id, id: subscriptionId, metadata } = event.data;
    const orgId = metadata.organization_id;

    if (!orgId) {
        throw new Error('Missing organization_id in webhook metadata');
    }

    const validTiers = ['trial', 'starter', 'growth', 'scale', 'enterprise'];
    const tier = validTiers.includes(metadata.tier) ? metadata.tier : 'starter';

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            subscription_tier: tier,
            subscription_status: 'active',
            polar_subscription_id: subscriptionId,
            subscription_started_at: new Date(),
            trial_ends_at: new Date(), // End trial immediately
            next_billing_date: new Date(event.data.current_period_end)
        }
    });

    // Event already recorded in processWebhook() for idempotency

    // Audit log
    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'subscription',
        entityId: subscriptionId,
        trigger: 'polar_webhook',
        action: 'activated',
        details: `Subscription activated: ${tier}`
    });

    // Notify user
    await notificationService.createNotification(orgId, {
        type: 'SUCCESS',
        title: 'Subscription Activated',
        message: `Your ${tier} subscription is now active. Welcome to Superkabe!`
    });

    logger.info('[BILLING] Subscription created', { orgId, tier, subscriptionId });
}

/**
 * Handle subscription.updated event.
 * Updates tier and billing information.
 */
async function handleSubscriptionUpdated(event: WebhookEvent): Promise<void> {
    const { id: subscriptionId, metadata } = event.data;
    const orgId = metadata.organization_id;

    if (!orgId) {
        throw new Error('Missing organization_id in webhook metadata');
    }

    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { subscription_tier: true }
    });

    const previousTier = org?.subscription_tier || 'unknown';
    const newTier = metadata.tier || previousTier;

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            subscription_tier: newTier,
            next_billing_date: new Date(event.data.current_period_end)
        }
    });

    // Event already recorded in processWebhook() for idempotency

    // Audit log
    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'subscription',
        entityId: subscriptionId,
        trigger: 'polar_webhook',
        action: 'updated',
        details: `Subscription updated: ${previousTier} → ${newTier}`
    });

    logger.info('[BILLING] Subscription updated', { orgId, previousTier, newTier });
}

/**
 * Handle subscription.canceled event.
 * Marks subscription as canceled.
 */
async function handleSubscriptionCanceled(event: WebhookEvent): Promise<void> {
    const { id: subscriptionId, metadata } = event.data;
    const orgId = metadata.organization_id;

    if (!orgId) {
        throw new Error('Missing organization_id in webhook metadata');
    }

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            subscription_status: 'canceled',
            polar_subscription_id: null
        }
    });

    // Event already recorded in processWebhook() for idempotency

    // Audit log
    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'subscription',
        entityId: subscriptionId,
        trigger: 'polar_webhook',
        action: 'canceled',
        details: 'Subscription canceled'
    });

    // Notify user
    await notificationService.createNotification(orgId, {
        type: 'WARNING',
        title: 'Subscription Canceled',
        message: 'Your subscription has been canceled. Access will continue until the end of your billing period.'
    });

    logger.info('[BILLING] Subscription canceled', { orgId, subscriptionId });
}

/**
 * Handle invoice.paid event.
 * Updates billing date.
 */
async function handleInvoicePaid(event: WebhookEvent): Promise<void> {
    const { subscription_id, metadata } = event.data;
    const orgId = metadata.organization_id;

    if (!orgId) {
        return; // Not all invoices have metadata
    }

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            next_billing_date: new Date(event.data.period_end)
        }
    });

    // Event already recorded in processWebhook() for idempotency

    logger.info('[BILLING] Invoice paid', { orgId, subscriptionId: subscription_id });
}

/**
 * Handle invoice.payment_failed event.
 * Sets status to past_due with 7-day grace period.
 */
async function handlePaymentFailed(event: WebhookEvent): Promise<void> {
    const { subscription_id, metadata } = event.data;
    const orgId = metadata.organization_id;

    if (!orgId) {
        throw new Error('Missing organization_id in webhook metadata');
    }

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            subscription_status: 'past_due'
        }
    });

    // Event already recorded in processWebhook() for idempotency

    // Audit log
    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'subscription',
        entityId: subscription_id,
        trigger: 'polar_webhook',
        action: 'payment_failed',
        details: 'Payment failed - subscription past due'
    });

    // Notify user
    await notificationService.createNotification(orgId, {
        type: 'ERROR',
        title: 'Payment Failed',
        message: 'Your payment failed. Please update your payment method to avoid service interruption.'
    });

    logger.warn('[BILLING] Payment failed', { orgId, subscriptionId: subscription_id });
}

// ============================================================================
// USAGE TRACKING
// ============================================================================

/**
 * Refresh usage counts for an organization.
 * Called periodically or after significant changes.
 */
export async function refreshUsageCounts(orgId: string): Promise<UsageCounts> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            current_lead_count: true,
            current_domain_count: true,
            current_mailbox_count: true
        }
    });

    const [leadCount, domainCount, mailboxCount, emailsValidatedCount] = await Promise.all([
        prisma.lead.count({
            where: {
                organization_id: orgId,
                status: { in: ['held', 'active', 'paused'] }
            }
        }),
        prisma.domain.count({ where: { organization_id: orgId } }),
        prisma.mailbox.count({ where: { organization_id: orgId } }),
        prisma.validationAttempt.count({ where: { organization_id: orgId } })
    ]);

    // Use a high-water mark approach so usage doesn't drop when data is purged or API keys are removed
    const maxLeadCount = Math.max(org?.current_lead_count || 0, leadCount);
    const maxDomainCount = Math.max(org?.current_domain_count || 0, domainCount);
    const maxMailboxCount = Math.max(org?.current_mailbox_count || 0, mailboxCount);

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            current_lead_count: maxLeadCount,
            current_domain_count: maxDomainCount,
            current_mailbox_count: maxMailboxCount,
            usage_last_updated_at: new Date()
        }
    });

    return { leads: maxLeadCount, domains: maxDomainCount, mailboxes: maxMailboxCount, emailsValidated: emailsValidatedCount };
}

/**
 * Get current usage and limits for an organization.
 */
export async function getUsageAndLimits(orgId: string): Promise<{
    usage: UsageCounts;
    limits: typeof TIER_LIMITS[string];
    tier: string;
}> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            subscription_tier: true,
            current_lead_count: true,
            current_domain_count: true,
            current_mailbox_count: true
        }
    });

    if (!org) {
        throw new Error(`Organization not found: ${orgId}`);
    }

    const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;

    // ValidationAttempt rows are append-only, so a live count is always accurate
    // (no high-water mark needed — the table never shrinks).
    const emailsValidated = await prisma.validationAttempt.count({
        where: { organization_id: orgId }
    });

    return {
        usage: {
            leads: org.current_lead_count,
            domains: org.current_domain_count,
            mailboxes: org.current_mailbox_count,
            emailsValidated
        },
        limits,
        tier: org.subscription_tier
    };
}
