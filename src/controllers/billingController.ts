/**
 * Billing Controller
 *
 * HTTP handlers for billing-related endpoints:
 * - Polar webhook processing
 * - Checkout session creation
 * - Subscription management
 */

import { Request, Response } from 'express';
import path from 'path';
import PDFDocument from 'pdfkit';
import { logger } from '../services/observabilityService';
import * as billingService from '../services/billingService';
import * as polarClient from '../services/polarClient';
import { TIER_LIMITS } from '../services/polarClient';
import { recordConsentFromRequest } from '../services/consentService';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

/**
 * Handle Polar webhook events. Validates signature using Standard Webhooks
 * format and processes events idempotently.
 *
 * Returns 200 on success and on permanent failures (so Polar doesn't retry
 * a malformed event forever), but returns 401 on signature failure and 500
 * on transient infra errors so Polar's retry queue can recover.
 */
export const handlePolarWebhook = async (req: Request, res: Response): Promise<Response> => {
    const eventType = (req.body && (req.body as any).type) || 'unknown';
    const dataId = (req.body && (req.body as any).data && (req.body as any).data.id) || null;
    try {
        const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;
        if (!webhookSecret) {
            logger.error('[BILLING] Missing POLAR_WEBHOOK_SECRET environment variable');
            return res.status(500).json({ success: false, error: 'Webhook secret not configured' });
        }

        // Standard Webhooks: signature is over `${id}.${ts}.${rawBody}`. We
        // need the original bytes — express.json() captures them via
        // verifyRawBody for /api/billing/* and stores on req.rawBody.
        const rawBody = (req as any).rawBody as Buffer | undefined;
        if (!rawBody) {
            logger.error('[BILLING] rawBody missing on Polar webhook — bodyParser misconfigured', undefined, { eventType, dataId });
            return res.status(500).json({ success: false, error: 'Server misconfiguration' });
        }

        const isValid = polarClient.verifyPolarWebhook(rawBody, req.headers as any, webhookSecret);
        if (!isValid) {
            logger.warn('[BILLING] Invalid Polar webhook signature — rejected', { eventType, dataId });
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }

        await billingService.processWebhook(req.body);
        return res.json({ success: true, received: true });
    } catch (error) {
        // Log the actual message — the prior version logged just a prefix
        // and the underlying error never made it to Railway, leaving us
        // blind to root causes for paying customers stuck on trial.
        const errMsg = error instanceof Error ? error.message : String(error);
        const errStack = error instanceof Error ? error.stack : undefined;
        logger.error('[BILLING] Webhook processing failed', error instanceof Error ? error : new Error(errMsg));
        console.error('[BILLING] Webhook error detail', { eventType, dataId, message: errMsg, stack: errStack });
        // 200 with explicit error so Polar marks delivered (we don't want
        // retry storms on permanent errors). Operator needs to watch the
        // detail logs and reconcile manually if needed.
        return res.status(200).json({ success: false, error: 'Processing failed', received: true, message: errMsg });
    }
};

// ============================================================================
// CHECKOUT MANAGEMENT
// ============================================================================

/**
 * Create a Polar checkout session for ANY plan transition — initial
 * subscribe, upgrade, downgrade, or re-subscribe after cancellation.
 *
 * The "every plan change goes through checkout" model. Earlier we had a
 * second path (PATCH /subscriptions via change-plan) that tried to be
 * smart with proration — but that path didn't take a payment, so coupon
 * customers could upgrade themselves to a higher tier without paying.
 * Routing every change through checkout makes coupon/non-coupon and
 * upgrade/downgrade behave identically: customer pays the new tier price,
 * Polar fires subscription.created, our webhook updates the org and
 * cancels the old subscription so they aren't double-billed at renewal.
 */
