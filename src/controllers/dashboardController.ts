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
import { logger } from '../services/observabilityService';

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
        const skip = (page - 1) * limit;

        const where: any = {
            organization_id: orgId,
            deleted_at: null
        };

        if (status && status !== 'all') {
            where.status = status;
        }

        if (campaignId) {
            where.assigned_campaign_id = campaignId;
        }

        const [leads, total] = await Promise.all([
            prisma.lead.findMany({
                where,
                orderBy: { created_at: 'desc' },
                take: limit,
                skip
            }),
            prisma.lead.count({ where })
        ]);

        // Fetch campaign names for all assigned campaigns
        const campaignIds = [...new Set(leads.filter(l => l.assigned_campaign_id).map(l => l.assigned_campaign_id))];
        const campaigns = await prisma.campaign.findMany({
            where: { id: { in: campaignIds as string[] } },
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

        const where: any = {
            organization_id: orgId,
            deleted_at: null
        };

        if (campaignId) {
            where.assigned_campaign_id = campaignId;
        }

        const [activeCount, heldCount, pausedCount, completedCount, totalCount] = await Promise.all([
            prisma.lead.count({ where: { ...where, status: 'active' } }),
            prisma.lead.count({ where: { ...where, status: 'held' } }),
            prisma.lead.count({ where: { ...where, status: 'paused' } }),
            prisma.lead.count({ where: { ...where, status: 'completed' } }),
            prisma.lead.count({ where })
        ]);

        res.json({
            success: true,
            data: {
                active: activeCount,
                held: heldCount,
                paused: pausedCount,
                completed: completedCount,
                total: totalCount
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
        const skip = (page - 1) * limit;

        const [campaigns, total] = await Promise.all([
            prisma.campaign.findMany({
                where: { organization_id: orgId },
                include: {
                    mailboxes: {
                        select: {
                            id: true,
                            email: true,
                            status: true,
                            domain: {
                                select: { id: true, domain: true, status: true }
                            }
                        }
                    }
                },
                orderBy: { name: 'asc' },
                take: limit,
                skip
            }),
            prisma.campaign.count({ where: { organization_id: orgId } })
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
        const skip = (page - 1) * limit;

        const [domains, total] = await Promise.all([
            prisma.domain.findMany({
                where: { organization_id: orgId },
                include: {
                    mailboxes: {
                        select: {
                            id: true, email: true, status: true, hard_bounce_count: true, window_bounce_count: true
                        }
                    }
                },
                orderBy: { domain: 'asc' },
                take: limit,
                skip
            }),
            prisma.domain.count({ where: { organization_id: orgId } })
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
        const skip = (page - 1) * limit;

        const [mailboxes, total] = await Promise.all([
            prisma.mailbox.findMany({
                where: { organization_id: orgId },
                include: {
                    domain: {
                        select: { id: true, domain: true, status: true }
                    }
                },
                orderBy: { email: 'asc' },
                take: limit,
                skip
            }),
            prisma.mailbox.count({ where: { organization_id: orgId } })
        ]);

        res.json({
            data: mailboxes,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
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
        const { entity, limit } = req.query;

        const logs = await prisma.auditLog.findMany({
            where: {
                organization_id: orgId,
                ...(entity && { entity: entity as string })
            },
            orderBy: { timestamp: 'desc' },
            take: limit ? parseInt(limit as string, 10) : 100
        });

        res.json({ success: true, data: logs });
    } catch (error) {
        logger.error('getAuditLogs error', error as Error);
        res.status(500).json({ error: 'Failed to fetch audit logs' });
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
        res.status(500).json({ error: 'Failed to fetch routing rules' });
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
            return res.status(400).json({ error: 'Missing required fields: persona, target_campaign_id' });
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
        res.status(500).json({ error: 'Failed to create routing rule' });
    }
};

/**
 * Get state transitions for an entity.
 */
export const getStateTransitions = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { entityType, entityId } = req.query;

        const transitions = await prisma.stateTransition.findMany({
            where: {
                organization_id: orgId,
                ...(entityType && { entity_type: entityType as string }),
                ...(entityId && { entity_id: entityId as string })
            },
            orderBy: { created_at: 'desc' },
            take: 100
        });

        res.json({ success: true, data: transitions });
    } catch (error) {
        logger.error('getStateTransitions error', error as Error);
        res.status(500).json({ error: 'Failed to fetch state transitions' });
    }
};

/**
 * Get raw events for debugging/replay.
 */
export const getRawEvents = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { eventType, entityType, limit } = req.query;

        const events = await prisma.rawEvent.findMany({
            where: {
                organization_id: orgId,
                ...(eventType && { event_type: eventType as string }),
                ...(entityType && { entity_type: entityType as string })
            },
            orderBy: { created_at: 'desc' },
            take: limit ? parseInt(limit as string, 10) : 100
        });

        res.json({ success: true, data: events });
    } catch (error) {
        logger.error('getRawEvents error', error as Error);
        res.status(500).json({ error: 'Failed to fetch events' });
    }
};

/**
 * Get lead health gate statistics.
 * Returns GREEN/YELLOW/RED counts and recent blocked leads.
 */
export const getLeadHealthStats = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        // Count leads by health classification
        const [total, green, yellow, red, blocked, recentBlocked] = await Promise.all([
            prisma.lead.count({ where: { organization_id: orgId, deleted_at: null } }),
            prisma.lead.count({ where: { organization_id: orgId, health_classification: 'green', deleted_at: null } }),
            prisma.lead.count({ where: { organization_id: orgId, health_classification: 'yellow', deleted_at: null } }),
            prisma.lead.count({ where: { organization_id: orgId, health_classification: 'red', deleted_at: null } }),
            prisma.lead.count({ where: { organization_id: orgId, status: 'blocked', deleted_at: null } }),
            prisma.lead.findMany({
                where: {
                    organization_id: orgId,
                    health_classification: 'red',
                    deleted_at: null
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

        res.json({
            success: true,
            data: {
                total,
                green,
                yellow,
                red,
                blocked,
                recentBlocked,
                greenPercent: total > 0 ? Math.round((green / total) * 100) : 0,
                yellowPercent: total > 0 ? Math.round((yellow / total) * 100) : 0,
                redPercent: total > 0 ? Math.round((red / total) * 100) : 0
            }
        });
    } catch (error) {
        logger.error('getLeadHealthStats error', error as Error);
        res.status(500).json({ error: 'Failed to fetch lead health stats' });
    }
};

/**
 * Get campaign health statistics.
 * Returns active/paused/warning counts and campaign details.
 */
export const getCampaignHealthStats = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: orgId },
            select: {
                id: true,
                name: true,
                status: true,
                paused_reason: true,
                paused_at: true,
                bounce_rate: true,
                warning_count: true,
                total_sent: true,
                total_bounced: true
            },
            orderBy: { updated_at: 'desc' }
        });

        const total = campaigns.length;
        const active = campaigns.filter(c => c.status === 'active').length;
        const paused = campaigns.filter(c => c.status === 'paused').length;
        const warning = campaigns.filter(c => c.status === 'warning').length;

        res.json({
            success: true,
            data: {
                total,
                active,
                paused,
                warning,
                campaigns
            }
        });
    } catch (error) {
        logger.error('getCampaignHealthStats error', error as Error);
        res.status(500).json({ error: 'Failed to fetch campaign health stats' });
    }
};

/**
 * Pause a campaign.
 */
export const pauseCampaign = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { campaignId, reason } = req.body;

        if (!campaignId) {
            return res.status(400).json({ error: 'Missing campaignId' });
        }

        await campaignHealthService.pauseCampaign(orgId, campaignId, reason || 'Manual pause');
        res.json({ success: true, message: 'Campaign paused' });
    } catch (error) {
        logger.error('pauseCampaign error', error as Error);
        res.status(500).json({ error: 'Failed to pause campaign' });
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
            return res.status(400).json({ error: 'Missing campaignId' });
        }

        await campaignHealthService.resumeCampaign(orgId, campaignId);
        res.json({ success: true, message: 'Campaign resumed' });
    } catch (error) {
        logger.error('resumeCampaign error', error as Error);
        res.status(500).json({ error: 'Failed to resume campaign' });
    }
};
