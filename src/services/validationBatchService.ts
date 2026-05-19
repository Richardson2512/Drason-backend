/**
 * Validation Batch Service
 *
 * Core orchestrator for bulk email validation + ESP classification.
 * Manages the batch lifecycle: create → process → route → export → analytics.
 */

import { prisma } from '../prisma';
import { logger } from './observabilityService';
import * as emailValidationService from './emailValidationService';
import { validationPersistData } from './emailValidationService';
import { classifyLeadHealth } from './leadHealthService';
import * as espClassifierService from './espClassifierService';
import * as entityStateService from './entityStateService';
import * as auditLogService from './auditLogService';
import { enrollLeadInSequencerCampaign } from './sequencerEnrollmentService';
import { getValidationCreditState } from './validationCreditService';
import { LeadState, TriggerType } from '../types';
import type { ParsedLead } from './csvParserService';

const CHUNK_SIZE = 50;

// ============================================================================
// BATCH LIFECYCLE
// ============================================================================

/**
 * Create a validation batch and bulk-insert batch leads in pending state.
 */
export async function createBatch(
    organizationId: string,
    source: string,
    leads: ParsedLead[],
    options?: { fileName?: string; targetCampaignId?: string }
): Promise<{ batchId: string; totalCount: number }> {
    const batch = await prisma.validationBatch.create({
        data: {
            organization_id: organizationId,
            source,
            status: 'processing',
            file_name: options?.fileName || null,
            total_count: leads.length,
            target_campaign_id: options?.targetCampaignId || null,
        }
    });

    // Bulk-insert leads in chunks to avoid large transaction overhead
    for (let i = 0; i < leads.length; i += 500) {
        const chunk = leads.slice(i, i + 500);
        await prisma.validationBatchLead.createMany({
            data: chunk.map(lead => ({
                batch_id: batch.id,
                email: lead.email,
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company || null,
                persona: lead.persona || null,
                lead_score: lead.lead_score ?? 50,
                validation_status: 'pending',
            }))
        });
    }

    logger.info('[VALIDATION_BATCH] Created batch', {
        batchId: batch.id,
        organizationId,
        source,
        totalCount: leads.length,
    });

    return { batchId: batch.id, totalCount: leads.length };
}

/**
 * Process a batch: validate each lead + classify ESP.
 * Runs asynchronously after HTTP response. Emits SSE progress events.
 */
