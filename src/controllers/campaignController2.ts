/**
 * Campaign Controller (Sequencer)
 *
 * CRUD + lifecycle for SendCampaigns with steps, variants, leads, and accounts.
 * Named campaignController2 to avoid conflict with existing campaignController.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { classifyLeadHealth } from '../services/leadHealthService';
import * as entityStateService from '../services/entityStateService';
import * as webhookBus from '../services/webhookEventBus';
import { SlackAlertService } from '../services/SlackAlertService';
import { LeadState, TriggerType } from '../types';
import {
    STEP_TYPES,
    validateStepConfig,
    validateSequenceShape,
    isLinkedInStepType,
    type FullStepLite,
} from '../services/sequencer/stepTypeRegistry';
import { normalizeSequenceSteps } from '../services/sequencer/stepNormalizer';
import { runPreLaunchValidation } from '../services/linkedin/preLaunchValidator';
import * as auditLogService from '../services/auditLogService';

/**
 * GET /api/sequencer/campaigns
 * List SendCampaigns with pagination and status filter.
 */
export const listCampaigns = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        // Hard cap on page size. The detail-row payload includes `_count`
        // joins on steps/leads/accounts plus tag relations - an unbounded
        // limit lets a single request load every campaign in the org with
        // their counts into memory, which we've seen OOM on dev DBs at a
        // few thousand rows. 200 is enough for any practical UI surface.
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 25));
        const status = (req.query.status as string) || undefined;
        // Filter by org-level tag IDs (OR semantics - any tag matches).
        const tagIdsRaw = (req.query.tag_ids as string) || '';
        const tagIds = tagIdsRaw.split(',').map(s => s.trim()).filter(Boolean);

        // List all of the org's campaigns. Campaign table is unified post-Phase-B
        // (2026-04-26) - every row is a native sequencer campaign.
        // Channel filter - when present, narrows to a single channel. The
        // Super LinkedIn campaigns list calls this with channel='linkedin'
        // so it only renders LinkedIn-only campaigns (mixed + email-only
        // are owned by the Sequencer surface).
        const channel = (req.query.channel as string) || undefined;
        const includeDeleted = req.query.include_deleted === 'true';
        const where: any = { organization_id: orgId };
        if (!includeDeleted) where.deleted_at = null;
        if (status && status !== 'all') where.status = status;
        if (channel && channel !== 'all') where.channel = channel;
        if (tagIds.length > 0) {
            where.tagLinks = { some: { tag_id: { in: tagIds } } };
        }

        const [campaigns, total] = await Promise.all([
            prisma.campaign.findMany({
                where,
                orderBy: { created_at: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    _count: {
                        select: {
                            steps: true,
                            leads: true,
                            accounts: true,
                        },
                    },
                    tagLinks: { include: { tag: { select: { id: true, name: true, color: true } } } },
                },
            }),
            prisma.campaign.count({ where }),
        ]);

        const data = campaigns.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            channel: c.channel,
            // Org-level tag relation - objects with { id, name, color }.
            // Used for the new tag UI on the campaigns list.
            tags: c.tagLinks.map(tl => ({ id: tl.tag.id, name: tl.tag.name, color: tl.tag.color })),
            // Legacy Smartlead-import string-array tags. Kept under a distinct
            // key so the create/duplicate wizard's pre-fill keeps working.
            legacy_tags: c.tags,
            daily_limit: c.daily_limit,
            send_gap_minutes: c.send_gap_minutes,
            total_leads: c.total_leads,
            total_sent: c.total_sent,
            // Post-merge Campaign uses open_count / click_count / reply_count / unsubscribed_count
            // internally. API response keeps the prior sequencer-style field names for FE stability.
            total_opened: c.open_count,
            total_clicked: c.click_count,
            total_replied: c.reply_count,
            total_bounced: c.total_bounced,
            total_unsubscribed: c.unsubscribed_count,
            step_count: c._count.steps,
            lead_count: c._count.leads,
            account_count: c._count.accounts,
            created_at: c.created_at,
            launched_at: c.launched_at,
        }));

        return res.json({
            success: true,
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to list campaigns', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list campaigns' });
    }
};

/**
 * GET /api/sequencer/campaigns/:id
 * Full campaign with steps (include variants), leads summary, and accounts.
 */
export const getCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);

        // Three independent reads - the main campaign row + relations,
        // the per-status lead count (groupBy), and the lead-import
        // provenance list. None depend on each other's data, only on
        // the campaign_id. Running them sequentially was a P1 - the
        // page paid for round-trip latency three times. Parallel reads
        // cap wall-clock at the slowest query (the big include).
        const [campaign, leadsByStatus, leadImports] = await Promise.all([
            prisma.campaign.findFirst({
                where: { id: campaignId, organization_id: orgId, deleted_at: null },
                include: {
                    steps: {
                        orderBy: { step_number: 'asc' },
                        include: { variants: true },
                    },
                    accounts: {
                        include: {
                            account: {
                                select: { id: true, email: true, display_name: true, provider: true, connection_status: true },
                            },
                        },
                    },
                    // LinkedIn sender pool - only populated on mixed-channel
                    // campaigns. The wizard reads this to pre-fill the sender
                    // picker in edit mode.
                    linkedinSenders: {
                        include: {
                            linkedin_account: {
                                select: { id: true, display_name: true, account_type: true, status: true },
                            },
                        },
                        orderBy: { rotation_priority: 'asc' },
                    },
                    tagLinks: { include: { tag: { select: { id: true, name: true, color: true } } } },
                    _count: { select: { leads: true } },
                },
            }),
            prisma.campaignLead.groupBy({
                by: ['status'],
                where: { campaign_id: campaignId, campaign: { organization_id: orgId } },
                _count: true,
            }),
            // Lead-source provenance - every CSV upload / Clay ingest / manual
            // add is its own CampaignLeadImport row. Surface them so the
            // detail page can render a "Lead sources" panel with filenames +
            // counts + dates.
            prisma.campaignLeadImport.findMany({
                where: { campaign_id: campaignId, campaign: { organization_id: orgId } },
                orderBy: { created_at: 'desc' },
                take: 50,
            }),
        ]);

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        const leadsSummary = leadsByStatus.reduce((acc: Record<string, number>, g) => {
            acc[g.status] = g._count;
            return acc;
        }, {});

        // Map sequencer-internal column names to the legacy `total_*` API shape
        // the frontend expects. Mirrors the mapping in listCampaigns so detail
        // and list responses agree on `total_replied`, `total_opened`, etc.
        // (Prior bug: the detail endpoint spread raw Prisma fields, so the FE
        // read `total_replied` as undefined → rendered 0 even when reply_count
        // was non-zero on the same row that the list page showed correctly.)
        return res.json({
            success: true,
            data: {
                ...campaign,
                // Override the raw Prisma `tags` (legacy String[]) and
                // `tagLinks` (relation) with the same dual-key shape the
                // list endpoint returns: `tags` = proper objects,
                // `legacy_tags` = the old string array. Wizard reads
                // `legacy_tags`; the new tag UI reads `tags`.
                tags: campaign.tagLinks.map(tl => ({ id: tl.tag.id, name: tl.tag.name, color: tl.tag.color })),
                legacy_tags: campaign.tags,
                tagLinks: undefined,
                total_opened: campaign.open_count,
                total_clicked: campaign.click_count,
                total_replied: campaign.reply_count,
                total_unsubscribed: campaign.unsubscribed_count,
                lead_count: campaign._count.leads,
                leads_summary: leadsSummary,
                lead_imports: leadImports,
                // Flatten linkedinSenders into the linkedin_senders key the
                // wizard / detail page expect.
                linkedin_senders: campaign.linkedinSenders.map(s => ({
                    id: s.id,
                    linkedin_account_id: s.linkedin_account_id,
                    display_name: s.linkedin_account.display_name,
                    account_type: s.linkedin_account.account_type,
                    status: s.linkedin_account.status,
                    rotation_priority: s.rotation_priority,
                    enabled: s.enabled,
                })),
                linkedinSenders: undefined,
            },
        });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to get campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get campaign' });
    }
};

