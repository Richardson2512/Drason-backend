/**
 * Contact Controller
 *
 * List, create, delete, and export contacts — unified view over:
 *  - Standalone Leads (main Lead table, from manual add / Clay / API ingestion)
 *  - CampaignLeads (leads assigned to specific SendCampaigns)
 *
 * Contacts in the main Lead table that haven't been assigned to any campaign
 * appear with campaign_count = 0. They're available to add to campaigns via
 * the campaign creation wizard's "From Lead Database" tab.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { classifyLeadHealth } from '../services/leadHealthService';
import { validateLeadEmail } from '../services/emailValidationService';
import * as espClassifierService from '../services/espClassifierService';
import { TIER_LIMITS } from '../services/polarClient';
import * as entityStateService from '../services/entityStateService';
import * as dualEnrollmentService from '../services/dualEnrollmentService';
import { SlackAlertService } from '../services/SlackAlertService';
import { LeadState, TriggerType } from '../types';
import { eraseLeadPII } from '../services/piiErasureService';

/**
 * Parse a comma-separated query-string value into a deduped, trimmed array.
 * Returns [] for missing / empty inputs so callers can do `if (arr.length > 0)`.
 */
function parseCsv(raw: string | undefined): string[] {
    if (!raw || typeof raw !== 'string') return [];
    const seen = new Set<string>();
    for (const part of raw.split(',')) {
        const trimmed = part.trim();
        if (trimmed) seen.add(trimmed);
    }
    return Array.from(seen);
}

/**
 * GET /api/sequencer/contacts/facets
 * Returns the distinct companies and titles in the org's contact pool, with
 * counts. Powers the multi-select filters in the contacts page so users see
 * actual values rather than typing free text. Capped per facet to keep the
 * payload sane on large orgs — top FACET_LIMIT by frequency, then alpha.
 */
const FACET_LIMIT = 200;

export const getContactFacets = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        const [companyGroups, titleGroups] = await Promise.all([
            prisma.lead.groupBy({
                by: ['company'],
                where: { organization_id: orgId, company: { not: null } },
                _count: { _all: true },
                orderBy: { _count: { company: 'desc' } },
                take: FACET_LIMIT,
            }),
            prisma.lead.groupBy({
                by: ['title'],
                where: { organization_id: orgId, title: { not: null } },
                _count: { _all: true },
                orderBy: { _count: { title: 'desc' } },
                take: FACET_LIMIT,
            }),
        ]);

        const companies = companyGroups
            .filter(g => g.company && g.company.trim().length > 0)
            .map(g => ({ value: g.company as string, count: g._count._all }));
        const titles = titleGroups
            .filter(g => g.title && g.title.trim().length > 0)
            .map(g => ({ value: g.title as string, count: g._count._all }));

        return res.json({
            success: true,
            data: { companies, titles, limit: FACET_LIMIT },
        });
    } catch (error) {
        logger.error('[CONTACTS] facets failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to load filter options' });
    }
};

/**
 * GET /api/sequencer/contacts
 * List CampaignLeads across all campaigns for the org.
 * Aggregates by email (same person in multiple campaigns). Supports search + pagination.
 */
