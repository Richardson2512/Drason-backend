/**
 * Precondition evaluator - called by the dispatcher before executing a
 * sequence step, returns whether the step is executable and (if not) a
 * skip_reason that gets written to SequenceStepExecution.
 *
 * The evaluator is intentionally pure: callers gather the lead + sender
 * facts upfront, then invoke evaluate(). This makes the function easy to
 * unit-test and avoids surprise DB reads inside the scheduler loop.
 *
 * Skip reasons are short, stable strings (used both for analytics
 * aggregation and as cache keys) - see SKIP_REASON_LABELS for the
 * human-friendly mapping the UI uses.
 */

import { STEP_TYPES, type PreconditionKey } from './stepTypeRegistry';

/**
 * The dispatcher resolves these facts once per (lead, step, sender) tuple
 * and passes them in. NULL values mean "unknown" - the evaluator treats
 * unknown as a failing precondition rather than guessing.
 */
export interface PreconditionContext {
    /** Email-channel facts */
    lead_has_email: boolean;

    /** LinkedIn-channel facts */
    lead_has_linkedin_profile: boolean;
    /** True if the lead's LinkedIn profile is a 1st-degree connection of the
     *  sending account. NULL when unknown (e.g. we haven't fetched the edge
     *  yet) - treated as a failing precondition. */
    sender_is_first_degree: boolean | null;

    /** Sender capability facts */
    sender_account_type?: 'CLASSIC' | 'PREMIUM' | 'SALES_NAV' | 'RECRUITER' | null;
    sender_has_inmail_credits: boolean | null;
    /** Lead's LinkedIn profile is Open (in Sales Nav's sense) - when true,
     *  InMail does NOT consume a credit. */
    lead_profile_is_open: boolean | null;

    /** For linkedin_like_post - has the lead posted within the configured timespan? */
    lead_has_recent_post: boolean | null;
}

export type EvalResult =
    | { executable: true }
    | { executable: false; skip_reason: string };

/**
 * Account tiers that have InMail capability at all.
 *
 *   CLASSIC   - Free account. No InMail. Even to Open-Profile recipients,
 *               we don't attempt - LinkedIn's free tier doesn't expose the
 *               InMail send button at all in most UI surfaces.
 *   PREMIUM   - Premium Career (5/month) and Premium Business (15/month)
 *               both ship with InMail credits. We collapse both into the
 *               PREMIUM enum; the per-account daily cap handles throttling.
 *   SALES_NAV - Sales Navigator (Core / Advanced) - ~50/month.
 *   RECRUITER - Recruiter / Recruiter Lite - 30/month (Lite) up to 150+
 *               (full Recruiter). Daily cap handles the spread.
 */
const SUPPORTS_INMAIL = new Set(['PREMIUM', 'SALES_NAV', 'RECRUITER']);

export function evaluate(stepType: string, ctx: PreconditionContext): EvalResult {
    const def = STEP_TYPES[stepType];
    if (!def) return { executable: false, skip_reason: 'unknown_step_type' };

    // find_email is the one inverted-precondition step: SKIP if lead already
    // has an email. Encoded here rather than in the registry to keep the
    // registry's precondition list strictly additive.
    if (stepType === 'find_email' && ctx.lead_has_email) {
        return { executable: false, skip_reason: 'lead_already_has_email' };
    }

    for (const pk of def.preconditions) {
        const ok = check(pk, ctx);
        if (!ok) return { executable: false, skip_reason: pk };
    }

    return { executable: true };
}

function check(pk: PreconditionKey, ctx: PreconditionContext): boolean {
    switch (pk) {
        case 'lead_has_email':
            return ctx.lead_has_email === true;
        case 'lead_has_linkedin_profile':
            return ctx.lead_has_linkedin_profile === true;
        case 'sender_is_first_degree':
            return ctx.sender_is_first_degree === true;
        case 'sender_is_not_first_degree':
            return ctx.sender_is_first_degree === false; // strict false; null = unknown = fail
        case 'sender_supports_inmail':
            return Boolean(ctx.sender_account_type && SUPPORTS_INMAIL.has(ctx.sender_account_type));
        case 'sender_has_inmail_credits_or_open_profile': {
            // Optimistic when we don't yet have credit data: assume tiered
            // accounts have credits available. The actual credit balance
            // is enforced at Unipile send time - Unipile returns an
            // "insufficient credits" error which the dispatcher catches
            // and converts to a per-step failure (NOT a global skip). The
            // alternative (pessimistic null) would block 100% of InMail
            // steps until we add a credit-poller, which is overkill.
            if (ctx.lead_profile_is_open === true) return true;
            if (ctx.sender_has_inmail_credits === true) return true;
            if (ctx.sender_has_inmail_credits === false) return false;
            // Credit balance unknown - fall through to tier-based gate.
            return Boolean(ctx.sender_account_type && SUPPORTS_INMAIL.has(ctx.sender_account_type));
        }
        case 'lead_has_recent_post':
            return ctx.lead_has_recent_post === true;
        default:
            // Exhaustive - TypeScript will surface unhandled keys
            return false;
    }
}

// Human-readable labels surfaced in Lead Analytics. The dispatcher writes
// the bare precondition key as skip_reason; the analytics layer joins
// against this map for the UI.
export const SKIP_REASON_LABELS: Record<string, string> = {
    lead_has_email: 'Lead has no email address on file',
    lead_has_linkedin_profile: 'Lead has no LinkedIn profile on file',
    sender_is_first_degree: 'Lead is not yet a 1st-degree connection',
    sender_is_not_first_degree: 'Lead is already a 1st-degree connection',
    sender_supports_inmail: 'Sender account tier does not support InMail (Classic / free accounts) - upgrade to Premium, Sales Navigator, or Recruiter',
    sender_has_inmail_credits_or_open_profile: 'No InMail credits and lead profile is closed',
    lead_has_recent_post: 'Lead has no post within the configured timespan',
    lead_already_has_email: 'Lead already has an enriched email - find_email skipped',
    unknown_step_type: 'Step type is not registered',
};