/**
 * GET /api/sequencer/campaigns/:id/health
 *
 * Lightweight live status - the detail page polls this every 30s while the
 * campaign is active so operators see the auto-pause flip the moment the
 * dispatcher trips it. Returns just the operationally-important bits:
 * current status, paused reason, mailbox tally. No expensive includes.
 */
export const getCampaignHealth = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
            select: {
                id: true,
                status: true,
                paused_reason: true,
                paused_at: true,
                paused_by: true,
                accounts: {
                    select: {
                        account: {
                            select: {
                                connection_status: true,
                                mailbox: {
                                    select: { status: true, recovery_phase: true, domain: { select: { status: true } } },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        const total = campaign.accounts.length;
        let healthy = 0;
        let paused = 0;
        let recovering = 0;
        for (const ca of campaign.accounts) {
            const acct = ca.account as any;
            if (acct.connection_status !== 'active') { paused++; continue; }
            const mbStatus = acct.mailbox?.status;
            const mbPhase = acct.mailbox?.recovery_phase;
            const domainStatus = acct.mailbox?.domain?.status;
            if (mbStatus === 'paused' || domainStatus === 'paused' || mbPhase === 'paused' || mbPhase === 'quarantine') {
                paused++;
            } else if (mbPhase === 'restricted_send' || mbPhase === 'warm_recovery') {
                recovering++;
            } else {
                healthy++;
            }
        }

        return res.json({
            success: true,
            data: {
                status: campaign.status,
                paused_reason: campaign.paused_reason,
                paused_at: campaign.paused_at,
                paused_by: campaign.paused_by,
                auto_paused: campaign.paused_by === 'system',
                mailboxes: { total, healthy, paused, recovering },
            },
        });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to get campaign health', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get campaign health' });
    }
};

/**
 * GET /api/sequencer/enrichment-providers/status
 *
 * Lightweight read used by the campaign wizard to gate the
 * `find_linkedin_url` / `find_email` step types. Returns the count of
 * configured providers + their codes so the wizard can show:
 *   - "No enrichment providers connected - connect one in Settings → Enrichment"
 *   - "Waterfall: Apollo → Clay → ..." when 2+ are wired
 */
export const getEnrichmentProviderStatus = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const providers = await prisma.enrichmentProvider.findMany({
            where: { organization_id: orgId, enabled: true },
            orderBy: { order_index: 'asc' },
            select: { id: true, provider: true, order_index: true },
        });
        return res.json({
            success: true,
            data: {
                count: providers.length,
                providers: providers.map(p => ({ id: p.id, code: p.provider, order_index: p.order_index })),
            },
        });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to get enrichment provider status', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get enrichment provider status' });
    }
};

/**
 * GET /api/sequencer/campaigns/:id/skip-stats
 *
 * Aggregates SequenceStepExecution rows by skip_reason for the detail
 * page's "Why steps were skipped" widget. Lets operators see at a glance
 * that, say, 400 leads bypassed every LinkedIn step because they had no
 * profile URL on file - informs whether to add a find_linkedin_url step
 * or fix the import.
 */
export const getCampaignSkipStats = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
            select: { id: true },
        });
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        // Group SKIPPED + FAILED-with-skip-prefix executions by skip_reason.
        // The dispatcher writes "skipped:<reason>" into error_message when a
        // step flips an already-scheduled row to a skip outcome, so we
        // surface both shapes under the same bucket.
        const grouped = await prisma.sequenceStepExecution.groupBy({
            by: ['skip_reason', 'step_type'],
            where: {
                campaign_id: campaignId,
                status: 'SKIPPED',
                skip_reason: { not: null },
            },
            _count: { _all: true },
        });

        // Human-readable labels for the front-end. Keys match the reason
        // strings the dispatcher emits.
        const REASON_LABELS: Record<string, string> = {
            lead_has_linkedin_profile: 'Lead has no LinkedIn URL on file',
            lead_has_email: 'Lead has no email on file',
            sender_is_first_degree: 'Lead is not a 1st-degree connection yet',
            sender_is_not_first_degree: 'Lead is already a 1st-degree connection',
            sender_supports_inmail: 'Sender account tier does not support InMail',
            sender_has_inmail_credits_or_open_profile: 'No InMail credits and lead profile is closed',
            lead_has_recent_post: 'Lead has no post within the configured timespan',
            lead_already_has_linkedin_url: 'Lead already has a LinkedIn URL (find step no-op)',
            no_enrichment_provider_configured: 'No enrichment provider connected - connect one in Settings → Enrichment',
            linkedin_url_not_found_by_any_provider: 'Waterfall ran but no provider returned a LinkedIn URL',
            no_sender_capacity_or_out_of_hours: 'Sender out of daily budget or outside working hours',
        };

        const reasons = grouped.map(g => ({
            skip_reason: g.skip_reason,
            label: REASON_LABELS[g.skip_reason || ''] || (g.skip_reason || 'unknown'),
            step_type: g.step_type,
            count: g._count._all,
        }));

        const totalSkipped = reasons.reduce((n, r) => n + r.count, 0);

        return res.json({
            success: true,
            data: {
                total_skipped: totalSkipped,
                reasons: reasons.sort((a, b) => b.count - a.count),
            },
        });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to get skip stats', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get skip stats' });
    }
};

/**
 * GET /api/sequencer/campaigns/:id/leads
 * Paginated CampaignLead list for the edit-mode Leads panel.
 */
