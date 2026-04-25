/**
 * Public API v1 Controller
 *
 * All endpoints for external integrations: lead management, campaigns,
 * validation, replies, and account info. Used by MCP server and API key users.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getOrgId } from '../middleware/orgContext';
import { TIER_LIMITS } from '../services/polarClient';
import { classifyLeadHealth } from '../services/leadHealthService';
import * as webhookBus from '../services/webhookEventBus';

// ────────────────────────────────────────────────────────────────────
// Scope check helper
// ────────────────────────────────────────────────────────────────────

function hasScope(req: Request, scope: string): boolean {
    const scopes = (req.orgContext as any)?.scopes as string[] | undefined;
    // JWT users (no scopes array) get full access; API key users must have the scope
    if (!scopes) return true;
    return scopes.includes(scope);
}

function requireScope(req: Request, res: Response, scope: string): boolean {
    if (!hasScope(req, scope)) {
        res.status(403).json({ success: false, error: `Missing required scope: ${scope}` });
        return false;
    }
    return true;
}

// ────────────────────────────────────────────────────────────────────
// LEADS
// ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/leads/bulk
 * Import leads from a JSON array.
 */
export const bulkImportLeads = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'leads:write')) return res as Response;
    const orgId = getOrgId(req);
    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
        return res.status(400).json({ success: false, error: 'leads must be a non-empty array' });
    }

    if (leads.length > 5000) {
        return res.status(400).json({ success: false, error: 'Maximum 5000 leads per request' });
    }

    try {
        const results: { email: string; id?: string; status: string; error?: string }[] = [];

        for (const lead of leads) {
            if (!lead.email || typeof lead.email !== 'string') {
                results.push({ email: lead.email || 'missing', status: 'rejected', error: 'Email is required' });
                continue;
            }

            try {
                // Check for duplicate
                const existing = await prisma.lead.findFirst({
                    where: { organization_id: orgId, email: lead.email.toLowerCase().trim() }
                });

                if (existing) {
                    results.push({ email: lead.email, id: existing.id, status: 'duplicate' });
                    continue;
                }

                const created = await prisma.lead.create({
                    data: {
                        organization_id: orgId,
                        email: lead.email.toLowerCase().trim(),
                        persona: lead.persona || 'general',
                        source: lead.source || 'api',
                        status: 'held',
                        lead_score: lead.lead_score || 50,
                    }
                });

                results.push({ email: lead.email, id: created.id, status: 'created' });
            } catch (err) {
                results.push({ email: lead.email, status: 'error', error: 'Failed to create lead' });
            }
        }

        const created = results.filter(r => r.status === 'created').length;
        const duplicates = results.filter(r => r.status === 'duplicate').length;
        const errors = results.filter(r => r.status === 'error' || r.status === 'rejected').length;

        logger.info(`[API_V1] Bulk lead import for ${orgId}: ${created} created, ${duplicates} dupes, ${errors} errors`);

        return res.json({
            success: true,
            data: { total: leads.length, created, duplicates, errors, results }
        });
    } catch (error) {
        logger.error('[API_V1] Bulk lead import failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Bulk import failed' });
    }
};

/**
 * POST /api/v1/leads/validate
 * Trigger email validation on a set of leads.
 */
export const validateLeads = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'validation:trigger')) return res as Response;
    const orgId = getOrgId(req);
    const { lead_ids, emails } = req.body;

    try {
        let leadsToValidate: { id: string; email: string }[] = [];

        if (Array.isArray(lead_ids) && lead_ids.length > 0) {
            const leads = await prisma.lead.findMany({
                where: { id: { in: lead_ids }, organization_id: orgId },
                select: { id: true, email: true }
            });
            leadsToValidate = leads;
        } else if (Array.isArray(emails) && emails.length > 0) {
            const leads = await prisma.lead.findMany({
                where: { email: { in: emails.map((e: string) => e.toLowerCase().trim()) }, organization_id: orgId },
                select: { id: true, email: true }
            });
            leadsToValidate = leads;
        } else {
            return res.status(400).json({ success: false, error: 'Provide lead_ids or emails array' });
        }

        if (leadsToValidate.length === 0) {
            return res.status(404).json({ success: false, error: 'No matching leads found' });
        }

        // Trigger validation by updating status to pending
        await prisma.lead.updateMany({
            where: { id: { in: leadsToValidate.map(l => l.id) }, organization_id: orgId },
            data: { validation_status: 'pending' }
        });

        logger.info(`[API_V1] Validation triggered for ${leadsToValidate.length} leads in org ${orgId}`);

        return res.json({
            success: true,
            data: {
                queued: leadsToValidate.length,
                lead_ids: leadsToValidate.map(l => l.id),
                message: 'Validation has been queued. Poll GET /api/v1/leads to check results.'
            }
        });
    } catch (error) {
        logger.error('[API_V1] Validate leads failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Validation trigger failed' });
    }
};

