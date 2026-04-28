/**
 * Lead Health Re-Evaluation Worker
 *
 * Periodically re-evaluates leads to detect classification changes.
 *
 * Two cycles:
 *   1. UPGRADE CYCLE (every 24h, default): scans YELLOW/RED leads, upgrades on
 *      improved checks. Prioritizes leads with assigned_campaign_id (imminent
 *      enrollment) ahead of dormant leads.
 *   2. DOWNGRADE CYCLE (every 24h, runs after upgrade): scans GREEN leads
 *      whose health was last verified >HEALTH_FULL_REVERIFY_DAYS ago. Downgrades
 *      to YELLOW only if (a) score drops ≥HEALTH_DOWNGRADE_MIN_DROP points AND
 *      (b) lead is NOT currently in an active sequence step (avoids disrupting
 *      in-flight campaigns mid-stream).
 *
 * Industry alignment: M3AAWG BCP §3.4 + ZeroBounce/Kickbox: bi-directional
 * list hygiene with quarterly full re-verification. Email decay = ~5–7%/quarter.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../index';
import { logger } from './observabilityService';
import * as leadHealthService from './leadHealthService';
import * as auditLogService from './auditLogService';
import { MONITORING_THRESHOLDS } from '../types';

const {
    HEALTH_DOWNGRADE_MIN_DROP,
    HEALTH_FULL_REVERIFY_DAYS,
} = MONITORING_THRESHOLDS;

// ============================================================================
// TYPES
// ============================================================================

interface WorkerStatus {
    lastRunAt: Date | null;
    lastError: string | null;
    totalReclassified: number;
    lastBatchSize: number;
}

type HealthClassification = 'green' | 'yellow' | 'red';

// ============================================================================
// STATE
// ============================================================================

let workerInterval: NodeJS.Timeout | null = null;
let workerStatus: WorkerStatus = {
    lastRunAt: null,
    lastError: null,
    totalReclassified: 0,
    lastBatchSize: 0,
};

// Run every 24 hours by default (configurable via env var)
const RE_EVAL_INTERVAL_MS = parseInt(process.env.LEAD_HEALTH_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);

// Process in batches to avoid DB overload
const BATCH_SIZE = 50;

// Classification rank for direction-of-change comparison.
// Schema stores values lowercase; leadHealthService returns lowercase. Keep keys
// matching the storage layer so rank lookups don't silently default to 0.
const CLASSIFICATION_RANK: Record<HealthClassification, number> = {
    red: 0,
    yellow: 1,
    green: 2,
};

function normalizeClassification(c: string | null | undefined): HealthClassification {
    const v = (c || 'red').toLowerCase();
    if (v === 'green' || v === 'yellow' || v === 'red') return v;
    return 'red';
}

// ============================================================================
// WORKER LIFECYCLE
// ============================================================================

/**
 * Start the lead health re-evaluation worker.
 * Runs the first check after 5 minutes, then every 24 hours.
 */
export function startLeadHealthWorker(): void {
    if (workerInterval) {
        logger.warn('[LEAD-HEALTH-WORKER] Worker already running');
        return;
    }

    // First run after 5 minutes (let the server warm up)
    setTimeout(runReEvaluation, 5 * 60 * 1000);

    // Then every 24 hours
    workerInterval = setInterval(runReEvaluation, RE_EVAL_INTERVAL_MS);

    logger.info('[LEAD-HEALTH-WORKER] Started (24h interval, first run in 5min)');
}

/**
 * Get worker status for health checks.
 */
export function getLeadHealthWorkerStatus(): WorkerStatus {
    return { ...workerStatus };
}

// ============================================================================
// RE-EVALUATION LOGIC
// ============================================================================

/**
 * Run a full re-evaluation cycle.
 * Processes YELLOW and RED leads in batches.
 */