export async function processBatch(organizationId: string, batchId: string): Promise<void> {
    const logTag = 'VALIDATION_BATCH';

    try {
        // Get the org subscription tier for MillionVerifier gating + credit limits
        const org = await prisma.organization.findUnique({
            where: { id: organizationId },
            select: { subscription_tier: true }
        });
        const tier = org?.subscription_tier || 'trial';

        // Credit accounting now reads the SINGLE ledger (ValidationAttempt)
        // via the shared service, so this batch sees by-tag / single /
        // Clay / other-batch usage too (F2 root). Re-derived at the start
        // of every chunk below, not snapshotted once - that collapses the
        // overspend race from a whole batch to one chunk.
        let credit = await getValidationCreditState(organizationId, tier);

        // Fetch all pending leads for this batch
        const batchLeads = await prisma.validationBatchLead.findMany({
            where: { batch_id: batchId, validation_status: 'pending' },
            orderBy: { created_at: 'asc' },
        });

        // F8: BATCHED DEDUP. Replace the old per-lead two-findFirst pattern
        // (2 DB queries per lead = ~10k queries on a 5k upload) with a
        // single pre-load. crossBatch is immutable for this batch run;
        // inBatch grows as we process rows in this batch so an earlier
        // row's status is visible when a later identical email is reached.
        const batchEmails = Array.from(new Set(batchLeads.map(b => b.email)));
        const crossBatchRows = batchEmails.length > 0
            ? await prisma.validationBatchLead.findMany({
                where: {
                    batch_id: { not: batchId },
                    email: { in: batchEmails },
                    batch: { organization_id: organizationId },
                    validation_status: { notIn: ['pending', 'skipped'] },
                },
                select: { email: true, validation_status: true, routed_to_campaign_id: true, created_at: true },
                orderBy: { created_at: 'desc' },
            })
            : [];
        const crossBatchByEmail = new Map<string, { validation_status: string; routed_to_campaign_id: string | null }>();
        for (const r of crossBatchRows) {
            // orderBy desc + first-wins keeps the most recent prior record.
            if (!crossBatchByEmail.has(r.email)) {
                crossBatchByEmail.set(r.email, {
                    validation_status: r.validation_status,
                    routed_to_campaign_id: r.routed_to_campaign_id,
                });
            }
        }
        const inBatchProcessed = new Set<string>();

        let validCount = 0;
        let invalidCount = 0;
        let riskyCount = 0;
        let duplicateCount = 0;
        let skippedCount = 0;
        let processedCount = 0;

        // Process in chunks
        for (let i = 0; i < batchLeads.length; i += CHUNK_SIZE) {
            const chunk = batchLeads.slice(i, i + CHUNK_SIZE);

            // Re-derive remaining credits from the SINGLE ledger at every
            // chunk boundary so concurrent batches / the by-tag path can't
            // each spend the full monthly allowance (race window = one
            // chunk, not a whole batch).
            credit = await getValidationCreditState(organizationId, tier);
            let creditsUsedThisChunk = 0;

            for (const batchLead of chunk) {
                try {
                    // --- Duplicate check (F8: in-memory, no DB query) ---
                    // In-batch: any earlier non-pending/non-skipped row with
                    // the same email was already processed in this run.
                    if (inBatchProcessed.has(batchLead.email)) {
                        await prisma.validationBatchLead.update({
                            where: { id: batchLead.id },
                            data: { validation_status: 'duplicate', error_message: 'Duplicate within this upload' }
                        });
                        inBatchProcessed.add(batchLead.email);
                        duplicateCount++;
                        processedCount++;
                        continue;
                    }

                    // Cross-batch: precomputed once above.
                    const previousBatchLead = crossBatchByEmail.get(batchLead.email);
                    if (previousBatchLead) {
                        const msg = previousBatchLead.routed_to_campaign_id
                            ? `Previously uploaded and routed to campaign`
                            : `Previously uploaded (status: ${previousBatchLead.validation_status})`;
                        await prisma.validationBatchLead.update({
                            where: { id: batchLead.id },
                            data: { validation_status: 'duplicate', error_message: msg }
                        });
                        inBatchProcessed.add(batchLead.email);
                        duplicateCount++;
                        processedCount++;
                        continue;
                    }

                    // --- Credit check (F5) ---
                    // Credit-exhausted is NOT 'invalid' - the email was
                    // never checked. Mark 'skipped' so it is excluded from
                    // invalid-rate analytics AND from dedup, so it gets
                    // re-validated next month / after an upgrade instead of
                    // being permanently treated as a "duplicate".
                    if (!credit.unlimited && creditsUsedThisChunk >= credit.remaining) {
                        await prisma.validationBatchLead.update({
                            where: { id: batchLead.id },
                            data: { validation_status: 'skipped', error_message: 'Monthly validation credit limit reached. Upgrade your plan to validate the rest.' }
                        });
                        skippedCount++;
                        processedCount++;
                        continue;
                    }
                    creditsUsedThisChunk++;

                    // --- Validate email ---
                    const validationResult = await emailValidationService.validateLeadEmail(
                        organizationId,
                        batchLead.email,
                        tier
                    );

                    // --- Classify ESP ---
                    const domain = batchLead.email.split('@')[1];
                    let espBucket = 'other';
                    try {
                        espBucket = await espClassifierService.getEspBucket(organizationId, domain);
                    } catch {
                        // ESP classification is best-effort - don't fail the lead
                    }

                    // --- Derive rejection reason ---
                    let rejectionReason: string | null = null;
                    if (validationResult.status === 'invalid') {
                        if (validationResult.is_disposable) rejectionReason = 'disposable';
                        else if (validationResult.details?.syntax_ok === false) rejectionReason = 'syntax';
                        else if (validationResult.details?.mx_found === false) rejectionReason = 'no_mx';
                        else rejectionReason = 'smtp_fail';
                    } else if (validationResult.status === 'risky') {
                        if (validationResult.is_catch_all) rejectionReason = 'catch_all';
                        else rejectionReason = 'low_score';
                    }

                    // --- Update batch lead ---
                    // Persist validation_source here so routeLeads + push-
                    // to-contacts attribute the result truthfully later
                    // ('internal' vs 'millionverifier') instead of
                    // fabricating 'internal' at routing time (F3 root).
                    await prisma.validationBatchLead.update({
                        where: { id: batchLead.id },
                        data: {
                            validation_status: validationResult.status,
                            validation_score: validationResult.score,
                            validation_source: validationResult.source,
                            rejection_reason: rejectionReason,
                            is_disposable: validationResult.is_disposable ?? null,
                            is_catch_all: validationResult.is_catch_all ?? null,
                            esp_bucket: espBucket,
                        }
                    });

                    // Credit ledger is written ONCE inside
                    // validateLeadEmail (single source - F2). The old
                    // per-batch ValidationAttempt create here was the
                    // double-write that, combined with the separate
                    // ValidationBatchLead counter, made credit accounting
                    // incoherent. Removed.

                    // Track counts
                    if (validationResult.status === 'valid') validCount++;
                    else if (validationResult.status === 'invalid') invalidCount++;
                    else if (validationResult.status === 'risky') riskyCount++;
                    inBatchProcessed.add(batchLead.email);

                } catch (err: any) {
                    logger.error(`[${logTag}] Failed to validate lead ${batchLead.email}`, err);
                    await prisma.validationBatchLead.update({
                        where: { id: batchLead.id },
                        data: {
                            validation_status: 'invalid',
                            error_message: err.message || 'Validation failed',
                        }
                    });
                    inBatchProcessed.add(batchLead.email);
                    invalidCount++;
                }

                processedCount++;
            }

            // Update batch counts after each chunk
            await prisma.validationBatch.update({
                where: { id: batchId },
                data: { valid_count: validCount, invalid_count: invalidCount, risky_count: riskyCount, duplicate_count: duplicateCount }
            });

        }

        // Mark batch as completed
        await prisma.validationBatch.update({
            where: { id: batchId },
            data: {
                status: 'completed',
                completed_at: new Date(),
                valid_count: validCount,
                invalid_count: invalidCount,
                risky_count: riskyCount,
                duplicate_count: duplicateCount,
            }
        });

        logger.info(`[${logTag}] Batch completed`, {
            batchId, validCount, invalidCount, riskyCount, duplicateCount
        });

    } catch (err: any) {
        logger.error('[VALIDATION_BATCH] Batch processing failed', err, { batchId });
        await prisma.validationBatch.update({
            where: { id: batchId },
            data: { status: 'failed' }
        });
    }
}