export const createCheckout = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { tier } = req.body;

        // Defensive — the route's Zod middleware already enforces this,
        // but if a path ever reaches here without that middleware (e.g.
        // future internal calls) we still want a clear error rather than
        // a downstream Polar 4xx.
        const ALLOWED_TIERS = ['starter', 'pro', 'pro_80k', 'pro_100k', 'pro_150k', 'pro_200k', 'pro_250k', 'growth', 'scale'];
        if (!tier || !ALLOWED_TIERS.includes(tier)) {
            return res.status(400).json({ success: false, error: `Invalid tier. Must be one of: ${ALLOWED_TIERS.join(', ')}` });
        }

        const { prisma } = await import('../index');
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { subscription_status: true, subscription_tier: true }
        });
        if (!org) {
            return res.status(404).json({ success: false, error: 'Organization not found' });
        }

        // Block only the no-op case: same tier, already active. Otherwise
        // any state (trialing, active, canceled, past_due) goes to checkout.
        if (org.subscription_status === 'active' && org.subscription_tier === tier) {
            return res.status(400).json({ success: false, error: `You're already on the ${tier} plan.` });
        }

        const checkoutSession = await polarClient.createCheckoutSession(orgId, tier);

        return res.json({
            success: true,
            checkoutUrl: checkoutSession.url,
            checkoutId: checkoutSession.id
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('[BILLING] Checkout creation failed', error instanceof Error ? error : new Error(errMsg));
        return res.status(500).json({ success: false, error: errMsg || 'Failed to create checkout session' });
    }
};

// ============================================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================================

/**
 * Get current subscription status and usage.
 */
export const getSubscriptionStatus = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        // Refresh usage counts
        await billingService.refreshUsageCounts(orgId);

        // Get current status
        const data = await billingService.getUsageAndLimits(orgId);

        // Get organization details
        const { prisma } = await import('../index');
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: {
                subscription_tier: true,
                subscription_status: true,
                trial_started_at: true,
                trial_ends_at: true,
                subscription_started_at: true,
                next_billing_date: true
            }
        });

        return res.json({
            success: true,
            subscription: {
                tier: org?.subscription_tier,
                status: org?.subscription_status,
                trialStartedAt: org?.trial_started_at,
                trialEndsAt: org?.trial_ends_at,
                subscriptionStartedAt: org?.subscription_started_at,
                nextBillingDate: org?.next_billing_date
            },
            usage: data.usage,
            limits: data.limits
        });
    } catch (error) {
        logger.error('[BILLING] Failed to get subscription status', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get subscription status' });
    }
};

/**
 * Cancel current subscription.
 */
/**
 * Cancel the current subscription with explicit data-retention consent.
 *
 * GDPR / DPDP / PDPA: we can't silently retain user data after the paid
 * relationship ends. The body MUST carry data_retention ('keep' | 'delete')
 * — Zod middleware enforces this. Behavior per choice:
 *
 *   keep   — record an affirmative Consent row (audit-grade artifact: who,
 *            when, IP, UA, document version) and proceed with a normal
 *            Polar cancel_at_period_end. Customer keeps full access until
 *            period end; we keep their data for re-subscription afterwards.
 *
 *   delete — record a deletion-request audit log keyed at period end, then
 *            cancel Polar at period end. The existing accountDeletionWorker
 *            picks up the audit row after the grace window and erases.
 *            We do NOT delete now — the customer paid for the period and
 *            should keep using the product until it ends.
 */
