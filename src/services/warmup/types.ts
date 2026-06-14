/**
 * Warmup pool - shared types.
 *
 * Architectural rule: nothing in this module touches EmailThread /
 * EmailMessage / SendEvent / BounceEvent. Warmup lives in its own
 * lane so the unibox, send-counter, and bounce-state-machine stay
 * untouched.
 */

export type WarmupTemplateKind = 'subject' | 'body' | 'signoff' | 'thread_reply';

export type WarmupExchangeState =
    | 'scheduled'
    | 'sent'
    | 'delivered'
    | 'opened'
    | 'replied'
    | 'recovered_from_spam'
    | 'failed'
    | 'bounced';

export type WarmupHealth = 'warming' | 'maintenance' | 'paused' | 'error';

/** Hard cap on per-mailbox per-day warmup volume. The user can set
 *  target_daily anywhere up to this number; values above are clamped.
 *  Decision: 50/day is the documented ceiling - the user explicitly
 *  asked for this; do not raise without their say-so. */
export const MAX_TARGET_DAILY = 50;

/** Minimum useful start volume - below this the ramp signal is too
 *  weak to register on ISP reputation models. */
export const MIN_START_DAILY = 1;

/** Maintenance volume floor + ceiling. After ramp completes the mailbox
 *  drops to maintenance_daily; user can configure within this band. */
export const MIN_MAINTENANCE_DAILY = 5;
export const MAX_MAINTENANCE_DAILY = 20;

/** Maximum reply depth in a warmup thread. Initial → reply → reply-of
 *  -reply, then stop. Going deeper inflates pool volume without adding
 *  reputation signal. */
export const MAX_THREAD_DEPTH = 2;

/** Probability the recipient generates a reply when it processes a
 *  warmup email. Uniform - every mailbox replies at this rate. */
export const REPLY_PROBABILITY = 0.6;

/** Adaptive-ramp guard: if a mailbox's rolling 30-day spam rate exceeds
 *  this fraction, ramp advancement pauses (current_daily holds steady)
 *  until the rate drops below the threshold again. Different from the
 *  healing-pipeline thresholds - these are warmup-only. */
export const SPAM_RATE_PAUSE_THRESHOLD = 0.05;

/** Same threshold as a hard limit at which a membership flips into
 *  'error' health and stops sending entirely. The operator must
 *  manually re-enable. */
export const SPAM_RATE_ERROR_THRESHOLD = 0.15;

/** Window over which spam_rate_30d is computed. */
export const SPAM_RATE_WINDOW_DAYS = 30;