/**
 * GET /api/v1/leads
 * List leads with filtering and pagination.
 */
export const listLeads = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'leads:read')) return res as Response;
    const orgId = getOrgId(req);

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const status = req.query.status as string | undefined;
    const validation_status = req.query.validation_status as string | undefined;
    const search = req.query.search as string | undefined;

    try {
        const where: any = { organization_id: orgId };
        if (status) where.status = status;
        if (validation_status) where.validation_status = validation_status;
        if (search) where.email = { contains: search.toLowerCase(), mode: 'insensitive' };

        const [leads, total] = await Promise.all([
            prisma.lead.findMany({
                where,
                select: {
                    id: true, email: true, persona: true, status: true, lead_score: true,
                    source: true, source_platform: true,
                    validation_status: true, validation_score: true,
                    is_catch_all: true, is_disposable: true,
                    emails_sent: true, emails_opened: true, emails_clicked: true, emails_replied: true,
                    last_activity_at: true, created_at: true,
                },
                skip: (page - 1) * limit,
                take: limit,
                orderBy: { created_at: 'desc' },
            }),
            prisma.lead.count({ where }),
        ]);

        return res.json({
            success: true,
            data: leads,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        logger.error('[API_V1] List leads failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list leads' });
    }
};

/**
 * GET /api/v1/leads/:id
 * Get a single lead with full details.
 */
export const getLead = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'leads:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const lead = await prisma.lead.findFirst({
            where: { id: req.params.id as string, organization_id: orgId },
        });

        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

        return res.json({ success: true, data: lead });
    } catch (error) {
        logger.error('[API_V1] Get lead failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get lead' });
    }
};

// ────────────────────────────────────────────────────────────────────
// CAMPAIGNS
// ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/campaigns
 * Create a campaign with sequence steps and leads in a single call.
 */
export const createCampaign = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'campaigns:write')) return res as Response;
    const orgId = getOrgId(req);

    const { name, steps, lead_ids, schedule } = req.body;

    if (!name || typeof name !== 'string') {
        return res.status(400).json({ success: false, error: 'Campaign name is required' });
    }

    if (!Array.isArray(steps) || steps.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one sequence step is required' });
    }

    try {
        const campaign = await prisma.campaign.create({
            data: {
                id: crypto.randomUUID(),
                organization_id: orgId,
                name: name.trim(),
                status: 'draft',
                source_platform: 'sequencer',
                channel: 'email',
                schedule_timezone: schedule?.timezone || 'UTC',
                schedule_start_time: schedule?.start_time || '09:00',
                schedule_end_time: schedule?.end_time || '17:00',
                schedule_days: schedule?.days || ['mon', 'tue', 'wed', 'thu', 'fri'],
                daily_limit: schedule?.daily_limit || 50,
                send_gap_minutes: schedule?.send_gap_minutes ?? 17,
            }
        });

        // Create sequence steps
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const createdStep = await prisma.sequenceStep.create({
                data: {
                    campaign_id: campaign.id,
                    step_number: i + 1,
                    delay_days: step.delay_days ?? (i === 0 ? 0 : 2),
                    delay_hours: step.delay_hours ?? 0,
                    subject: step.subject || '',
                    body_html: step.body_html || step.body || '',
                    body_text: step.body_text || '',
                }
            });

            // Create variants if provided
            if (Array.isArray(step.variants)) {
                for (const variant of step.variants) {
                    await prisma.stepVariant.create({
                        data: {
                            step_id: createdStep.id,
                            variant_label: variant.label || 'A',
                            subject: variant.subject || step.subject || '',
                            body_html: variant.body_html || variant.body || '',
                            body_text: variant.body_text || '',
                            weight: variant.weight || 50,
                        }
                    });
                }
            }
        }

        // Assign leads if provided — runs through lead health gate (RED blocked, YELLOW paused, GREEN active)
        let leadsAssigned = 0;
        let leadsBlocked = 0;
        if (Array.isArray(lead_ids) && lead_ids.length > 0) {
            const leads = await prisma.lead.findMany({
                where: { id: { in: lead_ids }, organization_id: orgId },
                select: { id: true, email: true }
            });

            for (const lead of leads) {
                const health = await classifyLeadHealth(lead.email).catch(() => ({
                    classification: 'yellow' as const,
                    reasons: ['Health check failed'],
                }));

                if (health.classification === 'red') {
                    leadsBlocked++;
                    continue; // Skip — do not add RED leads to campaign
                }

                await prisma.campaignLead.create({
                    data: {
                        campaign_id: campaign.id,
                        email: lead.email,
                        status: health.classification === 'yellow' ? 'paused' : 'active',
                        current_step: 0,
                    }
                });
                leadsAssigned++;
            }
        }

        logger.info(`[API_V1] Campaign created: "${name}" with ${steps.length} steps, ${leadsAssigned} leads (${leadsBlocked} blocked by health gate)`, { campaignId: campaign.id });

        return res.status(201).json({
            success: true,
            data: {
                id: campaign.id,
                name: campaign.name,
                status: campaign.status,
                steps_count: steps.length,
                leads_assigned: leadsAssigned,
                leads_blocked: leadsBlocked,
            }
        });
    } catch (error) {
        logger.error('[API_V1] Create campaign failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create campaign' });
    }
};

