/**
 * Agent supervisor worker - consumes unprocessed EngagementEvent rows
 * and routes them through the signal→action loop in supervisor.ts.
 *
 * Ticks every 30 seconds. Batches up to 50 events per cycle so the
 * worker can keep up with steady-state polling load (4 cycles/day per
 * account × N accounts produces maybe 5-50 events per minute for a
 * mid-size customer). Crash-safe: events are marked processed inside
 * supervisor.processEvent ONLY after the agent envelope completes, so
 * a worker crash mid-batch is re-tried on the next cycle.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { processEvent } from '../services/agents/supervisor';

const RUN_INTERVAL_MS = 30 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;
const BATCH_SIZE = 50;

let scheduled: NodeJS.Timeout | null = null;
let totalCycles = 0;
let totalProcessed = 0;
let totalErrors = 0;
let lastError: string | null = null;
const outcomeCounts: Record<string, number> = {};

export async function runOnce(): Promise<{ processed: number; errors: number; outcomes: Record<string, number> }> {
    const events = await prisma.engagementEvent.findMany({
        where: { processed_at: null },
        orderBy: { ingested_at: 'asc' },
        take: BATCH_SIZE,
        select: {
            id: true,
            organization_id: true,
            linkedin_post_id: true,
            actor_profile_id: true,
            event_type: true,
            reaction_type: true,
            occurred_at: true,
        },
    });

    let processed = 0;
    let errors = 0;
    const outcomes: Record<string, number> = {};

    for (const ev of events) {
        try {
            const outcome = await processEvent(ev);
            outcomes[outcome] = (outcomes[outcome] || 0) + 1;
            processed++;
        } catch (err) {
            errors++;
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('[AGENT-SUPERVISOR] event processing failed', err instanceof Error ? err : new Error(msg));
            // Mark processed with error sentinel so we don't loop on the same
            // broken row forever. The AgentRun row keeps the error context.
            try {
                await prisma.engagementEvent.update({
                    where: { id: ev.id },
                    data: { processed_at: new Date() },
                });
            } catch { /* swallow */ }
        }
    }

    return { processed, errors, outcomes };
}

async function tick(): Promise<void> {
    totalCycles += 1;
    try {
        const { processed, errors, outcomes } = await runOnce();
        totalProcessed += processed;
        totalErrors += errors;
        for (const [k, v] of Object.entries(outcomes)) {
            outcomeCounts[k] = (outcomeCounts[k] || 0) + v;
        }
        if (processed > 0 || errors > 0) {
            logger.info('[AGENT-SUPERVISOR] Cycle complete', { processed, errors, outcomes });
        }
        lastError = null;
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('[AGENT-SUPERVISOR] Cycle failed', err instanceof Error ? err : new Error(lastError));
    }
}

export function scheduleAgentSupervisorWorker(): void {
    if (scheduled) return;
    setTimeout(() => {
        void tick();
        scheduled = setInterval(() => { void tick(); }, RUN_INTERVAL_MS);
    }, FIRST_RUN_DELAY_MS);
    logger.info('[AGENT-SUPERVISOR] Scheduled', { intervalMs: RUN_INTERVAL_MS, batchSize: BATCH_SIZE });
}

export function stopAgentSupervisorWorker(): void {
    if (scheduled) {
        clearInterval(scheduled);
        scheduled = null;
    }
}

export function getAgentSupervisorStatus() {
    return { totalCycles, totalProcessed, totalErrors, outcomeCounts, lastError, scheduled: Boolean(scheduled) };
}