async function runReEvaluation(): Promise<void> {
    const startTime = Date.now();
    logger.info('[LEAD-HEALTH-WORKER] Starting re-evaluation cycle');

    try {
        const upgradeStats = await runUpgradeCycle();
        const downgradeStats = await runDowngradeCycle();

        workerStatus = {
            lastRunAt: new Date(),
            lastError: null,
            totalReclassified:
                workerStatus.totalReclassified + upgradeStats.upgraded + downgradeStats.downgraded,
            lastBatchSize: upgradeStats.processed + downgradeStats.processed,
        };

        logger.info('[LEAD-HEALTH-WORKER] Re-evaluation cycle complete', {
            upgrade: upgradeStats,
            downgrade: downgradeStats,
            durationMs: Date.now() - startTime,
        });
    } catch (err) {
        workerStatus.lastError = (err as Error).message;
        workerStatus.lastRunAt = new Date();
        logger.error('[LEAD-HEALTH-WORKER] Re-evaluation cycle failed', err as Error);
    }
}

/**
 * Upgrade cycle: scans YELLOW/RED leads, upgrades on improved checks.
 * Priority: leads with assigned_campaign_id (imminent enrollment) first.
 */
async function runUpgradeCycle(): Promise<{ processed: number; upgraded: number }> {
    let processed = 0;
    let upgraded = 0;
    const cutoff = new Date(Date.now() - RE_EVAL_INTERVAL_MS);

    // Two passes: priority leads (assigned to a campaign) first, then the rest.
    for (const priorityPass of [true, false] as const) {
        let hasMore = true;
        let skip = 0;

        while (hasMore && processed < 500) {
            const leads = await prisma.lead.findMany({
                where: {
                    health_classification: { in: ['yellow', 'red'] },
                    assigned_campaign_id: priorityPass ? { not: null } : null,
                    OR: [
                        { health_checked_at: null },
                        { health_checked_at: { lt: cutoff } },
                    ],
                },
                select: {
                    id: true,
                    email: true,
                    organization_id: true,
                    health_classification: true,
                    health_score_calc: true,
                },
                take: BATCH_SIZE,
                skip,
                orderBy: { health_checked_at: 'asc' },
            });

            if (leads.length === 0) {
                hasMore = false;
                break;
            }

            for (const lead of leads) {
                try {
                    const didUpgrade = await reclassifyLead(lead);
                    if (didUpgrade) upgraded++;
                    processed++;
                } catch (err) {
                    logger.error('[LEAD-HEALTH-WORKER] Error reclassifying lead', err as Error, {
                        leadId: lead.id, priorityPass,
                    });
                }
                if (processed >= 500) break;
            }

            skip += BATCH_SIZE;
        }
    }

    return { processed, upgraded };
}

/**
 * Downgrade cycle: scans GREEN leads checked >HEALTH_FULL_REVERIFY_DAYS ago.
 * Downgrades to YELLOW only if (a) score drops ≥HEALTH_DOWNGRADE_MIN_DROP AND
 * (b) lead is NOT in an active campaign sequence (status != 'active').
 *
 * Industry alignment: M3AAWG BCP §3.4 — bi-directional hygiene; quarterly
 * full re-verification with conservative thresholds to avoid disrupting
 * in-flight sequences.
 */
async function runDowngradeCycle(): Promise<{ processed: number; downgraded: number }> {
    let processed = 0;
    let downgraded = 0;
    const reverifyCutoff = new Date(Date.now() - HEALTH_FULL_REVERIFY_DAYS * 24 * 60 * 60 * 1000);

    let hasMore = true;
    let skip = 0;

    while (hasMore && processed < 500) {
        const leads = await prisma.lead.findMany({
            where: {
                health_classification: 'green',
                status: { not: 'active' },  // Don't disrupt in-flight sequences
                OR: [
                    { health_checked_at: null },
                    { health_checked_at: { lt: reverifyCutoff } },
                ],
            },
            select: {
                id: true,
                email: true,
                organization_id: true,
                health_classification: true,
                health_score_calc: true,
            },
            take: BATCH_SIZE,
            skip,
            orderBy: { health_checked_at: 'asc' },
        });

        if (leads.length === 0) {
            hasMore = false;
            break;
        }

        for (const lead of leads) {
            try {
                const didDowngrade = await maybeDowngradeLead(lead);
                if (didDowngrade) downgraded++;
                processed++;
            } catch (err) {
                logger.error('[LEAD-HEALTH-WORKER] Error in downgrade re-eval', err as Error, {
                    leadId: lead.id,
                });
            }
            if (processed >= 500) break;
        }

        skip += BATCH_SIZE;
    }

    return { processed, downgraded };
}

