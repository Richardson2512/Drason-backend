/**
 * Sequencer Settings Service
 *
 * Fetches per-org SequencerSettings with defaults.
 * Used by mailbox creation, campaign defaults, and any flow that needs org-level config.
 */

import { prisma } from '../index';

export interface SequencerSettingsDefaults {
    default_daily_limit: number;
    default_timezone: string;
    default_start_time: string;
    default_end_time: string;
    default_active_days: string[];
    delay_between_emails: number;
    default_track_opens: boolean;
    default_track_clicks: boolean;
    default_include_unsubscribe: boolean;
    global_daily_max: number;
    auto_pause_on_bounce: boolean;
    bounce_threshold: number;
    stop_on_reply_default: boolean;
    tracking_domain: string | null;
}

const FALLBACK_DEFAULTS: SequencerSettingsDefaults = {
    default_daily_limit: 50,
    default_timezone: 'UTC',
    default_start_time: '09:00',
    default_end_time: '17:00',
    default_active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    delay_between_emails: 1, // minutes
    default_track_opens: true,
    default_track_clicks: true,
    default_include_unsubscribe: true,
    global_daily_max: 500,
    auto_pause_on_bounce: true,
    bounce_threshold: 3,
    stop_on_reply_default: true,
    tracking_domain: null,
};

/**
 * Get org's Sequencer settings, falling back to defaults when fields are null or the row is missing.
 */
export async function getSequencerSettings(orgId: string): Promise<SequencerSettingsDefaults> {
    const settings = await prisma.sequencerSettings.findUnique({
        where: { organization_id: orgId },
    });

    if (!settings) return { ...FALLBACK_DEFAULTS };

    return {
        default_daily_limit: settings.default_daily_limit ?? FALLBACK_DEFAULTS.default_daily_limit,
        default_timezone: settings.default_timezone ?? FALLBACK_DEFAULTS.default_timezone,
        default_start_time: settings.default_start_time ?? FALLBACK_DEFAULTS.default_start_time,
        default_end_time: settings.default_end_time ?? FALLBACK_DEFAULTS.default_end_time,
        default_active_days: settings.default_active_days?.length ? settings.default_active_days : FALLBACK_DEFAULTS.default_active_days,
        delay_between_emails: settings.delay_between_emails ?? FALLBACK_DEFAULTS.delay_between_emails,
        default_track_opens: settings.default_track_opens ?? FALLBACK_DEFAULTS.default_track_opens,
        default_track_clicks: settings.default_track_clicks ?? FALLBACK_DEFAULTS.default_track_clicks,
        default_include_unsubscribe: (settings as any).default_unsubscribe ?? FALLBACK_DEFAULTS.default_include_unsubscribe,
        global_daily_max: settings.global_daily_max ?? FALLBACK_DEFAULTS.global_daily_max,
        auto_pause_on_bounce: settings.auto_pause_on_bounce ?? FALLBACK_DEFAULTS.auto_pause_on_bounce,
        bounce_threshold: settings.bounce_threshold ?? FALLBACK_DEFAULTS.bounce_threshold,
        stop_on_reply_default: settings.stop_on_reply_default ?? FALLBACK_DEFAULTS.stop_on_reply_default,
        tracking_domain: settings.tracking_domain ?? FALLBACK_DEFAULTS.tracking_domain,
    };
}
