/**
 * Validation credit accounting - THE single source of truth for "how many
 * email-validation credits has this org used this month, and how many
 * remain."
 *
 * Root cause of F2: credit usage was metered two incompatible ways - the
 * by-tag/single path counted ValidationAttempt rows, the CSV-batch path
 * counted ValidationBatchLead rows - and ValidationAttempt was not even
 * written for pre-Lead bulk validations. So neither counter saw the
 * other's usage and the monthly cap was not coherently enforced (plus a
 * concurrency race from snapshotting usage once per batch).
 *
 * Fix: ValidationAttempt is now the ONE ledger (one row per engine run
 * from every path - Clay ingest, CSV batch, by-tag, single - written
 * unconditionally by emailValidationService). Every credit check reads it
 * through this module with the SAME query, so the two paths can never
 * disagree again.
 *
 * Residual concurrency note: callers re-derive usage per chunk (not once
 * per batch), which collapses the overspend window from "a whole batch"
 * to "one chunk of in-flight validations" - a proportionate fix. True
 * DB-atomic reservation (a counter row + SELECT ... FOR UPDATE) is the
 * stricter alternative; the plan limit is a soft business cap (not a
 * security boundary) and MillionVerifier is independently tier-gated, so
 * the per-chunk shared-ledger check is the right cost/benefit.
 */

import { prisma } from '../prisma';
import { TIER_LIMITS } from './polarClient';

/** First day of the current month at 00:00 UTC - the monthly usage epoch. */
export function monthStartUTC(now: Date = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** The org's plan validation-credit limit. Infinity for unlimited tiers. */
export function getValidationLimit(tier: string | null | undefined): number {
    const t = (tier || 'trial').toLowerCase();
    const limits = TIER_LIMITS[t] || TIER_LIMITS.trial;
    return limits.validationCredits;
}

/** Credits consumed this calendar month, from the single ledger. */
export async function getValidationCreditsUsed(organizationId: string): Promise<number> {
    return prisma.validationAttempt.count({
        where: {
            organization_id: organizationId,
            created_at: { gte: monthStartUTC() },
        },
    });
}

export interface ValidationCreditState {
    /** Infinity for unlimited tiers. */
    limit: number;
    used: number;
    /** Infinity when unlimited; never negative otherwise. */
    remaining: number;
    unlimited: boolean;
}

/**
 * One call every credit-gated path uses. Reads the single ledger so the
 * CSV-batch, by-tag and single flows all see each other's spend.
 */
export async function getValidationCreditState(
    organizationId: string,
    tier: string | null | undefined,
): Promise<ValidationCreditState> {
    const limit = getValidationLimit(tier);
    if (limit === Infinity) {
        return { limit: Infinity, used: 0, remaining: Infinity, unlimited: true };
    }
    const used = await getValidationCreditsUsed(organizationId);
    return { limit, used, remaining: Math.max(0, limit - used), unlimited: false };
}
