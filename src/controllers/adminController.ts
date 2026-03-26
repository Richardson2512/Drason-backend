/**
 * Super Admin Controller
 *
 * Cross-organization admin endpoints for the Superkabe platform.
 * All routes require super_admin role.
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';

// ============================================================================
// CSV HELPERS
// ============================================================================

function escapeField(val: any): string {
    if (val === null || val === undefined) return '';
    let str = String(val);
    // CSV injection protection: prefix formula-triggering characters with single quote
    if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function toCsv(rows: Record<string, any>[], columns: { key: string; label: string }[]): string {
    const header = columns.map(c => escapeField(c.label)).join(',');
    const body = rows.map(row =>
        columns.map(c => escapeField(row[c.key])).join(',')
    ).join('\n');
    return header + '\n' + body;
}

// ============================================================================
// GET /api/admin/organizations
// ============================================================================

export const getOrganizations = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const organizations = await prisma.organization.findMany({
            select: {
                id: true,
                name: true,
                slug: true,
                system_mode: true,
                subscription_tier: true,
                subscription_status: true,
                created_at: true,
                trial_ends_at: true,
                _count: {
                    select: {
                        users: true,
                        campaigns: true,
                        mailboxes: true,
                        domains: true,
                        leads: true,
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        logger.info('[SUPER_ADMIN] Listed organizations', {
            userId: req.orgContext?.userId,
            count: organizations.length,
        });

        res.json({ success: true, data: organizations });
    } catch (error) {
        next(error);
    }
};

// ============================================================================
// GET /api/admin/organizations/:orgId/impact
// ============================================================================

async function gatherImpactData(orgId: string) {
    // Organization info
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return null;

    // Counts
    const [totalMailboxes, totalDomains, totalCampaigns, totalLeads] = await Promise.all([
        prisma.mailbox.count({ where: { organization_id: orgId } }),
        prisma.domain.count({ where: { organization_id: orgId } }),
        prisma.campaign.count({ where: { organization_id: orgId } }),
        prisma.lead.count({ where: { organization_id: orgId } }),
    ]);

    // Impact metrics from audit logs
    const [
        mailboxesPaused,
        mailboxesHealed,
        leadsBlocked,
        leadsValidated,
        invalidLeadsBlocked,
        campaignsPaused,
        domainsPaused,
    ] = await Promise.all([
        prisma.auditLog.count({
            where: { organization_id: orgId, action: { in: ['would_pause_observe', 'paused', 'mailbox_paused'] } }
        }),
        prisma.auditLog.count({
            where: { organization_id: orgId, action: { in: ['graduated', 'recovery_complete', 'phase_transition'] } }
        }),
        prisma.lead.count({
            where: { organization_id: orgId, status: 'blocked' }
        }),
        prisma.lead.count({
            where: { organization_id: orgId, validation_status: { not: null } }
        }),
        prisma.lead.count({
            where: { organization_id: orgId, validation_status: 'invalid' }
        }),
        prisma.auditLog.count({
            where: { organization_id: orgId, entity: 'campaign', action: { contains: 'pause' } }
        }),
        prisma.auditLog.count({
            where: { organization_id: orgId, entity: 'domain', action: { contains: 'pause' } }
        }),
    ]);

    // Bounce prevention stats
    const totalBounces = await prisma.mailbox.aggregate({
        where: { organization_id: orgId },
        _sum: { hard_bounce_count: true, window_bounce_count: true }
    });

    // Active healing
    const inRecovery = await prisma.mailbox.count({
        where: { organization_id: orgId, recovery_phase: { not: 'healthy' } }
    });

    // Timeline of actions (last 50)
    const recentActions = await prisma.auditLog.findMany({
        where: { organization_id: orgId },
        orderBy: { timestamp: 'desc' },
        take: 50,
        select: { id: true, entity: true, entity_id: true, action: true, trigger: true, details: true, timestamp: true }
    });

    // Mailbox health distribution
    const healthDistribution = await prisma.mailbox.groupBy({
        by: ['status'],
        where: { organization_id: orgId },
        _count: true
    });

    // Domain health distribution
    const domainHealthDistribution = await prisma.domain.groupBy({
        by: ['status'],
        where: { organization_id: orgId },
        _count: true
    });

    // Lead status distribution
    const leadDistribution = await prisma.lead.groupBy({
        by: ['status'],
        where: { organization_id: orgId },
        _count: true
    });

    return {
        organization: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            system_mode: org.system_mode,
            subscription_tier: (org as any).subscription_tier,
            subscription_status: (org as any).subscription_status,
            created_at: org.created_at,
        },
        infrastructure: {
            totalMailboxes,
            totalDomains,
            totalCampaigns,
            totalLeads,
        },
        protectionActions: {
            mailboxesPaused,
            mailboxesHealed,
            leadsBlocked,
            leadsValidated,
            invalidLeadsBlocked,
            campaignsPaused,
            domainsPaused,
        },
        bounceStats: {
            totalHardBounces: totalBounces._sum?.hard_bounce_count || 0,
            totalWindowBounces: totalBounces._sum?.window_bounce_count || 0,
        },
        healing: {
            inRecovery,
        },
        healthDistribution: {
            mailboxes: healthDistribution.map(h => ({ status: h.status, count: h._count })),
            domains: domainHealthDistribution.map(h => ({ status: h.status, count: h._count })),
            leads: leadDistribution.map(h => ({ status: h.status, count: h._count })),
        },
        recentActions,
    };
}

export const getOrgImpactReport = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = String(req.params.orgId);
        const data = await gatherImpactData(orgId);

        if (!data) {
            return res.status(404).json({ success: false, error: 'Organization not found' });
        }

        logger.info('[SUPER_ADMIN] Generated impact report', {
            userId: req.orgContext?.userId,
            orgId,
        });

        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

// ============================================================================
// GET /api/admin/organizations/:orgId/impact/csv
// ============================================================================

export const getOrgImpactCsv = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = String(req.params.orgId);
        const data = await gatherImpactData(orgId);

        if (!data) {
            return res.status(404).json({ success: false, error: 'Organization not found' });
        }

        const sections: string[] = [];
        const today = new Date().toISOString().split('T')[0];

        // Header
        sections.push(`=== SUPERKABE IMPACT REPORT ===`);
        sections.push(`Organization: ${escapeField(data.organization.name)}`);
        sections.push(`Report Date: ${today}`);
        sections.push(`Period: All Time`);
        sections.push('');

        // Infrastructure Overview
        sections.push(`=== INFRASTRUCTURE OVERVIEW ===`);
        sections.push(toCsv([
            { metric: 'Total Mailboxes', value: data.infrastructure.totalMailboxes },
            { metric: 'Total Domains', value: data.infrastructure.totalDomains },
            { metric: 'Total Campaigns', value: data.infrastructure.totalCampaigns },
            { metric: 'Total Leads', value: data.infrastructure.totalLeads },
        ], [
            { key: 'metric', label: 'Metric' },
            { key: 'value', label: 'Value' },
        ]));
        sections.push('');

        // Protection Actions
        sections.push(`=== PROTECTION ACTIONS ===`);
        sections.push(toCsv([
            { metric: 'Mailboxes Auto-Paused', count: data.protectionActions.mailboxesPaused },
            { metric: 'Mailboxes Healed', count: data.protectionActions.mailboxesHealed },
            { metric: 'Leads Blocked', count: data.protectionActions.leadsBlocked },
            { metric: 'Leads Validated', count: data.protectionActions.leadsValidated },
            { metric: 'Invalid Leads Blocked', count: data.protectionActions.invalidLeadsBlocked },
            { metric: 'Campaigns Paused', count: data.protectionActions.campaignsPaused },
            { metric: 'Domains Paused', count: data.protectionActions.domainsPaused },
            { metric: 'Total Hard Bounces', count: data.bounceStats.totalHardBounces },
            { metric: 'Total Window Bounces', count: data.bounceStats.totalWindowBounces },
            { metric: 'Mailboxes In Recovery', count: data.healing.inRecovery },
        ], [
            { key: 'metric', label: 'Metric' },
            { key: 'count', label: 'Count' },
        ]));
        sections.push('');

        // Mailbox Health Distribution
        sections.push(`=== MAILBOX HEALTH DISTRIBUTION ===`);
        sections.push(toCsv(
            data.healthDistribution.mailboxes.map(h => ({ status: h.status, count: h.count })),
            [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Count' }]
        ));
        sections.push('');

        // Domain Health Distribution
        sections.push(`=== DOMAIN HEALTH DISTRIBUTION ===`);
        sections.push(toCsv(
            data.healthDistribution.domains.map(h => ({ status: h.status, count: h.count })),
            [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Count' }]
        ));
        sections.push('');

        // Lead Status Distribution
        sections.push(`=== LEAD STATUS DISTRIBUTION ===`);
        sections.push(toCsv(
            data.healthDistribution.leads.map(h => ({ status: h.status, count: h.count })),
            [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Count' }]
        ));
        sections.push('');

        // Recent Actions
        sections.push(`=== RECENT ACTIONS (Last 50) ===`);
        sections.push(toCsv(
            data.recentActions.map(a => ({
                timestamp: a.timestamp?.toISOString() || '',
                entity: a.entity || '',
                action: a.action || '',
                trigger: a.trigger || '',
                details: typeof a.details === 'object' ? JSON.stringify(a.details) : String(a.details || ''),
            })),
            [
                { key: 'timestamp', label: 'Timestamp' },
                { key: 'entity', label: 'Entity' },
                { key: 'action', label: 'Action' },
                { key: 'trigger', label: 'Trigger' },
                { key: 'details', label: 'Details' },
            ]
        ));

        const csvContent = sections.join('\n');

        logger.info('[SUPER_ADMIN] Generated impact CSV', {
            userId: req.orgContext?.userId,
            orgId,
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="superkabe-impact-${data.organization.slug}-${today}.csv"`);
        res.send(csvContent);
    } catch (error) {
        next(error);
    }
};
