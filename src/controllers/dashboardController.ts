/**
 * Dashboard Controller
 * 
 * Provides endpoints for the UI dashboard to fetch data.
 * All queries are scoped to the organization context.
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import * as routingService from '../services/routingService';
import * as leadHealthService from '../services/leadHealthService';
import * as campaignHealthService from '../services/campaignHealthService';
import * as entityStateService from '../services/entityStateService';
import { MailboxState, DomainState, TriggerType } from '../types';
import { logger } from '../services/observabilityService';
import { cached } from '../utils/responseCache';
import { getAdapterForMailbox } from '../adapters/platformRegistry';

/**
 * Get all leads for the organization with pagination.
 */
export const getLeads = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const status = req.query.status as string;
        const campaignId = req.query.campaignId as string;
        const search = req.query.search as string;
        const sortBy = req.query.sortBy as string || 'created_desc';
        const minScore = req.query.minScore ? parseInt(req.query.minScore as string) : undefined;
        const maxScore = req.query.maxScore ? parseInt(req.query.maxScore as string) : undefined;
        const hasEngagement = req.query.hasEngagement as string;
        const platform = req.query.platform as string;
        const skip = (page - 1) * limit;

        // Only show leads from active campaigns (exclude deleted/archived).
        // Leads with no campaign (unassigned) are always shown.
        const activeCampaignIds = await prisma.campaign.findMany({
            where: {
                organization_id: orgId,
                status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] }
            },
            select: { id: true }
        }).then(cs => cs.map(c => c.id));

        const where: any = {
            organization_id: orgId,
            deleted_at: null,
            AND: [
                {
                    OR: [
                        { assigned_campaign_id: { in: activeCampaignIds } },
                        { assigned_campaign_id: null }
                    ]
                }
            ]
        };

        // Platform filter (supports comma-separated multi-select)
        if (platform && platform !== 'all') {
            const platforms = platform.split(',').filter(Boolean);
            where.source_platform = platforms.length === 1 ? platforms[0] : { in: platforms };
        }

        if (status === 'bounced') {
            where.bounced = true;
        } else if (status && status !== 'all') {
            const statuses = status.split(',').filter(Boolean);
            if (statuses.includes('bounced')) {
                // Mixed: bounced + other statuses
                const nonBounced = statuses.filter(s => s !== 'bounced');
                if (nonBounced.length > 0) {
                    where.AND.push({
                        OR: [
                            { bounced: true },
                            { status: { in: nonBounced } }
                        ]
                    });
                } else {
                    where.bounced = true;
                }
            } else {
                where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
            }
        }

        // Campaign filter (supports comma-separated multi-select)
        if (campaignId) {
            const campaignIds = campaignId.split(',').filter(Boolean);
            where.assigned_campaign_id = campaignIds.length === 1 ? campaignIds[0] : { in: campaignIds };
        }

        if (search && search.trim()) {
            where.email = {
                contains: search.trim(),
                mode: 'insensitive'
            };
        }

        // Score range filter
        if (minScore !== undefined || maxScore !== undefined) {
            where.lead_score = {};
            if (minScore !== undefined) where.lead_score.gte = minScore;
            if (maxScore !== undefined) where.lead_score.lte = maxScore;
        }

        // Engagement filter (pushed into AND to avoid overwriting campaign OR)
        if (hasEngagement === 'yes') {
            where.AND.push({
                OR: [
                    { emails_opened: { gt: 0 } },
                    { emails_clicked: { gt: 0 } },
                    { emails_replied: { gt: 0 } }
                ]
            });
        } else if (hasEngagement === 'no') {
            where.emails_opened = 0;
            where.emails_clicked = 0;
            where.emails_replied = 0;
        }

        // Sorting
        let orderBy: any = { created_at: 'desc' }; // Default
        switch (sortBy) {
            case 'email_asc':
                orderBy = { email: 'asc' };
                break;
            case 'email_desc':
                orderBy = { email: 'desc' };
                break;
            case 'score_desc':
                orderBy = { lead_score: 'desc' };
                break;
            case 'score_asc':
                orderBy = { lead_score: 'asc' };
                break;
            case 'activity_desc':
                orderBy = { last_activity_at: 'desc' };
                break;
            case 'activity_asc':
                orderBy = { last_activity_at: 'asc' };
                break;
            case 'created_desc':
                orderBy = { created_at: 'desc' };
                break;
            case 'created_asc':
                orderBy = { created_at: 'asc' };
                break;
        }

        const [leads, total] = await Promise.all([
            prisma.lead.findMany({
                where,
                orderBy,
                take: limit,
                skip
            }),
            prisma.lead.count({ where })
        ]);

        // Fetch campaign names for all assigned campaigns
        const campaignIds = [...new Set(leads.filter(l => l.assigned_campaign_id).map(l => l.assigned_campaign_id))];
        const campaigns = await prisma.campaign.findMany({
            where: { id: { in: campaignIds as string[] }, organization_id: orgId },
            select: { id: true, name: true, status: true }
        });

        // Create a map for quick lookup
        const campaignMap = new Map(campaigns.map(c => [c.id, c]));

        // Enrich leads with campaign data
        const enrichedLeads = leads.map(lead => ({
            ...lead,
            campaign: lead.assigned_campaign_id ? campaignMap.get(lead.assigned_campaign_id) : null
        }));

        res.json({
            data: enrichedLeads,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get dashboard stats (Global or Campaign-specific)
 */
export const getStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const campaignId = req.query.campaignId as string;

        // Exclude leads from deleted/archived campaigns
        const activeCampaignIds = await prisma.campaign.findMany({
            where: {
                organization_id: orgId,
                status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] }
            },
            select: { id: true }
        }).then(cs => cs.map(c => c.id));

        const where: any = {
            organization_id: orgId,
            deleted_at: null,
            OR: [
                { assigned_campaign_id: { in: activeCampaignIds } },
                { assigned_campaign_id: null }
            ]
        };

        if (campaignId) {
            where.assigned_campaign_id = campaignId;
        }

        const cacheKey = campaignId ? `stats:${campaignId}` : 'stats:all';
        const data = await cached(orgId, cacheKey, async () => {
            const [activeCount, heldCount, pausedCount, completedCount, totalCount] = await Promise.all([
                prisma.lead.count({ where: { ...where, status: 'active' } }),
                prisma.lead.count({ where: { ...where, status: 'held' } }),
                prisma.lead.count({ where: { ...where, status: 'paused' } }),
                prisma.lead.count({ where: { ...where, status: 'completed' } }),
                prisma.lead.count({ where })
            ]);
            return {
                active: activeCount,
                held: heldCount,
                paused: pausedCount,
                completed: completedCount,
                total: totalCount
            };
        });

        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