// ============================================================================
// QUERY
// ============================================================================

/**
 * Get batch results with pagination and filtering.
 */
export async function getBatchResults(
    organizationId: string,
    batchId: string,
    options: {
        page?: number;
        limit?: number;
        statusFilter?: string;
        espFilter?: string;
        search?: string;
    } = {}
) {
    const { page = 1, limit = 20, statusFilter, espFilter, search } = options;

    // Verify batch belongs to org
    const batch = await prisma.validationBatch.findFirst({
        where: { id: batchId, organization_id: organizationId }
    });
    if (!batch) throw new Error('Batch not found');

    const where: any = { batch_id: batchId };
    if (statusFilter && statusFilter !== 'all') where.validation_status = statusFilter;
    if (espFilter && espFilter !== 'all') where.esp_bucket = espFilter;
    if (search) where.email = { contains: search, mode: 'insensitive' };

    const [leads, total] = await Promise.all([
        prisma.validationBatchLead.findMany({
            where,
            orderBy: { created_at: 'asc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.validationBatchLead.count({ where }),
    ]);

    return {
        batch,
        data: leads,
        meta: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        }
    };
}

/**
 * List past batches for an organization.
 */
export async function listBatches(
    organizationId: string,
    options: { page?: number; limit?: number; from?: Date | null; to?: Date | null } = {}
) {
    const { page = 1, limit = 20, from, to } = options;

    const where: any = { organization_id: organizationId };
    if (from || to) {
        where.created_at = {};
        if (from) where.created_at.gte = from;
        if (to) where.created_at.lte = to;
    }

    const [batches, total] = await Promise.all([
        prisma.validationBatch.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.validationBatch.count({ where }),
    ]);

    return {
        data: batches,
        meta: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        }
    };
}

// ============================================================================
// ROUTING
// ============================================================================

/**
 * Route selected validated leads to a campaign. Does NOT re-validate.
 * Upserts into Lead table, assigns to campaign, pushes to sending platform.
 */
export async function routeLeads(
    organizationId: string,
    batchId: string,
    leadIds: string[],
    campaignId: string
): Promise<{ routed: number; failed: number; errors: string[] }> {
    const logTag = 'VALIDATION_BATCH_ROUTE';

    // Verify batch + campaign
    const [batch, campaign] = await Promise.all([
        prisma.validationBatch.findFirst({ where: { id: batchId, organization_id: organizationId } }),
        prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true } }),
    ]);
    if (!batch) throw new Error('Batch not found');
    if (!campaign) throw new Error('Campaign not found');

    const batchLeads = await prisma.validationBatchLead.findMany({
        where: {
            id: { in: leadIds },
            batch_id: batchId,
            // F6: 'unknown' is now routable along with valid/risky -
            // per the ratified policy only 'invalid' blocks. The
            // enroll-guard refuses 'invalid' too, so an invalid that
            // somehow slipped past this filter is still safely rejected
            // downstream.
            validation_status: { in: ['valid', 'risky', 'unknown'] },
            routed_to_campaign_id: null, // not already routed
        }
    });

    let routed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const batchLead of batchLeads) {
        try {
            // Real health classification (F4 root). The old code hardcoded
            // health_classification='green' + health_score_calc=80 here,
            // bypassing the validation->health gate that ingestion
            // applies. classifyLeadHealth seeded with the batch lead's
            // actual validation context now produces the same shape on
            // both entry paths.
            const healthResult = await classifyLeadHealth(batchLead.email, {
                validationScore: batchLead.validation_score ?? 50,
                isDisposable: batchLead.is_disposable ?? false,
                isCatchAll: batchLead.is_catch_all ?? false,
            });

            // Truthful source attribution (F3 root). processBatch persisted
            // validation_source on the batch row at engine time; carry it
            // through unchanged instead of fabricating 'internal' here.
            // Legacy batch rows (pre-migration) fall back to 'internal'.
            const persist = validationPersistData({
                status: batchLead.validation_status,
                score: batchLead.validation_score ?? 0,
                source: batchLead.validation_source || 'internal',
                is_catch_all: batchLead.is_catch_all,
                is_disposable: batchLead.is_disposable,
            });

            // Upsert into Lead table with validation results already computed
            const lead = await prisma.lead.upsert({
                where: {
                    organization_id_email: {
                        organization_id: organizationId,
                        email: batchLead.email,
                    }
                },
                update: {
                    persona: batchLead.persona || 'General',
                    lead_score: batchLead.lead_score ?? 50,
                    source: batch.source,
                    assigned_campaign_id: campaignId,
                    ...persist,
                },
                create: {
                    email: batchLead.email,
                    persona: batchLead.persona || 'General',
                    lead_score: batchLead.lead_score ?? 50,
                    source: batch.source,
                    status: 'held',
                    health_state: 'healthy',
                    health_classification: healthResult.classification,
                    health_score_calc: healthResult.score,
                    health_checks: healthResult.checks as any,
                    assigned_campaign_id: campaignId,
                    organization_id: organizationId,
                    ...persist,
                }
            });

            // Native sequencer enrollment - creates a CampaignLead row idempotently.
            // ESP-aware routing happens at dispatch time inside sendQueueService,
            // which scores connected mailboxes by 30-day per-ESP performance.
            const enroll = await enrollLeadInSequencerCampaign(organizationId, campaignId, {
                email: batchLead.email,
                first_name: batchLead.first_name || undefined,
                last_name: batchLead.last_name || undefined,
                company: batchLead.company || undefined,
                validation_status: batchLead.validation_status,
                validation_score: batchLead.validation_score,
            });

            if (enroll.success) {
                await entityStateService.transitionLead(
                    organizationId,
                    lead.id,
                    LeadState.ACTIVE,
                    `Enrolled in sequencer campaign ${campaignId} via validation batch ${batchId}`,
                    TriggerType.SYSTEM
                );

                // Update batch lead as routed
                await prisma.validationBatchLead.update({
                    where: { id: batchLead.id },
                    data: { routed_to_campaign_id: campaignId, routed_at: new Date() }
                });

                routed++;
            } else {
                // Roll back assignment
                await prisma.lead.update({
                    where: { id: lead.id },
                    data: { assigned_campaign_id: null }
                });
                errors.push(`${batchLead.email}: ${enroll.error || 'enrollment failed'}`);
                failed++;
            }
        } catch (err: any) {
            logger.error(`[${logTag}] Failed to route lead ${batchLead.email}`, err);
            errors.push(`${batchLead.email}: ${err.message}`);
            failed++;
        }
    }

    // Update batch routed count
    const totalRouted = await prisma.validationBatchLead.count({
        where: { batch_id: batchId, routed_to_campaign_id: { not: null } }
    });
    await prisma.validationBatch.update({
        where: { id: batchId },
        data: { routed_count: totalRouted }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'validation_batch',
        entityId: batchId,
        trigger: 'user',
        action: 'route_leads',
        details: `Routed ${routed} leads to campaign ${campaignId} (${failed} failed)`,
    });

    return { routed, failed, errors };
}

