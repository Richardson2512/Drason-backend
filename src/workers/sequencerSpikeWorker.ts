/**
 * Sequencer spike detector — runs hourly, scans active campaigns, alerts to
 * Slack when bounce or unsubscribe rates cross thresholds.
 *
 * Thresholds chosen to fire BEFORE the protection layer auto-pauses anything:
 *   • Bounce > 5% over the last 1h, with ≥ 50 sends in the window
 *   • Unsubscribe > 2% over the last 24h, with ≥ 100 sends in the window
 *
 * The min-sample gate avoids noisy alerts on tiny denominators
 * (e.g. 1/2 = 50% bounce on a brand-new campaign).
 *
 * Idempotency: SlackAlertService dedupes within 15-minute buckets keyed on
 * org+eventType+entityId, so repeat ticks while the spike persists won't
 * re-alert until the bucket rolls over.
 */
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { SlackAlertService } from '../services/SlackAlertService';

const LOG_TAG = 'SEQUENCER-SPIKE';
const TICK_MS = 60 * 60 * 1000; // 1 hour

const BOUNCE_WINDOW_MS = 60 * 60 * 1000;     // 1h
const BOUNCE_RATE_THRESHOLD = 0.05;          // 5%
const BOUNCE_MIN_SENDS = 50;

const UNSUB_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const UNSUB_RATE_THRESHOLD = 0.02;           // 2%
const UNSUB_MIN_SENDS = 100;

let interval: NodeJS.Timeout | null = null;

async function runTick(): Promise<void> {
    try {
        const activeCampaigns = await prisma.campaign.findMany({
            where: { status: 'active' },
            select: { id: true, organization_id: true, name: true },
        });

        if (activeCampaigns.length === 0) return;

        const now = Date.now();
        const bounceSince = new Date(now - BOUNCE_WINDOW_MS);
        const unsubSince = new Date(now - UNSUB_WINDOW_MS);

        for (const campaign of activeCampaigns) {
            try {
                // ── Bounce spike (1h) ──────────────────────────────────────
                const [bounces1h, sends1h] = await Promise.all([
                    prisma.bounceEvent.count({
                        where: {
                            campaign_id: campaign.id,
                            bounced_at: { gte: bounceSince },
                        },
                    }),
                    prisma.sendEvent.count({
                        where: {
                            campaign_id: campaign.id,
                            sent_at: { gte: bounceSince },
                        },
                    }),
                ]);

                if (sends1h >= BOUNCE_MIN_SENDS) {
                    const rate = bounces1h / sends1h;
                    if (rate > BOUNCE_RATE_THRESHOLD) {
                        const pct = (rate * 100).toFixed(1);
                        SlackAlertService.sendAlert({
                            organizationId: campaign.organization_id,
                            eventType: 'campaign.bounce_spike',
                            entityId: campaign.id,
                            severity: 'warning',
                            title: '📈 Bounce rate spike',
                            message: `*${campaign.name}* bounced *${pct}%* in the last hour (${bounces1h}/${sends1h}). Threshold is 5%. Investigate list quality and mailbox health before protection auto-pauses.`,
                        }).catch((err) => logger.warn(`[${LOG_TAG}] alert failed (bounce_spike)`, { error: err?.message }));
                    }
                }

                // ── Unsubscribe spike (24h) ────────────────────────────────
                const [unsubs24h, sends24h] = await Promise.all([
                    prisma.campaignLead.count({
                        where: {
                            campaign_id: campaign.id,
                            unsubscribed_at: { gte: unsubSince },
                        },
                    }),
                    prisma.sendEvent.count({
                        where: {
                            campaign_id: campaign.id,
                            sent_at: { gte: unsubSince },
                        },
                    }),
                ]);

                if (sends24h >= UNSUB_MIN_SENDS) {
                    const rate = unsubs24h / sends24h;
                    if (rate > UNSUB_RATE_THRESHOLD) {
                        const pct = (rate * 100).toFixed(1);
                        SlackAlertService.sendAlert({
                            organizationId: campaign.organization_id,
                            eventType: 'campaign.unsubscribe_spike',
                            entityId: campaign.id,
                            severity: 'warning',
                            title: '📉 Unsubscribe rate spike',
                            message: `*${campaign.name}* unsubscribe rate is *${pct}%* over the last 24h (${unsubs24h}/${sends24h}). Threshold is 2%. Review copy and audience targeting.`,
                        }).catch((err) => logger.warn(`[${LOG_TAG}] alert failed (unsubscribe_spike)`, { error: err?.message }));
                    }
                }
            } catch (err: any) {
                logger.error(`[${LOG_TAG}] Campaign scan failed`, err, { campaignId: campaign.id });
            }
        }
    } catch (err: any) {
        logger.error(`[${LOG_TAG}] Tick failed`, err);
    }
}

export function scheduleSequencerSpikeWorker(): void {
    if (interval) return;
    runTick().catch(() => {});
    interval = setInterval(() => { runTick().catch(() => {}); }, TICK_MS);
    logger.info(`[${LOG_TAG}] Scheduled — hourly tick`);
}

export function stopSequencerSpikeWorker(): void {
    if (interval) {
        clearInterval(interval);
        interval = null;
    }
}