export const cancelSubscription = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const userId = req.orgContext?.userId;
        const { data_retention, reason } = req.body as { data_retention: 'keep' | 'delete'; reason?: string };

        if (!userId) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        // Cancel Polar subscription first — if this fails we don't want
        // a stale consent or deletion request lying around with no actual
        // cancellation backing it. Polar takes effect at period end, so
        // the access window is preserved for the customer either way.
        await polarClient.cancelSubscription(orgId);

        // Snapshot user identity now so the consent record stays valid as
        // an audit artifact even if the user row is later erased.
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { email: true, name: true },
        });

        // Record the consent for BOTH choices via the canonical
        // consentService. 'keep' is consent to retain after cancellation;
        // 'delete' is consent to erase. Either way the user made an
        // affirmative privacy decision and we want it on the audit trail.
        await recordConsentFromRequest(req, {
            consentType: 'subscription_cancellation',
            documentVersion: '2026-05-04',
            channel: 'dashboard_billing_cancel',
            userId,
            organizationId: orgId,
            userEmailSnapshot: user?.email || null,
            userNameSnapshot: user?.name || null,
            metadata: {
                choice: data_retention,
                reason: reason || null,
            },
        });

        if (data_retention === 'delete') {
            // Schedule account deletion. We mirror the dataRights flow:
            // an AuditLog row with entity='account_deletion' is the
            // source of truth — accountDeletionWorker scans for these.
            // Idempotent: don't double-schedule if a request already exists.
            const existing = await prisma.auditLog.findFirst({
                where: {
                    organization_id: orgId,
                    entity: 'account_deletion',
                    entity_id: userId,
                    action: 'deletion_requested',
                },
                orderBy: { timestamp: 'desc' },
            });
            if (!existing) {
                await prisma.auditLog.create({
                    data: {
                        organization_id: orgId,
                        entity: 'account_deletion',
                        entity_id: userId,
                        trigger: 'user',
                        action: 'deletion_requested',
                        user_id: userId,
                        details: JSON.stringify({
                            source: 'subscription_cancellation',
                            reason: reason || null,
                            grace_period_days: 30,
                        }),
                    },
                });
            }
        }

        logger.info('[BILLING] Cancellation processed', { orgId, userId, choice: data_retention });

        return res.json({
            success: true,
            data_retention,
            message: data_retention === 'keep'
                ? 'Subscription canceled. Access continues until period end. Your data will be retained for re-subscription.'
                : 'Subscription canceled. Access continues until period end. Your account and all data will be permanently deleted after the 30-day grace period.',
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('[BILLING] Failed to cancel subscription', error instanceof Error ? error : new Error(errMsg));
        return res.status(500).json({ success: false, error: errMsg || 'Failed to cancel subscription' });
    }
};

// ============================================================================
// USAGE TRACKING
// ============================================================================

/**
 * Manually refresh usage counts.
 */
export const refreshUsage = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        const usage = await billingService.refreshUsageCounts(orgId);

        return res.json({ success: true, usage });
    } catch (error) {
        logger.error('[BILLING] Failed to refresh usage', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to refresh usage' });
    }
};

export const getInvoices = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { polar_subscription_id: true, subscription_started_at: true, subscription_tier: true, subscription_status: true }
        });

        if (!org?.polar_subscription_id || org.subscription_status === 'trialing') {
            return res.json({ success: true, invoices: [] });
        }

        // Fallback prices in cents — only used for legacy SubscriptionEvent
        // rows written before we started capturing amount_cents from the
        // Polar payload. New rows always have the real amount.
        const tierFallbackCents: Record<string, number> = {
            starter: 4900,
            pro: 4900,
            growth: 19900,
            scale: 34900,
        };

        // Return subscription events as invoice records
        const events = await prisma.subscriptionEvent.findMany({
            where: { organization_id: orgId, event_type: { in: ['invoice.paid', 'subscription.created', 'subscription.updated'] } },
            orderBy: { created_at: 'desc' },
            take: 20,
        });

        const invoices = events.map(e => {
            const tier = e.new_tier || org.subscription_tier;
            const amount = e.amount_cents ?? tierFallbackCents[tier] ?? 0;
            const currency = (e.currency || 'USD').toLowerCase();
            // Prefer Polar's hosted invoice — it's the legally-relevant
            // document with proper tax handling, invoice number, and refund
            // adjustments. Fall back to our PDFKit-rendered version when
            // Polar didn't send a URL (legacy rows, non-invoice events like
            // subscription.created, or webhook payload variants we missed).
            const url = e.polar_invoice_url || `/api/billing/invoices/${e.id}/pdf`;
            return {
                id: e.id,
                date: e.created_at.toISOString(),
                amount,
                currency,
                number: e.polar_invoice_number || null,
                status: e.event_type === 'invoice.paid' ? 'paid' : 'completed',
                source: e.polar_invoice_url ? 'polar' : 'self',
                url,
            };
        });

        return res.json({ success: true, invoices });
    } catch (error) {
        logger.error('[BILLING] Failed to fetch invoices', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to fetch invoices' });
    }
};

