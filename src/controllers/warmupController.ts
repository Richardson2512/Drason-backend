/**
 * Warmup Pool Controller
 *
 *   GET    /api/sequencer/warmup/overview              - org-level dashboard data
 *   GET    /api/sequencer/warmup/consent               - workspace-level consent state
 *   POST   /api/sequencer/warmup/consent               - { consent: bool } - opt the workspace into the cross-tenant pool
 *   GET    /api/sequencer/warmup/memberships           - list per-mailbox memberships
 *   POST   /api/sequencer/warmup/memberships/:mid/toggle - enable/disable per mailbox
 *   PATCH  /api/sequencer/warmup/memberships/:mid      - update ramp config (start/target/days)
 *   GET    /api/sequencer/warmup/memberships/:mid/exchanges - recent activity for one mailbox
 *
 * All endpoints are org-scoped via getOrgId / orgContext middleware.
 */

import type { Request, Response } from 'express';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import {
    setOrgConsent,
    getOrgConsent,
} from '../services/warmup/poolService';
import {
    setEnabled,
    updateConfig,
    bulkUpdateOrgConfig,
    type MembershipConfig,
} from '../services/warmup/membershipService';
import { MAX_TARGET_DAILY } from '../services/warmup/types';

// ────────────────────────────────────────────────────────────────────
// Workspace-level consent - required for cross-tenant participation.
// ────────────────────────────────────────────────────────────────────

export async function getConsent(req: Request, res: Response): Promise<Response> {
    const orgId = getOrgId(req);
    const status = await getOrgConsent(orgId);
    return res.json({ success: true, data: status });
}

export async function postConsent(req: Request, res: Response): Promise<Response> {
    const orgId = getOrgId(req);
    const consent = !!req.body?.consent;
    await setOrgConsent(orgId, consent);
    const status = await getOrgConsent(orgId);
    return res.json({ success: true, data: status });
}

// ────────────────────────────────────────────────────────────────────
// Org overview - pool size, total volume today, top-line stats.
// ────────────────────────────────────────────────────────────────────

export async function getOverview(req: Request, res: Response): Promise<Response> {
    const orgId = getOrgId(req);

    const [memberships, consent] = await Promise.all([
        prisma.warmupPoolMembership.findMany({
            where: { organization_id: orgId },
            include: {
                mailbox: { select: { email: true, status: true, recovery_phase: true } },
            },
            orderBy: { joined_at: 'asc' },
        }),
        getOrgConsent(orgId),
    ]);

    // Today's send + open + recovered counts across this org's mailboxes.
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayExchanges = await prisma.warmupExchange.findMany({
        where: {
            sender_membership_id: { in: memberships.map(m => m.id) },
            created_at: { gte: startOfDay },
        },
        select: { state: true, landed_in: true },
    });

    let sentToday = 0, openedToday = 0, recoveredToday = 0;
    for (const e of todayExchanges) {
        if (e.state === 'sent' || e.state === 'opened' || e.state === 'replied' || e.state === 'recovered_from_spam' || e.state === 'delivered') sentToday += 1;
        if (e.state === 'opened' || e.state === 'replied' || e.state === 'recovered_from_spam') openedToday += 1;
        if (e.state === 'recovered_from_spam') recoveredToday += 1;
    }

    return res.json({
        success: true,
        data: {
            consent,
            limits: {
                max_target_daily_per_mailbox: MAX_TARGET_DAILY,
            },
            counts: {
                memberships_total: memberships.length,
                memberships_enabled: memberships.filter(m => m.enabled).length,
                memberships_warming: memberships.filter(m => m.health === 'warming').length,
                memberships_maintenance: memberships.filter(m => m.health === 'maintenance').length,
                memberships_paused: memberships.filter(m => m.health === 'paused').length,
                memberships_error: memberships.filter(m => m.health === 'error').length,
            },
            today: {
                sent: sentToday,
                opened: openedToday,
                recovered_from_spam: recoveredToday,
            },
            lifetime: memberships.reduce((acc, m) => ({
                sent: acc.sent + m.total_sent,
                received: acc.received + m.total_received,
                opened: acc.opened + m.total_opened,
                replied: acc.replied + m.total_replied,
                recovered_from_spam: acc.recovered_from_spam + m.total_recovered_from_spam,
            }), { sent: 0, received: 0, opened: 0, replied: 0, recovered_from_spam: 0 }),
        },
    });
}

