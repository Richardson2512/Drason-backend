/**
 * 15-min delayed reply-tag worker — Auto-Tag pipeline.
 *
 * The Auto-Tag fires 15 minutes after the first reply (workspace-wide,
 * one tag per lead, latest-wins). This worker scans LinkedInProfile rows
 * where the webhook handler staged a pending classification ≥ 15 min ago,
 * runs the classifier, persists the tag, and clears the pending fields.
 *
 * The webhook handler writes the pending data into auto_tag_pending +
 * sets auto_tag_pending_at to now() — NOT now()+15min — so a fresh
 * reply landing in the window naturally pushes the due-time forward
 * (latest-text wins).
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { classifyReply } from '../services/agents/replyClassifier';
import { pauseCrossChannelForLead } from '../services/crossChannelSuppressionService';

/**
 * Map the LinkedIn auto-tag taxonomy (Interested / Not Interested / Generic)
 * into the cross-channel suppression service's reply-class vocabulary so
 * the CLASSIFIED + ASYMMETRIC policy gates fire correctly. Interested maps
 * to 'positive' (intent-bearing, pauses email), Not Interested to 'hard_no'
 * (intent-bearing, also pauses email), Generic stays 'generic' (noisy —
 * CLASSIFIED skips, ASYMMETRIC also skips for LinkedIn→email).
 */
function mapLinkedInTagToReplyClass(tag: string): string {
    if (tag === 'Interested') return 'positive';
    if (tag === 'Not Interested') return 'hard_no';
    return 'generic';
}

const RUN_INTERVAL_MS = 60 * 1000;
const FIRST_RUN_DELAY_MS = 45 * 1000;
const DELAY_MS = 15 * 60 * 1000; // 15-minute Auto-Tag debounce
const BATCH_SIZE = 100;

let scheduled: NodeJS.Timeout | null = null;
let totalCycles = 0;
let totalClassified = 0;
let lastError: string | null = null;

interface PendingPayload {
    text?: string;
    sender_name?: string;
    thread_id?: string;
}

export async function runOnce(): Promise<{ classified: number }> {
    const cutoff = new Date(Date.now() - DELAY_MS);
    const due = await prisma.linkedInProfile.findMany({
        where: { auto_tag_pending_at: { not: null, lte: cutoff } },
        take: BATCH_SIZE,
        select: { id: true, organization_id: true, auto_tag_pending: true },
    });

    let classified = 0;
    for (const p of due) {
        const payload = (p.auto_tag_pending as PendingPayload) || {};
        if (!payload.text) {
            // Stale row with no text — clear it.
            await prisma.linkedInProfile.update({
                where: { id: p.id },
                data: { auto_tag_pending: undefined, auto_tag_pending_at: null },
            });
            continue;
        }
        try {
            const result = await classifyReply(p.organization_id, payload.text, {
                triggerRefId: payload.thread_id,
                senderName: payload.sender_name,
                linkedinProfileId: p.id,
            });
            // classifyReply persists the tag itself; just clear the queue.
            const fresh = await prisma.linkedInProfile.update({
                where: { id: p.id },
                data: { auto_tag_pending: undefined, auto_tag_pending_at: null },
                select: { lead_id: true },
            });
            classified++;

            // Cross-channel fan-out — if the LinkedInProfile is linked to a
            // Lead, ask the suppression service whether to pause the lead's
            // email-side enrollments. Mode is org-configurable; this call
            // is idempotent + non-fatal.
            if (fresh.lead_id) {
                try {
                    await pauseCrossChannelForLead({
                        organizationId: p.organization_id,
                        leadId: fresh.lead_id,
                        source: 'linkedin',
                        replyClass: mapLinkedInTagToReplyClass(result.tag),
                        reason: `LinkedIn auto-tag: ${result.tag}`,
                    });
                } catch (xchErr) {
                    logger.warn('[REPLY-TAG-WORKER] cross-channel suppression skipped (non-fatal)', {
                        profile_id: p.id,
                        err: String(xchErr).slice(0, 200),
                    });
                }
            }
        } catch (err) {
            logger.warn('[REPLY-TAG-WORKER] classify failed', { profile_id: p.id, err: String(err).slice(0, 200) });
            // Leave the pending row in place so the next cycle retries.
            // If it keeps failing, the operator sees the AgentRun ERRORs.
        }
    }
    return { classified };
}

async function tick(): Promise<void> {
    totalCycles += 1;
    try {
        const { classified } = await runOnce();
        totalClassified += classified;
        if (classified > 0) {
            logger.info('[REPLY-TAG-WORKER] Cycle complete', { classified });
        }
        lastError = null;
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('[REPLY-TAG-WORKER] Cycle failed', err instanceof Error ? err : new Error(lastError));
    }
}

export function scheduleLinkedInReplyTagWorker(): void {
    if (scheduled) return;
    setTimeout(() => {
        void tick();
        scheduled = setInterval(() => { void tick(); }, RUN_INTERVAL_MS);
    }, FIRST_RUN_DELAY_MS);
    logger.info('[REPLY-TAG-WORKER] Scheduled', { intervalMs: RUN_INTERVAL_MS, delayMs: DELAY_MS });
}

export function stopLinkedInReplyTagWorker(): void {
    if (scheduled) {
        clearInterval(scheduled);
        scheduled = null;
    }
}

export function getReplyTagWorkerStatus() {
    return { totalCycles, totalClassified, lastError, scheduled: Boolean(scheduled) };
}