// ============================================================================
// PUSH TO CONTACTS (Process B - operator-requested)
// ============================================================================

/**
 * "Push validated contacts to the Contacts page." Selected batch leads
 * become Lead rows (org-scoped) WITHOUT being enrolled in any campaign -
 * this is the "I just want them on the contacts list" action, distinct
 * from routeLeads which requires a campaignId.
 *
 * Auto-excludes invalids: only leads in {valid, risky, unknown} can be
 * pushed (mirrors the routeLeads filter under the same D1 policy "only
 * invalid blocks"). Idempotent via pushed_to_contacts_at.
 */
export async function pushLeadsToContacts(
    organizationId: string,
    batchId: string,
    leadIds: string[],
): Promise<{ added: number; skipped: number; errors: string[] }> {
    const batch = await prisma.validationBatch.findFirst({
        where: { id: batchId, organization_id: organizationId },
    });
    if (!batch) throw new Error('Batch not found');

    const batchLeads = await prisma.validationBatchLead.findMany({
        where: {
            id: { in: leadIds },
            batch_id: batchId,
            validation_status: { in: ['valid', 'risky', 'unknown'] },
            pushed_to_contacts_at: null,
        },
    });

    let added = 0;
    const skipped = leadIds.length - batchLeads.length; // invalid / already-pushed / not-in-batch
    const errors: string[] = [];

    for (const batchLead of batchLeads) {
        try {
            // Real health (same shape ingestion uses).
            const healthResult = await classifyLeadHealth(batchLead.email, {
                validationScore: batchLead.validation_score ?? 50,
                isDisposable: batchLead.is_disposable ?? false,
                isCatchAll: batchLead.is_catch_all ?? false,
            });
            // Truthful source attribution from the engine-time write.
            const persist = validationPersistData({
                status: batchLead.validation_status,
                score: batchLead.validation_score ?? 0,
                source: batchLead.validation_source || 'internal',
                is_catch_all: batchLead.is_catch_all,
                is_disposable: batchLead.is_disposable,
            });
            await prisma.lead.upsert({
                where: {
                    organization_id_email: { organization_id: organizationId, email: batchLead.email },
                },
                update: {
                    persona: batchLead.persona || 'General',
                    lead_score: batchLead.lead_score ?? 50,
                    source: batch.source,
                    ...persist,
                },
                create: {
                    email: batchLead.email,
                    persona: batchLead.persona || 'General',
                    lead_score: batchLead.lead_score ?? 50,
                    source: batch.source,
                    status: 'held',
                    health_state: 'healthy',
                    health_classification: healthResult.classification,
                    health_score_calc: healthResult.score,
                    health_checks: healthResult.checks as any,
                    organization_id: organizationId,
                    ...persist,
                },
            });
            await prisma.validationBatchLead.update({
                where: { id: batchLead.id },
                data: { pushed_to_contacts_at: new Date() },
            });
            added++;
        } catch (err: any) {
            logger.error('[VALIDATION_BATCH_PUSH] Failed to push lead to contacts', err, { batchLeadId: batchLead.id });
            errors.push(`${batchLead.email}: ${err.message || 'push failed'}`);
        }
    }

    await auditLogService.logAction({
        organizationId,
        entity: 'validation_batch',
        entityId: batchId,
        trigger: 'user',
        action: 'push_to_contacts',
        details: `Pushed ${added} leads to Contacts page (${skipped} skipped, ${errors.length} errors)`,
    });

    return { added, skipped, errors };
}

