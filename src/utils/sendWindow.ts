/**
 * Campaign sending-window evaluation, in the campaign's own timezone.
 *
 * Shared by the dispatcher (skip scheduling outside the window) AND the
 * send-time gate canSendNow (defer queued batch emails that would otherwise
 * drain out past the window end - incident 2026-07-05: batches enqueued
 * inside a 10:00-16:30 Istanbul window kept sending until ~18:00 because
 * only enqueue time was checked, not drain time).
 */
export function isWithinSendingWindow(campaign: {
    // Schedule fields are nullable on Campaign post-merge (legacy platform-synced rows
    // have no schedule since the external platform owns it). Sequencer rows explicitly
    // populate these. Null timezone / times / days default to "always-open" below.
    schedule_timezone: string | null;
    schedule_start_time: string | null;
    schedule_end_time: string | null;
    schedule_days: string[];
}): boolean {
    // Interpret schedule in the campaign's timezone, not UTC. Prior bug: a user in
    // ET who set "09:00-17:00 America/New_York" had their window compared against
    // UTC hours, so sending only happened between 04:00-12:00 ET (or not at all).
    const tz = campaign.schedule_timezone || 'UTC';
    const now = new Date();

    let currentDay = 'sun';
    let hour = 0;
    let minute = 0;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(now);
        const weekdayMap: Record<string, string> = {
            Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat',
        };
        currentDay = weekdayMap[parts.find(p => p.type === 'weekday')?.value || 'Sun'] || 'sun';
        hour = Number(parts.find(p => p.type === 'hour')?.value || '0');
        minute = Number(parts.find(p => p.type === 'minute')?.value || '0');
    } catch {
        // Invalid timezone string - fall back to UTC
        const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        currentDay = days[now.getUTCDay()];
        hour = now.getUTCHours();
        minute = now.getUTCMinutes();
    }

    if (campaign.schedule_days.length > 0 && !campaign.schedule_days.includes(currentDay)) return false;
    if (campaign.schedule_start_time && campaign.schedule_end_time) {
        const nowMin = hour * 60 + minute;
        const [sH, sM] = campaign.schedule_start_time.split(':').map(Number);
        const [eH, eM] = campaign.schedule_end_time.split(':').map(Number);
        if (nowMin < sH * 60 + sM || nowMin > eH * 60 + eM) return false;
    }
    return true;
}
