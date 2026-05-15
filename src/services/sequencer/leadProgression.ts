/**
 * Lead progression — the single source of truth for the state a
 * CampaignLead moves to AFTER a sequence step is delivered, and the only
 * guarded path that writes that transition.
 *
 * Why this exists: the email dispatcher and the LinkedIn worker each
 * computed "where does this lead go next" and wrote current_step /
 * next_send_at / status themselves with divergent math. Divergent math +
 * multiple unguarded writers is the root cause of skipped/stuck steps and
 * of replied leads being resurrected. From here on, exactly ONE function
 * derives the post-delivery state and exactly ONE guarded path writes it,
 * so a lead that replied / bounced / unsubscribed / was paused between
 * the executor's pre-check and the write is never advanced.
 *
 * Timing note: next_send_at and last_sent_at are anchored to `now` at the
 * moment of the WRITE (actual delivery time), never at enqueue time — the
 * inter-step delay must be measured from when the step actually went out.
 * That's why the primitive takes the already-resolved next step rather
 * than a steps[] array (the email worker doesn't carry steps[]).
 *
 * SCOPE BOUNDARY (deliberate, not an omission): this module owns every
 * CampaignLead pointer/timing write — PROGRESSION ("finished step N,
 * advance the pointer", completeLead) AND reschedule of the SAME step
 * (rescheduleSameStep: defer/retry, pointer does NOT move). Both live
 * here, behind the same status='active' guard, precisely so there is ONE
 * guarded writer and the "multiple unguarded writers with divergent math"
 * root cause cannot regrow. It still does NOT own interrupts (reply/
 * bounce/suppression/pause: terminal state changes handled elsewhere).
 *
 * Pure compute is unit-tested; the writers are thin guarded updateManys.
 */

export interface ProgressionStepLite {
    step_number: number;
    delay_days: number;
    delay_hours: number;
}

export interface ProgressionState {
    current_step: number;
    last_sent_at: Date;
    next_send_at: Date | null;
    status: 'active' | 'completed';
}

/**
 * THE primitive. Given the step that was just delivered and the
 * already-resolved immediate next step (or null when the sequence is
 * finished), produce the lead's next progression state with timing
 * anchored to `now` (the actual delivery moment).
 *
 *   - nextStep == null → sequence finished: status 'completed',
 *     next_send_at null.
 *   - nextStep present → status 'active', current_step = delivered,
 *     next_send_at = now + nextStep.delay_days days + delay_hours hours.
 *
 * Date math is identical to the email dispatcher's prior
 * calculateNextSendAt (setDate + setHours from `now`), so adopting this
 * is a zero-behaviour-change extraction for email and the correct shared
 * behaviour for LinkedIn.
 */
export function progressionFromNextStep(args: {
    deliveredStepNumber: number;
    nextStep: { delay_days: number; delay_hours: number } | null;
    now?: Date;
}): ProgressionState {
    const now = args.now ?? new Date();

    if (!args.nextStep) {
        return {
            current_step: args.deliveredStepNumber,
            last_sent_at: now,
            next_send_at: null,
            status: 'completed',
        };
    }

    const nextSendAt = new Date(now);
    nextSendAt.setDate(nextSendAt.getDate() + (args.nextStep.delay_days ?? 0));
    nextSendAt.setHours(nextSendAt.getHours() + (args.nextStep.delay_hours ?? 0));

    return {
        current_step: args.deliveredStepNumber,
        last_sent_at: now,
        next_send_at: nextSendAt,
        status: 'active',
    };
}

/**
 * Convenience wrapper for callers that DO have the campaign's steps
 * (the LinkedIn worker). Derives the immediate next step from steps[]
 * with the exact semantics the email dispatcher always used:
 *
 *   - No step with a higher step_number than delivered → finished.
 *   - Otherwise the immediate next step is step (delivered + 1); if that
 *     exact number is missing but a higher one exists (legacy
 *     non-contiguous campaign predating step_number normalization) the
 *     delay falls back to 0 and the next tick's resolver walks on.
 */