// ============================================================================
// EXPORT
// ============================================================================

/**
 * Generate a CSV string of batch leads for download.
 */
export async function exportCleanCSV(
    organizationId: string,
    batchId: string,
    statusFilter?: string[]
): Promise<string> {
    const batch = await prisma.validationBatch.findFirst({
        where: { id: batchId, organization_id: organizationId }
    });
    if (!batch) throw new Error('Batch not found');

    const where: any = { batch_id: batchId };
    if (statusFilter?.length) where.validation_status = { in: statusFilter };

    const leads = await prisma.validationBatchLead.findMany({
        where,
        orderBy: { created_at: 'asc' },
    });

    const headers = ['email', 'first_name', 'last_name', 'company', 'persona', 'lead_score', 'validation_status', 'validation_score', 'esp_bucket'];
    // Neutralize spreadsheet formula injection (CWE-1236, F7). Lead
    // names / company / etc. are attacker-influenced via upload; a value
    // starting with = + - @ (or TAB/CR) runs as a formula when the CSV
    // is opened in Excel / Sheets. Prefix a single quote to force text.
    // Same chokepoint pattern as the cold-call CSV fix.
    const neutralizeFormula = (s: string): string =>
        /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    const escapeCSV = (val: string | number | null | undefined): string => {
        const str = neutralizeFormula(String(val ?? ''));
        return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"`
            : str;
    };

    const rows = leads.map(l => [
        l.email, l.first_name, l.last_name, l.company, l.persona,
        l.lead_score, l.validation_status, l.validation_score, l.esp_bucket
    ].map(escapeCSV).join(','));

    return [headers.join(','), ...rows].join('\n');
}