export const listContacts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 50;
        const search = (req.query.search as string) || undefined;
        const status = (req.query.status as string) || undefined;
        const validation_status = (req.query.validation_status as string) || undefined;
        // Comma-separated value lists for the multi-select filters in the UI.
        // Empty / missing means "no filter on that field."
        const companies = parseCsv(req.query.companies as string | undefined);
        const titles = parseCsv(req.query.titles as string | undefined);

        // Query the main Lead table — source of truth for all contacts.
        // Campaign assignments are counted separately.
        const leadWhere: any = { organization_id: orgId };
        if (status) leadWhere.status = status;
        if (validation_status) leadWhere.validation_status = validation_status;
        if (companies.length > 0) leadWhere.company = { in: companies };
        if (titles.length > 0) leadWhere.title = { in: titles };
        if (search) {
            leadWhere.OR = [
                { email: { contains: search, mode: 'insensitive' } },
                { first_name: { contains: search, mode: 'insensitive' } },
                { last_name: { contains: search, mode: 'insensitive' } },
                { full_name: { contains: search, mode: 'insensitive' } },
                { company: { contains: search, mode: 'insensitive' } },
                { persona: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [leads, total] = await Promise.all([
            prisma.lead.findMany({
                where: leadWhere,
                orderBy: { created_at: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.lead.count({ where: leadWhere }),
        ]);

        // Count how many sequencer campaigns each lead is assigned to (via CampaignLead.email match).
        // Post-merge Campaign table holds both legacy and sequencer campaigns — filter to sequencer.
        const emails = leads.map((l) => l.email);
        const orgCampaigns = await prisma.campaign.findMany({
            where: { organization_id: orgId },
            select: { id: true },
        });
        const campaignIds = orgCampaigns.map((c) => c.id);

        let assignmentCounts: Map<string, number> = new Map();
        if (campaignIds.length > 0 && emails.length > 0) {
            const assignments = await prisma.campaignLead.groupBy({
                by: ['email'],
                where: { campaign_id: { in: campaignIds }, email: { in: emails } },
                _count: true,
            });
            assignmentCounts = new Map(assignments.map((a) => [a.email, a._count]));
        }

        const data = leads.map((lead) => ({
            id: lead.id,
            email: lead.email,
            first_name: lead.first_name,
            last_name: lead.last_name,
            full_name: lead.full_name,
            company: lead.company,
            website: lead.website,
            title: lead.title,
            persona: lead.persona,
            source: lead.source,
            status: lead.status,
            esp_bucket: null,
            validation_status: lead.validation_status,
            validation_score: lead.validation_score,
            lead_score: lead.lead_score,
            campaign_count: assignmentCounts.get(lead.email) || 0,
            current_step: null,
            created_at: lead.created_at,
        }));

        // Return under 'contacts' key (not 'data') so apiClient doesn't auto-unwrap
        // the array and lose the meta field.
        return res.json({
            success: true,
            contacts: data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: any) {
        logger.error('[CONTACTS] Failed to list contacts', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list contacts' });
    }
};

/**
 * POST /api/sequencer/contacts
 * Create an individual contact in the main Lead table.
 * The contact becomes available in the campaign creation wizard's "From Lead Database" tab.
 * Runs through the lead health gate — RED leads (disposable, role, etc.) are rejected.
 */
export const createContact = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { email, first_name, last_name, full_name, company, website, title, persona, source } = req.body;

        if (!email || typeof email !== 'string' || !email.includes('@')) {
            return res.status(400).json({ success: false, error: 'Valid email address is required' });
        }

        const emailLower = email.toLowerCase().trim();

        // Check for existing lead with same email
        const existing = await prisma.lead.findFirst({
            where: { organization_id: orgId, email: emailLower },
        });
        if (existing) {
            return res.status(409).json({ success: false, error: 'A contact with this email already exists' });
        }

        // Health gate — block RED leads at creation time
        const health = await classifyLeadHealth(emailLower).catch(() => ({
            classification: 'yellow' as const,
            reasons: ['Health check failed'],
        }));

        if (health.classification === 'red') {
            return res.status(400).json({
                success: false,
                error: `Contact rejected by health gate: ${(health as any).reasons?.join(', ') || 'low score'}`,
            });
        }

        // Auto-compute full_name if not provided
        const fullName = full_name?.trim() ||
            [first_name?.trim(), last_name?.trim()].filter(Boolean).join(' ') ||
            null;

        // Persona is a required routing bucket — derive from title if not explicitly provided.
        // This keeps the UX simple (one field instead of two) while preserving routing functionality.
        const finalPersona = persona?.trim()
            || title?.trim().toLowerCase()
            || 'general';

        const lead = await prisma.lead.create({
            data: {
                organization_id: orgId,
                email: emailLower,
                first_name: first_name?.trim() || null,
                last_name: last_name?.trim() || null,
                full_name: fullName,
                company: company?.trim() || null,
                website: website?.trim() || null,
                title: title?.trim() || null,
                persona: finalPersona,
                source: source?.trim() || 'manual',
                status: 'held',
                lead_score: (health as any).score ?? 50,
                health_classification: health.classification,
            },
        });

        logger.info(`[CONTACTS] Contact created: ${emailLower}`, { orgId, leadId: lead.id });

        return res.status(201).json({
            success: true,
            data: {
                id: lead.id,
                email: lead.email,
                first_name: lead.first_name,
                last_name: lead.last_name,
                full_name: lead.full_name,
                company: lead.company,
                website: lead.website,
                title: lead.title,
                persona: lead.persona,
                source: lead.source,
                status: lead.status,
                lead_score: lead.lead_score,
                health_classification: lead.health_classification,
                campaign_count: 0,
                created_at: lead.created_at,
            },
        });
    } catch (error: any) {
        logger.error('[CONTACTS] Failed to create contact', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create contact' });
    }
};

/**
 * POST /api/sequencer/contacts/bulk
 * Bulk-import contacts from a CSV. Each row runs through the same health gate
 * as single-add — RED leads are rejected, duplicates are skipped, valid ones
 * are upserted into the Lead table.
 *
 * Body: { contacts: [{ email, first_name?, last_name?, full_name?, company?,
 *                      website?, title?, persona?, source? }, ...] }
 */
export const bulkCreateContacts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { contacts } = req.body;

        if (!Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ success: false, error: 'contacts array is required' });
        }
        if (contacts.length > 5000) {
            return res.status(413).json({ success: false, error: 'Max 5000 contacts per bulk import. Split into smaller files.' });
        }

        let created = 0;
        let updated = 0;
        let duplicates = 0;
        let rejected = 0;
        const rejectedEmails: Array<{ email: string; reason: string }> = [];

        // Preload existing emails for the org to classify duplicates quickly
        const emailsIn = contacts
            .map((c: any) => typeof c?.email === 'string' ? c.email.toLowerCase().trim() : null)
            .filter((e: string | null): e is string => !!e && e.includes('@'));
        const uniqueEmails = Array.from(new Set(emailsIn));

        if (uniqueEmails.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No valid email addresses found. Ensure your CSV has an "email" column.',
            });
        }

        const existingLeads = await prisma.lead.findMany({
            where: { organization_id: orgId, email: { in: uniqueEmails } },
            select: { email: true },
        });
        const existingSet = new Set(existingLeads.map((l) => l.email));

        // Process each contact — run health gate, upsert Lead. Keeps the flow identical
        // to single-add so duplicates/invalid emails get the same treatment.
        for (const c of contacts as any[]) {
            const rawEmail = typeof c?.email === 'string' ? c.email.trim().toLowerCase() : '';
            if (!rawEmail || !rawEmail.includes('@')) {
                rejected++;
                continue;
            }

            try {
                const health = await classifyLeadHealth(rawEmail).catch(() => ({
                    classification: 'yellow' as const,
                    reasons: ['Health check failed'],
                }));

                if (health.classification === 'red') {
                    rejected++;
                    rejectedEmails.push({
                        email: rawEmail,
                        reason: (health as any).reasons?.join(', ') || 'health gate',
                    });
                    continue;
                }

                const fullName = (c.full_name && String(c.full_name).trim())
                    || [c.first_name, c.last_name].filter(Boolean).map((s: any) => String(s).trim()).filter(Boolean).join(' ')
                    || null;
                const finalPersona = (c.persona && String(c.persona).trim())
                    || (c.title && String(c.title).trim().toLowerCase())
                    || 'general';

                const data: any = {
                    organization_id: orgId,
                    email: rawEmail,
                    first_name: c.first_name ? String(c.first_name).trim() : null,
                    last_name: c.last_name ? String(c.last_name).trim() : null,
                    full_name: fullName,
                    company: c.company ? String(c.company).trim() : null,
                    website: c.website ? String(c.website).trim() : null,
                    title: c.title ? String(c.title).trim() : null,
                    persona: finalPersona,
                    source: c.source ? String(c.source).trim() : 'csv',
                    status: 'held',
                    lead_score: (health as any).score ?? 50,
                    health_classification: health.classification,
                };

                if (existingSet.has(rawEmail)) {
                    duplicates++;
                    // Update non-destructive fields only — don't override validation/campaign assignments
                    await prisma.lead.update({
                        where: { organization_id_email: { organization_id: orgId, email: rawEmail } },
                        data: {
                            first_name: data.first_name,
                            last_name: data.last_name,
                            full_name: data.full_name,
                            company: data.company,
                            website: data.website,
                            title: data.title,
                        },
                    }).catch(() => {});
                    updated++;
                } else {
                    await prisma.lead.create({ data });
                    existingSet.add(rawEmail);
                    created++;
                }
            } catch (err: any) {
                rejected++;
                rejectedEmails.push({ email: rawEmail, reason: String(err?.message || err).slice(0, 120) });
            }
        }

        logger.info('[CONTACTS] Bulk import complete', { orgId, total: contacts.length, created, updated, duplicates, rejected });

        SlackAlertService.sendAlert({
            organizationId: orgId,
            eventType: 'import.csv_completed',
            entityId: `bulk_${Date.now()}`,
            severity: 'info',
            title: '📥 CSV import completed',
            message: [
                `Imported ${contacts.length} contacts from CSV:`,
                `• *${created}* new leads`,
                `• *${updated}* updated`,
                `• *${duplicates}* duplicates`,
                rejected ? `• *${rejected}* rejected (health gate or invalid)` : null,
            ].filter(Boolean).join('\n'),
        }).catch((err) => logger.warn('[CONTACTS] Slack alert failed', { error: err?.message }));

        return res.json({
            success: true,
            total: contacts.length,
            created,
            updated,
            duplicates,
            rejected,
            rejected_samples: rejectedEmails.slice(0, 10),
        });
    } catch (error: any) {
        logger.error('[CONTACTS] Bulk import failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Bulk import failed' });
    }
};

