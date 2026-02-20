/**
 * Mailbox Enrichment Controller
 *
 * API endpoints for backfilling mailbox engagement statistics.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import * as mailboxEnrichmentService from '../services/mailboxEnrichmentService';
import { logger } from '../services/observabilityService';

/**
 * POST /api/mailboxes/backfill-stats
 * Backfill mailbox engagement stats from historical lead data.
 */
export const backfillMailboxStats = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);

        logger.info('[MAILBOX-ENRICHMENT] Manual backfill triggered', { orgId });

        const result = await mailboxEnrichmentService.backfillMailboxStatsFromLeads(orgId);

        res.json({
            success: true,
            message: `Updated ${result.mailboxesUpdated} mailboxes with historical engagement data`,
            data: {
                mailboxesUpdated: result.mailboxesUpdated,
                totalOpens: result.totalOpens,
                totalClicks: result.totalClicks,
                totalReplies: result.totalReplies
            }
        });
    } catch (error: any) {
        logger.error('[MAILBOX-ENRICHMENT] Backfill failed', error);
        res.status(500).json({
            success: false,
            error: 'Failed to backfill mailbox stats',
            message: error.message
        });
    }
};

/**
 * POST /api/mailboxes/:mailboxId/backfill-stats
 * Backfill stats for a single mailbox.
 */
export const backfillSingleMailbox = async (req: Request, res: Response): Promise<void> => {
    try {
        const mailboxId = req.params.mailboxId;

        logger.info('[MAILBOX-ENRICHMENT] Single mailbox backfill triggered', { mailboxId });

        const result = await mailboxEnrichmentService.backfillSingleMailboxStats(mailboxId);

        res.json({
            success: true,
            message: `Backfilled stats for mailbox ${mailboxId}`,
            data: {
                opensAdded: result.opensAdded,
                clicksAdded: result.clicksAdded,
                repliesAdded: result.repliesAdded
            }
        });
    } catch (error: any) {
        logger.error('[MAILBOX-ENRICHMENT] Single mailbox backfill failed', error);
        res.status(500).json({
            success: false,
            error: 'Failed to backfill mailbox stats',
            message: error.message
        });
    }
};
