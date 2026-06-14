/**
 * Warmup Pool Membership Service
 *
 * Owns:
 *   - Auto-enroll on new ConnectedAccount creation
 *   - Per-mailbox toggle (enable/disable)
 *   - Ramp configuration (start_daily, target_daily, ramp_days)
 *   - Daily ramp advancement (called by warmupRampWorker)
 *   - Adaptive slowdown when spam_rate_30d crosses thresholds
 *
 * Doesn't own:
 *   - Sending (warmupSenderWorker / warmupDispatchWorker)
 *   - Recipient actions (warmupRecipientWorker / engagementService)
 *   - Pair selection (poolService)
 */

import { prisma } from '../../index';
import { logger } from '../observabilityService';
import {
    MAX_TARGET_DAILY,
    MIN_START_DAILY,
    MIN_MAINTENANCE_DAILY,
    MAX_MAINTENANCE_DAILY,
    SPAM_RATE_PAUSE_THRESHOLD,
    SPAM_RATE_ERROR_THRESHOLD,
    type WarmupHealth,
} from './types';

// ────────────────────────────────────────────────────────────────────
// Defaults (per the user's spec - do not change without sign-off):
//   start  5/day, target 50/day, ramp over 21 days, maintenance 10/day
// ────────────────────────────────────────────────────────────────────

export const DEFAULTS = {
    startDaily: 5,
    targetDaily: 50,
    rampDays: 21,
    maintenanceDaily: 10,
};

export interface MembershipConfig {
    startDaily?: number;
    targetDaily?: number;
    rampDays?: number;
    maintenanceDaily?: number;
}

function clampConfig(cfg: MembershipConfig): Required<MembershipConfig> {
    const startDaily = Math.max(MIN_START_DAILY, Math.min(cfg.startDaily ?? DEFAULTS.startDaily, MAX_TARGET_DAILY));
    const targetDaily = Math.max(startDaily, Math.min(cfg.targetDaily ?? DEFAULTS.targetDaily, MAX_TARGET_DAILY));
    const rampDays = Math.max(1, Math.min(cfg.rampDays ?? DEFAULTS.rampDays, 90));
    const maintenanceDaily = Math.max(
        MIN_MAINTENANCE_DAILY,
        Math.min(cfg.maintenanceDaily ?? DEFAULTS.maintenanceDaily, MAX_MAINTENANCE_DAILY),
    );
    return { startDaily, targetDaily, rampDays, maintenanceDaily };
}

// ────────────────────────────────────────────────────────────────────
// Auto-enroll - called from connectedAccountController right after a
// ConnectedAccount + Mailbox row are created. Idempotent.
// ────────────────────────────────────────────────────────────────────

export async function autoEnrollMailbox(opts: {
    mailboxId: string;
    organizationId: string;
}): Promise<void> {
    try {
        const cfg = clampConfig({});
        await prisma.warmupPoolMembership.upsert({
            where: { mailbox_id: opts.mailboxId },
            create: {
                mailbox_id: opts.mailboxId,
                organization_id: opts.organizationId,
                enabled: true,
                receive_enabled: true,
                start_daily: cfg.startDaily,
                target_daily: cfg.targetDaily,
                ramp_days: cfg.rampDays,
                maintenance_daily: cfg.maintenanceDaily,
                current_daily: cfg.startDaily,
                ramp_step: 0,
                health: 'warming',
            },
            // If the row already exists (re-import, ConnectedAccount
            // recreated for an existing Mailbox), don't reset ramp state.
            update: {},
        });
        logger.info('[WARMUP] auto-enrolled mailbox', { mailboxId: opts.mailboxId, orgId: opts.organizationId });
    } catch (err) {
        // Auto-enroll must NEVER fail the parent flow (mailbox connect).
        // Log and move on.
        logger.warn('[WARMUP] auto-enroll failed (non-fatal)', {
            mailboxId: opts.mailboxId,
            orgId: opts.organizationId,
            err: (err as Error)?.message,
        });
    }
}

// ────────────────────────────────────────────────────────────────────
// Per-membership controls
// ────────────────────────────────────────────────────────────────────

export async function setEnabled(mailboxId: string, organizationId: string, enabled: boolean): Promise<void> {
    await prisma.warmupPoolMembership.update({
        where: { mailbox_id: mailboxId },
        // Org guard at the controller layer; this query is keyed on the
        // unique mailbox_id which is per-org by design (mailboxes belong
        // to one org).
        data: {
            enabled,
            health: enabled ? 'warming' : 'paused',
            updated_at: new Date(),
        },
    });
    logger.info('[WARMUP] membership toggled', { mailboxId, organizationId, enabled });
}

export async function updateConfig(
    mailboxId: string,
    organizationId: string,
    cfg: MembershipConfig,
): Promise<void> {
    const clamped = clampConfig(cfg);
    await prisma.warmupPoolMembership.update({
        where: { mailbox_id: mailboxId },
        data: {
            start_daily: clamped.startDaily,
            target_daily: clamped.targetDaily,
            ramp_days: clamped.rampDays,
            maintenance_daily: clamped.maintenanceDaily,
            updated_at: new Date(),
        },
    });
    logger.info('[WARMUP] membership config updated', { mailboxId, organizationId, ...clamped });
}