// ────────────────────────────────────────────────────────────────────
// Per-mailbox memberships
// ────────────────────────────────────────────────────────────────────

export async function listMemberships(req: Request, res: Response): Promise<Response> {
    const orgId = getOrgId(req);
    const memberships = await prisma.warmupPoolMembership.findMany({
        where: { organization_id: orgId },
        include: {
            mailbox: {
                select: {
                    id: true,
                    email: true,
                    status: true,
                    recovery_phase: true,
                    connectedAccount: { select: { provider: true } },
                },
            },
        },
        orderBy: { joined_at: 'asc' },
    });

    // Per-mailbox sent/received today - counted from WarmupExchange so the
    // UI shows live activity, not just lifetime totals.
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayExchanges = memberships.length === 0
        ? []
        : await prisma.warmupExchange.findMany({
            where: {
                created_at: { gte: startOfDay },
                OR: [
                    { sender_membership_id: { in: memberships.map(m => m.id) } },
                    { recipient_membership_id: { in: memberships.map(m => m.id) } },
                ],
            },
            select: {
                sender_membership_id: true,
                recipient_membership_id: true,
                state: true,
            },
        });

    const sentTodayMap = new Map<string, number>();
    const receivedTodayMap = new Map<string, number>();
    for (const e of todayExchanges) {
        const isSent = e.state === 'sent' || e.state === 'opened' || e.state === 'replied' || e.state === 'recovered_from_spam' || e.state === 'delivered';
        if (isSent) {
            sentTodayMap.set(e.sender_membership_id, (sentTodayMap.get(e.sender_membership_id) || 0) + 1);
            receivedTodayMap.set(e.recipient_membership_id, (receivedTodayMap.get(e.recipient_membership_id) || 0) + 1);
        }
    }

    // Map provider strings to a uniform 3-bucket set the frontend filters on.
    function bucketProvider(raw?: string | null): 'google' | 'microsoft' | 'smtp' {
        const p = (raw || '').toLowerCase();
        if (p.includes('google') || p === 'gmail') return 'google';
        if (p.includes('microsoft') || p.includes('outlook') || p === '365' || p.includes('office')) return 'microsoft';
        return 'smtp';
    }

    return res.json({
        success: true,
        data: memberships.map(m => {
            const provider = bucketProvider(m.mailbox.connectedAccount?.provider);
            // Reputation score: 0..100, derived from spam_rate_30d.
            // null spam_rate (no signal yet) → use ramp progress as a soft proxy
            // so brand-new mailboxes don't show a misleading "0".
            let reputation_score: number;
            if (m.spam_rate_30d == null) {
                const rampPct = m.ramp_days > 0 ? Math.min(1, m.ramp_step / m.ramp_days) : 1;
                // Brand-new starts at 50, ramps to 75 even without signal.
                reputation_score = Math.round(50 + 25 * rampPct);
            } else {
                // 0% spam → 100, 5% spam → 50, 10%+ spam → 0.
                reputation_score = Math.max(0, Math.min(100, Math.round(100 - m.spam_rate_30d * 1000)));
            }
            const inbox_rate = m.spam_rate_30d == null ? null : Math.max(0, 1 - m.spam_rate_30d);

            return {
                id: m.id,
                mailbox_id: m.mailbox_id,
                mailbox_email: m.mailbox.email,
                mailbox_status: m.mailbox.status,
                mailbox_recovery_phase: m.mailbox.recovery_phase,
                provider,
                enabled: m.enabled,
                receive_enabled: m.receive_enabled,
                health: m.health,
                start_daily: m.start_daily,
                target_daily: m.target_daily,
                ramp_days: m.ramp_days,
                current_daily: m.current_daily,
                ramp_step: m.ramp_step,
                maintenance_daily: m.maintenance_daily,
                spam_rate_30d: m.spam_rate_30d,
                reputation_score,
                inbox_rate,
                sent_today: sentTodayMap.get(m.id) || 0,
                received_today: receivedTodayMap.get(m.id) || 0,
                total_sent: m.total_sent,
                total_received: m.total_received,
                total_opened: m.total_opened,
                total_replied: m.total_replied,
                total_recovered_from_spam: m.total_recovered_from_spam,
                last_error: m.last_error,
                joined_at: m.joined_at.toISOString(),
                updated_at: m.updated_at.toISOString(),
            };
        }),
    });
}

