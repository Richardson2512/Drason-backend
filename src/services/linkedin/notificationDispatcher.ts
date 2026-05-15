/**
 * LinkedIn notification dispatcher.
 *
 * Nine notification event types:
 *   - reply_received
 *   - cr_accepted               (mirrors invitation_accepted)
 *   - account_disconnected
 *   - account_credentials_needed
 *   - campaign_finished
 *   - campaign_insufficient_leads
 *   - campaign_failed
 *   - lead_tagged
 *   - icp_match                 (high-confidence ICP match - our addition)
 *
 * Each event triggers in-app + (Slack | email) delivery per the workspace's
 * preferences. v1 writes in-app rows via the existing notificationService;
 * Slack delivery uses the existing SlackAlertService surface.
 */

import { logger } from '../observabilityService';
import { createNotification } from '../notificationService';
import { SlackAlertService } from '../SlackAlertService';

export type LinkedInNotificationEvent =
    | 'reply_received'
    | 'cr_accepted'
    | 'account_disconnected'
    | 'account_credentials_needed'
    | 'campaign_finished'
    | 'campaign_insufficient_leads'
    | 'campaign_failed'
    | 'lead_tagged'
    | 'icp_match';

interface DispatchInput {
    organization_id: string;
    event: LinkedInNotificationEvent;
    title: string;
    message: string;
    /** Optional per-user routing; NULL = workspace-wide bell badge. */
    user_id?: string;
}

const TYPE_MAP: Record<LinkedInNotificationEvent, 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'SYSTEM'> = {
    reply_received:              'INFO',
    cr_accepted:                 'SUCCESS',
    account_disconnected:        'ERROR',
    account_credentials_needed:  'WARNING',
    campaign_finished:           'INFO',
    campaign_insufficient_leads: 'WARNING',
    campaign_failed:             'ERROR',
    lead_tagged:                 'INFO',
    icp_match:                   'SUCCESS',
};

const SLACK_SEVERITY_MAP: Record<LinkedInNotificationEvent, 'info' | 'warning' | 'critical'> = {
    reply_received:              'info',
    cr_accepted:                 'info',
    account_disconnected:        'critical',
    account_credentials_needed:  'warning',
    campaign_finished:           'info',
    campaign_insufficient_leads: 'warning',
    campaign_failed:             'critical',
    lead_tagged:                 'info',
    icp_match:                   'info',
};

export async function dispatch(input: DispatchInput): Promise<void> {
    // In-app notification (bell icon + Notifications page).
    try {
        await createNotification(input.organization_id, {
            type: TYPE_MAP[input.event],
            title: input.title,
            message: input.message,
            userId: input.user_id,
        });
    } catch (err) {
        logger.warn('[LINKEDIN-NOTIF] in-app create failed', { event: input.event, err: String(err).slice(0, 200) });
    }

    // Slack delivery - SlackAlertService respects the org's
    // SlackNotificationPreference table (per-event opt-in + optional
    // channel override). If the user hasn't enabled this event we
    // still log to slack_alert_log with suppressed_by_pref=true so the
    // Notifications history audit reflects the suppression.
    try {
        await SlackAlertService.sendAlert({
            organizationId: input.organization_id,
            eventType: `linkedin.${input.event}`,
            severity: SLACK_SEVERITY_MAP[input.event],
            title: input.title,
            message: input.message,
        });
    } catch (err) {
        logger.warn('[LINKEDIN-NOTIF] Slack dispatch failed', { event: input.event, err: String(err).slice(0, 200) });
    }
}

// ────────────────────────────────────────────────────────────────────
// Convenience wrappers - typed helpers per event so callers can't
// mis-spell the event key.
// ────────────────────────────────────────────────────────────────────

export async function notifyReplyReceived(orgId: string, leadName: string, snippet: string): Promise<void> {
    await dispatch({
        organization_id: orgId,
        event: 'reply_received',
        title: `${leadName} replied`,
        message: snippet.slice(0, 240),
    });
}

export async function notifyCrAccepted(orgId: string, leadName: string): Promise<void> {
    await dispatch({
        organization_id: orgId,
        event: 'cr_accepted',
        title: `${leadName} accepted your connection request`,
        message: 'Sequence will move to the LinkedIn DM step on its scheduled day.',
    });
}

export async function notifyAccountStatus(orgId: string, accountName: string, status: 'disconnected' | 'credentials'): Promise<void> {
    await dispatch({
        organization_id: orgId,
        event: status === 'disconnected' ? 'account_disconnected' : 'account_credentials_needed',
        title: status === 'disconnected'
            ? `${accountName} disconnected from Unipile`
            : `${accountName} needs re-authentication`,
        message: status === 'disconnected'
            ? 'Campaigns using this account are paused until reconnected.'
            : 'LinkedIn invalidated the session. Click Reconnect to refresh.',
    });
}

export async function notifyCampaignFinished(orgId: string, campaignName: string): Promise<void> {
    await dispatch({
        organization_id: orgId,
        event: 'campaign_finished',
        title: `Campaign "${campaignName}" finished`,
        message: 'All leads have reached a terminal state. Open the campaign to see the funnel.',
    });
}

export async function notifyIcpMatch(orgId: string, leadName: string, score: number, icpName: string): Promise<void> {
    if (score < 0.9) return; // Only fire on high-confidence matches.
    await dispatch({
        organization_id: orgId,
        event: 'icp_match',
        title: `${leadName} matched "${icpName}" ICP (${(score * 100).toFixed(0)}%)`,
        message: 'High-confidence ICP match - review the Signal Feed for context.',
    });
}