/**
 * Re-evaluate a GREEN lead and downgrade to YELLOW if score dropped materially.
 */
async function maybeDowngradeLead(lead: {
    id: string;
    email: string;
    organization_id: string;
    health_classification: string | null;
    health_score_calc: number | null;
}): Promise<boolean> {
    const newResult = await leadHealthService.classifyLeadHealth(lead.email);
    const oldScore = lead.health_score_calc ?? 100;
    const scoreDrop = oldScore - newResult.score;

    const updateData: Prisma.LeadUpdateInput = {
        health_checked_at: new Date(),
        health_score_calc: newResult.score,
        health_checks: newResult.checks as Prisma.InputJsonValue,
    };

    const willDowngrade =
        newResult.classification !== 'green' &&
        scoreDrop >= HEALTH_DOWNGRADE_MIN_DROP;

    if (willDowngrade) {
        updateData.health_classification = newResult.classification;
    }

    await prisma.lead.update({ where: { id: lead.id }, data: updateData });

    if (willDowngrade) {
        await auditLogService.logAction({
            organizationId: lead.organization_id,
            entity: 'lead',
            entityId: lead.id,
            trigger: 'system_re_evaluation',
            action: 'lead_health_downgraded',
            details: JSON.stringify({
                from: 'green',
                to: newResult.classification,
                oldScore, newScore: newResult.score, scoreDrop,
                reasons: newResult.reasons,
            }),
        });
        logger.info(`[LEAD-HEALTH-WORKER] Lead ${lead.id} downgraded green → ${newResult.classification} (score ${oldScore} → ${newResult.score})`);
        return true;
    }
    return false;
}

/**
 * Re-classify a single lead based on current email health checks.
 * Only upgrades (YELLOW→GREEN, RED→YELLOW). Never auto-downgrades.
 * Returns true if the lead was upgraded.
 */
async function reclassifyLead(lead: {
    id: string;
    email: string;
    organization_id: string;
    health_classification: string | null;
    health_score_calc: number | null;
}): Promise<boolean> {
    const currentClassification = normalizeClassification(lead.health_classification);
    const currentRank = CLASSIFICATION_RANK[currentClassification];

    // Re-run health checks
    const newResult = await leadHealthService.classifyLeadHealth(lead.email);
    const newClassification = normalizeClassification(newResult.classification);
    const newRank = CLASSIFICATION_RANK[newClassification];

    const updateData: Prisma.LeadUpdateInput = {
        health_checked_at: new Date(),
        health_score_calc: newResult.score,
        health_checks: newResult.checks as Prisma.InputJsonValue,
    };

    const willUpgrade = newRank > currentRank;
    if (willUpgrade) {
        updateData.health_classification = newClassification;
    }

    await prisma.lead.update({
        where: { id: lead.id },
        data: updateData,
    });

    if (willUpgrade) {
        await auditLogService.logAction({
            organizationId: lead.organization_id,
            entity: 'lead',
            entityId: lead.id,
            trigger: 'system_re_evaluation',
            action: 'lead_health_upgraded',
            details: JSON.stringify({
                from: currentClassification,
                to: newClassification,
                oldScore: lead.health_score_calc,
                newScore: newResult.score,
                reasons: newResult.reasons,
            }),
        });

        logger.info(`[LEAD-HEALTH-WORKER] Lead ${lead.id} upgraded: ${currentClassification} → ${newClassification}`);
        return true;
    }

    return false;
}