/**
 * GET /api/v1/campaigns
 */
export const listCampaigns = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'campaigns:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        // v1 API's sequencer campaigns endpoint — scoped to sequencer rows only.
        // Legacy platform-synced campaigns have their own lookup path.
        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: orgId, source_platform: 'sequencer' },
            include: {
                _count: { select: { leads: true, steps: true } }
            },
            orderBy: { created_at: 'desc' },
        });

        const data = campaigns.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            daily_limit: c.daily_limit,
            schedule_timezone: c.schedule_timezone,
            leads_count: c._count.leads,
            steps_count: c._count.steps,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }));

        return res.json({ success: true, data });
    } catch (error) {
        logger.error('[API_V1] List campaigns failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list campaigns' });
    }
};

/**
 * GET /api/v1/campaigns/:id
 */
export const getCampaign = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'campaigns:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const campaign = await prisma.campaign.findFirst({
            where: { id: req.params.id as string, organization_id: orgId, source_platform: 'sequencer' },
            include: {
                steps: {
                    include: { variants: true },
                    orderBy: { step_number: 'asc' },
                },
                leads: {
                    select: { id: true, email: true, status: true, current_step: true, last_sent_at: true },
                    take: 100,
                },
                _count: { select: { leads: true } },
            },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        return res.json({ success: true, data: campaign });
    } catch (error) {
        logger.error('[API_V1] Get campaign failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get campaign' });
    }
};

/**
 * PATCH /api/v1/campaigns/:id
 */
export const updateCampaign = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'campaigns:write')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const campaign = await prisma.campaign.findFirst({
            where: { id: req.params.id as string, organization_id: orgId }
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status === 'active') {
            return res.status(400).json({ success: false, error: 'Cannot update an active campaign. Pause it first.' });
        }

        const { name, daily_limit, send_gap_minutes, schedule_timezone, schedule_start_time, schedule_end_time, schedule_days } = req.body;

        const updated = await prisma.campaign.update({
            where: { id: campaign.id },
            data: {
                ...(name && { name }),
                ...(daily_limit && { daily_limit }),
                ...(send_gap_minutes !== undefined && { send_gap_minutes }),
                ...(schedule_timezone && { schedule_timezone }),
                ...(schedule_start_time && { schedule_start_time }),
                ...(schedule_end_time && { schedule_end_time }),
                ...(schedule_days && { schedule_days }),
            }
        });

        return res.json({ success: true, data: { id: updated.id, name: updated.name, status: updated.status } });
    } catch (error) {
        logger.error('[API_V1] Update campaign failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update campaign' });
    }
};

/**
 * POST /api/v1/campaigns/:id/launch
 */
export const launchCampaign = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'campaigns:write')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const campaign = await prisma.campaign.findFirst({
            where: { id: req.params.id as string, organization_id: orgId, source_platform: 'sequencer' },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status === 'active') return res.status(400).json({ success: false, error: 'Campaign is already active' });

        const [stepsCount, leadsCount] = await Promise.all([
            prisma.sequenceStep.count({ where: { campaign_id: campaign.id } }),
            prisma.campaignLead.count({ where: { campaign_id: campaign.id } }),
        ]);

        if (stepsCount === 0) return res.status(400).json({ success: false, error: 'Campaign has no sequence steps' });
        if (leadsCount === 0) return res.status(400).json({ success: false, error: 'Campaign has no leads assigned' });

        await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: 'active', launched_at: new Date() }
        });

        logger.info(`[API_V1] Campaign launched: ${campaign.name}`, { campaignId: campaign.id });

        webhookBus.emitCampaignLaunched(orgId, { id: campaign.id, name: campaign.name }, {
            leads: leadsCount,
            steps: stepsCount,
        });

        return res.json({
            success: true,
            data: { id: campaign.id, status: 'active', leads: leadsCount, steps: stepsCount }
        });
    } catch (error) {
        logger.error('[API_V1] Launch campaign failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to launch campaign' });
    }
};

