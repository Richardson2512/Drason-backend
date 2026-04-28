/**
 * Campaign Controller (Sequencer)
 *
 * CRUD + lifecycle for SendCampaigns with steps, variants, leads, and accounts.
 * Named campaignController2 to avoid conflict with existing campaignController.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { classifyLeadHealth } from '../services/leadHealthService';
import * as entityStateService from '../services/entityStateService';
import * as webhookBus from '../services/webhookEventBus';
import { SlackAlertService } from '../services/SlackAlertService';
import { LeadState, TriggerType } from '../types';

/**
 * GET /api/sequencer/campaigns
 * List SendCampaigns with pagination and status filter.
 */
export const listCampaigns = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 25;
        const status = (req.query.status as string) || undefined;

        // List all of the org's campaigns. Campaign table is unified post-Phase-B
        // (2026-04-26) — every row is a native sequencer campaign.
        const where: any = { organization_id: orgId };
        if (status && status !== 'all') where.status = status;

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
                },
            }),
            prisma.campaign.count({ where }),
        ]);

        const data = campaigns.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            tags: c.tags,
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

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId },
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
                _count: { select: { leads: true } },
            },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        // Leads summary: breakdown by status
        const leadsByStatus = await prisma.campaignLead.groupBy({
            by: ['status'],
            where: { campaign_id: campaignId },
            _count: true,
        });

        const leadsSummary = leadsByStatus.reduce((acc: Record<string, number>, g) => {
            acc[g.status] = g._count;
            return acc;
        }, {});

        // Lead-source provenance — every CSV upload / Clay ingest / manual add
        // is its own CampaignLeadImport row. Surface them so the detail page
        // can render a "Lead sources" panel with filenames + counts + dates.
        const leadImports = await prisma.campaignLeadImport.findMany({
            where: { campaign_id: campaignId },
            orderBy: { created_at: 'desc' },
            take: 50,
        });

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
                total_opened: campaign.open_count,
                total_clicked: campaign.click_count,
                total_replied: campaign.reply_count,
                total_unsubscribed: campaign.unsubscribed_count,
                lead_count: campaign._count.leads,
                leads_summary: leadsSummary,
                lead_imports: leadImports,
            },
        });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to get campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get campaign' });
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
            where: { id: campaignId, organization_id: orgId },
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
            // Provenance for the initial leads — surfaced in the campaign detail
            // page's "Lead sources" panel. Defaults to 'manual' if the caller
            // doesn't say otherwise (e.g. the legacy wizard before this change).
            leadSource = 'manual',
            leadSourceFile,
            leadSourceLabel,
        } = req.body;

        if (!name) return res.status(400).json({ success: false, error: 'Campaign name is required' });

        // No automatic validation pass. Users pre-validate their leads via the
        // "Verify Emails" button in the Leads step of the wizard before launch —
        // credits shouldn't be spent silently on campaign creation. classifyLeadHealth
        // still runs below, using cached validation_status from the Lead table when
        // available; otherwise it relies on light syntax/disposable/role checks.
        const leadValidations = new Map<string, { score: number; status: string; isDisposable: boolean; isCatchAll: boolean }>();

        // Emails actually accepted into the campaign — populated inside the transaction,
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
                                        channel: 'email',
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

            // 2. Create sequence steps + variants
            if (steps && Array.isArray(steps)) {
                for (const step of steps) {
                    // Accept both snake_case (v1 API / MCP) and camelCase (frontend wizard)
                    const stepNumber = step.step_number ?? step.stepNumber;
                    const delayDays = step.delay_days ?? step.delayDays ?? 1;
                    const delayHours = step.delay_hours ?? step.delayHours ?? 0;
                    const bodyHtml = step.body_html ?? step.bodyHtml ?? '';

                    const createdStep = await tx.sequenceStep.create({
                        data: {
                            campaign_id: camp.id,
                            step_number: stepNumber,
                            delay_days: delayDays,
                            delay_hours: delayHours,
                            subject: step.subject || '',
                            body_html: bodyHtml,
                        },
                    });

                    // Create variants if provided
                    if (step.variants && Array.isArray(step.variants)) {
                        for (const variant of step.variants) {
                            await tx.stepVariant.create({
                                data: {
                                    step_id: createdStep.id,
                                    variant_label: variant.label || 'A',
                                    subject: variant.subject,
                                    body_html: variant.body_html ?? variant.bodyHtml ?? '',
                                    weight: variant.weight ?? 50,
                                },
                            });
                        }
                    }
                }
            }

            // 3. Create campaign leads — with health gate classification + validation
            if (leads && Array.isArray(leads) && leads.length > 0) {
                // Optional cross-campaign dedupe: strip leads whose email already appears
                // in any other campaign in the org. Prevents accidentally re-mailing the
                // same person across multiple sequences.
                let inputLeads: any[] = leads;
                let skippedCrossCampaign = 0;
                if (skipDuplicatesAcrossCampaigns) {
                    const emails = Array.from(new Set(inputLeads
                        .map((l: any) => String(l.email || '').toLowerCase().trim())
                        .filter((e: string) => !!e)));
                    if (emails.length > 0) {
                        const existing = await tx.campaignLead.findMany({
                            where: {
                                email: { in: emails },
                                campaign: { organization_id: orgId },
                            },
                            select: { email: true },
                        });
                        const existingSet = new Set(existing.map((r) => r.email.toLowerCase()));
                        const before = inputLeads.length;
                        inputLeads = inputLeads.filter((l: any) => !existingSet.has(String(l.email || '').toLowerCase().trim()));
                        skippedCrossCampaign = before - inputLeads.length;
                    }
                }

                // Classify each lead using validation results as context
                const classifications = await Promise.all(
                    inputLeads.map(async (lead: any) => {
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
        // the new campaign. This is done post-transaction — the sequencer-side
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
        //     Lead rows here — that responsibility lives with the Contacts import path.
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
            // Provenance for the leads being added in this update — defaults to
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
            where: { id: campaignId, organization_id: orgId },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        // Editing is allowed on any status except archived/completed — replacing steps
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

        // No automatic validation on add — users run "Verify Emails" in the wizard
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
                // Delete existing steps — variants cascade via SequenceStepVariant relation
                await tx.sequenceStep.deleteMany({ where: { campaign_id: campaignId } });
                for (const step of steps as any[]) {
                    const stepNumber = step.step_number ?? step.stepNumber;
                    const delayDays = step.delay_days ?? step.delayDays ?? 1;
                    const delayHours = step.delay_hours ?? step.delayHours ?? 0;
                    const created = await tx.sequenceStep.create({
                        data: {
                            campaign_id: campaignId,
                            step_number: stepNumber,
                            delay_days: delayDays,
                            delay_hours: delayHours,
                            subject: step.subject ?? '',
                            body_html: step.body_html ?? step.bodyHtml ?? '',
                        },
                    });
                    if (Array.isArray(step.variants) && step.variants.length > 0) {
                        for (const variant of step.variants) {
                            await tx.stepVariant.create({
                                data: {
                                    step_id: created.id,
                                    variant_label: variant.variant_label ?? variant.label ?? 'B',
                                    subject: variant.subject ?? '',
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

            if (addList.length > 0) {
                // Strip leads already in OTHER campaigns when the flag is set. Same-campaign
                // duplicates are always skipped via the unique constraint on (campaign_id, email).
                let effectiveAddList: any[] = addList;
                if (skipDuplicatesAcrossCampaigns) {
                    const emails = Array.from(new Set(effectiveAddList
                        .map((l: any) => String(l.email || '').toLowerCase().trim())
                        .filter((e: string) => !!e)));
                    if (emails.length > 0) {
                        const existing = await tx.campaignLead.findMany({
                            where: {
                                email: { in: emails },
                                campaign_id: { not: campaignId },
                                campaign: { organization_id: orgId },
                            },
                            select: { email: true },
                        });
                        const existingSet = new Set(existing.map((r) => r.email.toLowerCase()));
                        effectiveAddList = effectiveAddList.filter((l: any) => !existingSet.has(String(l.email || '').toLowerCase().trim()));
                    }
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

                // Same provenance-batch pattern as createCampaign — every batch
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
 * Delete campaign + cascade.
 */
export const deleteCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });

        await prisma.campaign.delete({ where: { id: campaignId } });

        return res.json({ success: true, message: 'Campaign deleted' });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to delete campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to delete campaign' });
    }
};

/**
 * POST /api/sequencer/campaigns/:id/launch
 * Set status to 'active', set launched_at.
 */
export const launchCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status === 'active') return res.status(400).json({ success: false, error: 'Campaign is already active' });

        // Validate campaign has steps and accounts
        const [stepCount, accountCount] = await Promise.all([
            prisma.sequenceStep.count({ where: { campaign_id: campaignId } }),
            prisma.campaignAccount.count({ where: { campaign_id: campaignId } }),
        ]);

        if (stepCount === 0) return res.status(400).json({ success: false, error: 'Campaign has no sequence steps' });
        if (accountCount === 0) return res.status(400).json({ success: false, error: 'Campaign has no connected accounts' });

        const updated = await prisma.campaign.update({
            where: { id: campaignId },
            data: {
                status: 'active',
                launched_at: campaign.launched_at || new Date(),
            },
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
        const campaignId = String(req.params.id);

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaignId, organization_id: orgId },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status !== 'active') return res.status(400).json({ success: false, error: 'Campaign is not active' });

        const updated = await prisma.campaign.update({
            where: { id: campaignId },
            data: { status: 'paused' },
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
            where: { id: campaignId, organization_id: orgId },
        });

        if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
        if (campaign.status !== 'paused') return res.status(400).json({ success: false, error: 'Campaign is not paused' });

        const updated = await prisma.campaign.update({
            where: { id: campaignId },
            data: { status: 'active' },
        });

        return res.json({ success: true, data: updated });
    } catch (error: any) {
        logger.error('[CAMPAIGNS2] Failed to resume campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to resume campaign' });
    }
};