// ============================================================================
// TIER CONFIG
// ============================================================================

/**
 * GET /api/billing/tiers
 * Returns full tier catalog for frontend display (pricing page, billing page, settings).
 * Replaces hardcoded TIER_INFO/TIER_STATS in the frontend.
 */
export const getTiers = async (_req: Request, res: Response): Promise<Response> => {
    const tierMeta: Record<string, { name: string; price: string; priceValue: number; color: string }> = {
        trial:      { name: 'Free Trial', price: '$0',     priceValue: 0,   color: '#6B7280' },
        starter:    { name: 'Starter',    price: '$19',    priceValue: 19,  color: '#3B82F6' },
        pro:        { name: 'Pro',        price: '$49',    priceValue: 49,  color: '#6366F1' },
        pro_80k:    { name: 'Pro — 80K',  price: '$59',    priceValue: 59,  color: '#6366F1' },
        pro_100k:   { name: 'Pro — 100K', price: '$79',    priceValue: 79,  color: '#6366F1' },
        pro_150k:   { name: 'Pro — 150K', price: '$109',   priceValue: 109, color: '#6366F1' },
        pro_200k:   { name: 'Pro — 200K', price: '$139',   priceValue: 139, color: '#6366F1' },
        pro_250k:   { name: 'Pro — 250K', price: '$169',   priceValue: 169, color: '#6366F1' },
        growth:     { name: 'Growth',     price: '$199',   priceValue: 199, color: '#8B5CF6' },
        scale:      { name: 'Scale',      price: '$349',   priceValue: 349, color: '#22C55E' },
        enterprise: { name: 'Enterprise', price: 'Custom', priceValue: 0,   color: '#F59E0B' },
    };

    // Replace Infinity with a JSON-safe sentinel (null) for serialization
    const serialize = (n: number) => n === Infinity ? null : n;

    const tiers = Object.entries(TIER_LIMITS).map(([key, limits]) => ({
        key,
        name: tierMeta[key]?.name || key,
        price: tierMeta[key]?.price || 'Custom',
        priceValue: tierMeta[key]?.priceValue || 0,
        color: tierMeta[key]?.color || '#6B7280',
        limits: {
            validationCredits: serialize(limits.validationCredits),
            monthlySendLimit: serialize(limits.monthlySendLimit),
        },
    }));

    return res.json({ success: true, tiers });
};

// ============================================================================
// PLAN CHANGES (UPGRADE / DOWNGRADE)
// ============================================================================

/**
 * Change subscription plan (upgrade or downgrade).
 *
 * Upgrades: prorated, take effect immediately via Polar.
 * Downgrades: take effect at end of current billing period.
 *
 * For downgrades, validates current usage against new tier limits.
 * If usage exceeds new limits, returns warnings and requires `confirm: true`.
 */
