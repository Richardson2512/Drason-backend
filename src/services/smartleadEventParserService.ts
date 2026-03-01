/**
 * Smartlead Event Parser Service
 *
 * Handles Smartlead-specific event types that don't apply to other platforms.
 *
 * Generic event types (sent, opened, clicked, replied, bounced, spam, unsubscribed)
 * are now handled by the unified event queue (eventQueue.ts → processEventInline).
 * Only Smartlead-specific events remain here:
 * - campaign_status_changed: Syncs campaign status from Smartlead
 * - lead_category_updated: Captures lead categorization from Smartlead
 */
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as auditLogService from '../services/auditLogService';
import * as entityStateService from '../services/entityStateService';
import * as campaignHealthService from '../services/campaignHealthService';
import * as notificationService from '../services/notificationService';
import { recalculateLeadScore } from './leadScoringService';
import { LeadState, TriggerType } from '../types';

/**
 * Handle campaign status changed events from Smartlead.
 * Syncs campaign status when it changes externally (paused, completed, etc.)
 */
export async function handleCampaignStatusChangedEvent(orgId: string, event: any) {
    const campaignIdRaw = event.campaign_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
    const newStatus = (event.status || event.new_status || '').toLowerCase();
    const oldStatus = (event.old_status || event.previous_status || '').toLowerCase();

    if (!campaignId) {
        logger.warn('[SMARTLEAD-WEBHOOK] Campaign status changed event missing campaign_id', {
            organizationId: orgId,
            event
        });
        return;
    }

    logger.info('[SMARTLEAD-WEBHOOK] Processing campaign status changed event', {
        organizationId: orgId,
        campaignId,
        oldStatus,
        newStatus
    });

    // Find the campaign in our DB
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, name: true, status: true }
    });

    if (!campaign) {
        logger.warn('[SMARTLEAD-WEBHOOK] Campaign not found for status change', {
            organizationId: orgId,
            campaignId
        });
        return;
    }

    // Skip if status hasn't actually changed
    if (campaign.status === newStatus) {
        logger.info('[SMARTLEAD-WEBHOOK] Campaign status unchanged, skipping', {
            organizationId: orgId,
            campaignId,
            status: newStatus
        });
        return;
    }

    // Route through campaignHealthService for proper state tracking
    if (newStatus === 'paused') {
        await campaignHealthService.pauseCampaign(
            orgId,
            campaignId,
            `Campaign paused externally in Smartlead${oldStatus ? ` (was: ${oldStatus})` : ''}`
        );
    } else if (newStatus === 'active') {
        await campaignHealthService.resumeCampaign(orgId, campaignId);
    } else {
        // For other statuses (completed, draft, etc.) update directly + record transition
        await prisma.campaign.update({
            where: { id: campaignId },
            data: { status: newStatus }
        });

        await prisma.stateTransition.create({
            data: {
                organization_id: orgId,
                entity_type: 'campaign',
                entity_id: campaignId,
                from_state: campaign.status,
                to_state: newStatus,
                reason: `Campaign status changed in Smartlead`,
                triggered_by: 'webhook',
            }
        });
    }

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'campaign',
        entityId: campaignId,
        trigger: 'smartlead_webhook',
        action: 'campaign_status_changed',
        details: `Campaign "${campaign.name}" status changed: ${campaign.status} → ${newStatus}`
    });

    // Notify user of external status change
    try {
        await notificationService.createNotification(orgId, {
            type: newStatus === 'paused' ? 'WARNING' : 'INFO',
            title: 'Campaign Status Changed in Smartlead',
            message: `Campaign "${campaign.name}" was ${newStatus === 'paused' ? 'paused' : `changed to ${newStatus}`} in Smartlead.`
        });
    } catch (notifError) {
        logger.error('[SMARTLEAD-WEBHOOK] Failed to send campaign status notification', notifError as Error);
    }
}

/**
 * Handle lead category updated events from Smartlead.
 * Captures lead categorization (interested, not_interested, do_not_contact, etc.)
 */
export async function handleLeadCategoryUpdatedEvent(orgId: string, event: any) {
    const email = event.email || event.lead_email;
    const campaignIdRaw = event.campaign_id;
    const campaignId = campaignIdRaw ? String(campaignIdRaw) : undefined;
    const category = event.category || event.lead_category || event.new_category || '';

    logger.info('[SMARTLEAD-WEBHOOK] Processing lead category updated event', {
        organizationId: orgId,
        email,
        campaignId,
        category
    });

    if (!email) {
        logger.warn('[SMARTLEAD-WEBHOOK] Lead category event missing email', {
            organizationId: orgId,
            event
        });
        return;
    }

    // Find the lead
    const lead = await prisma.lead.findUnique({
        where: {
            organization_id_email: {
                organization_id: orgId,
                email: email
            }
        }
    });

    if (!lead) {
        logger.warn('[SMARTLEAD-WEBHOOK] Lead not found for category update', {
            organizationId: orgId,
            email,
            category
        });
        return;
    }

    const normalizedCategory = category.toLowerCase().replace(/\s+/g, '_');

    // Always persist the category on the lead record
    await prisma.lead.update({
        where: { id: lead.id },
        data: {
            lead_category: normalizedCategory,
            updated_at: new Date()
        }
    });

    // Handle "do not contact" / "not interested" as blocking signals
    if (['do_not_contact', 'not_interested', 'wrong_person', 'opted_out'].includes(normalizedCategory)) {
        await entityStateService.transitionLead(
            orgId, lead.id, LeadState.BLOCKED,
            `Lead categorized as "${category}" in Smartlead`,
            TriggerType.WEBHOOK
        );

        await prisma.lead.update({
            where: { id: lead.id },
            data: {
                health_state: 'unhealthy',
            }
        });
    }

    // Handle "interested" / "meeting_booked" as positive signals
    if (['interested', 'meeting_booked', 'meeting_completed', 'closed'].includes(normalizedCategory)) {
        // Recalculate score with a boost
        await recalculateLeadScore(lead.id);
    }

    // Log to timeline regardless of category
    const campaignName = campaignId ? await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { name: true }
    }) : null;

    await auditLogService.logAction({
        organizationId: orgId,
        entity: 'lead',
        entityId: lead.id,
        trigger: 'smartlead_webhook',
        action: 'lead_category_updated',
        details: `Lead categorized as "${category}"${campaignName ? ` in campaign "${campaignName.name}"` : ''}`
    });
}