/**
 * POST /api/sequencer/contacts/delete
 * Bulk delete contacts by IDs.
 *
 * Uses the PII erasure service so all child-table PII (CampaignLead,
 * BounceEvent.email_address, SendEvent.recipient_email, ValidationAttempt,
 * EmailMessage from/to/body) is scrubbed in place. Required for GDPR Art. 17,
 * DPDP § 12, and CCPA right-to-delete.
 */
export const deleteContacts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'ids array is required' });
        }

        // Look up emails for the IDs so we can run the erasure service per-recipient.
        const leadsToDelete = await prisma.lead.findMany({
            where: { id: { in: ids }, organization_id: orgId },
            select: { email: true },
        });

        let erasedCount = 0;
        for (const row of leadsToDelete) {
            // Skip already-erased rows (tombstone email prefix).
            if (row.email.startsWith('erased-')) continue;
            const r = await eraseLeadPII(orgId, row.email);
            if (r.leadFound) erasedCount++;
        }

        return res.json({ success: true, message: `Erased ${erasedCount} contacts (PII scrubbed across all related tables)` });
    } catch (error: any) {
        logger.error('[CONTACTS] Failed to erase contacts', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to erase contacts' });
    }
};

/**
 * POST /api/sequencer/contacts/validate
 * Verify email addresses for a set of leads. Each validation consumes one credit
 * against the org's monthly validationCredits allotment.
 */
