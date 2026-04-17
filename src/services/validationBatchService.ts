/**
 * Validation Batch Service
 *
 * Core orchestrator for bulk email validation + ESP classification.
 * Manages the batch lifecycle: create → process → route → export → analytics.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { syncProgressService } from './syncProgressService';
import * as emailValidationService from './emailValidationService';
import * as espClassifierService from './espClassifierService';
import * as entityStateService from './entityStateService';
import * as auditLogService from './auditLogService';
import { getAdapterForCampaign } from '../adapters/platformRegistry';
import { scoreMailboxesForEsp } from './espMailboxScoringService';
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
        // Get the org subscription tier for MillionVerifier gating
        const org = await prisma.organization.findUnique({
            where: { id: organizationId },
            select: { subscription_tier: true }
        });
        const tier = org?.subscription_tier || 'trial';

        // Fetch all pending leads for this batch
        const batchLeads = await prisma.validationBatchLead.findMany({
            where: { batch_id: batchId, validation_status: 'pending' },
            orderBy: { created_at: 'asc' },
        });

        let validCount = 0;
        let invalidCount = 0;
        let riskyCount = 0;
        let duplicateCount = 0;
        let processedCount = 0;

        // Process in chunks
        for (let i = 0; i < batchLeads.length; i += CHUNK_SIZE) {
            const chunk = batchLeads.slice(i, i + CHUNK_SIZE);

            for (const batchLead of chunk) {
                try {
                    // --- Duplicate check ---
                    const existingLead = await prisma.lead.findUnique({
                        where: {
                            organization_id_email: {
                                organization_id: organizationId,
                                email: batchLead.email,
                            }
                        },
                        select: { id: true, assigned_campaign_id: true, status: true }
                    });

                    // Check for duplicates within same batch (earlier row)
                    const batchDuplicate = await prisma.validationBatchLead.findFirst({
                        where: {
                            batch_id: batchId,
                            email: batchLead.email,
                            id: { not: batchLead.id },
                            validation_status: { not: 'pending' },
                        }
                    });

                    if (batchDuplicate) {
                        await prisma.validationBatchLead.update({
                            where: { id: batchLead.id },
                            data: { validation_status: 'duplicate', error_message: 'Duplicate within this upload' }
                        });
                        duplicateCount++;
                        processedCount++;
                        continue;
                    }

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
                        // ESP classification is best-effort — don't fail the lead
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
                    await prisma.validationBatchLead.update({
                        where: { id: batchLead.id },
                        data: {
                            validation_status: validationResult.status,
                            validation_score: validationResult.score,
                            rejection_reason: rejectionReason,
                            is_disposable: validationResult.is_disposable ?? null,
                            is_catch_all: validationResult.is_catch_all ?? null,
                            esp_bucket: espBucket,
                        }
                    });

                    // --- Record validation attempt (for billing credit tracking) ---
                    if (existingLead && validationResult.attempt) {
                        try {
                            await prisma.validationAttempt.create({
                                data: {
                                    lead_id: existingLead.id,
                                    organization_id: organizationId,
                                    source: validationResult.attempt.source,
                                    result_status: validationResult.attempt.result_status,
                                    result_score: validationResult.attempt.result_score,
                                    result_details: validationResult.attempt.result_details,
                                    duration_ms: validationResult.attempt.duration_ms,
                                },
                            });
                        } catch { /* best-effort */ }
                    }

                    // Track counts
                    if (validationResult.status === 'valid') validCount++;
                    else if (validationResult.status === 'invalid') invalidCount++;
                    else if (validationResult.status === 'risky') riskyCount++;

                } catch (err: any) {
                    logger.error(`[${logTag}] Failed to validate lead ${batchLead.email}`, err);
                    await prisma.validationBatchLead.update({
                        where: { id: batchLead.id },
                        data: {
                            validation_status: 'invalid',
                            error_message: err.message || 'Validation failed',
                        }
                    });
                    invalidCount++;
                }

                processedCount++;
            }

            // Update batch counts after each chunk
            await prisma.validationBatch.update({
                where: { id: batchId },
                data: { valid_count: validCount, invalid_count: invalidCount, risky_count: riskyCount, duplicate_count: duplicateCount }
            });

            // Emit SSE progress
            syncProgressService.emitProgress(batchId, 'validation' as any, 'in_progress', {
                current: processedCount,
                total: batchLeads.length,
                validCount,
                invalidCount,
                riskyCount,
                duplicateCount,
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

        syncProgressService.emitProgress(batchId, 'validation' as any, 'completed', {
            validCount, invalidCount, riskyCount, duplicateCount
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
        syncProgressService.emitProgress(batchId, 'validation' as any, 'failed', {
            error: err.message
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
    options: { page?: number; limit?: number } = {}
) {
    const { page = 1, limit = 20 } = options;

    const [batches, total] = await Promise.all([
        prisma.validationBatch.findMany({
            where: { organization_id: organizationId },
            orderBy: { created_at: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.validationBatch.count({ where: { organization_id: organizationId } }),
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
        prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, external_id: true, source_platform: true } }),
    ]);
    if (!batch) throw new Error('Batch not found');
    if (!campaign) throw new Error('Campaign not found');

    const batchLeads = await prisma.validationBatchLead.findMany({
        where: {
            id: { in: leadIds },
            batch_id: batchId,
            validation_status: { in: ['valid', 'risky'] },
            routed_to_campaign_id: null, // not already routed
        }
    });

    let routed = 0;
    let failed = 0;
    const errors: string[] = [];

    const adapter = await getAdapterForCampaign(campaignId);
    const externalCampaignId = campaign.external_id || campaignId;

    for (const batchLead of batchLeads) {
        try {
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
                    validation_status: batchLead.validation_status,
                    validation_score: batchLead.validation_score,
                    validation_source: 'internal',
                    validated_at: new Date(),
                    assigned_campaign_id: campaignId,
                },
                create: {
                    email: batchLead.email,
                    persona: batchLead.persona || 'General',
                    lead_score: batchLead.lead_score ?? 50,
                    source: batch.source,
                    status: 'held',
                    health_state: 'healthy',
                    health_classification: 'green',
                    health_score_calc: 80,
                    health_checks: {},
                    validation_status: batchLead.validation_status,
                    validation_score: batchLead.validation_score,
                    validation_source: 'internal',
                    validated_at: new Date(),
                    assigned_campaign_id: campaignId,
                    organization_id: organizationId,
                }
            });

            // ESP-aware mailbox scoring: pick the best mailboxes for this recipient's ESP
            let assignedMailboxIds: string[] | undefined;
            if (batchLead.esp_bucket && adapter.platform === 'smartlead') {
                const topMailboxes = await scoreMailboxesForEsp(organizationId, campaignId, batchLead.esp_bucket);
                if (topMailboxes) assignedMailboxIds = topMailboxes;
            }

            // Push to sending platform
            const pushResult = await adapter.pushLeadToCampaign(
                organizationId,
                externalCampaignId,
                {
                    email: batchLead.email,
                    first_name: batchLead.first_name || undefined,
                    last_name: batchLead.last_name || undefined,
                    company: batchLead.company || undefined,
                },
                // Pass ESP-pinned mailboxes if available (Smartlead adapter supports this)
                assignedMailboxIds ? { assignedEmailAccounts: assignedMailboxIds } : undefined
            );

            if (pushResult?.success) {
                await entityStateService.transitionLead(
                    organizationId,
                    lead.id,
                    LeadState.ACTIVE,
                    `Pushed to ${adapter.platform} campaign ${campaignId} via validation batch ${batchId}`,
                    TriggerType.SYSTEM
                );
                await prisma.lead.update({
                    where: { id: lead.id },
                    data: { source_platform: adapter.platform },
                });

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
                errors.push(`${batchLead.email}: push failed`);
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
    const escapeCSV = (val: string | number | null | undefined): string => {
        const str = String(val ?? '');
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
export async function getAnalytics(organizationId: string) {
    // Total validated across all batches
    const totalValidated = await prisma.validationBatchLead.count({
        where: { batch: { organization_id: organizationId }, validation_status: { not: 'pending' } }
    });

    // Counts by status
    const statusCounts = await prisma.validationBatchLead.groupBy({
        by: ['validation_status'],
        where: { batch: { organization_id: organizationId }, validation_status: { not: 'pending' } },
        _count: true,
    });

    // Invalid rate by source
    const sourceCounts = await prisma.$queryRaw<Array<{ source: string; total: bigint; invalid: bigint }>>`
        SELECT vb.source,
               COUNT(*)::bigint as total,
               COUNT(*) FILTER (WHERE vbl.validation_status = 'invalid')::bigint as invalid
        FROM "ValidationBatchLead" vbl
        JOIN "ValidationBatch" vb ON vb.id = vbl.batch_id
        WHERE vb.organization_id = ${organizationId}
          AND vbl.validation_status != 'pending'
        GROUP BY vb.source
    `;

    // Rejection reasons breakdown
    const rejectionCounts = await prisma.validationBatchLead.groupBy({
        by: ['rejection_reason'],
        where: { batch: { organization_id: organizationId }, rejection_reason: { not: null } },
        _count: true,
    });

    // ESP distribution
    const espCounts = await prisma.validationBatchLead.groupBy({
        by: ['esp_bucket'],
        where: { batch: { organization_id: organizationId }, esp_bucket: { not: null } },
        _count: true,
    });

    // 30-day trend
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trendData = await prisma.$queryRaw<Array<{ date: string; status: string; count: bigint }>>`
        SELECT DATE(vbl.created_at)::text as date,
               vbl.validation_status as status,
               COUNT(*)::bigint as count
        FROM "ValidationBatchLead" vbl
        JOIN "ValidationBatch" vb ON vb.id = vbl.batch_id
        WHERE vb.organization_id = ${organizationId}
          AND vbl.created_at >= ${thirtyDaysAgo}
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
