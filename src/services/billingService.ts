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
import { SlackAlertService } from './SlackAlertService';
import { dispatchEmail } from './emailTemplates/dispatcher';
import {
    paymentFailedEmail,
    subscriptionCanceledEmail,
    subscriptionChangedEmail,
    invoicePaidEmail,
    usageThresholdEmail,
} from './emailTemplates/billing';
import { buildFrontendUrl } from './emailTemplates/requesterContext';

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
    emailsValidated: number;     // current billing period
    monthlySends: number;        // rolling 30-day count of SendEvent rows
}

// ============================================================================
// WEBHOOK PROCESSING
// ============================================================================

/**
 * Process a Polar webhook event.
 * Implements idempotency using polar_event_id.
 */
export async function processWebhook(event: WebhookEvent): Promise<void> {
    // Pull the amount Polar charged (cents) and currency. Polar's invoice
    // events have used a few field names across versions; accept the common
    // ones and pick the first non-null match. amount_paid/total → already in
    // cents; amount in dollars (rare) is ignored to avoid unit mistakes.
    const d = event.data || {};
    const amountCents: number | null =
        typeof d.amount_paid === 'number' ? d.amount_paid :
        typeof d.amount_total === 'number' ? d.amount_total :
        typeof d.total === 'number' ? d.total :
        typeof d.amount === 'number' && d.amount >= 100 ? d.amount : // heuristic: cents not dollars
        null;
    const currency: string | null =
        typeof d.currency === 'string' ? d.currency.toUpperCase() :
        typeof d.currency_code === 'string' ? d.currency_code.toUpperCase() :
        null;

    // Polar's hosted invoice link — the legally-relevant document. Polar uses
    // a few field names across versions; accept the common ones. Falls back
    // to the rendered PDF in our app if none are present.
    const polarInvoiceUrl: string | null =
        typeof d.hosted_invoice_url === 'string' ? d.hosted_invoice_url :
        typeof d.invoice_url === 'string' ? d.invoice_url :
        typeof d.invoice_pdf === 'string' ? d.invoice_pdf :
        typeof d.pdf_url === 'string' ? d.pdf_url :
        null;
    const polarInvoiceNumber: string | null =
        typeof d.invoice_number === 'string' ? d.invoice_number :
        typeof d.number === 'string' ? d.number :
        null;

    // Idempotency check + record in a single transaction to prevent race conditions
    try {
        await prisma.subscriptionEvent.create({
            data: {
                organization_id: event.data?.metadata?.organization_id || 'unknown',
                event_type: event.type,
                polar_event_id: event.id,
                new_tier: event.data?.metadata?.tier || null,
                amount_cents: amountCents,
                currency: currency || 'USD',
                polar_invoice_url: polarInvoiceUrl,
                polar_invoice_number: polarInvoiceNumber,
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

    // Email notification — only when the tier actually changed (Polar
    // sends "updated" events for many things; we don't want to spam on
    // every webhook). Idempotency keys on the (subscription, tier-pair)
    // so a duplicate webhook delivery dedupes.
    if (previousTier !== newTier) {
        const direction: 'upgrade' | 'downgrade' = isUpgrade(previousTier, newTier) ? 'upgrade' : 'downgrade';
        const orgRow = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { name: true },
        });
        void dispatchEmail({
            rendered: subscriptionChangedEmail({
                organizationName: orgRow?.name || 'Your account',
                fromTier: previousTier,
                toTier: newTier,
                direction,
                effectiveAt: new Date(),
                billingUrl: buildFrontendUrl('/dashboard/billing'),
            }),
            audience: { kind: 'org-admins', organizationId: orgId },
            category: 'billing',
            eventKind: 'subscription_changed',
            idempotencyKey: `sub-changed:${subscriptionId}:${previousTier}->${newTier}`,
        });
    }
}

/**
 * Heuristic ordering of tiers — used to label changes as upgrade vs
 * downgrade for copy purposes only. Unknown tiers fall through as
 * downgrade since that's the more cautious framing.
 */
function isUpgrade(from: string, to: string): boolean {
    const order: Record<string, number> = {
        free: 0,
        trial: 1,
        starter: 2,
        pro: 3,
        growth: 4,
        scale: 5,
    };
    return (order[to] ?? 0) > (order[from] ?? 0);
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

    SlackAlertService.sendAlert({
        organizationId: orgId,
        eventType: 'billing.subscription_canceled',
        entityId: subscriptionId,
        severity: 'warning',
        title: '🛑 Subscription canceled',
        message: `Your Superkabe subscription has been canceled. Access continues until the end of your billing period.`,
    }).catch((err) => logger.warn('[BILLING] Slack alert failed (subscription_canceled)', { error: err?.message }));

    // Email all org admins. Active-until is the period_end from Polar so
    // the customer knows exactly when service stops.
    const orgForCancel = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, next_billing_date: true },
    });
    const activeUntil = orgForCancel?.next_billing_date || new Date(event.data.current_period_end || Date.now());
    void dispatchEmail({
        rendered: subscriptionCanceledEmail({
            organizationName: orgForCancel?.name || 'Your account',
            activeUntil,
            reason: event.data.reason || null,
            billingUrl: buildFrontendUrl('/dashboard/billing'),
        }),
        audience: { kind: 'org-admins', organizationId: orgId },
        category: 'billing',
        eventKind: 'subscription_canceled',
        idempotencyKey: `sub-canceled:${subscriptionId}`,
    });
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

    // Receipt email. Polar's webhook may include a hosted-invoice URL —
    // surface it as the CTA when present so the customer can pull a PDF.
    const orgForReceipt = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, next_billing_date: true },
    });
    const amountCents = Number(event.data.amount_paid || event.data.amount || 0);
    const currency = String(event.data.currency || 'USD').toUpperCase();
    const amountLabel = amountCents > 0
        ? `${(amountCents / 100).toFixed(2)} ${currency}`
        : 'Payment received';
    void dispatchEmail({
        rendered: invoicePaidEmail({
            organizationName: orgForReceipt?.name || 'Your account',
            invoiceId: String(event.data.id || event.data.invoice_id || event.id),
            amountLabel,
            paidAt: new Date(event.data.paid_at || event.created_at || Date.now()),
            nextBillingDate: orgForReceipt?.next_billing_date || null,
            receiptUrl: event.data.hosted_invoice_url || event.data.receipt_url || null,
            billingUrl: buildFrontendUrl('/dashboard/billing'),
        }),
        audience: { kind: 'org-admins', organizationId: orgId },
        category: 'billing',
        eventKind: 'invoice_paid',
        idempotencyKey: `invoice-paid:${event.data.id || event.id}`,
    });
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

    SlackAlertService.sendAlert({
        organizationId: orgId,
        eventType: 'billing.payment_failed',
        entityId: subscription_id,
        severity: 'critical',
        title: '💳 Payment failed',
        message: `Superkabe could not charge your card. Update your payment method to avoid service interruption — account is now in past-due state.`,
    }).catch((err) => logger.warn('[BILLING] Slack alert failed (payment_failed)', { error: err?.message }));

    // Critical email to org admins — they need to act before the next
    // retry cycle exhausts.
    const orgForFailure = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
    });
    const failedAmountCents = Number(event.data.amount_due || event.data.amount || 0);
    const failedCurrency = String(event.data.currency || 'USD').toUpperCase();
    void dispatchEmail({
        rendered: paymentFailedEmail({
            organizationName: orgForFailure?.name || 'Your account',
            attemptId: event.data.id || event.data.invoice_id || null,
            amountLabel: failedAmountCents > 0 ? `${(failedAmountCents / 100).toFixed(2)} ${failedCurrency}` : null,
            nextRetryAt: event.data.next_payment_attempt ? new Date(event.data.next_payment_attempt) : null,
            billingUrl: buildFrontendUrl('/dashboard/billing'),
        }),
        audience: { kind: 'org-admins', organizationId: orgId },
        category: 'billing',
        eventKind: 'payment_failed',
        // Per-attempt key: each new retry that fails sends a fresh email,
        // but a duplicate webhook delivery for the same attempt dedupes.
        idempotencyKey: `payment-failed:${event.data.id || subscription_id}:${event.created_at}`,
    });
}