export const validateContacts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'ids array is required' });
        }

        // Load tier limits for credit gating
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { subscription_tier: true },
        });
        const tier = (org?.subscription_tier || 'trial').toLowerCase();
        const tierLimits = TIER_LIMITS[tier] || TIER_LIMITS.trial;

        // Count validations already used this calendar month (ValidationAttempt is
        // the unified record — covers ingestion, batch, and single-lead flows).
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const usedThisMonth = await prisma.validationAttempt.count({
            where: { organization_id: orgId, created_at: { gte: monthStart } },
        });
        const creditsRemaining = tierLimits.validationCredits === Infinity
            ? Infinity
            : Math.max(0, tierLimits.validationCredits - usedThisMonth);

        if (creditsRemaining <= 0) {
            return res.status(402).json({
                success: false,
                error: 'Monthly email validation credits exhausted. Upgrade your plan to verify more contacts.',
                credits_used: usedThisMonth,
                credits_limit: tierLimits.validationCredits === Infinity ? null : tierLimits.validationCredits,
            });
        }

        const leads = await prisma.lead.findMany({
            where: { id: { in: ids }, organization_id: orgId },
            select: {
                id: true, email: true, first_name: true, last_name: true,
                company: true, persona: true, lead_score: true,
            },
        });
        if (leads.length === 0) {
            return res.status(404).json({ success: false, error: 'No matching contacts found' });
        }

        // Only validate up to the remaining credit allowance
        const processable = creditsRemaining === Infinity ? leads : leads.slice(0, creditsRemaining as number);
        const skipped = leads.length - processable.length;

        // Create a ValidationBatch so this run shows up in the Email Validation page
        // (analytics + batch history read from ValidationBatch/ValidationBatchLead).
        const batch = await prisma.validationBatch.create({
            data: {
                organization_id: orgId,
                source: 'contacts',
                status: 'processing',
                total_count: processable.length,
            },
        });

        let validCount = 0;
        let riskyCount = 0;
        let invalidCount = 0;
        let failedCount = 0;

        for (const lead of processable) {
            try {
                const result = await validateLeadEmail(orgId, lead.email, tier);

                // ESP classification (best-effort — matches batch flow)
                const domain = lead.email.split('@')[1];
                let espBucket: string | null = null;
                try {
                    espBucket = await espClassifierService.getEspBucket(orgId, domain);
                } catch { /* best-effort */ }

                let rejectionReason: string | null = null;
                if (result.status === 'invalid') {
                    if (result.is_disposable) rejectionReason = 'disposable';
                    else if (result.details?.syntax_ok === false) rejectionReason = 'syntax';
                    else if (result.details?.mx_found === false) rejectionReason = 'no_mx';
                    else rejectionReason = 'smtp_fail';
                } else if (result.status === 'risky') {
                    if (result.is_catch_all) rejectionReason = 'catch_all';
                    else rejectionReason = 'low_score';
                }

                // Persist validation fields on the Lead (ValidationAttempt is created
                // inside validateLeadEmail — that's what drives credit counting).
                await prisma.lead.update({
                    where: { id: lead.id },
                    data: {
                        validation_status: result.status,
                        validation_score: result.score,
                        validation_source: result.source,
                        validated_at: new Date(),
                        is_catch_all: result.is_catch_all ?? null,
                        is_disposable: result.is_disposable ?? null,
                    },
                });

                // Mirror into ValidationBatchLead so the Email Validation page picks it up
                await prisma.validationBatchLead.create({
                    data: {
                        batch_id: batch.id,
                        email: lead.email,
                        first_name: lead.first_name,
                        last_name: lead.last_name,
                        company: lead.company,
                        persona: lead.persona,
                        lead_score: lead.lead_score,
                        validation_status: result.status,
                        validation_score: result.score,
                        rejection_reason: rejectionReason,
                        is_disposable: result.is_disposable ?? null,
                        is_catch_all: result.is_catch_all ?? null,
                        esp_bucket: espBucket,
                    },
                });

                if (result.status === 'valid') validCount++;
                else if (result.status === 'risky') riskyCount++;
                else if (result.status === 'invalid') invalidCount++;
            } catch (err: any) {
                failedCount++;
                logger.warn('[CONTACTS] Validation failed for lead', { leadId: lead.id, error: String(err) });
                try {
                    await prisma.validationBatchLead.create({
                        data: {
                            batch_id: batch.id,
                            email: lead.email,
                            validation_status: 'invalid',
                            error_message: String(err).slice(0, 500),
                        },
                    });
                } catch { /* best-effort */ }
            }
        }

        await prisma.validationBatch.update({
            where: { id: batch.id },
            data: {
                status: 'completed',
                valid_count: validCount,
                invalid_count: invalidCount,
                risky_count: riskyCount,
                completed_at: new Date(),
            },
        });

        const usedAfter = usedThisMonth + (processable.length - failedCount);

        return res.json({
            success: true,
            processed: processable.length,
            skipped,
            valid: validCount,
            risky: riskyCount,
            invalid: invalidCount,
            failed: failedCount,
            credits_used: usedAfter,
            credits_limit: tierLimits.validationCredits === Infinity ? null : tierLimits.validationCredits,
            credits_remaining: tierLimits.validationCredits === Infinity
                ? null
                : Math.max(0, tierLimits.validationCredits - usedAfter),
        });
    } catch (error: any) {
        logger.error('[CONTACTS] Failed to validate contacts', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to validate contacts' });
    }
};

