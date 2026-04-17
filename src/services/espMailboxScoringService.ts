/**
 * ESP Mailbox Scoring Service
 *
 * Scores campaign mailboxes against a recipient's ESP bucket using
 * 30-day rolling performance data from MailboxEspPerformance.
 *
 * Returns the top N mailbox external IDs for use in assigned_email_accounts.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

const MIN_SENDS_FOR_SCORING = 30; // Minimum sends per cell before we trust the score
const TOP_N_MAILBOXES = 3; // How many mailboxes to pin per lead

interface ScoredMailbox {
    mailboxId: string;
    externalId: string;
    espMatch: boolean;
    bounceRate30d: number;
    sendCount30d: number;
    score: number;
}

/**
 * Score campaign mailboxes for a given recipient ESP bucket.
 * Returns external email account IDs of the top-performing mailboxes,
 * or null if insufficient data (caller should fall back to standard routing).
 */
export async function scoreMailboxesForEsp(
    organizationId: string,
    campaignId: string,
    recipientEsp: string
): Promise<string[] | null> {
    try {
        // Get all mailboxes attached to this campaign
        const campaignMailboxes = await prisma.mailbox.findMany({
            where: {
                campaigns: { some: { id: campaignId } },
                status: 'healthy',
            },
            select: {
                id: true,
                external_email_account_id: true,
            },
        });

        if (campaignMailboxes.length <= 1) return null; // Nothing to choose from

        // Get ESP performance data for these mailboxes
        const mailboxIds = campaignMailboxes.map(m => m.id);
        const perfData = await prisma.mailboxEspPerformance.findMany({
            where: {
                mailbox_id: { in: mailboxIds },
                esp_bucket: recipientEsp,
            },
        });

        const perfMap = new Map(perfData.map(p => [p.mailbox_id, p]));

        // Check if we have enough data to score meaningfully
        const mailboxesWithData = perfData.filter(p => p.send_count_30d >= MIN_SENDS_FOR_SCORING);
        if (mailboxesWithData.length < 2) {
            // Not enough data — fall back to standard routing
            logger.info('[ESP-SCORING] Insufficient data for ESP scoring, using standard routing', {
                organizationId,
                campaignId,
                recipientEsp,
                mailboxesWithData: mailboxesWithData.length,
            });
            return null;
        }

        // Score each mailbox
        const scored: ScoredMailbox[] = campaignMailboxes
            .filter(m => m.external_email_account_id)
            .map(m => {
                const perf = perfMap.get(m.id);
                const sendCount = perf?.send_count_30d || 0;
                const bounceRate = perf?.bounce_rate_30d || 0;
                const hasData = sendCount >= MIN_SENDS_FOR_SCORING;

                // Score: lower bounce rate = better. Bonus for more data (higher confidence).
                // Range: 0-100 where 100 = perfect (0% bounce, lots of sends)
                let score = 70; // default for no data
                if (hasData) {
                    // Bounce penalty: 0% = 100 score, 1% = 80, 2% = 60, 5% = 0
                    score = Math.max(0, 100 - (bounceRate * 100 * 20));
                    // Volume confidence bonus: up to +10 for high volume
                    const volumeBonus = Math.min(10, sendCount / 50);
                    score = Math.min(100, score + volumeBonus);
                }

                return {
                    mailboxId: m.id,
                    externalId: m.external_email_account_id!,
                    espMatch: false,
                    bounceRate30d: bounceRate,
                    sendCount30d: sendCount,
                    score,
                };
            });

        // Sort by score descending, take top N
        scored.sort((a, b) => b.score - a.score);
        const topMailboxes = scored.slice(0, TOP_N_MAILBOXES);

        logger.info('[ESP-SCORING] Scored mailboxes for ESP routing', {
            organizationId,
            campaignId,
            recipientEsp,
            totalMailboxes: scored.length,
            topMailboxes: topMailboxes.map(m => ({
                id: m.mailboxId,
                score: Math.round(m.score),
                bounceRate: m.bounceRate30d,
                sends: m.sendCount30d,
            })),
        });

        return topMailboxes.map(m => m.externalId);
    } catch (err: any) {
        logger.error('[ESP-SCORING] Scoring failed, falling back to standard routing', err, {
            organizationId, campaignId, recipientEsp,
        });
        return null;
    }
}