// ============================================================================
// ANALYTICS
// ============================================================================

/**
 * Return aggregated validation analytics for an organization.
 */
export async function getAnalytics(
    organizationId: string,
    options: { from?: Date | null; to?: Date | null } = {}
) {
    const { from, to } = options;

    // Shared filter for all aggregations - batch org + status not pending + optional date range
    const baseWhere: any = {
        batch: { organization_id: organizationId },
        validation_status: { not: 'pending' },
    };
    if (from || to) {
        baseWhere.created_at = {};
        if (from) baseWhere.created_at.gte = from;
        if (to) baseWhere.created_at.lte = to;
    }

    // Total validated across all batches
    const totalValidated = await prisma.validationBatchLead.count({ where: baseWhere });

    // Counts by status
    const statusCounts = await prisma.validationBatchLead.groupBy({
        by: ['validation_status'],
        where: baseWhere,
        _count: true,
    });

    // Invalid rate by source - raw SQL with optional date range.
    // Newer Prisma client versions reject Date objects in tagged-template form
    // ("Expected Flat JSON array, got JSON date object"), so we use
    // $queryRawUnsafe with a positional param array and ::timestamptz casts.
    // Build the date predicates conditionally so we never have to invent
    // sentinel dates - passing the JS max date (8640000000000000) overflows
    // Postgres's timezone range and fails with code 22009.
    const params: any[] = [organizationId];
    let dateClause = '';
    if (from) {
        params.push(from.toISOString());
        dateClause += ` AND vbl.created_at >= $${params.length}::timestamptz`;
    }
    if (to) {
        params.push(to.toISOString());
        dateClause += ` AND vbl.created_at <= $${params.length}::timestamptz`;
    }
    const sourceCounts = await prisma.$queryRawUnsafe<Array<{ source: string; total: bigint; invalid: bigint }>>(
        `SELECT vb.source,
                COUNT(*)::bigint as total,
                COUNT(*) FILTER (WHERE vbl.validation_status = 'invalid')::bigint as invalid
         FROM "ValidationBatchLead" vbl
         JOIN "ValidationBatch" vb ON vb.id = vbl.batch_id
         WHERE vb.organization_id = $1
           AND vbl.validation_status NOT IN ('pending', 'skipped')
           ${dateClause}
         GROUP BY vb.source`,
        ...params,
    );

    // Rejection reasons breakdown
    const rejectionWhere: any = {
        batch: { organization_id: organizationId },
        rejection_reason: { not: null },
    };
    if (from || to) {
        rejectionWhere.created_at = {};
        if (from) rejectionWhere.created_at.gte = from;
        if (to) rejectionWhere.created_at.lte = to;
    }
    const rejectionCounts = await prisma.validationBatchLead.groupBy({
        by: ['rejection_reason'],
        where: rejectionWhere,
        _count: true,
    });

    // ESP distribution
    const espWhere: any = {
        batch: { organization_id: organizationId },
        esp_bucket: { not: null },
    };
    if (from || to) {
        espWhere.created_at = {};
        if (from) espWhere.created_at.gte = from;
        if (to) espWhere.created_at.lte = to;
    }
    const espCounts = await prisma.validationBatchLead.groupBy({
        by: ['esp_bucket'],
        where: espWhere,
        _count: true,
    });

    // Per-day trend within the selected range (defaults to last 30 days if nothing specified)
    const trendFrom = from || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
    const trendTo = to || new Date();

    const trendData = await prisma.$queryRaw<Array<{ date: string; status: string; count: bigint }>>`
        SELECT DATE(vbl.created_at)::text as date,
               vbl.validation_status as status,
               COUNT(*)::bigint as count
        FROM "ValidationBatchLead" vbl
        JOIN "ValidationBatch" vb ON vb.id = vbl.batch_id
        WHERE vb.organization_id = ${organizationId}
          AND vbl.created_at >= ${trendFrom}
          AND vbl.created_at <= ${trendTo}
          AND vbl.validation_status != 'pending'
        GROUP BY DATE(vbl.created_at), vbl.validation_status
        ORDER BY date
    `;

    return {
        totalValidated,
        statusBreakdown: statusCounts.reduce((acc, s) => {
            acc[s.validation_status] = s._count;
            return acc;
        }, {} as Record<string, number>),
        invalidRateBySource: sourceCounts.map(s => ({
            source: s.source,
            total: Number(s.total),
            invalid: Number(s.invalid),
            rate: Number(s.total) > 0 ? Number(s.invalid) / Number(s.total) : 0,
        })),
        rejectionReasons: rejectionCounts
            .filter(r => r.rejection_reason)
            .map(r => ({ reason: r.rejection_reason!, count: r._count }))
            .sort((a, b) => b.count - a.count),
        espDistribution: espCounts.reduce((acc, e) => {
            if (e.esp_bucket) acc[e.esp_bucket] = e._count;
            return acc;
        }, {} as Record<string, number>),
        trend: trendData.map(t => ({
            date: t.date,
            status: t.status,
            count: Number(t.count),
        })),
    };
}