/**
 * POST /api/sequencer/leads/validate-preview
 * Validate a raw list of emails (not tied to a Lead record) and return results
 * per-email so the wizard's Leads step can show valid/risky/invalid inline
 * before the user launches. Consumes credits like any other validation call.
 * Body: { emails: string[] }
 */
export const validateLeadsPreview = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { emails } = req.body;

        if (!Array.isArray(emails) || emails.length === 0) {
            return res.status(400).json({ success: false, error: 'emails array is required' });
        }

        const cleaned = Array.from(new Set(
            emails
                .filter((e): e is string => typeof e === 'string' && e.includes('@'))
                .map((e) => e.toLowerCase().trim())
        ));
        if (cleaned.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid email strings in request' });
        }

        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { subscription_tier: true },
        });
        const tier = (org?.subscription_tier || 'trial').toLowerCase();
        const tierLimits = TIER_LIMITS[tier] || TIER_LIMITS.trial;

        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const usedThisMonth = await prisma.validationAttempt.count({
            where: { organization_id: orgId, created_at: { gte: monthStart } },
        });
        const creditsRemaining = tierLimits.validationCredits === Infinity
            ? Infinity
            : Math.max(0, tierLimits.validationCredits - usedThisMonth);

        if (creditsRemaining <= 0) {
            return res.status(402).json({
                success: false,
                error: 'Monthly email validation credits exhausted. Upgrade your plan to verify more leads.',
                credits_used: usedThisMonth,
                credits_limit: tierLimits.validationCredits === Infinity ? null : tierLimits.validationCredits,
            });
        }

        const processable = creditsRemaining === Infinity ? cleaned : cleaned.slice(0, creditsRemaining as number);
        const skipped = cleaned.length - processable.length;

        const batch = await prisma.validationBatch.create({
            data: {
                organization_id: orgId,
                source: 'wizard',
                status: 'processing',
                total_count: processable.length,
            },
        });

        const results: Array<{
            email: string;
            status: string;
            score: number;
            is_catch_all: boolean | null;
            is_disposable: boolean | null;
            rejection_reason: string | null;
            error?: string;
        }> = [];

        let validCount = 0, riskyCount = 0, invalidCount = 0, failedCount = 0;

        for (const email of processable) {
            try {
                const v = await validateLeadEmail(orgId, email, tier);

                let rejection: string | null = null;
                if (v.status === 'invalid') {
                    if (v.is_disposable) rejection = 'disposable';
                    else if (v.details?.syntax_ok === false) rejection = 'syntax';
                    else if (v.details?.mx_found === false) rejection = 'no_mx';
                    else rejection = 'smtp_fail';
                } else if (v.status === 'risky') {
                    rejection = v.is_catch_all ? 'catch_all' : 'low_score';
                }

                // If the email exists as a Lead for this org, persist the fresh
                // result so future visits don't re-burn credits on the same lead.
                const existing = await prisma.lead.findUnique({
                    where: { organization_id_email: { organization_id: orgId, email } },
                    select: { id: true },
                });
                if (existing) {
                    await prisma.lead.update({
                        where: { id: existing.id },
                        data: {
                            validation_status: v.status,
                            validation_score: v.score,
                            validation_source: v.source,
                            validated_at: new Date(),
                            is_catch_all: v.is_catch_all ?? null,
                            is_disposable: v.is_disposable ?? null,
                        },
                    });
                }

                await prisma.validationBatchLead.create({
                    data: {
                        batch_id: batch.id,
                        email,
                        validation_status: v.status,
                        validation_score: v.score,
                        rejection_reason: rejection,
                        is_disposable: v.is_disposable ?? null,
                        is_catch_all: v.is_catch_all ?? null,
                    },
                });

                if (v.status === 'valid') validCount++;
                else if (v.status === 'risky') riskyCount++;
                else if (v.status === 'invalid') invalidCount++;

                results.push({
                    email,
                    status: v.status,
                    score: v.score,
                    is_catch_all: v.is_catch_all ?? null,
                    is_disposable: v.is_disposable ?? null,
                    rejection_reason: rejection,
                });
            } catch (err: any) {
                failedCount++;
                results.push({
                    email,
                    status: 'error',
                    score: 0,
                    is_catch_all: null,
                    is_disposable: null,
                    rejection_reason: null,
                    error: String(err).slice(0, 200),
                });
            }
        }

        await prisma.validationBatch.update({
            where: { id: batch.id },
            data: {
                status: 'completed',
                valid_count: validCount,
                invalid_count: invalidCount,
                risky_count: riskyCount,
                completed_at: new Date(),
            },
        });

        const usedAfter = usedThisMonth + (processable.length - failedCount);

        return res.json({
            success: true,
            processed: processable.length,
            skipped,
            valid: validCount,
            risky: riskyCount,
            invalid: invalidCount,
            failed: failedCount,
            credits_used: usedAfter,
            credits_limit: tierLimits.validationCredits === Infinity ? null : tierLimits.validationCredits,
            credits_remaining: tierLimits.validationCredits === Infinity
                ? null
                : Math.max(0, tierLimits.validationCredits - usedAfter),
            results,
        });
    } catch (error: any) {
        logger.error('[CONTACTS] Failed to validate lead preview', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to validate leads' });
    }
};

