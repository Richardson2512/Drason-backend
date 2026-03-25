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

        if (status === 'invalid') {
            where.validation_status = 'invalid';
        } else if (status === 'bounced') {
            where.bounced = true;
        } else if (status && status !== 'all') {
            const statuses = status.split(',').filter(Boolean);
            // Separate special statuses that map to different fields
            const hasInvalid = statuses.includes('invalid');
            const hasBounced = statuses.includes('bounced');
            const normalStatuses = statuses.filter(s => s !== 'bounced' && s !== 'invalid');

            const orConditions: any[] = [];
            if (hasInvalid) orConditions.push({ validation_status: 'invalid' });
            if (hasBounced) orConditions.push({ bounced: true });
            if (normalStatuses.length > 0) {
                orConditions.push({ status: normalStatuses.length === 1 ? normalStatuses[0] : { in: normalStatuses } });
            }

            if (orConditions.length > 1) {
                where.AND.push({ OR: orConditions });
            } else if (orConditions.length === 1) {
                Object.assign(where, orConditions[0]);
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

        const mbWhere = { organization_id: orgId };
        const [
            leadTotal, leadActive, leadHeld, leadPaused, leadBounced, leadInvalid,
            campaignTotal, campaignActive, campaignPaused, campaignCompleted,
            mailboxTotal, mailboxHealthy, mailboxWarning, mailboxPaused,
            mbQuarantine, mbRestrictedSend, mbWarmRecovery, mbInRecovery,
            domainTotal, domainHealthy, domainWarning, domainPaused
        ] = await Promise.all([
            prisma.lead.count({ where: leadWhere }),
            prisma.lead.count({ where: { ...leadWhere, status: 'active' } }),
            prisma.lead.count({ where: { ...leadWhere, status: 'held' } }),
            prisma.lead.count({ where: { ...leadWhere, status: 'paused' } }),
            prisma.lead.count({ where: { ...leadWhere, bounced: true } }),
            prisma.lead.count({ where: { ...leadWhere, validation_status: 'invalid' } }),
            prisma.campaign.count({ where: { organization_id: orgId, status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] } } }),
            prisma.campaign.count({ where: { organization_id: orgId, status: 'active' } }),
            prisma.campaign.count({ where: { organization_id: orgId, status: 'paused' } }),
            prisma.campaign.count({ where: { organization_id: orgId, status: 'completed' } }),
            prisma.mailbox.count({ where: mbWhere }),
            prisma.mailbox.count({ where: { ...mbWhere, status: 'healthy' } }),
            prisma.mailbox.count({ where: { ...mbWhere, status: 'warning' } }),
            prisma.mailbox.count({ where: { ...mbWhere, status: 'paused' } }),
            prisma.mailbox.count({ where: { ...mbWhere, recovery_phase: 'quarantine' } }),
            prisma.mailbox.count({ where: { ...mbWhere, recovery_phase: 'restricted_send' } }),
            prisma.mailbox.count({ where: { ...mbWhere, recovery_phase: 'warm_recovery' } }),
            prisma.mailbox.count({ where: { ...mbWhere, recovery_phase: { notIn: ['healthy', 'paused'] } } }),
            prisma.domain.count({ where: { organization_id: orgId } }),
            prisma.domain.count({ where: { organization_id: orgId, status: 'healthy' } }),
            prisma.domain.count({ where: { organization_id: orgId, status: 'warning' } }),
            prisma.domain.count({ where: { organization_id: orgId, status: 'paused' } }),
        ]);

        // Get recent rotation events from audit logs
        const recentRotations = await prisma.auditLog.findMany({
            where: {
                organization_id: orgId,
                action: { in: ['rotated_into_campaign', 'mailbox_rotated_in'] },
            },
            orderBy: { timestamp: 'desc' },
            take: 20,
            select: { id: true, entity: true, entity_id: true, action: true, details: true, timestamp: true }
        });

        res.json({
            success: true,
            data: {
                leads: { total: leadTotal, active: leadActive, held: leadHeld, paused: leadPaused, bounced: leadBounced, invalid: leadInvalid },
                campaigns: { total: campaignTotal, active: campaignActive, paused: campaignPaused, completed: campaignCompleted },
                mailboxes: {
                    total: mailboxTotal, healthy: mailboxHealthy, warning: mailboxWarning, paused: mailboxPaused,
                    quarantine: mbQuarantine, restricted_send: mbRestrictedSend, warm_recovery: mbWarmRecovery, in_recovery: mbInRecovery,
                },
                domains: { total: domainTotal, healthy: domainHealthy, warning: domainWarning, paused: domainPaused },
                rotations: recentRotations,
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
 * Get recent email validation activity.
 * Returns the latest validation attempts with lead email and result.
 */
export const getValidationActivity = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const limit = Math.min(parseInt(req.query.limit as string || '20'), 50);

        // Get recent validation attempts
        const attempts = await prisma.validationAttempt.findMany({
            where: { organization_id: orgId },
            orderBy: { created_at: 'desc' },
            take: limit,
        });

        // Get summary counts for the last 24 hours
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [total24h, valid24h, risky24h, invalid24h, unknown24h] = await Promise.all([
            prisma.validationAttempt.count({ where: { organization_id: orgId, created_at: { gte: since24h } } }),
            prisma.validationAttempt.count({ where: { organization_id: orgId, created_at: { gte: since24h }, result_status: 'valid' } }),
            prisma.validationAttempt.count({ where: { organization_id: orgId, created_at: { gte: since24h }, result_status: 'risky' } }),
            prisma.validationAttempt.count({ where: { organization_id: orgId, created_at: { gte: since24h }, result_status: 'invalid' } }),
            prisma.validationAttempt.count({ where: { organization_id: orgId, created_at: { gte: since24h }, result_status: 'unknown' } }),
        ]);

        // Enrich attempts with lead email by looking up lead_id
        const leadIds = [...new Set(attempts.map(a => a.lead_id).filter(id => id !== 'pre-upsert'))];
        const leads = leadIds.length > 0 ? await prisma.lead.findMany({
            where: { id: { in: leadIds } },
            select: { id: true, email: true },
        }) : [];
        const leadMap = new Map(leads.map(l => [l.id, l.email]));

        const enrichedAttempts = attempts.map(a => ({
            id: a.id,
            email: leadMap.get(a.lead_id) || 'Unknown',
            source: a.source,
            status: a.result_status,
            score: a.result_score,
            details: a.result_details,
            duration_ms: a.duration_ms,
            created_at: a.created_at,
        }));

        res.json({
            success: true,
            data: {
                summary: { total: total24h, valid: valid24h, risky: risky24h, invalid: invalid24h, unknown: unknown24h },
                activity: enrichedAttempts,
            }
        });
    } catch (error) {
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

// ============================================================================
// REPORT GENERATION
// ============================================================================

/**
 * Convert an array of objects to a CSV string.
 * Handles quoting fields that contain commas, quotes, or newlines.
 */
function toCsv(rows: Record<string, any>[], columns: { key: string; label: string }[]): string {
    const escapeField = (val: any): string => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const header = columns.map(c => escapeField(c.label)).join(',');
    const lines = rows.map(row =>
        columns.map(c => escapeField(row[c.key])).join(',')
    );
    return [header, ...lines].join('\n');
}

/**
 * Generate CSV reports for various entity types.
 * GET /api/dashboard/reports/generate
 */
export const generateReport = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = getOrgId(req);
        const reportType = req.query.report_type as string;
        const startDateStr = req.query.start_date as string;
        const endDateStr = req.query.end_date as string;
        const statusFilter = req.query.status as string;
        const campaignIdFilter = req.query.campaign_id as string;
        const domainIdFilter = req.query.domain_id as string;
        const platformFilter = req.query.platform as string;

        const validTypes = ['leads', 'campaigns', 'mailboxes', 'domains', 'analytics', 'audit_logs', 'load_balancing', 'full'];
        if (!reportType || !validTypes.includes(reportType)) {
            res.status(400).json({ success: false, error: `Invalid report_type. Must be one of: ${validTypes.join(', ')}` });
            return;
        }

        const endDate = endDateStr ? new Date(endDateStr) : new Date();
        const startDate = startDateStr ? new Date(startDateStr) : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        // Set end date to end of day
        endDate.setHours(23, 59, 59, 999);

        const statuses = statusFilter ? statusFilter.split(',').filter(Boolean) : [];
        const campaignIds = campaignIdFilter ? campaignIdFilter.split(',').filter(Boolean) : [];
        const domainIds = domainIdFilter ? domainIdFilter.split(',').filter(Boolean) : [];
        const platforms = platformFilter ? platformFilter.split(',').filter(Boolean) : [];

        const sections: string[] = [];

        // ---- LEADS ----
        if (reportType === 'leads' || reportType === 'full') {
            const where: any = {
                organization_id: orgId,
                deleted_at: null,
                created_at: { gte: startDate, lte: endDate },
            };
            if (statuses.length > 0) {
                const normalStatuses = statuses.filter(s => s !== 'bounced' && s !== 'invalid');
                const orConds: any[] = [];
                if (statuses.includes('bounced')) orConds.push({ bounced: true });
                if (statuses.includes('invalid')) orConds.push({ validation_status: 'invalid' });
                if (normalStatuses.length > 0) orConds.push({ status: { in: normalStatuses } });
                if (orConds.length > 0) where.OR = orConds;
            }
            if (campaignIds.length > 0) where.assigned_campaign_id = { in: campaignIds };
            if (platforms.length > 0) where.source_platform = { in: platforms };

            const leads = await prisma.lead.findMany({
                where,
                orderBy: { created_at: 'desc' },
                take: 50000,
            });

            // Get campaign names
            const cIds = [...new Set(leads.filter(l => l.assigned_campaign_id).map(l => l.assigned_campaign_id as string))];
            const campaignMap = new Map<string, string>();
            if (cIds.length > 0) {
                const campaigns = await prisma.campaign.findMany({
                    where: { id: { in: cIds }, organization_id: orgId },
                    select: { id: true, name: true },
                });
                campaigns.forEach(c => campaignMap.set(c.id, c.name));
            }

            const columns = [
                { key: 'email', label: 'Email' },
                { key: 'status', label: 'Status' },
                { key: 'lead_score', label: 'Lead Score' },
                { key: 'health_classification', label: 'Health Classification' },
                { key: 'validation_status', label: 'Validation Status' },
                { key: 'validation_score', label: 'Validation Score' },
                { key: 'campaign_name', label: 'Campaign Name' },
                { key: 'emails_sent', label: 'Emails Sent' },
                { key: 'emails_opened', label: 'Emails Opened' },
                { key: 'emails_clicked', label: 'Emails Clicked' },
                { key: 'emails_replied', label: 'Emails Replied' },
                { key: 'bounced', label: 'Bounced' },
                { key: 'created_at', label: 'Created At' },
                { key: 'last_activity_at', label: 'Last Activity At' },
            ];

            const rows = leads.map(l => ({
                ...l,
                campaign_name: l.assigned_campaign_id ? (campaignMap.get(l.assigned_campaign_id) || '') : '',
                bounced: l.bounced ? 'Yes' : 'No',
                created_at: l.created_at?.toISOString() || '',
                last_activity_at: l.last_activity_at?.toISOString() || '',
            }));

            if (reportType === 'full') sections.push(`--- LEADS REPORT ---\n${toCsv(rows, columns)}`);
            else sections.push(toCsv(rows, columns));
        }

        // ---- CAMPAIGNS ----
        if (reportType === 'campaigns' || reportType === 'full') {
            const where: any = {
                organization_id: orgId,
                status: { notIn: ['deleted', 'DELETED', 'archived', 'ARCHIVED'] },
                created_at: { gte: startDate, lte: endDate },
            };
            if (statuses.length > 0) where.status = { in: statuses };
            if (campaignIds.length > 0) where.id = { in: campaignIds };
            if (platforms.length > 0) where.source_platform = { in: platforms };

            const campaigns = await prisma.campaign.findMany({
                where,
                include: {
                    mailboxes: { select: { id: true } },
                },
                orderBy: { created_at: 'desc' },
                take: 10000,
            });

            // Count leads per campaign
            const leadCounts = await prisma.lead.groupBy({
                by: ['assigned_campaign_id'],
                where: { organization_id: orgId, deleted_at: null, assigned_campaign_id: { in: campaigns.map(c => c.id) } },
                _count: true,
            });
            const leadCountMap = new Map(leadCounts.map(lc => [lc.assigned_campaign_id, lc._count]));

            const columns = [
                { key: 'name', label: 'Name' },
                { key: 'status', label: 'Status' },
                { key: 'source_platform', label: 'Platform' },
                { key: 'mailbox_count', label: 'Mailbox Count' },
                { key: 'lead_count', label: 'Lead Count' },
                { key: 'total_sent', label: 'Total Sent' },
                { key: 'total_opens', label: 'Total Opens' },
                { key: 'total_replies', label: 'Total Replies' },
                { key: 'total_bounces', label: 'Total Bounces' },
                { key: 'open_rate', label: 'Open Rate (%)' },
                { key: 'reply_rate', label: 'Reply Rate (%)' },
                { key: 'bounce_rate', label: 'Bounce Rate (%)' },
                { key: 'paused_reason', label: 'Paused Reason' },
                { key: 'created_at', label: 'Created At' },
            ];

            const rows = campaigns.map(c => ({
                ...c,
                mailbox_count: c.mailboxes.length,
                lead_count: leadCountMap.get(c.id) || 0,
                total_opens: c.open_count,
                total_replies: c.reply_count,
                total_bounces: c.total_bounced,
                open_rate: c.open_rate.toFixed(1),
                reply_rate: c.reply_rate.toFixed(1),
                bounce_rate: c.bounce_rate.toFixed(1),
                created_at: c.created_at?.toISOString() || '',
            }));

            if (reportType === 'full') sections.push(`\n--- CAMPAIGNS REPORT ---\n${toCsv(rows, columns)}`);
            else sections.push(toCsv(rows, columns));
        }

        // ---- MAILBOXES ----
        if (reportType === 'mailboxes' || reportType === 'full') {
            const where: any = {
                organization_id: orgId,
                created_at: { gte: startDate, lte: endDate },
            };
            if (statuses.length > 0) where.status = { in: statuses };
            if (domainIds.length > 0) where.domain_id = { in: domainIds };
            if (platforms.length > 0) where.source_platform = { in: platforms };

            const mailboxes = await prisma.mailbox.findMany({
                where,
                include: {
                    domain: { select: { domain: true } },
                    campaigns: { select: { id: true } },
                },
                orderBy: { created_at: 'desc' },
                take: 50000,
            });

            const columns = [
                { key: 'email', label: 'Email' },
                { key: 'status', label: 'Status' },
                { key: 'recovery_phase', label: 'Recovery Phase' },
                { key: 'domain_name', label: 'Domain' },
                { key: 'source_platform', label: 'Platform' },
                { key: 'resilience_score', label: 'Resilience Score' },
                { key: 'bounce_rate', label: 'Bounce Rate (%)' },
                { key: 'total_sent', label: 'Total Sent' },
                { key: 'total_opens', label: 'Total Opens' },
                { key: 'engagement_rate', label: 'Engagement Rate (%)' },
                { key: 'warmup_status', label: 'Warmup Status' },
                { key: 'campaign_count', label: 'Campaign Count' },
                { key: 'paused_reason', label: 'Paused Reason' },
                { key: 'consecutive_pauses', label: 'Consecutive Pauses' },
                { key: 'created_at', label: 'Created At' },
            ];

            const rows = mailboxes.map(m => {
                const bounceRate = m.total_sent_count > 0
                    ? ((m.hard_bounce_count / m.total_sent_count) * 100).toFixed(1)
                    : '0.0';
                return {
                    ...m,
                    domain_name: m.domain?.domain || '',
                    bounce_rate: bounceRate,
                    total_sent: m.total_sent_count,
                    total_opens: m.open_count_lifetime,
                    engagement_rate: m.engagement_rate.toFixed(1),
                    campaign_count: m.campaigns.length,
                    created_at: m.created_at?.toISOString() || '',
                };
            });

            if (reportType === 'full') sections.push(`\n--- MAILBOXES REPORT ---\n${toCsv(rows, columns)}`);
            else sections.push(toCsv(rows, columns));
        }

        // ---- DOMAINS ----
        if (reportType === 'domains' || reportType === 'full') {
            const where: any = {
                organization_id: orgId,
                created_at: { gte: startDate, lte: endDate },
            };
            if (statuses.length > 0) where.status = { in: statuses };
            if (domainIds.length > 0) where.id = { in: domainIds };
            if (platforms.length > 0) where.source_platform = { in: platforms };

            const domains = await prisma.domain.findMany({
                where,
                include: {
                    mailboxes: { select: { id: true, status: true } },
                },
                orderBy: { created_at: 'desc' },
                take: 10000,
            });

            const columns = [
                { key: 'domain', label: 'Domain' },
                { key: 'status', label: 'Status' },
                { key: 'mailbox_count', label: 'Mailbox Count' },
                { key: 'healthy_mailboxes', label: 'Healthy Mailboxes' },
                { key: 'paused_mailboxes', label: 'Paused Mailboxes' },
                { key: 'bounce_rate', label: 'Bounce Rate (%)' },
                { key: 'engagement_rate', label: 'Engagement Rate (%)' },
                { key: 'spf_valid', label: 'SPF Valid' },
                { key: 'dkim_valid', label: 'DKIM Valid' },
                { key: 'dmarc_valid', label: 'DMARC Valid' },
                { key: 'blacklisted', label: 'Blacklisted' },
                { key: 'created_at', label: 'Created At' },
            ];

            const rows = domains.map(d => {
                const healthyCount = d.mailboxes.filter(m => m.status === 'healthy').length;
                const pausedCount = d.mailboxes.filter(m => m.status === 'paused').length;
                const isBlacklisted = d.blacklist_results
                    ? Object.values(d.blacklist_results as Record<string, string>).some(v => v === 'CONFIRMED')
                    : false;
                return {
                    domain: d.domain,
                    status: d.status,
                    mailbox_count: d.mailboxes.length,
                    healthy_mailboxes: healthyCount,
                    paused_mailboxes: pausedCount,
                    bounce_rate: d.bounce_rate.toFixed(1),
                    engagement_rate: d.engagement_rate.toFixed(1),
                    spf_valid: d.spf_valid === null ? 'Unknown' : d.spf_valid ? 'Yes' : 'No',
                    dkim_valid: d.dkim_valid === null ? 'Unknown' : d.dkim_valid ? 'Yes' : 'No',
                    dmarc_valid: d.dmarc_policy ? d.dmarc_policy : 'Unknown',
                    blacklisted: isBlacklisted ? 'Yes' : 'No',
                    created_at: d.created_at?.toISOString() || '',
                };
            });

            if (reportType === 'full') sections.push(`\n--- DOMAINS REPORT ---\n${toCsv(rows, columns)}`);
            else sections.push(toCsv(rows, columns));
        }

        // ---- ANALYTICS ----
        if (reportType === 'analytics' || reportType === 'full') {
            const where: any = {
                organization_id: orgId,
                date: { gte: startDate, lte: endDate },
            };
            if (campaignIds.length > 0) where.campaign_id = { in: campaignIds };

            const analytics = await prisma.campaignDailyAnalytics.findMany({
                where,
                include: { campaign: { select: { name: true } } },
                orderBy: [{ date: 'desc' }, { campaign_id: 'asc' }],
                take: 100000,
            });

            const columns = [
                { key: 'campaign_name', label: 'Campaign Name' },
                { key: 'date', label: 'Date' },
                { key: 'sent_count', label: 'Sent' },
                { key: 'open_count', label: 'Opens' },
                { key: 'click_count', label: 'Clicks' },
                { key: 'reply_count', label: 'Replies' },
                { key: 'bounce_count', label: 'Bounces' },
                { key: 'unsubscribe_count', label: 'Unsubscribes' },
            ];

            const rows = analytics.map(a => ({
                ...a,
                campaign_name: a.campaign?.name || '',
                date: a.date?.toISOString().split('T')[0] || '',
            }));

            if (reportType === 'full') sections.push(`\n--- ANALYTICS REPORT ---\n${toCsv(rows, columns)}`);
            else sections.push(toCsv(rows, columns));
        }

        // ---- AUDIT LOGS ----
        if (reportType === 'audit_logs' || reportType === 'full') {
            const where: any = {
                organization_id: orgId,
                timestamp: { gte: startDate, lte: endDate },
            };

            const logs = await prisma.auditLog.findMany({
                where,
                orderBy: { timestamp: 'desc' },
                take: 100000,
            });

            const columns = [
                { key: 'timestamp', label: 'Timestamp' },
                { key: 'entity', label: 'Entity' },
                { key: 'entity_id', label: 'Entity ID' },
                { key: 'action', label: 'Action' },
                { key: 'trigger', label: 'Trigger' },
                { key: 'details', label: 'Details' },
            ];

            const rows = logs.map(l => ({
                ...l,
                timestamp: l.timestamp?.toISOString() || '',
            }));

            if (reportType === 'full') sections.push(`\n--- AUDIT LOGS REPORT ---\n${toCsv(rows, columns)}`);
            else sections.push(toCsv(rows, columns));
        }

        // ---- LOAD BALANCING ----
        if (reportType === 'load_balancing' || reportType === 'full') {
            const mailboxes = await prisma.mailbox.findMany({
                where: { organization_id: orgId },
                include: {
                    domain: { select: { domain: true } },
                    campaigns: { select: { id: true } },
                },
                orderBy: { total_sent_count: 'desc' },
                take: 50000,
            });

            const columns = [
                { key: 'email', label: 'Mailbox Email' },
                { key: 'domain_name', label: 'Domain' },
                { key: 'campaign_count', label: 'Campaign Count' },
                { key: 'effective_load', label: 'Effective Load' },
                { key: 'status', label: 'Status' },
                { key: 'total_sent', label: 'Total Sent' },
            ];

            const rows = mailboxes.map(m => ({
                email: m.email,
                domain_name: m.domain?.domain || '',
                campaign_count: m.campaigns.length,
                effective_load: m.campaigns.length * (m.window_sent_count || 0),
                status: m.status,
                total_sent: m.total_sent_count,
            }));

            if (reportType === 'full') sections.push(`\n--- LOAD BALANCING REPORT ---\n${toCsv(rows, columns)}`);
            else sections.push(toCsv(rows, columns));
        }

        const csvContent = sections.join('\n');
        const filename = `superkabe-${reportType}-report-${new Date().toISOString().split('T')[0]}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);

        logger.info(`[REPORTS] Generated ${reportType} report for org ${orgId}`, {
            reportType, startDate: startDate.toISOString(), endDate: endDate.toISOString(),
            filters: { statuses, campaignIds, domainIds, platforms },
        });
    } catch (error) {
        next(error);
    }
};
