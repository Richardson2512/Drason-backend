/**
 * Validation credit accounting - THE single source of truth for "how many
 * email-validation credits has this org used this month, and how many remain."
 *
 * Root cause of the prior bug: credit usage was metered two incompatible ways -
 * the by-tag / single / Clay-ingest paths counted ValidationAttempt rows, the
 * CSV-batch path counted ValidationBatchLead rows - and ValidationAttempt was
 * not even written for pre-Lead bulk validations (recordAttempt skipped them and
 * the batch / ingest callers wrote their own row, double-counting existing-lead
 * rows). So the two counters never saw each other's spend and the monthly cap
 * was not coherently enforced.
 *
 * Fix: ValidationAttempt is now the ONE ledger (one row per engine run from
 * every path, written unconditionally by emailValidationService.recordAttempt).
 * Every credit check reads it through this module with the SAME query, so the
 * paths can never disagree again.
 */

import { prisma } from '../index';
import { TIER_LIMITS } from './polarClient';

/**
 * First day of the current month at local midnight - the monthly usage epoch.
 * Matches the convention the credit gates used before this module existed
 * (setDate(1) + setHours(0,0,0,0)) so routing existing call sites through here
 * does not shift any month boundary.
 */
export function monthStart(now: Date = new Date()): Date {
    const d = new Date(now);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
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
            created_at: { gte: monthStart() },
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
 * One call every credit-gated path can use. Reads the single ledger so the
 * CSV-batch, by-tag, single and ingest flows all see each other's spend.
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
