/**
 * Lead Health Re-Evaluation Worker
 * 
 * Periodically re-evaluates YELLOW and RED leads to detect classification improvements.
 * 
 * Safety rules:
 *   - AUTO-UPGRADE ONLY: YELLOW → GREEN, RED → YELLOW (based on improved checks)
 *   - NO AUTO-DOWNGRADE: GREEN → YELLOW/RED never happens automatically
 *   - Downgrades only via event-driven triggers (bounces, complaints)
 *   - Runs every 24 hours
 *   - Processes in batches of 50 to avoid DB overload
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as leadHealthService from './leadHealthService';
import * as auditLogService from './auditLogService';

// ============================================================================
// TYPES
// ============================================================================

interface WorkerStatus {
    lastRunAt: Date | null;
    lastError: string | null;
    totalReclassified: number;
    lastBatchSize: number;
}

type HealthClassification = 'GREEN' | 'YELLOW' | 'RED';

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

// Run every 24 hours
const RE_EVAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Process in batches to avoid DB overload
const BATCH_SIZE = 50;

// Classification rank for upgrade-only comparison
const CLASSIFICATION_RANK: Record<HealthClassification, number> = {
    RED: 0,
    YELLOW: 1,
    GREEN: 2,
};

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
        let totalProcessed = 0;
        let totalUpgraded = 0;

        // Get YELLOW and RED leads that haven't been re-evaluated in 24h
        const cutoff = new Date(Date.now() - RE_EVAL_INTERVAL_MS);

        let hasMore = true;
        let skip = 0;

        while (hasMore) {
            const leads = await prisma.lead.findMany({
                where: {
                    health_classification: { in: ['YELLOW', 'RED'] },
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
                orderBy: { health_checked_at: 'asc' }, // Oldest checked first
            });

            if (leads.length === 0) {
                hasMore = false;
                break;
            }

            for (const lead of leads) {
                try {
                    const upgraded = await reclassifyLead(lead);
                    if (upgraded) totalUpgraded++;
                    totalProcessed++;
                } catch (err) {
                    logger.error('[LEAD-HEALTH-WORKER] Error reclassifying lead', err as Error, {
                        leadId: lead.id,
                    });
                }
            }

            skip += BATCH_SIZE;

            // Safety: don't process more than 500 leads per cycle
            if (totalProcessed >= 500) {
                logger.info('[LEAD-HEALTH-WORKER] Reached batch limit (500), stopping cycle');
                hasMore = false;
            }
        }

        workerStatus = {
            lastRunAt: new Date(),
            lastError: null,
            totalReclassified: workerStatus.totalReclassified + totalUpgraded,
            lastBatchSize: totalProcessed,
        };

        const durationMs = Date.now() - startTime;
        logger.info('[LEAD-HEALTH-WORKER] Re-evaluation cycle complete', {
            totalProcessed,
            totalUpgraded,
            durationMs,
        });
    } catch (err) {
        workerStatus.lastError = (err as Error).message;
        workerStatus.lastRunAt = new Date();
        logger.error('[LEAD-HEALTH-WORKER] Re-evaluation cycle failed', err as Error);
    }
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
    const currentClassification = (lead.health_classification || 'RED') as HealthClassification;
    const currentRank = CLASSIFICATION_RANK[currentClassification] ?? 0;

    // Re-run health checks
    const newResult = await leadHealthService.classifyLeadHealth(lead.email);
    const newRank = CLASSIFICATION_RANK[newResult.classification as HealthClassification] ?? 0;

    const updateData: any = {
        health_checked_at: new Date(),
        health_score_calc: newResult.score,
        health_checks: newResult.checks as any,
    };

    const willUpgrade = newRank > currentRank;
    if (willUpgrade) {
        updateData.health_classification = newResult.classification;
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
                to: newResult.classification,
                oldScore: lead.health_score_calc,
                newScore: newResult.score,
                reasons: newResult.reasons,
            }),
        });

        logger.info(`[LEAD-HEALTH-WORKER] Lead ${lead.id} upgraded: ${currentClassification} → ${newResult.classification}`);
        return true;
    }

    return false;
}