// ============================================================================
// USAGE TRACKING
// ============================================================================

/**
 * Refresh usage counts for an organization. Two meters today: validation
 * credits (rolling 30 days) and monthly sends (rolling 30 days). Lead/domain/
 * mailbox counters were dropped 2026-04-27 — protection is unmetered.
 */
export async function refreshUsageCounts(orgId: string): Promise<UsageCounts> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [emailsValidated, monthlySends] = await Promise.all([
        prisma.validationAttempt.count({
            where: { organization_id: orgId, created_at: { gte: thirtyDaysAgo } },
        }),
        prisma.sendEvent.count({
            where: { organization_id: orgId, sent_at: { gte: thirtyDaysAgo } },
        }),
    ]);

    await prisma.organization.update({
        where: { id: orgId },
        data: { usage_last_updated_at: new Date() },
    });

    // Threshold notifications — fire once per (org, period, threshold)
    // band. The dispatcher's idempotency-key gives us per-band dedup, and
    // the period anchor (next_billing_date) rolls over naturally so the
    // band re-arms on a fresh billing cycle.
    void evaluateUsageThresholds(orgId, { emailsValidated, monthlySends }).catch((err) => {
        logger.warn('[BILLING] usage-threshold evaluation failed', { orgId, error: err?.message });
    });

    return { emailsValidated, monthlySends };
}

