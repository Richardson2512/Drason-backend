/**
 * LinkedIn account-slot limits.
 *
 * Effective cap per organization =
 *   baseLimitForTier(subscription_tier) + linkedin_account_addon_count
 *
 * Add-on slots cost $15/account/month and are purchased through the
 * Accounts page in the dashboard. Each purchase increments the counter
 * and writes a LinkedInAccountAddonPurchase audit row.
 *
 * Pricing kept in code (not config) because it's UI-surfaced and changes
 * rarely. Pull into a CMS / pricing table if we need per-region pricing.
 */

import { prisma } from '../../prisma';

export const LINKEDIN_ADDON_PRICE_USD = 15;

/**
 * Default LinkedIn account capacity by subscription tier.
 *
 * The upsell ladder is shaped so Growth ($199) is the entry point for
 * 2 bundled LinkedIn slots without piling onto higher Pro send tiers,
 * and Scale ($349) is the only path to 3 bundled slots. Pro is capped
 * at 2 — at or above the 150K send variant — to keep the ladder
 * orderly:
 *
 *   tier             slots  notes
 *   ───────────────  ─────  ──────────────────────────────────────────
 *   trial / starter    1    low volume; single sender expected
 *   pro (60K)          1    entry Pro
 *   pro_80k            1
 *   pro_100k           1    still below the 150K cutoff
 *   pro_150k           2    crosses the volume cutoff → +1 bundled
 *   pro_200k           2
 *   pro_250k           2    matches Growth's bundled count
 *   growth             2    org-scale email-first motion
 *   scale              3    multi-rep cadence — only path to 3 bundled
 *   enterprise         5    sales-motion comfort
 *
 * Add-on slots beyond the bundled count cost $15/mo each regardless of
 * tier (see LINKEDIN_ADDON_PRICE_USD above).
 */
export function baseLimitForTier(tier: string | null | undefined): number {
    switch ((tier || 'trial').toLowerCase()) {
        case 'trial':    return 1;
        case 'starter':  return 1;
        case 'pro':      return 1;
        case 'pro_80k':  return 1;
        case 'pro_100k': return 1;
        case 'pro_150k': return 2;
        case 'pro_200k': return 2;
        case 'pro_250k': return 2;
        case 'growth':   return 2;
        case 'scale':    return 3;
        case 'enterprise': return 5;
        default: return 1; // unknown tier → conservative
    }
}

export interface LinkedInLimitSummary {
    tier: string;
    base_limit: number;
    addon_count: number;
    effective_limit: number;
    current_usage: number;
    /** Slots remaining before the cap is hit. Negative = over cap (shouldn't happen). */
    available: number;
    addon_unit_price_usd: number;
}

/**
 * Resolve the org's effective cap + current usage in one call. Used by:
 *   - GET /api/linkedin/accounts (so the UI can render "X of Y used")
 *   - enforceCanAddAccount() before generating a hosted-auth link
 */
export async function getLimitSummary(organizationId: string): Promise<LinkedInLimitSummary> {
    const [org, count] = await Promise.all([
        prisma.organization.findUnique({
            where: { id: organizationId },
            select: { subscription_tier: true, linkedin_account_addon_count: true },
        }),
        prisma.linkedInAccount.count({ where: { organization_id: organizationId } }),
    ]);
    if (!org) throw new Error('Organization not found');

    const tier = org.subscription_tier || 'trial';
    const base = baseLimitForTier(tier);
    const addons = org.linkedin_account_addon_count ?? 0;
    const effective = base + addons;
    return {
        tier,
        base_limit: base,
        addon_count: addons,
        effective_limit: effective,
        current_usage: count,
        available: effective - count,
        addon_unit_price_usd: LINKEDIN_ADDON_PRICE_USD,
    };
}

/**
 * Throws `AccountLimitExceededError` when the org is at cap.
 * Called before generating a Unipile hosted-auth link so we never burn a
 * connect flow on capacity the org doesn't have.
 */
export async function enforceCanAddAccount(organizationId: string): Promise<LinkedInLimitSummary> {
    const summary = await getLimitSummary(organizationId);
    if (summary.available <= 0) {
        throw new AccountLimitExceededError(summary);
    }
    return summary;
}

export class AccountLimitExceededError extends Error {
    public readonly summary: LinkedInLimitSummary;
    constructor(summary: LinkedInLimitSummary) {
        super(`LinkedIn account limit reached: ${summary.current_usage}/${summary.effective_limit} used on ${summary.tier} tier. Buy an add-on slot for $${LINKEDIN_ADDON_PRICE_USD}/mo or upgrade the plan.`);
        this.summary = summary;
        this.name = 'AccountLimitExceededError';
    }
}

