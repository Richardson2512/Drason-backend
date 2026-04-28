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
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';

// ============================================================================
// WEBHOOK HANDLER
// ============================================================================

/**
 * Handle Polar webhook events.
 * Validates signature and processes events idempotently.
 */
export const handlePolarWebhook = async (req: Request, res: Response): Promise<Response> => {
    try {
        const signature = req.headers['x-polar-signature'] as string;
        const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;

        if (!webhookSecret) {
            logger.error('[BILLING] Missing POLAR_WEBHOOK_SECRET environment variable');
            return res.status(500).json({ success: false, error: 'Webhook secret not configured' });
        }

        // Validate HMAC-SHA256 signature
        const payload = JSON.stringify(req.body);
        const isValid = polarClient.validateWebhookSignature(payload, signature, webhookSecret);

        if (!isValid) {
            logger.warn('[BILLING] Invalid webhook signature — rejected');
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }

        // Process webhook event
        await billingService.processWebhook(req.body);

        // Always return 200 to prevent retry storms
        return res.json({ success: true, received: true });
    } catch (error) {
        logger.error('[BILLING] Webhook processing failed', error instanceof Error ? error : new Error(String(error)));
        // Still return 200 to prevent retries for non-retryable errors
        return res.status(200).json({ success: false, error: 'Processing failed', received: true });
    }
};

// ============================================================================
// CHECKOUT MANAGEMENT
// ============================================================================

/**
 * Create a Polar checkout session for upgrading.
 */
export const createCheckout = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { tier } = req.body;

        if (!tier || !['starter', 'pro', 'growth', 'scale'].includes(tier)) {
            return res.status(400).json({ success: false, error: 'Invalid tier. Must be one of: starter, pro, growth, scale' });
        }

        // Check subscription status instead of tier
        // With no-payment trials, users can be on 'growth' tier while 'trialing'
        const { prisma } = await import('../index');
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: {
                subscription_status: true,
                subscription_tier: true
            }
        });

        if (!org) {
            return res.status(404).json({ success: false, error: 'Organization not found' });
        }

        // Active subscribers should use the change-plan endpoint instead
        if (org.subscription_status === 'active') {
            return res.status(400).json({
                success: false,
                error: 'You already have an active subscription. Use the change-plan endpoint to upgrade or downgrade.',
                useChangePlan: true
            });
        }

        // Create checkout session
        const checkoutSession = await polarClient.createCheckoutSession(orgId, tier);

        return res.json({
            success: true,
            checkoutUrl: checkoutSession.url,
            checkoutId: checkoutSession.id
        });
    } catch (error) {
        logger.error('[BILLING] Checkout creation failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create checkout session' });
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
export const cancelSubscription = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        await polarClient.cancelSubscription(orgId);

        return res.json({ success: true, message: 'Subscription canceled. Access will continue until the end of your billing period.' });
    } catch (error) {
        logger.error('[BILLING] Failed to cancel subscription', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to cancel subscription' });
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

        // Validate tier
        const validTiers = ['starter', 'pro', 'growth', 'scale'];
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

        // Determine direction
        const tierOrder: Record<string, number> = { trial: 0, starter: 1, pro: 2, growth: 3, scale: 4, enterprise: 5 };
        const currentRank = tierOrder[org.subscription_tier || 'trial'] || 0;
        const newRank = tierOrder[tier] || 0;
        const isDowngrade = newRank < currentRank;

        // Downgrades no longer surface lead/domain/mailbox warnings — those caps
        // were removed 2026-04-27. Validation credits and monthly sends are
        // rolling counters that reset, so they don't need a confirm-prompt either.

        // Execute the plan change via Polar
        const result = await polarClient.changeSubscription(orgId, tier);

        logger.info(`[BILLING] Plan changed for ${orgId}: ${org.subscription_tier} → ${tier}`, {
            direction: isDowngrade ? 'downgrade' : 'upgrade',
            effective: result.effective,
            confirmed: !!confirm
        });

        return res.json({
            success: true,
            previousTier: org.subscription_tier,
            newTier: tier,
            direction: isDowngrade ? 'downgrade' : 'upgrade',
            effective: result.effective,
            message: isDowngrade
                ? `Downgrade to ${tier} will take effect at the end of your current billing period.`
                : `Upgrade to ${tier} is effective immediately. Your next invoice will be prorated.`
        });
    } catch (error) {
        logger.error('[BILLING] Plan change failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to change plan' });
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