/**
 * POST /api/sequencer/contacts/assign-campaign/preview
 * Dry-run a campaign assignment: returns the dual-enrollment report so the UI
 * can show conflicts before commit. Does NOT persist anything.
 *
 * Conflict categories:
 *  - active: lead is currently in another campaign (status active|paused).
 *    Excluded by default in the commit step (toggle ON).
 *  - historical: lead has finished sequences in other campaigns with engagement
 *    (opens/clicks/replies). Surfaced for context, not excluded by default.
 *  - suppressed: lead is bounced or unsubscribed org-wide. Always excluded.
 */
export const previewAssignToCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { ids, campaign_id } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'ids array is required' });
        }
        if (!campaign_id || typeof campaign_id !== 'string') {
            return res.status(400).json({ success: false, error: 'campaign_id is required' });
        }

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaign_id, organization_id: orgId },
            select: { id: true, name: true, status: true },
        });
        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campaign not found' });
        }

        const report = await dualEnrollmentService.checkDualEnrollment(
            orgId,
            ids,
            campaign.id,
        );

        return res.json({
            success: true,
            campaign: { id: campaign.id, name: campaign.name },
            report,
        });
    } catch (error: any) {
        logger.error('[CONTACTS] Failed to preview campaign assignment', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to preview campaign assignment' });
    }
};