export const changePlan = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { tier, confirm } = req.body;

        // Defensive validation — Zod middleware already accepts the same
        // list. Keep these in sync with SUBSCRIBABLE_TIERS in validation.ts
        // and PRODUCT_IDS in services/polarClient.ts.
        const validTiers = ['starter', 'pro', 'pro_80k', 'pro_100k', 'pro_150k', 'pro_200k', 'pro_250k', 'growth', 'scale'];
        if (!tier || !validTiers.includes(tier)) {
            return res.status(400).json({ success: false, error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });
        }

        // Get org with subscription info
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: {
                subscription_tier: true,
                subscription_status: true,
                polar_subscription_id: true,
            }
        });

        if (!org) {
            return res.status(404).json({ success: false, error: 'Organization not found' });
        }

        // Must have an active subscription to change plan
        if (org.subscription_status !== 'active') {
            return res.status(400).json({
                success: false,
                error: 'No active subscription. Use checkout to subscribe first.'
            });
        }

        // Can't change to same tier
        if (org.subscription_tier === tier) {
            return res.status(400).json({ success: false, error: `Already on the ${tier} plan.` });
        }

        // Plan changes now go through Polar checkout — same flow as the
        // initial purchase. Customer pays the new tier's price, Polar
        // fires subscription.created, our webhook updates the org and
        // cancels the old subscription. No proration weirdness, no card-
        // on-file edge cases, no "free upgrade" exploit for coupon users.
        const checkoutSession = await polarClient.createCheckoutSession(orgId, tier);

        logger.info(`[BILLING] Plan-change checkout created for ${orgId}: ${org.subscription_tier} → ${tier}`, {
            checkoutId: checkoutSession.id,
            confirmed: !!confirm,
        });

        return res.json({
            success: true,
            previousTier: org.subscription_tier,
            newTier: tier,
            checkoutUrl: checkoutSession.url,
            checkoutId: checkoutSession.id,
            message: `Redirecting to checkout for ${tier}. Your existing subscription will be canceled automatically once payment completes.`,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('[BILLING] Plan change failed', error instanceof Error ? error : new Error(errMsg));
        return res.status(500).json({ success: false, error: errMsg || 'Failed to start plan change' });
    }
};

