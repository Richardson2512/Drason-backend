/**
 * Lead Processor
 *
 * Background job that processes held leads.
 * Checks execution gate and pushes leads to campaigns.
 *
 * Note: In production, this would be a proper worker using Redis/Bull queues.
 */

import { prisma } from './index';
import * as executionGateService from './services/executionGateService';
import * as auditLogService from './services/auditLogService';
import * as notificationService from './services/notificationService';
import * as entityStateService from './services/entityStateService';
import { enrollLeadInSequencerCampaign } from './services/sequencerEnrollmentService';
import { LeadState, TriggerType } from './types';
import { logger } from './services/observabilityService';
import {
    acquireLock,
    releaseLock,
    incrementPushRetry,
    getPushRetryCount,
    clearPushRetry,
} from './utils/redis';

const LOCK_KEY = 'worker:lock:lead_processor';
const LOCK_TTL_SECONDS = 60; // 1 minute TTL (processor runs every 10s, cycle should be fast)
const PROCESSOR_INTERVAL_MS = parseInt(process.env.PROCESSOR_INTERVAL_MS || '10000', 10);
/**
 * Max retry attempts before we stop pushing a HELD lead and BLOCK it.
 * Tuned for typical platform-side transients (rate limits, 5xx) to resolve
 * within a few minutes while catching permanently bad campaign configs.
 */
const MAX_PUSH_RETRIES = parseInt(process.env.MAX_PUSH_RETRIES || '5', 10);

const processHeldLeads = async () => {
    const acquired = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
    if (!acquired) {
        logger.info('[PROCESSOR] Already running on another instance. Skipping.');
        return;
    }

    try {
        logger.info('[PROCESSOR] Scanning for HELD leads...');

        // Get all organizations with leads to process
        const orgsWithLeads = await prisma.lead.groupBy({
            by: ['organization_id'],
            where: {
                status: 'held',
                assigned_campaign_id: { not: null },
                health_state: 'healthy',
                deleted_at: null
            }
        });

        for (const org of orgsWithLeads) {
            const orgId = org.organization_id;

            // Find HELD leads for this organization
            const leads = await prisma.lead.findMany({
                where: {
                    organization_id: orgId,
                    status: 'held',
                    assigned_campaign_id: { not: null },
                    health_state: 'healthy',
                    deleted_at: null
                },
                take: 50, // Batch size per org
            });

            logger.info(`[PROCESSOR] Org ${orgId}: Found ${leads.length} leads to process.`);

            for (const lead of leads) {
                if (!lead.assigned_campaign_id) continue;

                // Retry cap — if prior push attempts have already exhausted the budget,
                // block the lead and notify. Avoids spinning forever on a permanently
                // bad campaign config (missing mailboxes, revoked API key, etc.).
                const priorAttempts = await getPushRetryCount(lead.id).catch(() => 0);
                if (priorAttempts >= MAX_PUSH_RETRIES) {
                    logger.warn(`[PROCESSOR] Lead ${lead.id} exceeded ${MAX_PUSH_RETRIES} push attempts — blocking`);
                    await entityStateService.transitionLead(
                        orgId,
                        lead.id,
                        LeadState.BLOCKED,
                        `Push retry cap reached (${priorAttempts} attempts). Review campaign configuration and re-ingest manually.`,
                        TriggerType.SYSTEM,
                    ).catch((err) => {
                        logger.error('[PROCESSOR] Failed to transition lead to BLOCKED', err);
                    });
                    await notificationService.createNotification(orgId, {
                        type: 'ERROR',
                        title: 'Lead push retries exhausted',
                        message: `Lead ${lead.email} could not be pushed to its campaign after ${priorAttempts} attempts. The lead has been blocked. Check the campaign's mailboxes and platform API key.`,
                    }).catch((err) => {
                        logger.warn('[PROCESSOR] Failed to create push-exhausted notification', { error: err?.message });
                    });
                    await clearPushRetry(lead.id).catch(() => { /* best-effort */ });
                    continue;
                }

                const gateResult = await executionGateService.canExecuteLead(
                    orgId,
                    lead.assigned_campaign_id,
                    lead.id
                );

                if (gateResult.allowed) {
                    // Transition to ACTIVE
                    await prisma.lead.update({
                        where: { id: lead.id },
                        data: { status: 'active' },
                    });

                    await auditLogService.logAction({
                        organizationId: orgId,
                        entity: 'lead',
                        entityId: lead.id,
                        trigger: 'processor_gate',
                        action: 'activated',
                        details: `Passed execution gate. Risk: ${gateResult.riskScore.toFixed(1)}`
                    });
                    logger.info(`[PROCESSOR] Lead ${lead.id} ACTIVATED.`);

                    // Native sending — enroll the lead in the sequencer campaign.
                    // sendQueueService dispatches from the resulting CampaignLead row
                    // on its next 60s tick.
                    logger.info(`[PROCESSOR] Enrolling Lead ${lead.id} in campaign ${lead.assigned_campaign_id}...`);
                    try {
                        const result = await enrollLeadInSequencerCampaign(orgId, lead.assigned_campaign_id, {
                            email: lead.email,
                            first_name: lead.first_name,
                            last_name: lead.last_name,
                            company: lead.company,
                            title: lead.title,
                            validation_status: lead.validation_status,
                            validation_score: lead.validation_score,
                        });
                        const pushSucceeded = result.success;
                        if (!pushSucceeded) {
                            logger.warn(`[PROCESSOR] Sequencer enrollment failed for lead ${lead.id}: ${result.error}`);
                        }

                        if (pushSucceeded) {
                            // Success — clear retry counter.
                            await clearPushRetry(lead.id).catch(() => { /* non-critical */ });
                            logger.info(`[PROCESSOR] Lead ${lead.id} successfully pushed.`);
                        } else {
                            // Push returned false — bump retry counter AND revert lead to HELD
                            // so the next cycle retries. Without this revert the lead sits in
                            // ACTIVE but never landed on the platform.
                            const attempts = await incrementPushRetry(lead.id).catch(() => priorAttempts + 1);
                            await prisma.lead.update({
                                where: { id: lead.id },
                                data: { status: 'held' },
                            }).catch((err) => {
                                logger.error('[PROCESSOR] Failed to revert lead to HELD', err);
                            });
                            logger.warn(`[PROCESSOR] Push failed for Lead ${lead.id} (attempt ${attempts}/${MAX_PUSH_RETRIES}) — reverted to HELD for retry`);
                        }
                    } catch (pushError: any) {
                        const attempts = await incrementPushRetry(lead.id).catch(() => priorAttempts + 1);
                        await prisma.lead.update({
                            where: { id: lead.id },
                            data: { status: 'held' },
                        }).catch(() => { /* best-effort */ });
                        logger.error(`[PROCESSOR] Error pushing lead to campaign (attempt ${attempts}/${MAX_PUSH_RETRIES})`, pushError, {
                            leadId: lead.id,
                            campaignId: lead.assigned_campaign_id
                        });
                    }

                } else {
                    // Remain HELD, log was already created by gate service
                    logger.info(`[PROCESSOR] Lead ${lead.id} BLOCKED: ${gateResult.reason}`);
                }
            }
        }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('[PROCESSOR] Processing cycle failed', error);
    } finally {
        await releaseLock(LOCK_KEY);
    }
};

// Run on configurable interval (default: 10 seconds)
setInterval(processHeldLeads, PROCESSOR_INTERVAL_MS);

logger.info('[PROCESSOR] Started.');