export function computeProgression(args: {
    deliveredStepNumber: number;
    steps: ProgressionStepLite[];
    now?: Date;
}): ProgressionState {
    const anyHigherStep = args.steps.some(s => s.step_number > args.deliveredStepNumber);
    if (!anyHigherStep) {
        return progressionFromNextStep({
            deliveredStepNumber: args.deliveredStepNumber,
            nextStep: null,
            now: args.now,
        });
    }
    const nextImmediate = args.steps.find(s => s.step_number === args.deliveredStepNumber + 1);
    return progressionFromNextStep({
        deliveredStepNumber: args.deliveredStepNumber,
        nextStep: {
            delay_days: nextImmediate?.delay_days ?? 0,
            delay_hours: nextImmediate?.delay_hours ?? 0,
        },
        now: args.now,
    });
}

/** Minimal structural type for a Prisma client or interactive-tx client. */
interface CampaignLeadWriter {
    campaignLead: {
        updateMany: (args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }) => Promise<{ count: number }>;
    };
}

/**
 * The ONLY non-transactional place a progression transition is written.
 * Guarded on status='active' so a lead that replied / bounced /
 * unsubscribed / was paused since the executor's pre-send check is NOT
 * resurrected or advanced (updateMany matches 0 rows → no-op). Returns
 * the affected count so callers can log a no-op as "lead changed state
 * mid-delivery". (The email post-send writes the SAME guarded shape
 * inside its atomic $transaction — see progressionWriteData.)
 */
export async function writeProgression(
    client: CampaignLeadWriter,
    leadId: string,
    state: ProgressionState,
): Promise<number> {
    const r = await client.campaignLead.updateMany({
        where: { id: leadId, status: 'active' },
        data: progressionWriteData(state),
    });
    return r.count;
}

/**
 * The canonical guarded-write shape, exposed so the email post-send can
 * embed the SAME update as an element of its atomic prisma.$transaction
 * array (extracting it to a separate call would break the all-or-nothing
 * SendEvent + counters + progression guarantee). Single source of truth
 * for both the WHERE guard and the data payload.
 */
export function progressionWhere(leadId: string) {
    return { id: leadId, status: 'active' as const };
}
export function progressionWriteData(state: ProgressionState) {
    return {
        current_step: state.current_step,
        last_sent_at: state.last_sent_at,
        next_send_at: state.next_send_at,
        status: state.status,
    };
}

/**
 * Terminal completion for a lead with no deliverable step left (resolver
 * returned null, or an explicit `end` step). Same guarded path.
 * Previously the "no step" branch used an UNguarded update() that could
 * overwrite a lead that replied between selection and here, losing the
 * 'replied' signal — routing it through here fixes that too.
 */
export async function completeLead(
    client: CampaignLeadWriter,
    leadId: string,
): Promise<number> {
    const r = await client.campaignLead.updateMany({
        where: { id: leadId, status: 'active' },
        data: { status: 'completed', next_send_at: null },
    });
    return r.count;
}

/**
 * DEFER: the current step could not run yet and should be retried later
 * WITHOUT advancing (e.g. linkedin_like_post when the lead has no post yet
 * and skip-if-no-post is off — "wait for one"). current_step is left
 * untouched so the next selection (current_step + 1) lands on the SAME
 * step again; only next_send_at is pushed out. Same status='active' guard
 * as every other writer here, so a lead that replied / bounced / was
 * paused since selection is never resurrected by a deferral.
 *
 * The CALLER owns the retry policy (interval + a max-attempts ceiling) so
 * a never-satisfiable defer can't loop forever — this primitive only
 * performs the one guarded write.
 */
export async function rescheduleSameStep(
    client: CampaignLeadWriter,
    leadId: string,
    nextAttemptAt: Date,
): Promise<number> {
    const r = await client.campaignLead.updateMany({
        where: { id: leadId, status: 'active' },
        data: { next_send_at: nextAttemptAt },
    });
    return r.count;
}