// ────────────────────────────────────────────────────────────────────
// Add-on purchase (stub — Polar webhook integration is a follow-up).
//
// Today this is a direct increment + audit row; the controller is
// expected to gate on user role (admin) and to swap in a Polar
// checkout-session flow when billing wiring lands.
// ────────────────────────────────────────────────────────────────────

export interface PurchaseAddonInput {
    organizationId: string;
    userId: string;
    quantity?: number; // defaults to 1
}

export async function purchaseAddon(input: PurchaseAddonInput): Promise<LinkedInLimitSummary> {
    const qty = Math.max(1, input.quantity ?? 1);

    await prisma.$transaction([
        prisma.organization.update({
            where: { id: input.organizationId },
            data: { linkedin_account_addon_count: { increment: qty } },
        }),
        prisma.linkedInAccountAddonPurchase.create({
            data: {
                organization_id: input.organizationId,
                user_id: input.userId,
                quantity: qty,
                // Stored as a snapshot in case price changes later.
                unit_price_usd: LINKEDIN_ADDON_PRICE_USD,
                status: 'completed',
            },
        }),
    ]);

    return getLimitSummary(input.organizationId);
}

/**
 * Release one addon slot when the account that was occupying paid
 * capacity gets disconnected. This is a CAPACITY RELEASE — not a money
 * refund. Nothing is refunded; the operator simply stops being billed
 * for that slot on the next cycle (or, with Polar wired in Phase 5,
 * the recurring subscription is cancelled).
 *
 * Without this, an org buys 1 addon ($15/mo), deletes the account it
 * added, and the addon counter stays at 1 forever — they keep paying
 * for capacity they can't use without buying *another* addon. That's a
 * one-way revenue trap, which is the bug we're fixing.
 *
 * Release semantics:
 *   - We only decrement when the account being deleted was occupying
 *     paid capacity. That's true when (accounts_before_delete >
 *     base_limit). If the org was within their bundled tier limit, no
 *     addon slot was in use by this account, so nothing to release.
 *   - We never decrement below zero (defensive — the counter should
 *     always reflect the org's actual paid commitments).
 *   - We mark the most-recent active `LinkedInAccountAddonPurchase`
 *     row as `status='released'` + stamp `refunded_at` (column name is
 *     legacy — it just means "lifecycle ended"). Audit trail; Polar
 *     reconciliation (Phase 5) reads from this table to cancel the
 *     recurring subscription on the next webhook tick.
 *
 * Caller contract: invoke AFTER the LinkedInAccount row is deleted,
 * and pass the pre-delete account count so we can tell whether the
 * deleted slot was paid.
 */
export async function releaseAddonSlotOnDisconnect(
    organizationId: string,
    accountsBeforeDelete: number,
): Promise<{ released: boolean; reason: string }> {
    const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { subscription_tier: true, linkedin_account_addon_count: true },
    });
    if (!org) return { released: false, reason: 'org_not_found' };

    const base = baseLimitForTier(org.subscription_tier);
    const addonCount = org.linkedin_account_addon_count ?? 0;

    if (addonCount <= 0) return { released: false, reason: 'no_addons_to_release' };
    if (accountsBeforeDelete <= base) return { released: false, reason: 'within_base_limit_no_addon_used' };

    // Pre-delete the org was paying for at least one addon for the
    // account that just got disconnected. Find the most recent active
    // purchase + decrement the counter atomically.
    const candidate = await prisma.linkedInAccountAddonPurchase.findFirst({
        where: { organization_id: organizationId, status: 'completed', refunded_at: null },
        orderBy: { purchased_at: 'desc' },
        select: { id: true },
    });

    await prisma.$transaction([
        prisma.organization.update({
            where: { id: organizationId },
            data: { linkedin_account_addon_count: { decrement: 1 } },
        }),
        ...(candidate
            ? [prisma.linkedInAccountAddonPurchase.update({
                where: { id: candidate.id },
                // status='released' marks the lifecycle as ended.
                // refunded_at is the legacy column name — see docstring;
                // a future migration can rename it to released_at when
                // Polar integration lands.
                data: { status: 'released', refunded_at: new Date() },
            })]
            : []),
    ]);

    return { released: true, reason: candidate ? 'purchase_marked_released' : 'counter_decremented_no_audit_row' };
}