/**
 * Bulk-apply config across every membership in an org. Single SQL
 * UPDATE so it stays atomic - either every mailbox in the workspace
 * gets the new config or none do.
 *
 * Returns the number of rows touched. The caller surfaces it to the
 * UI as a toast confirmation.
 *
 * Note: only the four config columns are touched. ramp_step,
 * current_daily, health, and counters are NOT reset - operators bumping
 * a target should expect their mailboxes to keep their existing
 * progress, not restart from day 0.
 */
export async function bulkUpdateOrgConfig(
    organizationId: string,
    cfg: MembershipConfig,
): Promise<{ updated: number }> {
    const clamped = clampConfig(cfg);
    const result = await prisma.warmupPoolMembership.updateMany({
        where: { organization_id: organizationId },
        data: {
            start_daily: clamped.startDaily,
            target_daily: clamped.targetDaily,
            ramp_days: clamped.rampDays,
            maintenance_daily: clamped.maintenanceDaily,
        },
    });
    logger.info('[WARMUP] bulk pool config applied', { organizationId, ...clamped, updated: result.count });
    return { updated: result.count };
}

// ────────────────────────────────────────────────────────────────────
// Ramp computation - called nightly by warmupRampWorker.
//
// Formula (linear ramp, start → target over ramp_days):
//   day 0      → start_daily
//   day N      → start_daily + N * ((target - start) / ramp_days)
//   day ≥ days → target_daily, then drop to maintenance_daily
//
// Hard cap: never above MAX_TARGET_DAILY (50) regardless of input.
// ────────────────────────────────────────────────────────────────────

export function computeDailyForStep(opts: {
    rampStep: number;
    startDaily: number;
    targetDaily: number;
    rampDays: number;
    maintenanceDaily: number;
}): number {
    const step = Math.max(0, opts.rampStep);
    if (step >= opts.rampDays) return Math.min(opts.maintenanceDaily, MAX_TARGET_DAILY);

    const range = opts.targetDaily - opts.startDaily;
    const perDay = range / opts.rampDays;
    const computed = Math.round(opts.startDaily + step * perDay);
    return Math.max(0, Math.min(computed, MAX_TARGET_DAILY));
}

export interface RampDecision {
    nextRampStep: number;
    nextDaily: number;
    nextHealth: WarmupHealth;
    rampPaused: boolean;
}

/** Pure function: decides what TO write tomorrow given today's state +
 *  observed spam rate. Worker applies the decision. */
export function decideNextRamp(current: {
    rampStep: number;
    startDaily: number;
    targetDaily: number;
    rampDays: number;
    maintenanceDaily: number;
    spamRate30d: number | null;
    enabled: boolean;
}): RampDecision {
    if (!current.enabled) {
        return { nextRampStep: current.rampStep, nextDaily: 0, nextHealth: 'paused', rampPaused: true };
    }

    const spam = current.spamRate30d ?? 0;

    // Hard error threshold - stop sending entirely until operator clears.
    if (spam >= SPAM_RATE_ERROR_THRESHOLD) {
        return { nextRampStep: current.rampStep, nextDaily: 0, nextHealth: 'error', rampPaused: true };
    }

    // Soft pause - hold ramp but keep sending at current cap so the
    // mailbox doesn't idle.
    if (spam >= SPAM_RATE_PAUSE_THRESHOLD) {
        const heldDaily = computeDailyForStep(current);
        return {
            nextRampStep: current.rampStep,
            nextDaily: heldDaily,
            nextHealth: 'warming',
            rampPaused: true,
        };
    }

    const nextStep = current.rampStep + 1;
    const nextDaily = computeDailyForStep({ ...current, rampStep: nextStep });
    const nextHealth: WarmupHealth = nextStep >= current.rampDays ? 'maintenance' : 'warming';
    return { nextRampStep: nextStep, nextDaily, nextHealth, rampPaused: false };
}

// ────────────────────────────────────────────────────────────────────
// Spam-rate computation - called nightly to recompute spam_rate_30d
// from WarmupExchange rows.
// ────────────────────────────────────────────────────────────────────

export async function computeSpamRate(mailboxId: string, windowDays = 30): Promise<number | null> {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const exchanges = await prisma.warmupExchange.findMany({
        where: {
            sender_mailbox_id: mailboxId,
            sent_at: { gte: since },
            // Only count emails the recipient actually received and bucketed.
            // A still-scheduled or failed-to-send row gives no signal.
            landed_in: { not: null },
        },
        select: { landed_in: true },
    });
    if (exchanges.length === 0) return null;

    const spam = exchanges.filter(e => e.landed_in === 'spam' || e.landed_in === 'promotions').length;
    return spam / exchanges.length;
}
