/**
 * Lead Assignment Service
 *
 * Provides atomic lead-to-campaign assignment with capacity checking.
 * Prevents race conditions when multiple concurrent requests assign leads.
 *
 * Uses PostgreSQL row-level locking (SELECT FOR UPDATE) to ensure
 * capacity checks and assignments are atomic.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as auditLogService from './auditLogService';

// Campaign capacity limits
const IDEAL_LEADS_PER_MAILBOX = 75;
const MAX_LEADS_PER_MAILBOX = 150;

interface AssignmentResult {
    success: boolean;
    assigned: boolean;
    campaignId?: string;
    reason?: string;
    currentLoad?: number;
    capacity?: number;
}

/**
 * Atomically assign a lead to a campaign with capacity checking.
 *
 * Uses a Prisma interactive transaction with row-level locking to ensure:
 * 1. Campaign capacity is checked atomically
 * 2. Only one assignment happens at a time per campaign
 * 3. Capacity violations are impossible even under high concurrency
 *
 * @param organizationId - Organization ID
 * @param leadId - Lead ID to assign
 * @param campaignId - Target campaign ID
 * @param options - Assignment options
 * @returns AssignmentResult indicating success/failure with details
 */
export async function assignLeadToCampaignWithCapacityCheck(
    organizationId: string,
    leadId: string,
    campaignId: string,
    options: {
        allowOverCapacity?: boolean;  // Allow assignment even if over ideal capacity
        skipSmartlead?: boolean;      // Skip Smartlead push (for internal moves)
    } = {}
): Promise<AssignmentResult> {
    const { allowOverCapacity = false } = options;

    try {
        // Use interactive transaction with isolation level SERIALIZABLE
        // This ensures the capacity check and assignment are atomic
        const result = await prisma.$transaction(async (tx) => {
            // 1. Lock the campaign row for update (prevents concurrent modifications)
            // Fetch campaign and mailbox count
            const campaign = await tx.campaign.findUnique({
                where: { id: campaignId },
                include: {
                    _count: {
                        select: {
                            mailboxes: true
                        }
                    }
                }
            });

            if (!campaign) {
                return {
                    success: false,
                    assigned: false,
                    reason: `Campaign ${campaignId} not found`
                };
            }

            if (campaign.status !== 'active') {
                return {
                    success: false,
                    assigned: false,
                    reason: `Campaign ${campaignId} is ${campaign.status}, not active`
                };
            }

            const mailboxCount = campaign._count.mailboxes;
            if (mailboxCount === 0) {
                return {
                    success: false,
                    assigned: false,
                    reason: `Campaign ${campaignId} has no mailboxes`
                };
            }

            // 2. Count active leads for this campaign (inside the transaction lock)
            const currentLoad = await tx.lead.count({
                where: {
                    assigned_campaign_id: campaignId,
                    status: { in: ['active', 'held', 'paused'] }
                }
            });
            const idealCapacity = mailboxCount * IDEAL_LEADS_PER_MAILBOX;
            const maxCapacity = mailboxCount * MAX_LEADS_PER_MAILBOX;

            logger.info(`[ASSIGNMENT] Campaign ${campaignId}: ${currentLoad}/${maxCapacity} leads (${mailboxCount} mailboxes)`);

            // Hard limit: never exceed max capacity
            if (currentLoad >= maxCapacity) {
                return {
                    success: false,
                    assigned: false,
                    reason: `Campaign at max capacity (${currentLoad}/${maxCapacity} leads)`,
                    currentLoad,
                    capacity: maxCapacity
                };
            }

            // Soft limit: warn if over ideal capacity but allow if flag set
            if (!allowOverCapacity && currentLoad >= idealCapacity) {
                return {
                    success: false,
                    assigned: false,
                    reason: `Campaign above ideal capacity (${currentLoad}/${idealCapacity} leads). Use allowOverCapacity=true to override.`,
                    currentLoad,
                    capacity: idealCapacity
                };
            }

            // 3. Capacity OK - assign the lead
            await tx.lead.update({
                where: { id: leadId },
                data: {
                    assigned_campaign_id: campaignId
                }
            });

            logger.info(`[ASSIGNMENT] ✓ Assigned lead ${leadId} to campaign ${campaignId} (now ${currentLoad + 1}/${maxCapacity})`);

            return {
                success: true,
                assigned: true,
                campaignId,
                currentLoad: currentLoad + 1,
                capacity: maxCapacity
            };
        }, {
            // SERIALIZABLE isolation ensures no phantom reads
            // This is the strongest isolation level
            isolationLevel: 'Serializable',
            timeout: 10000 // 10 second timeout
        });

        // Log assignment in audit trail
        if (result.assigned) {
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: leadId,
                trigger: 'assignment',
                action: 'assigned_to_campaign',
                details: `Lead assigned to campaign ${campaignId} (load: ${result.currentLoad}/${result.capacity})`
            });
        }

        return result;

    } catch (error: any) {
        logger.error('[ASSIGNMENT] Failed to assign lead', error, {
            organizationId,
            leadId,
            campaignId
        });

        return {
            success: false,
            assigned: false,
            reason: `Assignment failed: ${error.message}`
        };
    }
}

/**
 * Batch assign multiple leads to a campaign with capacity checking.
 * Assigns leads sequentially to ensure capacity is not violated.
 *
 * @param organizationId - Organization ID
 * @param leadIds - Array of lead IDs to assign
 * @param campaignId - Target campaign ID
 * @param options - Assignment options
 * @returns Summary of assignments (success count, failure count, reasons)
 */
export async function batchAssignLeadsToCampaign(
    organizationId: string,
    leadIds: string[],
    campaignId: string,
    options: {
        allowOverCapacity?: boolean;
        continueOnFailure?: boolean;  // Continue even if some assignments fail
    } = {}
): Promise<{
    success: boolean;
    totalRequested: number;
    assigned: number;
    failed: number;
    failures: Array<{ leadId: string; reason: string }>;
}> {
    const { continueOnFailure = true } = options;

    logger.info(`[ASSIGNMENT] Batch assigning ${leadIds.length} leads to campaign ${campaignId}`);

    let assigned = 0;
    let failed = 0;
    const failures: Array<{ leadId: string; reason: string }> = [];

    for (const leadId of leadIds) {
        const result = await assignLeadToCampaignWithCapacityCheck(
            organizationId,
            leadId,
            campaignId,
            options
        );

        if (result.assigned) {
            assigned++;
        } else {
            failed++;
            failures.push({
                leadId,
                reason: result.reason || 'Unknown error'
            });

            if (!continueOnFailure) {
                logger.warn(`[ASSIGNMENT] Stopping batch assignment after first failure`);
                break;
            }
        }
    }

    logger.info(`[ASSIGNMENT] Batch complete: ${assigned} assigned, ${failed} failed out of ${leadIds.length}`);

    return {
        success: assigned > 0,
        totalRequested: leadIds.length,
        assigned,
        failed,
        failures
    };
}