export const listCampaignLeads = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const search = (req.query.search as string) || undefined;

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
            select: { id: true },
        });
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        const where: any = { campaign_id: campaignId };
        if (search) {
            where.OR = [
                { email: { contains: search, mode: 'insensitive' } },
                { first_name: { contains: search, mode: 'insensitive' } },
                { last_name: { contains: search, mode: 'insensitive' } },
                { company: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [rows, total] = await Promise.all([
            prisma.campaignLead.findMany({
                where,
                orderBy: { created_at: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                select: {
                    id: true, email: true, first_name: true, last_name: true,
                    company: true, title: true, status: true, current_step: true,
                    validation_status: true, validation_score: true, created_at: true,
                },
            }),
            prisma.campaignLead.count({ where }),
        ]);

        return res.json({
            success: true,
            leads: rows,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to list campaign leads', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list campaign leads' });
    }
};

/**
 * POST /api/sequencer/campaigns
 * Create a campaign with all data in one call (transaction).
 */
export const createCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const {
            name, tags, steps, leads, schedule, settings, accountIds, skipDuplicatesAcrossCampaigns,
            // New unified suppression model - see campaignSuppressionService.
            // `suppressionRules` is the canonical shape; `skipDuplicatesAcrossCampaigns`
            // is the legacy boolean preserved for backwards compat. When both are
            // provided, the boolean is folded into the rules as an 'all_campaigns'
            // rule so the resolver gets a single source of truth.
            suppressionRules,
            // Provenance for the initial leads - surfaced in the campaign detail
            // page's "Lead sources" panel. Defaults to 'manual' if the caller
            // doesn't say otherwise (e.g. the legacy wizard before this change).
            leadSource = 'manual',
            leadSourceFile,
            leadSourceLabel,
            // Mixed-channel support - attach LinkedIn senders when any
            // linkedin_* step is present in the sequence. Shape mirrors the
            // LinkedIn-only campaign controller so the wizard can reuse types.
            linkedinSenders,
        } = req.body;

        if (!name) return res.status(400).json({ success: false, error: 'Campaign name is required' });

        // ── Multi-channel preflight ──────────────────────────────────────
        // Normalize step_type (default 'email' for legacy callers), reject
        // unknown step types, and detect whether the sequence requires a
        // LinkedIn sender pool. The detail validation (config_schema +
        // cross-step shape) runs through validateStepConfig +
        // validateSequenceShape before we hit the transaction.
        // Canonical normalization (shared with the update path): contiguous
        // 1..N step_number in intended order, branch targets remapped, full
        // step shape preserved. step_number is never trusted raw again.
        const normalizedSteps = normalizeSequenceSteps(steps);

        for (const s of normalizedSteps) {
            if (!STEP_TYPES[s.step_type]) {
                return res.status(400).json({
                    success: false,
                    error: `Unknown step_type "${s.step_type}" on step ${s.step_number}`,
                });
            }
            const cfgIssues = validateStepConfig(s.step_type, s.step_config);
            if (cfgIssues.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid step_config on step ${s.step_number}: ${cfgIssues.map(i => i.message).join('; ')}`,
                });
            }
        }

        const requiresLinkedIn = normalizedSteps.some(s => isLinkedInStepType(s.step_type));
        const senderAttachments: Array<{
            linkedin_account_id: string;
            max_invites_per_day?: number | null;
            max_messages_per_day?: number | null;
            max_inmails_per_day?: number | null;
            rotation_priority?: number;
        }> = Array.isArray(linkedinSenders) ? linkedinSenders : [];

        if (requiresLinkedIn && senderAttachments.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Sequence includes LinkedIn step(s) but no LinkedIn sender pool was attached. Pick at least one LinkedIn account.',
            });
        }

        if (senderAttachments.length > 0) {
            const ids = senderAttachments.map(s => s.linkedin_account_id).filter(Boolean);
            const owned = await prisma.linkedInAccount.findMany({
                where: { id: { in: ids }, organization_id: orgId },
                select: { id: true },
            });
            if (owned.length !== ids.length) {
                return res.status(400).json({
                    success: false,
                    error: 'One or more LinkedIn sender accounts are not owned by this organisation',
                });
            }
        }

        const shapeIssues = validateSequenceShape(normalizedSteps as FullStepLite[]);
        if (shapeIssues.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'Sequence shape validation failed',
                issues: shapeIssues,
            });
        }

        // Derive the campaign-level channel column from the actual step mix.
        // 'email' = email-only (legacy); 'linkedin' = LinkedIn-only; 'multi'
        // = the mixed case introduced by Phase 3. The dispatcher / workers
        // already key off step_type per row, so this column is mostly an
        // editorial label for the UI + analytics filters.
        const hasEmailStep = normalizedSteps.some(s => s.step_type === 'email');
        const campaignChannel: 'email' | 'linkedin' | 'multi' = requiresLinkedIn
            ? (hasEmailStep ? 'multi' : 'linkedin')
            : 'email';

        // No automatic validation pass. Users pre-validate their leads via the
        // "Verify Emails" button in the Leads step of the wizard before launch -
        // credits shouldn't be spent silently on campaign creation. classifyLeadHealth
        // still runs below, using cached validation_status from the Lead table when
        // available; otherwise it relies on light syntax/disposable/role checks.
        const leadValidations = new Map<string, { score: number; status: string; isDisposable: boolean; isCatchAll: boolean }>();

        // Emails actually accepted into the campaign - populated inside the transaction,
        // consumed after it commits to forward-wire Protection Lead rows.
        let acceptedEmails: string[] = [];

        const campaign = await prisma.$transaction(async (tx) => {
            // 1. Create the campaign. Campaign.id has no DB default (the column was
            //    String @id without @default for historical reasons), so we generate
            //    a UUID here.
            const camp = await tx.campaign.create({
                data: {
                    id: crypto.randomUUID(),
                    organization_id: orgId,
                    name,
                    status: 'draft',
                    channel: campaignChannel,
                    tags: tags || [],
                    // Schedule
                    schedule_timezone: schedule?.timezone || 'UTC',
                    schedule_start_time: schedule?.start_time ?? schedule?.startTime ?? null,
                    schedule_end_time: schedule?.end_time ?? schedule?.endTime ?? null,
                    schedule_days: schedule?.days ?? schedule?.activeDays ?? ['mon', 'tue', 'wed', 'thu', 'fri'],
                    daily_limit: schedule?.daily_limit ?? schedule?.dailyLimit ?? 50,
                    send_gap_minutes: schedule?.send_gap_minutes ?? schedule?.sendGapMinutes ?? 17,
                    start_date: schedule?.start_date ? new Date(schedule.start_date) : (schedule?.startDate ? new Date(schedule.startDate) : null),
                    // Settings
                    esp_routing: settings?.esp_routing ?? settings?.espRouting ?? true,
                    stop_on_reply: settings?.stop_on_reply ?? settings?.stopOnReply ?? true,
                    stop_on_bounce: settings?.stop_on_bounce ?? settings?.stopOnBounce ?? true,
                    track_opens: settings?.track_opens ?? settings?.trackOpens ?? true,
                    track_clicks: settings?.track_clicks ?? settings?.trackClicks ?? true,
                    include_unsubscribe: settings?.include_unsubscribe ?? settings?.includeUnsubscribe ?? true,
                    tracking_domain: settings?.tracking_domain ?? settings?.trackingDomain ?? null,
                    eu_compliance_mode: settings?.eu_compliance_mode ?? settings?.euComplianceMode ?? false,
                },
            });

            // 2. Create sequence steps + variants. step_type / step_config /
            //    condition / branch_to_step_number come through the
            //    normalized array - defaults for legacy callers were already
            //    applied in the preflight above.
            for (const step of normalizedSteps) {
                const createdStep = await tx.sequenceStep.create({
                    data: {
                        campaign_id: camp.id,
                        step_number: step.step_number,
                        step_type: step.step_type,
                        step_config: step.step_config as Prisma.InputJsonValue,
                        delay_days: step.delay_days,
                        delay_hours: step.delay_hours,
                        subject: step.subject,
                        preheader: step.preheader,
                        body_html: step.body_html,
                        body_text: step.body_text,
                        condition: step.condition,
                        branch_to_step_number: step.branch_to_step_number,
                    },
                });

                if (step.variants && Array.isArray(step.variants)) {
                    for (const variant of step.variants as any[]) {
                        await tx.stepVariant.create({
                            data: {
                                step_id: createdStep.id,
                                variant_label: variant.label || 'A',
                                subject: variant.subject,
                                preheader: variant.preheader ?? '',
                                body_html: variant.body_html ?? variant.bodyHtml ?? '',
                                weight: variant.weight ?? 50,
                            },
                        });
                    }
                }
            }

            // 2b. Attach LinkedIn sender pool when the sequence has any
            //     linkedin_* steps. Mirrors the LinkedIn-only campaign create.
            if (senderAttachments.length > 0) {
                await tx.campaignLinkedInSender.createMany({
                    data: senderAttachments.map((s, idx) => ({
                        campaign_id: camp.id,
                        linkedin_account_id: s.linkedin_account_id,
                        max_invites_per_day: s.max_invites_per_day ?? null,
                        max_messages_per_day: s.max_messages_per_day ?? null,
                        max_inmails_per_day: s.max_inmails_per_day ?? null,
                        rotation_priority: s.rotation_priority ?? idx,
                        enabled: true,
                    })),
                });
            }

            // 3. Create campaign leads - with health gate classification + validation
            // Persist suppression rules and apply them before lead classification.
            // The legacy `skipDuplicatesAcrossCampaigns` boolean is folded into the
            // unified rule set as an 'all_campaigns' rule so the resolver is the
            // single source of truth - no logic forks below this point.
            const { setSuppressionRules, getSuppressedEmails, applySuppression } =
                await import('../services/campaignSuppressionService');
            const incomingRules = Array.isArray(suppressionRules) ? suppressionRules : [];
            const foldedRules = [...incomingRules];
            if (skipDuplicatesAcrossCampaigns && !foldedRules.some((r: any) => r?.kind === 'all_campaigns')) {
                foldedRules.push({ kind: 'all_campaigns' });
            }
            if (foldedRules.length > 0) {
                await setSuppressionRules({
                    campaignId: camp.id,
                    organizationId: orgId,
                    rules: foldedRules,
                    client: tx,
                });
            }

            if (leads && Array.isArray(leads) && leads.length > 0) {
                let inputLeads: any[] = leads;
                let skippedCrossCampaign = 0;
                if (foldedRules.length > 0) {
                    const suppressed = await getSuppressedEmails({ campaignId: camp.id, organizationId: orgId, client: tx });
                    const { kept, skipped } = applySuppression(inputLeads, suppressed);
                    inputLeads = kept;
                    skippedCrossCampaign = skipped;
                }

                // Org-level reply-suppression - leads who replied 'hard_no' /
                // 'angry' to any prior campaign should never be re-contacted
                // unless the operator manually removes them from the list.
                const { getSuppressedEmailSet } = await import('../services/replyActionService');
                const orgSuppressed = await getSuppressedEmailSet(
                    orgId,
                    inputLeads.map((l: any) => l.email || '').filter(Boolean),
                );
                if (orgSuppressed.size > 0) {
                    const before = inputLeads.length;
                    inputLeads = inputLeads.filter((l: any) =>
                        !orgSuppressed.has(String(l.email || '').trim().toLowerCase()),
                    );
                    skippedCrossCampaign += before - inputLeads.length;
                }

                // Classify each lead using validation results as context.
                // Chunked Promise.all so a 100k-lead import doesn't materialize
                // 100k pending microtasks inside the transaction - that bloats
                // the Node heap and holds DB row locks for the full duration.
                // classifyLeadHealth is pure (no DB) so chunking just paces
                // the in-process CPU work; each chunk runs in parallel, the
                // outer loop pauses between chunks.
                const CLASSIFY_CHUNK = 500;
                const classifications: Array<{ lead: any; result: any; validation: any }> = [];
                for (let i = 0; i < inputLeads.length; i += CLASSIFY_CHUNK) {
                    const slice = inputLeads.slice(i, i + CLASSIFY_CHUNK);
                    const chunkResults = await Promise.all(
                        slice.map(async (lead: any) => {
                            const validation = leadValidations.get(lead.email.toLowerCase());
                            const result = await classifyLeadHealth(
                                lead.email,
                                validation ? {
                                    validationScore: validation.score,
                                    isDisposable: validation.isDisposable,
                                    isCatchAll: validation.isCatchAll,
                                } : undefined
                            ).catch(() => ({
                                classification: 'yellow' as const,
                                reasons: ['Health check failed'],
                            }));
                            return { lead, result, validation };
                        })
                    );
                    classifications.push(...chunkResults);
                }

                const accepted = classifications.filter(({ result }) => result.classification !== 'red');
                const rejected = classifications.filter(({ result }) => result.classification === 'red');

                // Create the import-batch row first so the lead rows can carry
                // import_id pointing at it. Counts get patched after createMany.
                let importBatchId: string | null = null;
                if (inputLeads.length > 0) {
                    const importBatch = await tx.campaignLeadImport.create({
                        data: {
                            campaign_id: camp.id,
                            organization_id: orgId,
                            source: String(leadSource || 'manual').toLowerCase(),
                            source_file: leadSourceFile || null,
                            source_label: leadSourceLabel || null,
                            total_submitted: inputLeads.length,
                            added_count: accepted.length,
                            blocked_count: rejected.length,
                            duplicate_count: skippedCrossCampaign,
                            created_by_user_id: req.orgContext?.userId ?? null,
                        },
                    });
                    importBatchId = importBatch.id;
                }

                const acceptedRows = accepted.map(({ lead, result, validation }) => ({
                    campaign_id: camp.id,
                    import_id: importBatchId,
                    email: lead.email,
                    first_name: lead.first_name || null,
                    last_name: lead.last_name || null,
                    company: lead.company || null,
                    status: result.classification === 'yellow' ? 'paused' : 'active',
                    validation_status: validation?.status || null,
                    validation_score: validation?.score ?? null,
                    custom_variables: {
                        ...(lead.custom_variables || {}),
                        ...(lead.full_name ? { full_name: lead.full_name } : {}),
                        ...(lead.website ? { website: lead.website } : {}),
                        ...((result as any).reasons?.length ? { _health_reasons: (result as any).reasons } : {}),
                    },
                }));

                if (acceptedRows.length > 0) {
                    await tx.campaignLead.createMany({
                        data: acceptedRows,
                        skipDuplicates: true,
                    });
                    // Surface the emails out of the transaction so the post-commit
                    // Protection Lead forward-wiring knows which Lead rows to update.
                    acceptedEmails = acceptedRows.map((r) => r.email.toLowerCase());
                }

                if (skippedCrossCampaign > 0) {
                    logger.info(`[CAMPAIGNS2] Skipped ${skippedCrossCampaign} leads already in other campaigns`, { campaignId: camp.id });
                }

                // Update total_leads count (accepted only)
                const leadCount = await tx.campaignLead.count({ where: { campaign_id: camp.id } });
                await tx.campaign.update({
                    where: { id: camp.id },
                    data: { total_leads: leadCount },
                });

                if (rejected.length > 0) {
                    logger.info(`[CAMPAIGNS2] Blocked ${rejected.length} RED leads from campaign ${camp.id}`, {
                        rejectedEmails: rejected.slice(0, 5).map(r => r.lead.email),
                    });
                }
            }

            // 4. Link accounts
            if (accountIds && Array.isArray(accountIds) && accountIds.length > 0) {
                await tx.campaignAccount.createMany({
                    data: accountIds.map((accountId: string) => ({
                        campaign_id: camp.id,
                        account_id: accountId,
                    })),
                    skipDuplicates: true,
                });
            }

            return camp;
        });

        // Forward-wire Protection Lead rows for any email that was accepted into
        // the new campaign. This is done post-transaction - the sequencer-side
        // writes have committed, so failures here can't roll them back. Each
        // sub-step is isolated so one bad Lead row doesn't cascade.
        //
        // Behavior:
        //   - If a Lead row exists for (org, email), set assigned_campaign_id to this
        //     campaign and refresh last_activity_at.
        //   - If that Lead is currently in 'held' status, transition it to ACTIVE via
        //     entityStateService (the sequencer is about to start sending, so from the
        //     Protection perspective this lead has been released into execution).
        //   - If no Lead row exists (e.g. user uploaded emails inline without going
        //     through bulkImportContacts first), we intentionally do NOT auto-create
        //     Lead rows here - that responsibility lives with the Contacts import path.
        if (acceptedEmails.length > 0) {
            await prisma.lead.updateMany({
                where: { organization_id: orgId, email: { in: acceptedEmails } },
                data: { assigned_campaign_id: campaign.id, last_activity_at: new Date() },
            }).catch((err) => {
                logger.warn('[CAMPAIGNS2] Failed to forward-wire Lead.assigned_campaign_id', { error: err?.message });
            });

            const heldLeads = await prisma.lead.findMany({
                where: { organization_id: orgId, email: { in: acceptedEmails }, status: 'held' },
                select: { id: true },
            }).catch(() => []);
            for (const l of heldLeads) {
                await entityStateService.transitionLead(
                    orgId,
                    l.id,
                    LeadState.ACTIVE,
                    `Added to sequencer campaign ${campaign.id} via createCampaign`,
                    TriggerType.MANUAL,
                ).catch((err) => {
                    logger.warn('[CAMPAIGNS2] Failed to transition lead to ACTIVE on campaign create', { leadId: l.id, error: err?.message });
                });
            }
        }

        // Re-fetch with relations
        const full = await prisma.campaign.findUnique({
            where: { id: campaign.id },
            include: {
                steps: { orderBy: { step_number: 'asc' }, include: { variants: true } },
                accounts: { include: { account: { select: { id: true, email: true, display_name: true } } } },
                _count: { select: { leads: true } },
            },
        });

        return res.status(201).json({ success: true, data: full });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to create campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create campaign' });
    }
};

/**
 * PATCH /api/sequencer/campaigns/:id
 * Update name, tags, schedule, settings.
 */
export const updateCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);
        const {
            name, tags, schedule, settings, steps, accountIds, addLeads, removeLeadIds, skipDuplicatesAcrossCampaigns,
            // Replace this campaign's suppression rules when provided. Pass null
            // (or omit) to leave existing rules untouched; pass [] to clear them.
            suppressionRules,
            // Provenance for the leads being added in this update - defaults to
            // 'manual' (e.g. user added rows directly in the UI). CSV imports
            // pass leadSource='csv' + leadSourceFile=<filename>.
            leadSource = 'manual',
            leadSourceFile,
            leadSourceLabel,
        } = req.body;

        // Emails newly accepted into the campaign during this updateCampaign call.
        // Populated inside the transaction, consumed after commit to forward-wire
        // Protection Lead rows (assigned_campaign_id + status transition).
        let acceptedEmails: string[] = [];

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        // Editing is allowed on any status except archived/completed - replacing steps
        // on an active campaign is safe because CampaignLead.current_step is preserved
        // (leads continue from where they left off; leads past the new last step are
        // effectively done). Replacing mailboxes reroutes future sends.
        const wantsStepReplace = Array.isArray(steps);
        const wantsAccountReplace = Array.isArray(accountIds);
        if ((wantsStepReplace || wantsAccountReplace) && (campaign.status === 'completed' || campaign.status === 'archived')) {
            return res.status(400).json({
                success: false,
                error: 'Completed or archived campaigns cannot be edited.',
            });
        }

        const scalarUpdate: any = {};
        if (name !== undefined) scalarUpdate.name = name;
        if (tags !== undefined) scalarUpdate.tags = tags;

        if (schedule) {
            // Accept both camelCase and snake_case for consistency with createCampaign
            const tz = schedule.timezone;
            const startTime = schedule.startTime ?? schedule.start_time;
            const endTime = schedule.endTime ?? schedule.end_time;
            const days = schedule.activeDays ?? schedule.days;
            const dailyLim = schedule.dailyLimit ?? schedule.daily_limit;
            const gap = schedule.sendGapMinutes ?? schedule.send_gap_minutes;
            const startDate = schedule.startDate ?? schedule.start_date;

            if (tz !== undefined) scalarUpdate.schedule_timezone = tz;
            if (startTime !== undefined) scalarUpdate.schedule_start_time = startTime;
            if (endTime !== undefined) scalarUpdate.schedule_end_time = endTime;
            if (days !== undefined) scalarUpdate.schedule_days = days;
            if (dailyLim !== undefined) scalarUpdate.daily_limit = dailyLim;
            if (gap !== undefined) scalarUpdate.send_gap_minutes = gap;
            if (startDate !== undefined) scalarUpdate.start_date = startDate ? new Date(startDate) : null;
        }

        if (settings) {
            const espR = settings.espRouting ?? settings.esp_routing;
            const sor = settings.stopOnReply ?? settings.stop_on_reply;
            const sob = settings.stopOnBounce ?? settings.stop_on_bounce;
            const tOp = settings.trackOpens ?? settings.track_opens;
            const tCl = settings.trackClicks ?? settings.track_clicks;
            const inc = settings.includeUnsubscribe ?? settings.include_unsubscribe;
            const trD = settings.trackingDomain ?? settings.tracking_domain;
            const dailyLim = settings.daily_limit ?? settings.dailyLimit;

            if (espR !== undefined) scalarUpdate.esp_routing = espR;
            if (sor !== undefined) scalarUpdate.stop_on_reply = sor;
            if (sob !== undefined) scalarUpdate.stop_on_bounce = sob;
            if (tOp !== undefined) scalarUpdate.track_opens = tOp;
            if (tCl !== undefined) scalarUpdate.track_clicks = tCl;
            if (inc !== undefined) scalarUpdate.include_unsubscribe = inc;
            if (trD !== undefined) scalarUpdate.tracking_domain = trD;
            if (dailyLim !== undefined) scalarUpdate.daily_limit = dailyLim;
        }

        // No automatic validation on add - users run "Verify Emails" in the wizard
        // before saving if they want to pre-check credits against their list.
        const addList = Array.isArray(addLeads) ? addLeads : [];
        const leadValidations = new Map<string, { score: number; status: string; isDisposable: boolean; isCatchAll: boolean }>();

        const removeIds = Array.isArray(removeLeadIds) ? (removeLeadIds as string[]) : [];
        const wantsLeadChanges = addList.length > 0 || removeIds.length > 0;

        await prisma.$transaction(async (tx) => {
            if (Object.keys(scalarUpdate).length > 0) {
                await tx.campaign.update({ where: { id: campaignId }, data: scalarUpdate });
            }

            if (wantsStepReplace) {
                // Active-campaign step-replace audit. Comment at the top of
                // this controller says leads past the new last step are
                // "effectively done" (dispatcher's resolveDeliverableStep
                // returns null → marks them completed). That's intentional
                // but invisible to the operator - log a structured warning
                // with the count so support has a trail when a customer
                // asks "why did 200 leads suddenly complete?".
                // Same canonical normalization as createCampaign: contiguous
                // 1..N step_number, branch targets remapped, full shape kept.
                const normalizedUpdateSteps = normalizeSequenceSteps(steps);

                // Active-campaign step-replace audit. After normalization the
                // sequence is contiguous 1..N, so the new last step number is
                // simply the step count. Leads whose current_step is at/after
                // that are "effectively done" (resolver returns null → marks
                // them completed) - log it so support has a trail when a
                // customer asks "why did 200 leads suddenly complete?".
                if (campaign.status === 'active' && normalizedUpdateSteps.length > 0) {
                    const newMaxStep = normalizedUpdateSteps.length;
                    const orphanedCount = await tx.campaignLead.count({
                        where: {
                            campaign_id: campaignId,
                            status: 'active',
                            current_step: { gte: newMaxStep },
                        },
                    });
                    if (orphanedCount > 0) {
                        logger.warn('[CAMPAIGNS2] Step-replace on active campaign will orphan leads', {
                            campaignId,
                            orphanedCount,
                            newMaxStep,
                        });
                        auditLogService.logAction({
                            organizationId: orgId,
                            entity: 'campaign',
                            entityId: campaignId,
                            trigger: 'user',
                            action: 'step_replace_orphans_leads',
                            details: JSON.stringify({ orphanedCount, newMaxStep }),
                        }).catch(err => logger.warn('[CAMPAIGNS2] audit log failed on step-replace', { campaignId, error: err?.message }));
                    }
                }

                // Delete existing steps - variants cascade via SequenceStepVariant relation.
                await tx.sequenceStep.deleteMany({ where: { campaign_id: campaignId } });
                // Recreate persisting the FULL shape. The prior loop dropped
                // step_type / condition / branch_to_step_number / body_text /
                // step_config, silently turning every LinkedIn/branched step
                // back into a plain email step on edit - that bug is fixed
                // here by mirroring createCampaign's persistence exactly.
                for (const step of normalizedUpdateSteps) {
                    const created = await tx.sequenceStep.create({
                        data: {
                            campaign_id: campaignId,
                            step_number: step.step_number,
                            step_type: step.step_type,
                            step_config: step.step_config as Prisma.InputJsonValue,
                            delay_days: step.delay_days,
                            delay_hours: step.delay_hours,
                            subject: step.subject,
                            preheader: step.preheader,
                            body_html: step.body_html,
                            body_text: step.body_text,
                            condition: step.condition,
                            branch_to_step_number: step.branch_to_step_number,
                        },
                    });
                    if (Array.isArray(step.variants) && step.variants.length > 0) {
                        for (const variant of step.variants as any[]) {
                            await tx.stepVariant.create({
                                data: {
                                    step_id: created.id,
                                    variant_label: variant.variant_label ?? variant.label ?? 'B',
                                    subject: variant.subject ?? '',
                                    preheader: variant.preheader ?? '',
                                    body_html: variant.body_html ?? variant.bodyHtml ?? '',
                                    weight: variant.weight ?? 50,
                                },
                            });
                        }
                    }
                }
            }

            if (wantsAccountReplace) {
                await tx.campaignAccount.deleteMany({ where: { campaign_id: campaignId } });
                if ((accountIds as string[]).length > 0) {
                    await tx.campaignAccount.createMany({
                        data: (accountIds as string[]).map((accountId) => ({
                            campaign_id: campaignId,
                            account_id: accountId,
                        })),
                        skipDuplicates: true,
                    });
                }
            }

            if (removeIds.length > 0) {
                // Scope delete to this campaign so orgs can't cross-delete
                await tx.campaignLead.deleteMany({
                    where: { id: { in: removeIds }, campaign_id: campaignId },
                });
            }

            // Replace suppression rules when the caller sent any (an explicit []
            // clears them, undefined leaves them alone). Legacy boolean folds in.
            const { setSuppressionRules, getSuppressedEmails, applySuppression } =
                await import('../services/campaignSuppressionService');
            if (Array.isArray(suppressionRules) || skipDuplicatesAcrossCampaigns !== undefined) {
                const folded = Array.isArray(suppressionRules) ? [...suppressionRules] : [];
                if (skipDuplicatesAcrossCampaigns && !folded.some((r: any) => r?.kind === 'all_campaigns')) {
                    folded.push({ kind: 'all_campaigns' });
                }
                await setSuppressionRules({
                    campaignId,
                    organizationId: orgId,
                    rules: folded,
                    client: tx,
                });
            }

            if (addList.length > 0) {
                // Apply this campaign's stored suppression rules to every lead-add.
                // Same-campaign duplicates are always skipped via the unique
                // constraint on (campaign_id, email).
                let effectiveAddList: any[] = addList;
                const suppressed = await getSuppressedEmails({ campaignId, organizationId: orgId, client: tx });
                if (suppressed.size > 0) {
                    const { kept } = applySuppression(effectiveAddList, suppressed);
                    effectiveAddList = kept;
                }

                const classifications = await Promise.all(
                    effectiveAddList.map(async (lead: any) => {
                        const validation = leadValidations.get(String(lead.email).toLowerCase());
                        const result = await classifyLeadHealth(
                            lead.email,
                            validation ? {
                                validationScore: validation.score,
                                isDisposable: validation.isDisposable,
                                isCatchAll: validation.isCatchAll,
                            } : undefined
                        ).catch(() => ({
                            classification: 'yellow' as const,
                            reasons: ['Health check failed'],
                        }));
                        return { lead, result, validation };
                    })
                );

                const accepted = classifications.filter(({ result }) => result.classification !== 'red');
                const rejected = classifications.filter(({ result }) => result.classification === 'red');

                // Same provenance-batch pattern as createCampaign - every batch
                // of leads added in an update gets its own import row so the
                // detail page can show "added 50 from leads_q3.csv on Mon at 14:32"
                // separately from the original create-time import.
                let importBatchId: string | null = null;
                if (addList.length > 0) {
                    const importBatch = await tx.campaignLeadImport.create({
                        data: {
                            campaign_id: campaignId,
                            organization_id: orgId,
                            source: String(leadSource || 'manual').toLowerCase(),
                            source_file: leadSourceFile || null,
                            source_label: leadSourceLabel || null,
                            total_submitted: addList.length,
                            added_count: accepted.length,
                            blocked_count: rejected.length,
                            duplicate_count: 0, // updateCampaign doesn't filter dupes pre-classify; counted via skipDuplicates downstream
                            created_by_user_id: req.orgContext?.userId ?? null,
                        },
                    });
                    importBatchId = importBatch.id;
                }

                const acceptedRows = accepted.map(({ lead, result, validation }) => ({
                    campaign_id: campaignId,
                    import_id: importBatchId,
                    email: String(lead.email).toLowerCase().trim(),
                    first_name: lead.first_name || null,
                    last_name: lead.last_name || null,
                    company: lead.company || null,
                    title: lead.title || null,
                    status: result.classification === 'yellow' ? 'paused' : 'active',
                    // Seed next_send_at so the dispatcher picks new leads up immediately
                    next_send_at: result.classification === 'yellow' ? null : new Date(),
                    validation_status: validation?.status || null,
                    validation_score: validation?.score ?? null,
                    custom_variables: {
                        ...(lead.custom_variables || {}),
                        ...(lead.full_name ? { full_name: lead.full_name } : {}),
                        ...(lead.website ? { website: lead.website } : {}),
                        ...((result as any).reasons?.length ? { _health_reasons: (result as any).reasons } : {}),
                    },
                }));

                if (acceptedRows.length > 0) {
                    await tx.campaignLead.createMany({
                        data: acceptedRows,
                        skipDuplicates: true,
                    });
                    acceptedEmails = acceptedRows.map((r) => r.email.toLowerCase());
                }
            }

            if (wantsLeadChanges) {
                const leadCount = await tx.campaignLead.count({ where: { campaign_id: campaignId } });
                await tx.campaign.update({
                    where: { id: campaignId },
                    data: { total_leads: leadCount },
                });
            }
        });

        // Forward-wire Protection Lead rows for any email newly added to the campaign
        // during this update. Mirrors the same pattern as createCampaign; post-transaction,
        // best-effort, isolated failures.
        if (acceptedEmails.length > 0) {
            await prisma.lead.updateMany({
                where: { organization_id: orgId, email: { in: acceptedEmails } },
                data: { assigned_campaign_id: campaignId, last_activity_at: new Date() },
            }).catch((err) => {
                logger.warn('[CAMPAIGNS2] Failed to forward-wire Lead.assigned_campaign_id on update', { error: err?.message });
            });

            const heldLeads = await prisma.lead.findMany({
                where: { organization_id: orgId, email: { in: acceptedEmails }, status: 'held' },
                select: { id: true },
            }).catch(() => []);
            for (const l of heldLeads) {
                await entityStateService.transitionLead(
                    orgId,
                    l.id,
                    LeadState.ACTIVE,
                    `Added to sequencer campaign ${campaignId} via updateCampaign`,
                    TriggerType.MANUAL,
                ).catch((err) => {
                    logger.warn('[CAMPAIGNS2] Failed to transition lead to ACTIVE on update', { leadId: l.id, error: err?.message });
                });
            }
        }

        const updated = await prisma.campaign.findUnique({ where: { id: campaignId } });
        return res.json({ success: true, data: updated });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to update campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update campaign' });
    }
};

/**
 * DELETE /api/sequencer/campaigns/:id
 *
 * Soft-delete. We DO NOT cascade-drop the row anymore - that took analytics,
 * reply history, lead sources, and cross-campaign suppression references
 * with it, and a GDPR / audit request had nothing to show. Instead we
 * tombstone the row (`deleted_at`, `deleted_by_user_id`) and every read
 * path filters tombstoned rows out by default.
 *
 * Side effects:
 *   - Pause the dispatcher: status flips to 'paused' so the LinkedIn
 *     dispatcher and email dispatcher stop sending. Without this a
 *     tombstoned campaign would still be active until the read filter
 *     kicked in, and there's a window where the dispatcher's own query
 *     might not include the filter (defense-in-depth).
 *   - Mark all active CampaignLeads as 'paused' so cross-channel
 *     suppression already-in-flight stays consistent.
 *   - Write an AuditLog entry - entity='campaign', action='delete' - so
 *     the compliance team can prove the deletion happened and by whom.
 *
 * Hard-delete is a separate operation (future endpoint or retention
 * worker) that runs N days after soft-delete.
 */
export const deleteCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const userId = req.orgContext?.userId;
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
            select: { id: true, name: true, status: true },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        const deletedAt = new Date();
        await prisma.$transaction([
            prisma.campaign.update({
                where: { id: campaignId },
                data: {
                    deleted_at: deletedAt,
                    deleted_by_user_id: userId ?? null,
                    status: 'paused',
                    paused_reason: 'campaign_deleted',
                    paused_at: deletedAt,
                    paused_by: userId ? 'user' : 'system',
                },
            }),
            prisma.campaignLead.updateMany({
                where: { campaign_id: campaignId, status: 'active' },
                data: { status: 'paused', next_send_at: null },
            }),
        ]);

        auditLogService.logAction({
            organizationId: orgId,
            entity: 'campaign',
            entityId: campaignId,
            trigger: userId ? 'user' : 'system',
            action: 'delete',
            details: JSON.stringify({ name: campaign.name, prior_status: campaign.status, deleted_at: deletedAt.toISOString() }),
            userId,
        }).catch(err => logger.warn('[CAMPAIGNS2] audit log failed on delete', { campaignId, error: err?.message }));

        return res.json({ success: true, message: 'Campaign deleted', deleted_at: deletedAt.toISOString() });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to delete campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to delete campaign' });
    }
};

/**
 * POST /api/sequencer/campaigns/:id/launch
 *
 * Unified launch entry point - used by both the email-side Sequencer UI
 * and (indirectly) any caller that doesn't know about channel. We
 * dispatch on `channel` to validate per-channel preconditions:
 *
 *   - 'email'    → at least one CampaignAccount (mailbox) attached.
 *   - 'linkedin' → at least one CampaignLinkedInSender, AND the full
 *                  LinkedIn pre-launch validator must return can_launch.
 *                  This is the same gate the /api/linkedin route uses;
 *                  consolidating it here closes the bypass where a
 *                  caller hit this URL instead of the LinkedIn-specific
 *                  one and skipped capacity / tier / connection-state
 *                  checks.
 *   - 'multi'    → both channel checks. The LinkedIn validator runs as
 *                  long as the campaign has any linkedin_* steps; if it
 *                  has none, we skip it (a multi-channel campaign with
 *                  only email steps is operationally an email campaign).
 *
 * Idempotent: returns 400 if the campaign is already active. The status
 * read + update happen in one transaction so concurrent launches don't
 * both flip the flag.
 */
export const launchCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
            select: { id: true, name: true, status: true, channel: true, launched_at: true },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status === 'active') return res.status(400).json({ success: false, error: 'Campaign is already active' });

        const channel = (campaign.channel || 'email').toLowerCase();
        const hasEmail = channel === 'email' || channel === 'multi';
        const hasLinkedIn = channel === 'linkedin' || channel === 'multi';

        // Step + account counts up front. For LinkedIn we count the
        // LinkedIn sender pool (CampaignLinkedInSender), not the email
        // CampaignAccount table - they're separate attachments.
        const [stepCount, emailAccountCount, linkedInSenderCount, linkedInStepCount] = await Promise.all([
            prisma.sequenceStep.count({ where: { campaign_id: campaignId } }),
            hasEmail ? prisma.campaignAccount.count({ where: { campaign_id: campaignId } }) : Promise.resolve(0),
            hasLinkedIn ? prisma.campaignLinkedInSender.count({ where: { campaign_id: campaignId } }) : Promise.resolve(0),
            hasLinkedIn ? prisma.sequenceStep.count({
                where: { campaign_id: campaignId, step_type: { startsWith: 'linkedin_' } },
            }) : Promise.resolve(0),
        ]);

        if (stepCount === 0) return res.status(400).json({ success: false, error: 'Campaign has no sequence steps' });
        if (hasEmail && emailAccountCount === 0) {
            return res.status(400).json({ success: false, error: 'Campaign has no connected email accounts' });
        }
        if (hasLinkedIn && linkedInStepCount > 0 && linkedInSenderCount === 0) {
            return res.status(400).json({
                success: false,
                error: 'Campaign has LinkedIn steps but no LinkedIn senders attached. Attach a sender from /dashboard/linkedin/accounts before launching.',
            });
        }

        // Connected-state re-check for LinkedIn senders. The count above
        // can pass while every attached account is in ERROR/CREDENTIALS
        // (re-auth required) - the dispatcher would then no-op every
        // tick and the campaign would silently sit "active" with no
        // sends. Block launch and tell the operator which accounts need
        // attention.
        if (hasLinkedIn && linkedInStepCount > 0) {
            const senders = await prisma.campaignLinkedInSender.findMany({
                where: { campaign_id: campaignId, enabled: true },
                select: {
                    linkedin_account: { select: { id: true, display_name: true, status: true } },
                },
            });
            const okSenders = senders.filter(s => s.linkedin_account?.status === 'OK');
            if (okSenders.length === 0) {
                const broken = senders
                    .map(s => `${s.linkedin_account?.display_name ?? 'unknown'} (${s.linkedin_account?.status ?? 'missing'})`)
                    .join(', ');
                return res.status(400).json({
                    success: false,
                    error: `No LinkedIn senders in a healthy state. Reconnect: ${broken || '(no enabled senders)'}.`,
                });
            }
        }

        // Full LinkedIn pre-launch validation - capacity ladder, tier
        // gates for InMail, degree-of-connection state, working-hours,
        // sequence-shape rules. Only runs when the campaign actually has
        // LinkedIn steps; a multi-channel campaign with email-only steps
        // doesn't need it.
        if (hasLinkedIn && linkedInStepCount > 0) {
            const report = await runPreLaunchValidation({
                organizationId: orgId,
                campaignId,
            });
            if (!report.can_launch) {
                return res.status(400).json({
                    success: false,
                    error: 'Pre-launch validation failed',
                    data: report,
                });
            }
        }

        // Status flip + launched_at stamp in one transaction so two
        // concurrent launches can't both pass the "is active?" check
        // and double-seed leads.
        const updated = await prisma.$transaction(async (tx) => {
            const current = await tx.campaign.findUnique({
                where: { id: campaignId },
                select: { status: true, launched_at: true },
            });
            if (!current) throw new Error('Campaign disappeared during launch');
            if (current.status === 'active') {
                throw Object.assign(new Error('Campaign is already active'), { http: 400 });
            }
            return tx.campaign.update({
                where: { id: campaignId },
                data: {
                    status: 'active',
                    launched_at: current.launched_at || new Date(),
                },
            });
        });

        // Seed next_send_at for first-time leads so the dispatcher picks them up.
        // Only touches leads that have never been sent to (current_step=0, next_send_at IS NULL).
        const seeded = await prisma.campaignLead.updateMany({
            where: {
                campaign_id: campaignId,
                status: 'active',
                current_step: 0,
                next_send_at: null,
            },
            data: { next_send_at: new Date() },
        });
        logger.info('[CAMPAIGNS2] Campaign launched', { campaignId, leadsSeeded: seeded.count });

        webhookBus.emitCampaignLaunched(orgId, { id: updated.id, name: updated.name }, {
            leads: seeded.count,
            steps: stepCount,
        });

        SlackAlertService.sendAlert({
            organizationId: orgId,
            eventType: 'campaign.activated',
            entityId: updated.id,
            severity: 'info',
            title: '🚀 Campaign activated',
            message: `Campaign *${updated.name}* is now sending. ${seeded.count} lead${seeded.count !== 1 ? 's' : ''} seeded across ${stepCount} step${stepCount !== 1 ? 's' : ''}.`,
        }).catch((err) => logger.warn('[CAMPAIGNS2] Slack alert failed (campaign.activated)', { error: err?.message }));

        return res.json({ success: true, data: updated });
    } catch (error: any) {
        // The launch transaction throws a 400-tagged error when a
        // concurrent launch already flipped status. Forward that as the
        // user-visible 400 instead of masking it as a 500.
        if (error?.http === 400) {
            return res.status(400).json({ success: false, error: error.message });
        }
        logger.error('[CAMPAIGNS2] Failed to launch campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to launch campaign' });
    }
};

/**
 * POST /api/sequencer/campaigns/:id/pause
 * Set status to 'paused'.
 */
export const pauseCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const userId = req.orgContext?.userId;
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status !== 'active') return res.status(400).json({ success: false, error: 'Campaign is not active' });

        // Stamp the pause with metadata so the detail page can distinguish
        // a manual pause from a system auto-pause (healing pipeline). The
        // health endpoint's `auto_paused` derives from `paused_by`.
        const updated = await prisma.campaign.update({
            where: { id: campaignId },
            data: {
                status: 'paused',
                paused_reason: 'manual_pause',
                paused_at: new Date(),
                paused_by: userId ? 'user' : 'system',
            },
        });

        webhookBus.emitCampaignPaused(orgId, { id: updated.id, name: updated.name }, 'manual_pause');

        return res.json({ success: true, data: updated });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to pause campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to pause campaign' });
    }
};

/**
 * POST /api/sequencer/campaigns/:id/resume
 * Set status to 'active'.
 */
export const resumeCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status !== 'paused') return res.status(400).json({ success: false, error: 'Campaign is not paused' });

        // Clear the pause metadata on resume so a follow-up pause doesn't
        // inherit stale auto-pause attribution (e.g. campaign was
        // system-paused, operator resumed, then manually paused - without
        // clearing here the UI would still show `paused_by='system'`).
        const updated = await prisma.campaign.update({
            where: { id: campaignId },
            data: {
                status: 'active',
                paused_reason: null,
                paused_at: null,
                paused_by: null,
            },
        });

        return res.json({ success: true, data: updated });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to resume campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to resume campaign' });
    }
};

/**
 * PUT /api/sequencer/campaigns/:id/tags
 * Body: { tagIds: string[] }
 *
 * Replace the campaign's tag set wholesale. Mirror of contacts'
 * setContactTags - server-side validation that all tagIds belong to
 * the caller's org so cross-org tags can't be applied.
 */
export const setCampaignTags = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);
        const tagIds = Array.isArray(req.body?.tagIds) ? (req.body.tagIds as unknown[]).map(x => String(x)) : null;
        if (!tagIds) return res.status(400).json({ success: false, error: 'tagIds array is required' });

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
            select: { id: true },
        });
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        if (tagIds.length > 0) {
            const validTags = await prisma.tag.findMany({
                where: { id: { in: tagIds }, organization_id: orgId },
                select: { id: true },
            });
            if (validTags.length !== tagIds.length) {
                return res.status(400).json({ success: false, error: 'One or more tags not found in this organization' });
            }
        }

        await prisma.$transaction([
            prisma.campaignTag.deleteMany({ where: { campaign_id: campaignId } }),
            prisma.campaignTag.createMany({
                data: tagIds.map(tagId => ({ campaign_id: campaignId, tag_id: tagId })),
                skipDuplicates: true,
            }),
        ]);

        return res.json({ success: true });
    } catch (err) {
        logger.error('[CAMPAIGNS2] setCampaignTags failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to update tags' });
    }
};

/**
 * POST /api/sequencer/campaigns/bulk-tag
 * Body: { ids: string[], tagId: string, action: 'add' | 'remove' }
 *
 * Add or remove a single tag across many campaigns at once.
 */
export const bulkTagCampaigns = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(x => String(x)) : null;
        const tagId = typeof req.body?.tagId === 'string' ? req.body.tagId : null;
        const action = req.body?.action === 'remove' ? 'remove' : 'add';

        if (!ids || ids.length === 0) return res.status(400).json({ success: false, error: 'ids array is required' });
        if (!tagId) return res.status(400).json({ success: false, error: 'tagId is required' });

        const tag = await prisma.tag.findFirst({ where: { id: tagId, organization_id: orgId } });
        if (!tag) return res.status(404).json({ success: false, error: 'Tag not found' });

        const validCampaigns = await prisma.campaign.findMany({
            where: { id: { in: ids }, organization_id: orgId },
            select: { id: true },
        });
        const validIds = validCampaigns.map(c => c.id);
        if (validIds.length === 0) return res.json({ success: true, affected: 0 });

        if (action === 'add') {
            await prisma.campaignTag.createMany({
                data: validIds.map(campaignId => ({ campaign_id: campaignId, tag_id: tagId })),
                skipDuplicates: true,
            });
        } else {
            await prisma.campaignTag.deleteMany({
                where: { tag_id: tagId, campaign_id: { in: validIds } },
            });
        }

        return res.json({ success: true, affected: validIds.length });
    } catch (err) {
        logger.error('[CAMPAIGNS2] bulkTagCampaigns failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to apply tag' });
    }
};

// ────────────────────────────────────────────────────────────────────
// Suppression - GET rules for hydration + lead-picker for the modal
// ────────────────────────────────────────────────────────────────────

/**
 * GET /api/sequencer/campaigns/:id/suppression
 *
 * Returns the campaign's current suppression rules so the edit-time
 * "add leads" flow can pre-populate the picker with what's already
 * applied. Cross-tenant safe: 404s if the campaign isn't in the caller's
 * org. The 'all_campaigns' rule has both source columns null; clients
 * use `kind` as the discriminator.
 */
export const getCampaignSuppression = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);
        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId, deleted_at: null },
            select: { id: true },
        });
        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        const { listSuppressionRules } = await import('../services/campaignSuppressionService');
        const rules = await listSuppressionRules(campaignId);
        return res.json({ success: true, data: rules });
    } catch (err) {
        logger.error('[CAMPAIGNS2] getCampaignSuppression failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load suppression rules' });
    }
};

/**
 * GET /api/sequencer/campaigns/lead-picker
 * Query: campaign_ids=csv,uuid,…  [search=]  [offset=0]  [limit=50]
 *
 * Lists leads from the named source campaigns so the wizard's "pick
 * leads" modal can render a scoped, searchable list. The picker is
 * intentionally scoped to user-selected campaigns (per the product
 * decision in the design Q&A) - never returns the whole org's leads.
 *
 * Cross-tenant safe via the campaign.organization_id join.
 */
export const listLeadsForSuppression = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const raw = String(req.query.campaign_ids || '').trim();
        const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length === 0) {
            return res.status(400).json({ success: false, error: 'campaign_ids is required' });
        }
        if (ids.length > 50) {
            return res.status(400).json({ success: false, error: 'At most 50 campaigns at a time' });
        }
        const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        const offset = Math.max(0, Number(req.query.offset || 0) | 0);
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50) | 0));

        const whereBase = {
            campaign_id: { in: ids },
            campaign: { organization_id: orgId },
        };

        // Search across email, first/last/full-name, company. Case-insensitive
        // via Postgres ILIKE (Prisma mode: 'insensitive'). Index on email is the
        // primary access path; the other fields are scanned on the campaign
        // subset only, so latency is bounded by the campaign sizes selected.
        const where = search
            ? {
                ...whereBase,
                OR: [
                    { email: { contains: search, mode: 'insensitive' as const } },
                    { first_name: { contains: search, mode: 'insensitive' as const } },
                    { last_name: { contains: search, mode: 'insensitive' as const } },
                    { company: { contains: search, mode: 'insensitive' as const } },
                ],
            }
            : whereBase;

        const [total, rows] = await Promise.all([
            prisma.campaignLead.count({ where }),
            prisma.campaignLead.findMany({
                where,
                select: {
                    id: true,
                    email: true,
                    first_name: true,
                    last_name: true,
                    company: true,
                    campaign_id: true,
                    campaign: { select: { id: true, name: true } },
                },
                orderBy: [{ email: 'asc' }],
                skip: offset,
                take: limit,
            }),
        ]);

        return res.json({
            success: true,
            data: {
                total,
                offset,
                limit,
                leads: rows.map(r => ({
                    id: r.id,
                    email: r.email,
                    first_name: r.first_name,
                    last_name: r.last_name,
                    company: r.company,
                    campaign_id: r.campaign_id,
                    campaign_name: r.campaign?.name ?? null,
                })),
            },
        });
    } catch (err) {
        logger.error('[CAMPAIGNS2] listLeadsForSuppression failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load leads' });
    }
};
