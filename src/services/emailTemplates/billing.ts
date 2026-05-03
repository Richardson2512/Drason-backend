/**
 * Billing & subscription emails.
 *
 * Seven envelope-builders, one per billing event. All return the standard
 * { subject, html, text, preheader } shape for the dispatcher.
 *
 * Recipient policy: every email here goes to org admins (managed by the
 * dispatcher's `org-admins` audience). The org itself is the customer of
 * record on the Polar subscription, not a single user.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

// ─── 1. Trial ending — 3 days out ───────────────────────────────────────

export interface TrialEndingEmailParams {
    organizationName: string;
    daysRemaining: number;
    /** When the trial actually ends (UTC). */
    trialEndsAt: Date;
    /** Current sends used + included this trial — surfaces value being delivered. */
    sendsUsed?: number | null;
    /** /dashboard/billing on the frontend. */
    billingUrl: string;
}

export function trialEndingEmail(p: TrialEndingEmailParams): RenderedEmail {
    const subject = `${p.daysRemaining} day${p.daysRemaining === 1 ? '' : 's'} left in your Superkabe trial`;
    const preheader = `Pick a plan before ${formatDate(p.trialEndsAt)} to keep your campaigns running uninterrupted.`;

    const facts = [
        { label: 'Trial ends', value: p.trialEndsAt.toUTCString() },
        { label: 'Days remaining', value: String(p.daysRemaining) },
    ];
    if (typeof p.sendsUsed === 'number') {
        facts.push({ label: 'Sends used so far', value: String(p.sendsUsed) });
    }

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Trial reminder',
        heading: `Your trial ends in ${p.daysRemaining} day${p.daysRemaining === 1 ? '' : 's'}`,
        intro: `Heads-up — the Superkabe trial for <strong>${escapeHtml(p.organizationName)}</strong> ends on <strong>${escapeHtml(formatDate(p.trialEndsAt))}</strong>. After that, sending pauses until a paid plan is selected.`,
        facts,
        body: `Pick a plan before then to keep campaigns sending without a hiccup. You can upgrade or downgrade later — billing prorates automatically.`,
        ctaLabel: 'Choose a plan',
        ctaUrl: p.billingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 2. Trial expired ───────────────────────────────────────────────────

export interface TrialExpiredEmailParams {
    organizationName: string;
    billingUrl: string;
}

export function trialExpiredEmail(p: TrialExpiredEmailParams): RenderedEmail {
    const subject = 'Your Superkabe trial has ended';
    const preheader = `Sending is paused. Upgrade now to resume campaigns and keep your mailbox health intact.`;

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Trial ended',
        heading: 'Your trial has ended',
        intro: `The 14-day trial for <strong>${escapeHtml(p.organizationName)}</strong> has ended. We've automatically paused all active campaigns to prevent unmonitored sending — your mailboxes and domain reputation stay safe.`,
        body: `Pick a paid plan and your campaigns will resume from where they left off. Your data, sequences, leads, and mailbox connections are all preserved.`,
        ctaLabel: 'Upgrade now',
        ctaUrl: p.billingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 3. Payment failed ──────────────────────────────────────────────────

export interface PaymentFailedEmailParams {
    organizationName: string;
    /** Polar attempt id when available — useful for support correlation. */
    attemptId?: string | null;
    /** Amount that failed, in major units (dollars), pre-formatted. */
    amountLabel?: string | null;
    /** When Polar will next retry the charge automatically. */
    nextRetryAt?: Date | null;
    /** Direct link to update payment method. */
    billingUrl: string;
}

export function paymentFailedEmail(p: PaymentFailedEmailParams): RenderedEmail {
    const subject = 'Payment failed — action needed';
    const preheader = `We couldn't charge your card for the latest Superkabe invoice. Update your payment method to avoid service interruption.`;

    const facts: { label: string; value: string; mono?: boolean }[] = [];
    if (p.amountLabel) facts.push({ label: 'Amount', value: p.amountLabel });
    if (p.nextRetryAt) facts.push({ label: 'Next automatic retry', value: p.nextRetryAt.toUTCString() });
    if (p.attemptId) facts.push({ label: 'Reference', value: p.attemptId, mono: true });

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Billing · Action required',
        heading: 'We couldn\'t process your payment',
        intro: `The latest charge for <strong>${escapeHtml(p.organizationName)}</strong> didn't go through. Common causes are an expired card, insufficient funds, or a bank-side authorization block.`,
        facts: facts.length > 0 ? facts : undefined,
        body: `Update your payment method below before the next retry. If multiple retries fail, the subscription downgrades automatically and active campaigns will pause.`,
        ctaLabel: 'Update payment method',
        ctaUrl: p.billingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 4. Subscription canceled ───────────────────────────────────────────

export interface SubscriptionCanceledEmailParams {
    organizationName: string;
    /** When the active period ends. Until then, service continues. */
    activeUntil: Date;
    /** Optional reason captured in the cancel flow. */
    reason?: string | null;
    /** Re-subscribe URL. */
    billingUrl: string;
}

export function subscriptionCanceledEmail(p: SubscriptionCanceledEmailParams): RenderedEmail {
    const subject = 'Your Superkabe subscription was canceled';
    const preheader = `Your service stays active until ${formatDate(p.activeUntil)}. Resubscribe anytime to keep going.`;

    const facts = [
        { label: 'Service active until', value: p.activeUntil.toUTCString() },
    ];
    if (p.reason) facts.push({ label: 'Reason', value: p.reason });

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Billing',
        heading: 'Subscription canceled',
        intro: `We've recorded the cancellation for <strong>${escapeHtml(p.organizationName)}</strong>. Your subscription will not auto-renew, but full service stays active until <strong>${escapeHtml(formatDate(p.activeUntil))}</strong>.`,
        facts,
        body: `If this wasn't you, or you change your mind, you can resubscribe anytime — your data, sequences, and integrations are preserved. We'd love to know what didn't work; reply to this email and we'll listen.`,
        ctaLabel: 'Resubscribe',
        ctaUrl: p.billingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 5. Subscription changed (upgraded/downgraded) ──────────────────────

export interface SubscriptionChangedEmailParams {
    organizationName: string;
    fromTier: string;
    toTier: string;
    /** "upgrade" | "downgrade" — affects copy. */
    direction: 'upgrade' | 'downgrade';
    /** When the new tier takes effect. */
    effectiveAt: Date;
    billingUrl: string;
}

export function subscriptionChangedEmail(p: SubscriptionChangedEmailParams): RenderedEmail {
    const verb = p.direction === 'upgrade' ? 'upgraded' : 'changed';
    const subject = `Your Superkabe plan was ${verb} to ${capitalize(p.toTier)}`;
    const preheader = `${capitalize(p.organizationName)} is now on the ${capitalize(p.toTier)} plan. New limits are active${p.effectiveAt.getTime() <= Date.now() ? ' immediately' : ` from ${formatDate(p.effectiveAt)}`}.`;

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: p.direction === 'upgrade' ? 'Plan upgraded' : 'Plan changed',
        heading: `Your plan was ${verb}`,
        intro: `<strong>${escapeHtml(p.organizationName)}</strong> moved from <strong>${escapeHtml(capitalize(p.fromTier))}</strong> to <strong>${escapeHtml(capitalize(p.toTier))}</strong>. ${p.direction === 'upgrade' ? 'Higher send and validation limits are active now.' : 'New limits apply on the next billing cycle.'}`,
        facts: [
            { label: 'Previous plan', value: capitalize(p.fromTier) },
            { label: 'New plan', value: capitalize(p.toTier) },
            { label: 'Effective at', value: p.effectiveAt.toUTCString() },
        ],
        ctaLabel: 'View billing details',
        ctaUrl: p.billingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 6. Invoice paid (receipt) ──────────────────────────────────────────

export interface InvoicePaidEmailParams {
    organizationName: string;
    /** Invoice / receipt id from Polar. */
    invoiceId: string;
    amountLabel: string;             // pre-formatted "$49.00 USD"
    paidAt: Date;
    nextBillingDate?: Date | null;
    /** Hosted invoice URL from Polar — receipt PDF / page. */
    receiptUrl?: string | null;
    /** Fallback CTA if receiptUrl is null. */
    billingUrl: string;
}

export function invoicePaidEmail(p: InvoicePaidEmailParams): RenderedEmail {
    const subject = `Payment receipt — ${p.amountLabel}`;
    const preheader = `Thanks for renewing Superkabe.${p.nextBillingDate ? ` Next charge: ${formatDate(p.nextBillingDate)}.` : ''}`;

    const facts: { label: string; value: string; mono?: boolean }[] = [
        { label: 'Amount', value: p.amountLabel },
        { label: 'Paid at', value: p.paidAt.toUTCString() },
        { label: 'Invoice', value: p.invoiceId, mono: true },
    ];
    if (p.nextBillingDate) {
        facts.push({ label: 'Next charge', value: p.nextBillingDate.toUTCString() });
    }

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Receipt',
        heading: 'Payment received',
        intro: `Thanks for being a Superkabe customer. Here's the receipt for <strong>${escapeHtml(p.organizationName)}</strong>'s latest invoice.`,
        facts,
        ctaLabel: p.receiptUrl ? 'View invoice' : 'Open billing',
        ctaUrl: p.receiptUrl || p.billingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 7. Usage threshold (80% / 90% / 100%) ──────────────────────────────

export interface UsageThresholdEmailParams {
    organizationName: string;
    /** Which metric tripped the threshold. */
    metric: 'sends' | 'validations';
    /** Percentage of the cap consumed (80 / 90 / 100 typically). */
    percentUsed: number;
    /** Counts behind the percentage so the email is interpretable. */
    used: number;
    limit: number;
    /** When the cap resets to 0 (e.g. start of next billing month). */
    resetsAt?: Date | null;
    billingUrl: string;
}

export function usageThresholdEmail(p: UsageThresholdEmailParams): RenderedEmail {
    const metricLabel = p.metric === 'sends' ? 'monthly sends' : 'validation credits';
    const subject = p.percentUsed >= 100
        ? `${capitalize(metricLabel)} cap reached for ${p.organizationName}`
        : `${p.percentUsed}% of ${metricLabel} used`;
    const preheader = p.percentUsed >= 100
        ? `Sending is throttled until your plan refreshes${p.resetsAt ? ` on ${formatDate(p.resetsAt)}` : ''} — or upgrade to lift the cap.`
        : `${p.used} of ${p.limit} ${metricLabel} used. Plan ahead before you hit 100%.`;

    const facts: { label: string; value: string }[] = [
        { label: 'Metric', value: capitalize(metricLabel) },
        { label: 'Used', value: `${p.used} / ${p.limit}` },
        { label: 'Percent', value: `${p.percentUsed}%` },
    ];
    if (p.resetsAt) facts.push({ label: 'Resets at', value: p.resetsAt.toUTCString() });

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: p.percentUsed >= 100 ? 'Usage · Cap reached' : 'Usage · Heads-up',
        heading: p.percentUsed >= 100
            ? `You've hit your ${metricLabel} cap`
            : `You've used ${p.percentUsed}% of your ${metricLabel}`,
        intro: p.percentUsed >= 100
            ? `<strong>${escapeHtml(p.organizationName)}</strong> has consumed the full ${metricLabel} allowance for this billing period. To keep sending without waiting for the reset, upgrade to a higher plan.`
            : `Just a heads-up — <strong>${escapeHtml(p.organizationName)}</strong> has used <strong>${p.used} of ${p.limit}</strong> ${metricLabel} this billing period.`,
        facts,
        body: p.percentUsed >= 100
            ? 'Your data is safe. New sends are queued and will dispatch as soon as the cap resets, or immediately if you upgrade.'
            : 'No action required yet. We\'ll email again when you cross 90% and 100% so you have time to plan.',
        ctaLabel: p.percentUsed >= 100 ? 'Upgrade plan' : 'View usage',
        ctaUrl: p.billingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── helpers ────────────────────────────────────────────────────────────

function wrap(subject: string, tpl: RenderEmailParams, preheader: string): RenderedEmail {
    return {
        subject,
        html: renderEmailTemplate(tpl),
        text: renderEmailPlainText(tpl),
        preheader,
    };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function capitalize(s: string): string {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function formatDate(d: Date): string {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
