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
import { getAdapterForCampaign } from './adapters/platformRegistry';
import * as auditLogService from './services/auditLogService';
import { logger } from './services/observabilityService';

const processHeldLeads = async () => {
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

                // Push to campaign on external platform
                logger.info(`[PROCESSOR] Pushing Lead ${lead.id} to campaign ${lead.assigned_campaign_id}...`);
                try {
                    const adapter = await getAdapterForCampaign(lead.assigned_campaign_id);
                    const campaign = await prisma.campaign.findUnique({
                        where: { id: lead.assigned_campaign_id },
                        select: { external_id: true }
                    });
                    const externalCampaignId = campaign?.external_id || lead.assigned_campaign_id;
                    const pushed = await adapter.pushLeadToCampaign(
                        orgId,
                        externalCampaignId,
                        { email: lead.email }
                    );

                    if (pushed) {
                        logger.info(`[PROCESSOR] Lead ${lead.id} successfully pushed.`);
                    } else {
                        logger.info(`[PROCESSOR] Failed to push Lead ${lead.id} (Check API Key).`);
                    }
                } catch (pushError: any) {
                    logger.error(`[PROCESSOR] Error pushing lead to campaign`, pushError, {
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
};

// Run every 10 seconds
setInterval(processHeldLeads, 10000);

logger.info('[PROCESSOR] Started.');