/**
 * POST /api/v1/campaigns/:id/pause
 */
export const pauseCampaign = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'campaigns:write')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const campaign = await prisma.campaign.findFirst({
            where: { id: req.params.id as string, organization_id: orgId }
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status !== 'active') return res.status(400).json({ success: false, error: 'Campaign is not active' });

        await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: 'paused' }
        });

        webhookBus.emitCampaignPaused(orgId, { id: campaign.id, name: campaign.name }, 'manual_pause');

        return res.json({ success: true, data: { id: campaign.id, status: 'paused' } });
    } catch (error) {
        logger.error('[API_V1] Pause campaign failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to pause campaign' });
    }
};

/**
 * GET /api/v1/campaigns/:id/report
 * Aggregate performance report for a campaign.
 */
export const getCampaignReport = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'reports:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const campaign = await prisma.campaign.findFirst({
            where: { id: req.params.id as string, organization_id: orgId, source_platform: 'sequencer' },
            select: { id: true, name: true, status: true, created_at: true }
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        const [leadStats, sendEvents, replyEvents] = await Promise.all([
            prisma.campaignLead.groupBy({
                by: ['status'],
                where: { campaign_id: campaign.id },
                _count: true,
            }),
            prisma.sendEvent.count({
                where: { campaign_id: campaign.id, organization_id: orgId }
            }),
            prisma.replyEvent.count({
                where: { campaign_id: campaign.id, organization_id: orgId }
            }),
        ]);

        const statusMap: Record<string, number> = {};
        leadStats.forEach(s => { statusMap[s.status] = s._count; });
        const totalLeads = Object.values(statusMap).reduce((a, b) => a + b, 0);

        return res.json({
            success: true,
            data: {
                campaign_id: campaign.id,
                campaign_name: campaign.name,
                status: campaign.status,
                total_leads: totalLeads,
                lead_status_breakdown: statusMap,
                emails_sent: sendEvents,
                replies: replyEvents,
                reply_rate: sendEvents > 0 ? ((replyEvents / sendEvents) * 100).toFixed(2) + '%' : '0%',
                created_at: campaign.created_at,
            }
        });
    } catch (error) {
        logger.error('[API_V1] Campaign report failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get campaign report' });
    }
};

/**
 * GET /api/v1/campaigns/:id/replies
 * List replies for a campaign.
 */
export const getCampaignReplies = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'replies:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const campaign = await prisma.campaign.findFirst({
            where: { id: req.params.id as string, organization_id: orgId, source_platform: 'sequencer' },
            select: { id: true }
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        // Get threads with inbound messages for this campaign
        const threads = await prisma.emailThread.findMany({
            where: { campaign_id: campaign.id, organization_id: orgId, status: 'replied' },
            include: {
                messages: {
                    where: { direction: 'inbound' },
                    orderBy: { created_at: 'desc' },
                    take: 1,
                }
            },
            orderBy: { last_message_at: 'desc' },
            take: 100,
        });

        const replies = threads
            .filter(t => t.messages.length > 0)
            .map(t => ({
                thread_id: t.id,
                contact_email: t.contact_email,
                contact_name: t.contact_name,
                subject: t.messages[0].subject,
                body_text: t.messages[0].body_text,
                received_at: t.messages[0].created_at,
            }));

        return res.json({
            success: true,
            data: { total_replies: replies.length, replies }
        });
    } catch (error) {
        logger.error('[API_V1] Campaign replies failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get replies' });
    }
};

// ────────────────────────────────────────────────────────────────────
// REPLIES
// ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/replies
 * Send a reply to a lead via a connected mailbox.
 */