export async function toggleMembership(req: Request, res: Response): Promise<Response> {
    const orgId = getOrgId(req);
    const id = String(req.params.mid || '');

    const found = await prisma.warmupPoolMembership.findFirst({
        where: { id, organization_id: orgId },
        select: { id: true, mailbox_id: true, enabled: true },
    });
    if (!found) return res.status(404).json({ success: false, error: 'Membership not found' });

    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : !found.enabled;
    await setEnabled(found.mailbox_id, orgId, enabled);
    return res.json({ success: true, data: { id: found.id, enabled } });
}

export async function patchMembershipConfig(req: Request, res: Response): Promise<Response> {
    const orgId = getOrgId(req);
    const id = String(req.params.mid || '');

    const found = await prisma.warmupPoolMembership.findFirst({
        where: { id, organization_id: orgId },
        select: { id: true, mailbox_id: true },
    });
    if (!found) return res.status(404).json({ success: false, error: 'Membership not found' });

    const cfg: MembershipConfig = {
        startDaily: typeof req.body?.start_daily === 'number' ? req.body.start_daily : undefined,
        targetDaily: typeof req.body?.target_daily === 'number' ? req.body.target_daily : undefined,
        rampDays: typeof req.body?.ramp_days === 'number' ? req.body.ramp_days : undefined,
        maintenanceDaily: typeof req.body?.maintenance_daily === 'number' ? req.body.maintenance_daily : undefined,
    };

    try {
        await updateConfig(found.mailbox_id, orgId, cfg);
        return res.json({ success: true });
    } catch (err) {
        logger.warn('[WARMUP] config update failed', { id, err: (err as Error)?.message });
        return res.status(400).json({ success: false, error: (err as Error)?.message || 'Update failed' });
    }
}

// ────────────────────────────────────────────────────────────────────
// Bulk pool config - applies the same config to every membership in
// this org. Useful for "I want all my mailboxes ramping at the same
// pace" without clicking through each one.
// ────────────────────────────────────────────────────────────────────

export async function patchPoolConfig(req: Request, res: Response): Promise<Response> {
    const orgId = getOrgId(req);

    const cfg: MembershipConfig = {
        startDaily: typeof req.body?.start_daily === 'number' ? req.body.start_daily : undefined,
        targetDaily: typeof req.body?.target_daily === 'number' ? req.body.target_daily : undefined,
        rampDays: typeof req.body?.ramp_days === 'number' ? req.body.ramp_days : undefined,
        maintenanceDaily: typeof req.body?.maintenance_daily === 'number' ? req.body.maintenance_daily : undefined,
    };

    if (cfg.startDaily == null && cfg.targetDaily == null && cfg.rampDays == null && cfg.maintenanceDaily == null) {
        return res.status(400).json({ success: false, error: 'No config fields provided' });
    }

    try {
        const result = await bulkUpdateOrgConfig(orgId, cfg);
        return res.json({ success: true, data: result });
    } catch (err) {
        logger.warn('[WARMUP] bulk pool config failed', { orgId, err: (err as Error)?.message });
        return res.status(400).json({ success: false, error: (err as Error)?.message || 'Bulk update failed' });
    }
}

export async function listExchanges(req: Request, res: Response): Promise<Response> {
    const orgId = getOrgId(req);
    const id = String(req.params.mid || '');

    const found = await prisma.warmupPoolMembership.findFirst({
        where: { id, organization_id: orgId },
        select: { id: true, mailbox_id: true },
    });
    if (!found) return res.status(404).json({ success: false, error: 'Membership not found' });

    const exchanges = await prisma.warmupExchange.findMany({
        where: {
            OR: [
                { sender_membership_id: found.id },
                { recipient_membership_id: found.id },
            ],
        },
        select: {
            id: true,
            sender_mailbox_id: true,
            recipient_mailbox_id: true,
            subject: true,
            body_preview: true,
            state: true,
            landed_in: true,
            scheduled_at: true,
            sent_at: true,
            opened_at: true,
            recovered_at: true,
            error: true,
        },
        orderBy: { created_at: 'desc' },
        take: 100,
    });

    return res.json({
        success: true,
        data: exchanges.map(e => ({
            ...e,
            direction: e.sender_mailbox_id === found.mailbox_id ? 'outgoing' : 'incoming',
            scheduled_at: e.scheduled_at.toISOString(),
            sent_at: e.sent_at?.toISOString() ?? null,
            opened_at: e.opened_at?.toISOString() ?? null,
            recovered_at: e.recovered_at?.toISOString() ?? null,
        })),
    });
}