export const downloadInvoicePdf = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const id = req.params.id as string;

        const event = await prisma.subscriptionEvent.findFirst({
            where: { id, organization_id: orgId },
        });

        if (!event) {
            res.status(404).json({ success: false, error: 'Invoice not found' });
            return;
        }

        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { name: true, subscription_tier: true },
        });

        // Get customer email from the user who triggered the event, or fallback to requesting user
        const userId = req.orgContext?.userId;
        const user = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }) : null;

        // Tier base prices — only used as fallback when we don't have the
        // real Polar-charged amount on the event row. The Pro plan has
        // multiple send-volume variants priced differently; for Pro the
        // fallback is the lowest tier, which is fine for legacy rows that
        // pre-date amount capture.
        const tierFallbackCents: Record<string, number> = { starter: 4900, pro: 4900, growth: 19900, scale: 34900 };
        const tier = event.new_tier || org?.subscription_tier || 'starter';
        const amountCents = event.amount_cents ?? tierFallbackCents[tier] ?? 0;
        const currency = event.currency || 'USD';
        const amountDollars = (amountCents / 100).toFixed(2);
        const tierName = tier.charAt(0).toUpperCase() + tier.slice(1);
        const invoiceDate = event.created_at;
        const invoiceNumber = `INV-${invoiceDate.toISOString().slice(0, 10).replace(/-/g, '')}-${id.slice(0, 6).toUpperCase()}`;

        const doc = new PDFDocument({ size: 'A4', margin: 50 });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`);
        doc.pipe(res);

        // Header — brand bar
        doc.rect(0, 0, 595.28, 100).fill('#4F46E5');
        doc.fontSize(28).fillColor('#FFFFFF').text('INVOICE', 50, 35);
        doc.fontSize(10).fillColor('#E0E7FF').text(`Invoice #: ${invoiceNumber}`, 50, 68);
        doc.text(`Date: ${invoiceDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`, 50, 82);

        // Logo + Company info (right side of header)
        const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
        try { doc.image(logoPath, 480, 25, { width: 50 }); } catch { /* logo missing — skip */ }
        doc.fontSize(14).fillColor('#FFFFFF').text('Superkabe', 350, 35, { width: 125, align: 'left' });
        doc.fontSize(9).fillColor('#E0E7FF').text('support@superkabe.com', 350, 55, { width: 125, align: 'left' });

        // Bill To section
        doc.fillColor('#6B7280').fontSize(9).text('BILL TO', 50, 125);
        doc.fillColor('#111827').fontSize(12).text(org?.name || 'Customer', 50, 140);
        if (user?.email) {
            doc.fillColor('#6B7280').fontSize(9).text(user.email, 50, 157);
        }

        // Divider
        const dividerY = user?.email ? 180 : 175;
        doc.moveTo(50, dividerY).lineTo(545, dividerY).strokeColor('#E5E7EB').lineWidth(1).stroke();

        // Table header
        const tableTop = dividerY + 20;
        doc.rect(50, tableTop, 495, 30).fill('#F8FAFC');
        doc.fillColor('#64748B').fontSize(9);
        doc.text('DESCRIPTION', 60, tableTop + 10);
        doc.text('QTY', 320, tableTop + 10, { width: 50, align: 'center' });
        doc.text('UNIT PRICE', 380, tableTop + 10, { width: 80, align: 'right' });
        doc.text('AMOUNT', 470, tableTop + 10, { width: 70, align: 'right' });

        // Table row
        const rowTop = tableTop + 40;
        doc.fillColor('#111827').fontSize(10);
        doc.text(`Superkabe ${tierName} Plan — Monthly Subscription`, 60, rowTop);
        doc.text('1', 320, rowTop, { width: 50, align: 'center' });
        doc.text(`$${amountDollars}`, 380, rowTop, { width: 80, align: 'right' });
        doc.text(`$${amountDollars}`, 470, rowTop, { width: 70, align: 'right' });

        // Divider
        doc.moveTo(50, rowTop + 30).lineTo(545, rowTop + 30).strokeColor('#E5E7EB').lineWidth(1).stroke();

        // Total
        const totalTop = rowTop + 50;
        doc.fillColor('#64748B').fontSize(9).text('SUBTOTAL', 380, totalTop, { width: 80, align: 'right' });
        doc.fillColor('#111827').fontSize(10).text(`$${amountDollars}`, 470, totalTop, { width: 70, align: 'right' });

        doc.fillColor('#64748B').fontSize(9).text('TAX', 380, totalTop + 22, { width: 80, align: 'right' });
        doc.fillColor('#111827').fontSize(10).text('$0.00', 470, totalTop + 22, { width: 70, align: 'right' });

        doc.moveTo(380, totalTop + 42).lineTo(545, totalTop + 42).strokeColor('#E5E7EB').lineWidth(1).stroke();

        doc.fillColor('#111827').fontSize(12).font('Helvetica-Bold').text('TOTAL', 380, totalTop + 52, { width: 80, align: 'right' });
        doc.text(`$${amountDollars} ${currency}`, 470, totalTop + 52, { width: 70, align: 'right' });

        // Payment status
        const statusTop = totalTop + 90;
        const statusText = event.event_type === 'invoice.paid' ? 'PAID' : 'COMPLETED';
        const statusColor = event.event_type === 'invoice.paid' ? '#059669' : '#3B82F6';
        doc.roundedRect(380, statusTop, 165, 28, 4).fill(statusColor);
        doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold').text(statusText, 380, statusTop + 8, { width: 165, align: 'center' });

        // Footer
        doc.font('Helvetica').fillColor('#94A3B8').fontSize(8);
        doc.text('Thank you for your business.', 50, 750, { align: 'center', width: 495 });
        doc.text('Superkabe — Outbound Execution Control Layer', 50, 762, { align: 'center', width: 495 });

        doc.end();
    } catch (error) {
        logger.error('[BILLING] Failed to generate invoice PDF', error instanceof Error ? error : new Error(String(error)));
        res.status(500).json({ success: false, error: 'Failed to generate invoice PDF' });
    }
};
