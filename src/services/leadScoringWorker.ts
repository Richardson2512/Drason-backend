/**
 * Lead Scoring Worker
 *
 * Runs periodically to update lead scores based on engagement data.
 * Should run daily or after major sync operations.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as leadScoringService from './leadScoringService';

// Run every 24 hours
const SCORING_INTERVAL_MS = 24 * 60 * 60 * 1000;

let scoringInterval: NodeJS.Timeout | null = null;

/**
 * Start the lead scoring worker.
 */
export function startLeadScoringWorker(): void {
    if (scoringInterval) {
        logger.warn('[LEAD-SCORING-WORKER] Already running');
        return;
    }

    logger.info('[LEAD-SCORING-WORKER] Starting lead scoring worker');

    // Run immediately on startup
    runScoringCycle().catch(error => {
        logger.error('[LEAD-SCORING-WORKER] Initial scoring cycle failed', error);
    });

    // Then run on interval
    scoringInterval = setInterval(async () => {
        try {
            await runScoringCycle();
        } catch (error) {
            logger.error('[LEAD-SCORING-WORKER] Scoring cycle failed', error instanceof Error ? error : new Error(String(error)));
        }
    }, SCORING_INTERVAL_MS);

    logger.info(`[LEAD-SCORING-WORKER] Scheduled to run every ${SCORING_INTERVAL_MS / 1000 / 60 / 60} hours`);
}

/**
 * Stop the lead scoring worker.
 */
export function stopLeadScoringWorker(): void {
    if (scoringInterval) {
        clearInterval(scoringInterval);
        scoringInterval = null;
        logger.info('[LEAD-SCORING-WORKER] Stopped');
    }
}

/**
 * Run a complete scoring cycle for all organizations.
 */
async function runScoringCycle(): Promise<void> {
    logger.info('[LEAD-SCORING-WORKER] Starting scoring cycle');

    try {
        // Get all organizations with Smartlead leads
        const organizations = await prisma.organization.findMany({
            where: {
                leads: {
                    some: {
                        source: 'smartlead'
                    }
                }
            },
            select: {
                id: true,
                name: true
            }
        });

        logger.info(`[LEAD-SCORING-WORKER] Processing ${organizations.length} organizations`);

        let totalUpdated = 0;

        for (const org of organizations) {
            try {
                const result = await leadScoringService.syncLeadScoresFromSmartlead(org.id);

                logger.info('[LEAD-SCORING-WORKER] Org scoring complete', {
                    orgId: org.id,
                    orgName: org.name,
                    updated: result.updated,
                    topLeadScore: result.topLeads[0]?.score || 0
                });

                totalUpdated += result.updated;
            } catch (orgError: any) {
                logger.error(`[LEAD-SCORING-WORKER] Failed to score org ${org.id}`, orgError);
                // Continue with other orgs
            }
        }

        logger.info('[LEAD-SCORING-WORKER] Scoring cycle complete', {
            organizations: organizations.length,
            totalUpdated
        });

    } catch (error: any) {
        logger.error('[LEAD-SCORING-WORKER] Cycle failed', error);
        throw error;
    }
}

/**
 * Manually trigger a scoring cycle (for API endpoint).
 */
export async function triggerManualScoring(organizationId?: string): Promise<{
    updated: number;
    topLeads: any[];
}> {
    if (organizationId) {
        logger.info('[LEAD-SCORING-WORKER] Manual scoring triggered for org', { organizationId });
        return await leadScoringService.syncLeadScoresFromSmartlead(organizationId);
    } else {
        logger.info('[LEAD-SCORING-WORKER] Manual scoring triggered for all orgs');
        await runScoringCycle();
        return { updated: 0, topLeads: [] };
    }
}