/**
 * Get entity breakdown stats for all entity types.
 * Returns status counts for leads, campaigns, mailboxes, and domains.
 */
export const getEntityStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);

        const activeCampaignIds = await prisma.campaign.findMany({
            where: { organization_id: orgId, status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] } },
            select: { id: true }
        }).then(cs => cs.map(c => c.id));

        const leadWhere = {
            organization_id: orgId,
            deleted_at: null,
            OR: [
                { assigned_campaign_id: { in: activeCampaignIds } },
                { assigned_campaign_id: null }
            ]
        };

        const [
            leadTotal, leadActive, leadHeld, leadPaused, leadBounced,
            campaignTotal, campaignActive, campaignPaused, campaignCompleted,
            mailboxTotal, mailboxHealthy, mailboxWarning, mailboxPaused,
            domainTotal, domainHealthy, domainWarning, domainPaused
        ] = await Promise.all([
            prisma.lead.count({ where: leadWhere }),
            prisma.lead.count({ where: { ...leadWhere, status: 'active' } }),
            prisma.lead.count({ where: { ...leadWhere, status: 'held' } }),
            prisma.lead.count({ where: { ...leadWhere, status: 'paused' } }),
            prisma.lead.count({ where: { ...leadWhere, bounced: true } }),
            prisma.campaign.count({ where: { organization_id: orgId, status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] } } }),
            prisma.campaign.count({ where: { organization_id: orgId, status: 'active' } }),
            prisma.campaign.count({ where: { organization_id: orgId, status: 'paused' } }),
            prisma.campaign.count({ where: { organization_id: orgId, status: 'completed' } }),
            prisma.mailbox.count({ where: { organization_id: orgId } }),
            prisma.mailbox.count({ where: { organization_id: orgId, status: 'healthy' } }),
            prisma.mailbox.count({ where: { organization_id: orgId, status: 'warning' } }),
            prisma.mailbox.count({ where: { organization_id: orgId, status: 'paused' } }),
            prisma.domain.count({ where: { organization_id: orgId } }),
            prisma.domain.count({ where: { organization_id: orgId, status: 'healthy' } }),
            prisma.domain.count({ where: { organization_id: orgId, status: 'warning' } }),
            prisma.domain.count({ where: { organization_id: orgId, status: 'paused' } }),
        ]);

        res.json({
            success: true,
            data: {
                leads: { total: leadTotal, active: leadActive, held: leadHeld, paused: leadPaused, bounced: leadBounced },
                campaigns: { total: campaignTotal, active: campaignActive, paused: campaignPaused, completed: campaignCompleted },
                mailboxes: { total: mailboxTotal, healthy: mailboxHealthy, warning: mailboxWarning, paused: mailboxPaused },
                domains: { total: domainTotal, healthy: domainHealthy, warning: domainWarning, paused: domainPaused },
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get all campaigns with pagination.
 */
export const getCampaigns = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const status = req.query.status as string;
        const search = req.query.search as string;
        const sortBy = req.query.sortBy as string || 'name_asc';
        const minSent = req.query.minSent ? parseInt(req.query.minSent as string) : undefined;
        const maxSent = req.query.maxSent ? parseInt(req.query.maxSent as string) : undefined;
        const minOpenRate = req.query.minOpenRate ? parseFloat(req.query.minOpenRate as string) : undefined;
        const maxOpenRate = req.query.maxOpenRate ? parseFloat(req.query.maxOpenRate as string) : undefined;
        const platform = req.query.platform as string;
        const skip = (page - 1) * limit;

        const where: any = {
            organization_id: orgId
        };

        // Status filter (supports comma-separated multi-select)
        if (status && status !== 'all') {
            const statuses = status.split(',').filter(Boolean);
            where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
        } else {
            // Exclude campaigns deleted from the platform unless explicitly filtered
            where.status = { not: 'deleted' };
        }

        // Platform filter (supports comma-separated multi-select)
        if (platform && platform !== 'all') {
            const platforms = platform.split(',').filter(Boolean);
            where.source_platform = platforms.length === 1 ? platforms[0] : { in: platforms };
        }

        if (search && search.trim()) {
            where.name = {
                contains: search.trim(),
                mode: 'insensitive'
            };
        }

        // Total sent range filter
        if (minSent !== undefined || maxSent !== undefined) {
            where.total_sent = {};
            if (minSent !== undefined) where.total_sent.gte = minSent;
            if (maxSent !== undefined) where.total_sent.lte = maxSent;
        }

        // Open rate range filter
        if (minOpenRate !== undefined || maxOpenRate !== undefined) {
            where.open_rate = {};
            if (minOpenRate !== undefined) where.open_rate.gte = minOpenRate;
            if (maxOpenRate !== undefined) where.open_rate.lte = maxOpenRate;
        }

        // Sorting
        let orderBy: any = { name: 'asc' }; // Default
        switch (sortBy) {
            case 'name_asc':
                orderBy = { name: 'asc' };
                break;
            case 'name_desc':
                orderBy = { name: 'desc' };
                break;
            case 'sent_desc':
                orderBy = { total_sent: 'desc' };
                break;
            case 'sent_asc':
                orderBy = { total_sent: 'asc' };
                break;
            case 'open_rate_desc':
                orderBy = { open_rate: 'desc' };
                break;
            case 'open_rate_asc':
                orderBy = { open_rate: 'asc' };
                break;
            case 'reply_rate_desc':
                orderBy = { reply_rate: 'desc' };
                break;
            case 'reply_rate_asc':
                orderBy = { reply_rate: 'asc' };
                break;
            case 'bounce_rate_desc':
                orderBy = { bounce_rate: 'desc' };
                break;
            case 'bounce_rate_asc':
                orderBy = { bounce_rate: 'asc' };
                break;
        }

        const [campaigns, total] = await Promise.all([
            prisma.campaign.findMany({
                where,
                include: {
                    mailboxes: {
                        select: {
                            id: true,
                            email: true,
                            status: true,
                            window_sent_count: true,
                            total_sent_count: true,
                            domain: {
                                select: { id: true, domain: true, status: true }
                            }
                        }
                    }
                },
                orderBy,
                take: limit,
                skip
            }),
            prisma.campaign.count({ where })
        ]);

        res.json({
            data: campaigns,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get all domains with pagination.
 */
export const getDomains = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const sortBy = req.query.sortBy as string || 'domain_asc';
        const status = req.query.status as string;
        const search = req.query.search as string;
        const minEngagement = req.query.minEngagement ? parseFloat(req.query.minEngagement as string) : undefined;
        const maxEngagement = req.query.maxEngagement ? parseFloat(req.query.maxEngagement as string) : undefined;
        const minBounceRate = req.query.minBounceRate ? parseFloat(req.query.minBounceRate as string) : undefined;
        const maxBounceRate = req.query.maxBounceRate ? parseFloat(req.query.maxBounceRate as string) : undefined;
        const platform = req.query.platform as string;
        const skip = (page - 1) * limit;

        const where: any = {
            organization_id: orgId
        };

        // Platform filter (supports comma-separated multi-select)
        if (platform && platform !== 'all') {
            const platforms = platform.split(',').filter(Boolean);
            where.source_platform = platforms.length === 1 ? platforms[0] : { in: platforms };
        }

        // Search by domain name
        if (search && search.trim()) {
            where.domain = { contains: search.trim(), mode: 'insensitive' };
        }

        // Status filter (supports comma-separated multi-select)
        if (status && status !== 'all') {
            const statuses = status.split(',').filter(Boolean);
            where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
        }

        // Engagement rate range filter
        if (minEngagement !== undefined || maxEngagement !== undefined) {
            where.engagement_rate = {};
            if (minEngagement !== undefined) where.engagement_rate.gte = minEngagement;
            if (maxEngagement !== undefined) where.engagement_rate.lte = maxEngagement;
        }

        // Bounce rate range filter
        if (minBounceRate !== undefined || maxBounceRate !== undefined) {
            where.bounce_rate = {};
            if (minBounceRate !== undefined) where.bounce_rate.gte = minBounceRate;
            if (maxBounceRate !== undefined) where.bounce_rate.lte = maxBounceRate;
        }

        // Sorting
        let orderBy: any = { domain: 'asc' }; // Default
        switch (sortBy) {
            case 'domain_asc':
                orderBy = { domain: 'asc' };
                break;
            case 'domain_desc':
                orderBy = { domain: 'desc' };
                break;
            case 'sent_desc':
                orderBy = { total_sent_lifetime: 'desc' };
                break;
            case 'sent_asc':
                orderBy = { total_sent_lifetime: 'asc' };
                break;
            case 'engagement_desc':
                orderBy = { engagement_rate: 'desc' };
                break;
            case 'engagement_asc':
                orderBy = { engagement_rate: 'asc' };
                break;
            case 'bounce_desc':
                orderBy = { bounce_rate: 'desc' };
                break;
            case 'bounce_asc':
                orderBy = { bounce_rate: 'asc' };
                break;
        }

        const [domains, total] = await Promise.all([
            prisma.domain.findMany({
                where,
                include: {
                    mailboxes: {
                        select: {
                            id: true,
                            email: true,
                            status: true,
                            hard_bounce_count: true,
                            window_bounce_count: true,
                            campaigns: {
                                select: {
                                    id: true,
                                    name: true,
                                    status: true
                                }
                            }
                        }
                    }
                },
                orderBy,
                take: limit,
                skip
            }),
            prisma.domain.count({ where })
        ]);

        res.json({
            data: domains,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get all mailboxes with pagination.
 */
export const getMailboxes = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const sortBy = req.query.sortBy as string || 'email_asc';
        const status = req.query.status as string;
        const domainId = req.query.domainId as string;
        const campaignId = req.query.campaignId as string;
        const warmupStatus = req.query.warmupStatus as string;
        const search = req.query.search as string;
        const minEngagement = req.query.minEngagement ? parseFloat(req.query.minEngagement as string) : undefined;
        const maxEngagement = req.query.maxEngagement ? parseFloat(req.query.maxEngagement as string) : undefined;
        const platform = req.query.platform as string;
        const skip = (page - 1) * limit;

        const where: any = {
            organization_id: orgId
        };

        // Platform filter (supports comma-separated multi-select)
        if (platform && platform !== 'all') {
            const platforms = platform.split(',').filter(Boolean);
            where.source_platform = platforms.length === 1 ? platforms[0] : { in: platforms };
        }

        // Search by email
        if (search && search.trim()) {
            where.email = { contains: search.trim(), mode: 'insensitive' };
        }

        // Status filter (supports comma-separated multi-select)
        if (status && status !== 'all') {
            const statuses = status.split(',').filter(Boolean);
            where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
        }

        // Domain filter (supports comma-separated multi-select)
        if (domainId && domainId !== 'all') {
            const domainIds = domainId.split(',').filter(Boolean);
            where.domain_id = domainIds.length === 1 ? domainIds[0] : { in: domainIds };
        }

        // Campaign filter (supports comma-separated multi-select)
        if (campaignId && campaignId !== 'all') {
            const campaignIds = campaignId.split(',').filter(Boolean);
            where.campaigns = campaignIds.length === 1
                ? { some: { id: campaignIds[0] } }
                : { some: { id: { in: campaignIds } } };
        }

        // Warmup status filter
        if (warmupStatus && warmupStatus !== 'all') {
            where.warmup_status = warmupStatus;
        }

        // Engagement rate range filter
        if (minEngagement !== undefined || maxEngagement !== undefined) {
            where.engagement_rate = {};
            if (minEngagement !== undefined) where.engagement_rate.gte = minEngagement;
            if (maxEngagement !== undefined) where.engagement_rate.lte = maxEngagement;
        }

        // Sorting
        let orderBy: any = { email: 'asc' }; // Default
        switch (sortBy) {
            case 'email_asc':
                orderBy = { email: 'asc' };
                break;
            case 'email_desc':
                orderBy = { email: 'desc' };
                break;
            case 'sent_desc':
                orderBy = { total_sent_count: 'desc' };
                break;
            case 'sent_asc':
                orderBy = { total_sent_count: 'asc' };
                break;
            case 'engagement_desc':
                orderBy = { engagement_rate: 'desc' };
                break;
            case 'engagement_asc':
                orderBy = { engagement_rate: 'asc' };
                break;
            case 'bounce_desc':
                orderBy = { hard_bounce_count: 'desc' };
                break;
            case 'bounce_asc':
                orderBy = { hard_bounce_count: 'asc' };
                break;
        }

        const [mailboxes, total] = await Promise.all([
            prisma.mailbox.findMany({
                where,
                include: {
                    domain: {
                        select: { id: true, domain: true, status: true }
                    },
                    campaigns: {
                        select: { id: true, name: true, status: true }
                    }
                },
                orderBy,
                take: limit,
                skip
            }),
            prisma.mailbox.count({ where })
        ]);

        logger.info(`[DEBUG] getMailboxes: orgId=${orgId} total=${total} returned=${mailboxes.length} where=${JSON.stringify(where)}`);

        res.json({
            data: mailboxes,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        logger.error('[DEBUG] getMailboxes error', error as Error);
        next(error);
    }
};

/**
 * Get audit logs with optional filtering.
 */
export const getAuditLogs = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { entity, entity_id, limit } = req.query;

        const logs = await prisma.auditLog.findMany({
            where: {
                organization_id: orgId,
                ...(entity && { entity: entity as string }),
                ...(entity_id && { entity_id: entity_id as string })
            },
            orderBy: { timestamp: 'desc' },
            take: limit ? parseInt(limit as string, 10) : 100
        });

        res.json({ success: true, data: logs });
    } catch (error) {
        logger.error('getAuditLogs error', error as Error);
        res.status(500).json({ success: false, error: 'Failed to fetch audit logs' });
    }
};

/**
 * Get routing rules.
 */
export const getRoutingRules = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const rules = await routingService.getRules(orgId);
        res.json({ success: true, data: rules });
    } catch (error) {
        logger.error('getRoutingRules error', error as Error);
        res.status(500).json({ success: false, error: 'Failed to fetch routing rules' });
    }
};

/**
 * Create a new routing rule.
 */
export const createRoutingRule = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { persona, min_score, target_campaign_id, priority } = req.body;

        if (!persona || !target_campaign_id) {
            return res.status(400).json({ success: false, error: 'Missing required fields: persona, target_campaign_id' });
        }

        const rule = await routingService.createRule(orgId, {
            persona,
            min_score: min_score || 0,
            target_campaign_id,
            priority: priority || 0
        });

        res.json({ success: true, data: rule });
    } catch (error) {
        logger.error('createRoutingRule error', error as Error);
        res.status(500).json({ success: false, error: 'Failed to create routing rule' });
    }
};


/**
 * Get lead health gate statistics.
 * Returns GREEN/YELLOW/RED counts and recent blocked leads.
 */
export const getLeadHealthStats = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        // Exclude leads from deleted/archived campaigns
        const activeCampaignIds = await prisma.campaign.findMany({
            where: {
                organization_id: orgId,
                status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] }
            },
            select: { id: true }
        }).then(cs => cs.map(c => c.id));

        const activeCampaignFilter = {
            OR: [
                { assigned_campaign_id: { in: activeCampaignIds } },
                { assigned_campaign_id: null }
            ]
        };

        // Count leads by health classification (cached for 15s)
        const data = await cached(orgId, 'leadHealthStats', async () => {
            const [total, green, yellow, red, blocked, recentBlocked] = await Promise.all([
                prisma.lead.count({ where: { organization_id: orgId, deleted_at: null, ...activeCampaignFilter } }),
                prisma.lead.count({ where: { organization_id: orgId, health_classification: 'green', deleted_at: null, ...activeCampaignFilter } }),
                prisma.lead.count({ where: { organization_id: orgId, health_classification: 'yellow', deleted_at: null, ...activeCampaignFilter } }),
                prisma.lead.count({ where: { organization_id: orgId, health_classification: 'red', deleted_at: null, ...activeCampaignFilter } }),
                prisma.lead.count({ where: { organization_id: orgId, status: 'blocked', deleted_at: null, ...activeCampaignFilter } }),
                prisma.lead.findMany({
                    where: {
                        organization_id: orgId,
                        health_classification: 'red',
                        deleted_at: null,
                        ...activeCampaignFilter
                    },
                    select: {
                        id: true,
                        email: true,
                        health_classification: true,
                        health_score_calc: true,
                        health_checks: true,
                        created_at: true
                    },
                    orderBy: { created_at: 'desc' },
                    take: 10
                })
            ]);
            return {
                total, green, yellow, red, blocked, recentBlocked,
                greenPercent: total > 0 ? Math.round((green / total) * 100) : 0,
                yellowPercent: total > 0 ? Math.round((yellow / total) * 100) : 0,
                redPercent: total > 0 ? Math.round((red / total) * 100) : 0
            };
        });

        res.json({ success: true, data });
    } catch (error) {
        logger.error('getLeadHealthStats error', error as Error);
        res.status(500).json({ success: false, error: 'Failed to fetch lead health stats' });
    }
};