/**
 * POST /api/sequencer/contacts/assign-campaign
 * Add a set of leads to an existing SendCampaign. Creates CampaignLead rows
 * (skipping any email already in the campaign) and refreshes total_leads.
 *
 * Optional flag `exclude_dual_enrolled` (default true) excludes leads currently
 * active/paused in another campaign. Operators can override by setting false.
 */
export const assignToCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { ids, campaign_id, exclude_dual_enrolled } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'ids array is required' });
        }
        if (!campaign_id || typeof campaign_id !== 'string') {
            return res.status(400).json({ success: false, error: 'campaign_id is required' });
        }

        // Default ON — safer for cold-email reputation. Operators can disable
        // with explicit false (e.g., intentional BDR→AE handoff).
        const excludeDualEnrolled = exclude_dual_enrolled !== false;

        const campaign = await prisma.campaign.findFirst({
            where: { id: campaign_id, organization_id: orgId },
            select: { id: true, status: true },
        });
        if (!campaign) {
            return res.status(404).json({ success: false, error: 'Campaign not found' });
        }

        const leads = await prisma.lead.findMany({
            where: { id: { in: ids }, organization_id: orgId },
            select: {
                id: true, email: true, first_name: true, last_name: true,
                full_name: true, company: true, website: true, title: true,
                validation_status: true, validation_score: true,
                health_classification: true,
            },
        });
        if (leads.length === 0) {
            return res.status(404).json({ success: false, error: 'No matching contacts found' });
        }

        // Re-run dual-enrollment check at commit time (covers race conditions
        // where another campaign added the same email between preview and submit).
        const dualReport = await dualEnrollmentService.checkDualEnrollment(
            orgId, leads.map(l => l.id), campaign.id
        );
        const { excludedLeadIds } = dualEnrollmentService.resolveExclusions(
            dualReport,
            { excludeActive: excludeDualEnrolled }
        );
        const excludedDualEnrolled = excludedLeadIds.size;

        // Block RED leads at assignment time — consistent with campaign creation flow
        const eligible = leads.filter((l) =>
            l.health_classification !== 'red' &&
            !excludedLeadIds.has(l.id)
        );
        const blocked = leads.filter(l => l.health_classification === 'red').length;

        const rows = eligible.map((lead) => ({
            campaign_id: campaign.id,
            email: lead.email,
            first_name: lead.first_name,
            last_name: lead.last_name,
            company: lead.company,
            title: lead.title,
            status: lead.health_classification === 'yellow' ? 'paused' : 'active',
            validation_status: lead.validation_status,
            validation_score: lead.validation_score,
            custom_variables: {
                ...(lead.full_name ? { full_name: lead.full_name } : {}),
                ...(lead.website ? { website: lead.website } : {}),
            },
        }));

        let createdCount = 0;
        if (rows.length > 0) {
            const result = await prisma.campaignLead.createMany({
                data: rows,
                skipDuplicates: true,
            });
            createdCount = result.count;

            const newTotal = await prisma.campaignLead.count({ where: { campaign_id: campaign.id } });
            await prisma.campaign.update({
                where: { id: campaign.id },
                data: { total_leads: newTotal },
            });

            // Forward-wire the Protection Lead row so the Protection Leads page
            // reflects the sequencer enrollment:
            //   - assigned_campaign_id points at the SendCampaign
            //   - status transitions held → active (lead is now in a live sequence)
            // updateMany covers the happy path in one round-trip; the entityStateService
            // transition is then applied per-lead so state-transition audit + history
            // recording stays correct. Failures here are non-critical to the sequencer
            // assignment — they only affect the Protection-side view, so each step is
            // guarded independently.
            await prisma.lead.updateMany({
                where: { id: { in: eligible.map((l) => l.id) }, organization_id: orgId },
                data: { assigned_campaign_id: campaign.id, last_activity_at: new Date() },
            }).catch((err) => {
                logger.warn('[CONTACTS] Failed to forward-wire Lead.assigned_campaign_id', { error: err?.message });
            });

            // Status transitions are per-lead and skip any lead already in ACTIVE / COMPLETED.
            // The transition is best-effort and isolated so one bad lead doesn't break the batch.
            const heldLeads = await prisma.lead.findMany({
                where: { id: { in: eligible.map((l) => l.id) }, organization_id: orgId, status: 'held' },
                select: { id: true },
            });
            for (const l of heldLeads) {
                await entityStateService.transitionLead(
                    orgId,
                    l.id,
                    LeadState.ACTIVE,
                    `Added to sequencer campaign ${campaign.id} via assignToCampaign`,
                    TriggerType.MANUAL,
                ).catch((err) => {
                    logger.warn('[CONTACTS] Failed to transition lead to ACTIVE on assign', { leadId: l.id, error: err?.message });
                });
            }
        }

        logger.info('[CONTACTS] Assigned leads to campaign', {
            orgId, campaignId: campaign.id,
            requested: ids.length, created: createdCount, blocked,
            excludedDualEnrolled,
        });

        return res.json({
            success: true,
            added: createdCount,
            skipped_duplicates: eligible.length - createdCount,
            blocked_red: blocked,
            excluded_dual_enrolled: excludedDualEnrolled,
        });
    } catch (error: any) {
        logger.error('[CONTACTS] Failed to assign to campaign', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to assign contacts to campaign' });
    }
};

/**
 * GET /api/sequencer/contacts/export
 * Return CSV of all contacts.
 */
export const exportContacts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        const leads = await prisma.lead.findMany({
            where: { organization_id: orgId },
            orderBy: { created_at: 'desc' },
        });

        // Build CSV
        const headers = ['email', 'first_name', 'last_name', 'full_name', 'company', 'title', 'website', 'persona', 'source', 'status', 'lead_score', 'validation_status', 'validation_score', 'health_classification', 'created_at'];
        const rows = leads.map((l) => [
            l.email,
            l.first_name || '',
            l.last_name || '',
            l.full_name || '',
            l.company || '',
            l.title || '',
            l.website || '',
            l.persona || '',
            l.source || '',
            l.status,
            String(l.lead_score),
            l.validation_status || '',
            l.validation_score !== null && l.validation_score !== undefined ? String(l.validation_score) : '',
            l.health_classification,
            l.created_at.toISOString(),
        ]);

        const csv = [
            headers.join(','),
            ...rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')),
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
        return res.send(csv);
    } catch (error: any) {
        logger.error('[CONTACTS] Failed to export contacts', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to export contacts' });
    }
};