/**
 * Picks the highest band (80, 90, or 100) the org has crossed for either
 * sends or validations and sends a notification, idempotent per period.
 */
async function evaluateUsageThresholds(orgId: string, usage: UsageCounts): Promise<void> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, subscription_tier: true, next_billing_date: true },
    });
    if (!org) return;

    const limits = TIER_LIMITS[org.subscription_tier];
    if (!limits) return;

    // Period anchor — rolls over each billing cycle. Falls back to a
    // 30-day calendar bucket so trial / unbilled orgs still get
    // sensible thresholds.
    const periodAnchor = org.next_billing_date
        ? org.next_billing_date.toISOString().slice(0, 10)
        : `30d-${Math.floor(Date.now() / (30 * 24 * 60 * 60 * 1000))}`;

    const sendsLimit = (limits as any).monthly_sends ?? (limits as any).sends ?? 0;
    const validationsLimit = (limits as any).monthly_validations ?? (limits as any).validations ?? 0;

    const sendsBand = bandFor(usage.monthlySends, sendsLimit);
    const validationsBand = bandFor(usage.emailsValidated, validationsLimit);

    if (sendsBand && sendsLimit > 0) {
        void dispatchEmail({
            rendered: usageThresholdEmail({
                organizationName: org.name,
                metric: 'sends',
                percentUsed: sendsBand,
                used: usage.monthlySends,
                limit: sendsLimit,
                resetsAt: org.next_billing_date,
                billingUrl: buildFrontendUrl('/dashboard/billing'),
            }),
            audience: { kind: 'org-admins', organizationId: orgId },
            category: 'billing',
            eventKind: 'usage_threshold',
            idempotencyKey: `usage:${orgId}:${periodAnchor}:sends:${sendsBand}`,
        });
    }
    if (validationsBand && validationsLimit > 0) {
        void dispatchEmail({
            rendered: usageThresholdEmail({
                organizationName: org.name,
                metric: 'validations',
                percentUsed: validationsBand,
                used: usage.emailsValidated,
                limit: validationsLimit,
                resetsAt: org.next_billing_date,
                billingUrl: buildFrontendUrl('/dashboard/billing'),
            }),
            audience: { kind: 'org-admins', organizationId: orgId },
            category: 'billing',
            eventKind: 'usage_threshold',
            idempotencyKey: `usage:${orgId}:${periodAnchor}:validations:${validationsBand}`,
        });
    }
}

/** Returns the highest crossed band (80, 90, 100) or null. */
function bandFor(used: number, limit: number): 80 | 90 | 100 | null {
    if (limit <= 0) return null;
    const pct = (used / limit) * 100;
    if (pct >= 100) return 100;
    if (pct >= 90) return 90;
    if (pct >= 80) return 80;
    return null;
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
        select: { subscription_tier: true },
    });

    if (!org) {
        throw new Error(`Organization not found: ${orgId}`);
    }

    const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;
    const usage = await refreshUsageCounts(orgId);

    return { usage, limits, tier: org.subscription_tier };
}