/**
 * Get campaign health statistics.
 * Returns active/paused/warning counts and campaign details.
 */
/**
 * Pause a campaign.
 */
export const pauseCampaign = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { campaignId, reason } = req.body;

        if (!campaignId) {
            return res.status(400).json({ success: false, error: 'Missing campaignId' });
        }

        await campaignHealthService.pauseCampaign(orgId, campaignId, reason || 'Manual pause');
        res.json({ success: true, message: 'Campaign paused' });
    } catch (error) {
        logger.error('pauseCampaign error', error as Error);
        res.status(500).json({ success: false, error: 'Failed to pause campaign' });
    }
};

/**
 * Resume a campaign.
 */
export const resumeCampaign = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { campaignId } = req.body;

        if (!campaignId) {
            return res.status(400).json({ success: false, error: 'Missing campaignId' });
        }

        await campaignHealthService.resumeCampaign(orgId, campaignId);
        res.json({ success: true, message: 'Campaign resumed' });
    } catch (error) {
        logger.error('resumeCampaign error', error as Error);
        res.status(500).json({ success: false, error: 'Failed to resume campaign' });
    }
};

/**
 * Get warmup recovery status summary for organization
 */
export const getWarmupStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const { getWarmupStatusSummary } = require('../workers/warmupTrackingWorker');

        const summary = await getWarmupStatusSummary(orgId);

        res.json({
            success: true,
            data: summary
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Manually trigger warmup progress check for organization
 */
export const checkWarmupProgress = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const { checkWarmupProgress } = require('../workers/warmupTrackingWorker');

        const result = await checkWarmupProgress();

        res.json({
            success: true,
            data: result,
            message: `Checked ${result.checked} mailboxes, graduated ${result.graduated}`
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Manually resume a paused mailbox
 * @route POST /api/infrastructure/mailbox/resume
 */
export const resumeMailbox = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const { mailboxId } = req.body;

        if (!mailboxId) {
            return res.status(400).json({
                success: false,
                error: 'mailboxId is required'
            });
        }

        // Verify mailbox belongs to organization
        const mailbox = await prisma.mailbox.findUnique({
            where: { id: mailboxId }
        });

        if (!mailbox || mailbox.organization_id !== orgId) {
            return res.status(404).json({
                success: false,
                error: 'Mailbox not found'
            });
        }

        // Resume mailbox via centralized state service
        const result = await entityStateService.transitionMailbox(
            orgId,
            mailboxId,
            MailboxState.HEALTHY,
            'Manually resumed by user',
            TriggerType.MANUAL
        );

        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error || 'Cannot transition mailbox to healthy from current state'
            });
        }

        // Clear paused metadata (separate from status transition)
        await prisma.mailbox.update({
            where: { id: mailboxId },
            data: {
                paused_reason: null,
                paused_at: null,
                paused_by: null,
            }
        });

        // ── PLATFORM SYNC: Re-add mailbox to its campaigns on the external platform ──
        // When paused, the mailbox was removed from campaigns on the platform but the
        // DB relationship was preserved. Re-add it now.
        let platformAdded = 0;
        let platformFailed = 0;
        try {
            const adapter = await getAdapterForMailbox(mailboxId);
            const campaigns = await prisma.campaign.findMany({
                where: {
                    organization_id: orgId,
                    mailboxes: { some: { id: mailboxId } },
                    status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] },
                },
                select: { id: true, external_id: true, name: true },
            });

            for (const campaign of campaigns) {
                try {
                    await adapter.addMailboxToCampaign(
                        orgId,
                        campaign.external_id || campaign.id,
                        mailbox.external_email_account_id || mailboxId,
                    );
                    platformAdded++;
                } catch (addErr: any) {
                    platformFailed++;
                    logger.warn(`[INFRASTRUCTURE] Failed to re-add mailbox ${mailboxId} to campaign ${campaign.name} on platform`, {
                        error: addErr.message,
                    });
                }
            }

            logger.info(`[INFRASTRUCTURE] Re-added mailbox ${mailboxId} to ${platformAdded} campaigns on platform`, {
                platformAdded, platformFailed,
            });
        } catch (adapterErr: any) {
            logger.error(`[INFRASTRUCTURE] Failed to get adapter for mailbox ${mailboxId}`, adapterErr);
        }

        logger.info(`[INFRASTRUCTURE] Mailbox ${mailboxId} manually resumed by user`);

        res.json({
            success: true,
            message: `Mailbox resumed successfully${platformAdded > 0 ? ` and re-added to ${platformAdded} campaign(s) on platform` : ''}`,
            platformAdded,
            platformFailed,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Manually resume a paused domain
 * @route POST /api/infrastructure/domain/resume
 */
export const resumeDomain = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const { domainId } = req.body;

        if (!domainId) {
            return res.status(400).json({
                success: false,
                error: 'domainId is required'
            });
        }

        // Verify domain belongs to organization
        const domain = await prisma.domain.findUnique({
            where: { id: domainId }
        });

        if (!domain || domain.organization_id !== orgId) {
            return res.status(404).json({
                success: false,
                error: 'Domain not found'
            });
        }

        // Resume domain via centralized state service
        const result = await entityStateService.transitionDomain(
            orgId,
            domainId,
            DomainState.HEALTHY,
            'Manually resumed by user',
            TriggerType.MANUAL
        );

        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error || 'Cannot transition domain to healthy from current state'
            });
        }

        // Clear paused metadata (separate from status transition)
        await prisma.domain.update({
            where: { id: domainId },
            data: {
                paused_reason: null,
                paused_at: null,
                paused_by: null,
                warning_count: 0
            }
        });

        // ── PLATFORM SYNC: Re-add domain's mailboxes to their campaigns ──
        // When domain was paused, its mailboxes were removed from campaigns on the platform.
        // Re-add each healthy mailbox back to its assigned campaigns.
        let totalAdded = 0;
        let totalFailed = 0;
        try {
            const mailboxes = await prisma.mailbox.findMany({
                where: {
                    domain_id: domainId,
                    organization_id: orgId,
                    status: { in: ['healthy', 'active'] },
                },
                select: { id: true, external_email_account_id: true, email: true },
            });

            for (const mb of mailboxes) {
                try {
                    const adapter = await getAdapterForMailbox(mb.id);
                    const campaigns = await prisma.campaign.findMany({
                        where: {
                            organization_id: orgId,
                            mailboxes: { some: { id: mb.id } },
                            status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] },
                        },
                        select: { id: true, external_id: true, name: true },
                    });

                    for (const campaign of campaigns) {
                        try {
                            await adapter.addMailboxToCampaign(
                                orgId,
                                campaign.external_id || campaign.id,
                                mb.external_email_account_id || mb.id,
                            );
                            totalAdded++;
                        } catch (addErr: any) {
                            totalFailed++;
                            logger.warn(`[INFRASTRUCTURE] Failed to re-add mailbox ${mb.email} to campaign ${campaign.name} on platform`, {
                                error: addErr.message,
                            });
                        }
                    }
                } catch (mbErr: any) {
                    logger.warn(`[INFRASTRUCTURE] Failed to process mailbox ${mb.email} for domain resume`, {
                        error: mbErr.message,
                    });
                }
            }

            logger.info(`[INFRASTRUCTURE] Domain ${domainId} resume: re-added ${totalAdded} mailbox-campaign links on platform`, {
                totalAdded, totalFailed, mailboxCount: mailboxes.length,
            });
        } catch (adapterErr: any) {
            logger.error(`[INFRASTRUCTURE] Failed to re-add mailboxes for domain ${domainId}`, adapterErr);
        }

        logger.info(`[INFRASTRUCTURE] Domain ${domainId} manually resumed by user`);

        res.json({
            success: true,
            message: `Domain resumed successfully${totalAdded > 0 ? ` and re-added ${totalAdded} mailbox-campaign link(s) on platform` : ''}`,
            platformAdded: totalAdded,
            platformFailed: totalFailed,
        });
    } catch (error) {
        next(error);
    }
};
