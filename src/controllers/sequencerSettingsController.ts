/**
 * Sequencer Settings Controller
 *
 * Get and update org-level SequencerSettings (upsert default if not exists).
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { getSuppressionMode, setSuppressionMode, type SuppressionMode } from '../services/crossChannelSuppressionService';
import { recordSecurityEvent, EVENT_TYPES } from '../services/securityAuditLog';

/**
 * GET /api/sequencer/settings
 * Return SequencerSettings for org (upsert default if not exists).
 */
export const getSettings = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        const settings = await prisma.sequencerSettings.upsert({
            where: { organization_id: orgId },
            create: { organization_id: orgId },
            update: {},
        });

        return res.json({ success: true, data: settings });
    } catch (error: any) {
        logger.error('[SEQ_SETTINGS] Failed to get settings', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get settings' });
    }
};

/**
 * PATCH /api/sequencer/settings
 * Update all settings fields.
 */
export const updateSettings = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const {
            defaultDailyLimit, defaultTimezone, defaultStartTime, defaultEndTime,
            defaultActiveDays, delayBetweenEmails, globalDailyMax, trackingDomain,
            defaultTrackOpens, defaultTrackClicks, defaultUnsubscribe,
            autoPauseOnBounce, bounceThreshold, stopOnReplyDefault,
            notifyOnReply, notifyOnBounce, notifyOnComplete,
            applyToExistingMailboxes, // when true, propagate default_daily_limit to all existing mailboxes
        } = req.body;

        const updateData: any = {};
        if (defaultDailyLimit !== undefined) updateData.default_daily_limit = defaultDailyLimit;
        if (defaultTimezone !== undefined) updateData.default_timezone = defaultTimezone;
        if (defaultStartTime !== undefined) updateData.default_start_time = defaultStartTime;
        if (defaultEndTime !== undefined) updateData.default_end_time = defaultEndTime;
        if (defaultActiveDays !== undefined) updateData.default_active_days = defaultActiveDays;
        if (delayBetweenEmails !== undefined) updateData.delay_between_emails = delayBetweenEmails;
        if (globalDailyMax !== undefined) updateData.global_daily_max = globalDailyMax;
        if (trackingDomain !== undefined) updateData.tracking_domain = trackingDomain;
        if (defaultTrackOpens !== undefined) updateData.default_track_opens = defaultTrackOpens;
        if (defaultTrackClicks !== undefined) updateData.default_track_clicks = defaultTrackClicks;
        if (defaultUnsubscribe !== undefined) updateData.default_unsubscribe = defaultUnsubscribe;
        if (autoPauseOnBounce !== undefined) updateData.auto_pause_on_bounce = autoPauseOnBounce;
        if (bounceThreshold !== undefined) updateData.bounce_threshold = bounceThreshold;
        if (stopOnReplyDefault !== undefined) updateData.stop_on_reply_default = stopOnReplyDefault;
        if (notifyOnReply !== undefined) updateData.notify_on_reply = notifyOnReply;
        if (notifyOnBounce !== undefined) updateData.notify_on_bounce = notifyOnBounce;
        if (notifyOnComplete !== undefined) updateData.notify_on_complete = notifyOnComplete;

        const settings = await prisma.sequencerSettings.upsert({
            where: { organization_id: orgId },
            create: { organization_id: orgId, ...updateData },
            update: updateData,
        });

        // Optionally propagate default_daily_limit to all existing mailboxes
        let mailboxesUpdated = 0;
        if (applyToExistingMailboxes && defaultDailyLimit !== undefined) {
            const result = await prisma.connectedAccount.updateMany({
                where: { organization_id: orgId },
                data: { daily_send_limit: defaultDailyLimit },
            });
            mailboxesUpdated = result.count;
        }

        return res.json({
            success: true,
            data: settings,
            mailboxesUpdated,
        });
    } catch (error: any) {
        logger.error('[SEQ_SETTINGS] Failed to update settings', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
};

// ────────────────────────────────────────────────────────────────────
// Cross-channel suppression mode
// ────────────────────────────────────────────────────────────────────
//
// Org-level toggle for how email replies pause LinkedIn campaigns and
// vice-versa. Lives on Organization.cross_channel_suppression_mode and is
// read by both reply handlers (replyActionService + linkedinReplyTagWorker).

const VALID_MODES: SuppressionMode[] = ['OFF', 'HARD', 'CLASSIFIED', 'ASYMMETRIC'];

export const getSuppressionModeHandler = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const mode = await getSuppressionMode(orgId);
        return res.json({ success: true, data: { mode } });
    } catch (error: any) {
        logger.error('[SEQ_SETTINGS] Failed to read suppression mode', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to read suppression mode' });
    }
};

export const updateSuppressionModeHandler = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const requested = (req.body?.mode ?? '').toString().toUpperCase() as SuppressionMode;
        if (!VALID_MODES.includes(requested)) {
            return res.status(400).json({
                success: false,
                error: `mode must be one of ${VALID_MODES.join(', ')}`,
            });
        }
        // Capture the previous mode for the audit row. A flip from
        // CLASSIFIED to OFF disables cross-channel reply protection
        // across the entire org; the audit table is where "who flipped
        // protection off and when" lives. Super Protect audit SP3.
        const previous = await getSuppressionMode(orgId);
        await setSuppressionMode(orgId, requested);
        void recordSecurityEvent({
            organizationId: orgId,
            actorKind: 'user',
            actorId: req.orgContext?.userId ?? null,
            eventType: EVENT_TYPES.SUPPRESSION_MODE_CHANGED,
            target: orgId,
            metadata: { from: previous, to: requested },
            req,
        });
        return res.json({ success: true, data: { mode: requested } });
    } catch (error: any) {
        logger.error('[SEQ_SETTINGS] Failed to update suppression mode', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update suppression mode' });
    }
};