export const sendReply = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'replies:send')) return res as Response;
    const orgId = getOrgId(req);

    const { thread_id, body_html, body_text } = req.body;

    if (!thread_id) return res.status(400).json({ success: false, error: 'thread_id is required' });
    if (!body_html && !body_text) return res.status(400).json({ success: false, error: 'body_html or body_text is required' });

    try {
        const thread = await prisma.emailThread.findFirst({
            where: { id: thread_id, organization_id: orgId },
            include: { account: { select: { id: true, email: true, provider: true, connection_status: true } } }
        });

        if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });
        if (!thread.account || thread.account.connection_status !== 'active') {
            return res.status(400).json({ success: false, error: 'No active mailbox connected for this thread. Connect a mailbox in Superkabe first.' });
        }

        // Create the outbound message
        const message = await prisma.emailMessage.create({
            data: {
                thread_id: thread.id,
                direction: 'outbound',
                from_email: thread.account.email,
                to_email: thread.contact_email,
                subject: thread.subject || 'Re: ',
                body_html: body_html || '',
                body_text: body_text || '',
            }
        });

        // Update thread
        await prisma.emailThread.update({
            where: { id: thread.id },
            data: { last_message_at: new Date(), snippet: (body_text || body_html || '').slice(0, 200) }
        });

        logger.info(`[API_V1] Reply sent via ${thread.account.email} to ${thread.contact_email}`, {
            threadId: thread.id, messageId: message.id
        });

        return res.json({
            success: true,
            data: {
                message_id: message.id,
                thread_id: thread.id,
                from: thread.account.email,
                to: thread.contact_email,
                status: 'sent'
            }
        });
    } catch (error) {
        logger.error('[API_V1] Send reply failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to send reply' });
    }
};

// ────────────────────────────────────────────────────────────────────
// VALIDATION
// ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/validation/results
 * Get validation analytics for the organization.
 */
export const getValidationResults = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'validation:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const [total, statusBreakdown] = await Promise.all([
            prisma.lead.count({ where: { organization_id: orgId, validation_status: { not: null } } }),
            prisma.lead.groupBy({
                by: ['validation_status'],
                where: { organization_id: orgId, validation_status: { not: null } },
                _count: true,
            }),
        ]);

        const breakdown: Record<string, number> = {};
        statusBreakdown.forEach(s => {
            if (s.validation_status) breakdown[s.validation_status] = s._count;
        });

        return res.json({
            success: true,
            data: { total_validated: total, status_breakdown: breakdown }
        });
    } catch (error) {
        logger.error('[API_V1] Validation results failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get validation results' });
    }
};

// ────────────────────────────────────────────────────────────────────
// INFRASTRUCTURE
// ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/mailboxes
 */
export const listMailboxes = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'mailboxes:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const mailboxes = await prisma.mailbox.findMany({
            where: { organization_id: orgId },
            select: {
                id: true, email: true, status: true, source_platform: true,
                smtp_status: true, imap_status: true,
                total_sent_count: true, hard_bounce_count: true,
                warmup_status: true, warmup_reputation: true,
                recovery_phase: true, resilience_score: true,
            },
            orderBy: { email: 'asc' },
        });

        return res.json({ success: true, data: mailboxes });
    } catch (error) {
        logger.error('[API_V1] List mailboxes failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list mailboxes' });
    }
};

/**
 * GET /api/v1/domains
 */
export const listDomains = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'domains:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const domains = await prisma.domain.findMany({
            where: { organization_id: orgId },
            select: {
                id: true, domain: true, status: true, source_platform: true,
                total_sent_lifetime: true, total_opens: true, total_clicks: true, total_replies: true,
                aggregated_bounce_rate_trend: true, warning_count: true,
                recovery_phase: true, resilience_score: true,
            },
            orderBy: { domain: 'asc' },
        });

        return res.json({ success: true, data: domains });
    } catch (error) {
        logger.error('[API_V1] List domains failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list domains' });
    }
};

// ────────────────────────────────────────────────────────────────────
// ACCOUNT
// ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/account
 * Account info, usage, and limits.
 */
export const getAccount = async (req: Request, res: Response): Promise<Response> => {
    if (!requireScope(req, res, 'account:read')) return res as Response;
    const orgId = getOrgId(req);

    try {
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: {
                id: true, name: true, slug: true,
                subscription_tier: true, subscription_status: true,
                current_lead_count: true, current_domain_count: true, current_mailbox_count: true,
            }
        });

        if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });

        const limits = TIER_LIMITS[org.subscription_tier] || TIER_LIMITS.trial;

        return res.json({
            success: true,
            data: {
                id: org.id,
                name: org.name,
                slug: org.slug,
                tier: org.subscription_tier,
                status: org.subscription_status,
                usage: {
                    leads: org.current_lead_count,
                    domains: org.current_domain_count,
                    mailboxes: org.current_mailbox_count,
                },
                limits: {
                    leads: limits.leads,
                    domains: limits.domains,
                    mailboxes: limits.mailboxes,
                    monthly_sends: limits.monthlySendLimit,
                    validation_credits: limits.validationCredits,
                },
            }
        });
    } catch (error) {
        logger.error('[API_V1] Get account failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get account info' });
    }
};
