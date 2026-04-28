/**
 * Smartlead Import Orchestrator
 *
 * One-time import from a customer's existing Smartlead workspace into Superkabe.
 *
 * Boundary:
 *   - Smartlead is the data source: campaigns, sequences, leads, mailbox metadata,
 *     7-day warmup health snapshot.
 *   - Superkabe owns all runtime decisions: variant rotation, ESP routing, send
 *     scheduling, warmup logic, sticky pinning, state machine.
 *
 * Lead policy: only `status=STARTED` leads with `last_sent_time=null` are
 * imported (Gap A — Smartlead does not expose per-lead mailbox pinning, so
 * mid-sequence leads cannot be safely resumed without breaking threading).
 * In-flight leads are counted and surfaced in `ImportJob.stats`.
 *
 * Campaign policy: every imported campaign lands in `status='paused'` regardless
 * of source status. Customer must explicitly launch in Superkabe UI after
 * connecting their mailboxes. This guarantees no double-sending during the
 * connection window.
 *
 * Idempotency: every entity (Campaign, SequenceStep, StepVariant, Lead,
 * CampaignLead, Mailbox) carries `import_external_id`. Re-running the import
 * upserts on `(scope, import_external_id)`. Safe to retry on failure within
 * the 72h key TTL window.
 */

import { randomUUID } from 'crypto';
import { prisma } from '../index';
import { logger } from './observabilityService';
import * as smartlead from './smartleadClient';
import * as importJob from './importJobService';
import { SlackAlertService } from './SlackAlertService';
import type {
    SmartleadCampaign,
    SmartleadCampaignMailbox,
    SmartleadEmailAccount,
    SmartleadLead,
    SmartleadSequenceStep,
    SmartleadWarmupStats,
} from './smartleadClient';

// ─────────────────────────────────────────────────────────────────────────────
// Lead classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recipients contacted within this many days are considered "recent" — they're
 * the most likely to remember a prior outreach and react badly to a duplicate
 * first-touch from a new sender. In aggressive mode they're skipped by default
 * unless `include_recent_contacts` is explicitly enabled.
 */
export const RECENT_CONTACT_THRESHOLD_DAYS = 14;

/**
 * Leads fall into one of five buckets — both the preview UI and the orchestrator
 * use this exact taxonomy to keep numbers consistent.
 */
export type LeadBucket =
    | 'never_contacted'  // no email has gone out yet — always safe to import
    | 'stale_contact'    // last_sent_time older than threshold
    | 'recent_contact'   // last_sent_time within threshold
    | 'opted_out'        // PAUSED or STOPPED — customer explicitly halted
    | 'completed';       // sequence finished without reply

const RECENT_THRESHOLD_MS = RECENT_CONTACT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

export const classifyLead = (lead: SmartleadLead, now: number = Date.now()): LeadBucket => {
    if (lead.status === 'PAUSED' || lead.status === 'STOPPED') return 'opted_out';
    if (lead.status === 'COMPLETED') return 'completed';
    if (!lead.last_sent_time) return 'never_contacted';
    const lastSent = Date.parse(lead.last_sent_time);
    if (Number.isNaN(lastSent)) return 'never_contacted';
    const ageMs = now - lastSent;
    return ageMs > RECENT_THRESHOLD_MS ? 'stale_contact' : 'recent_contact';
};

/**
 * Decide whether a lead is imported under the chosen mode. Single source of
 * truth — used by both `previewImport` (to compute "Will be imported" counts)
 * and the actual `ingestLeads` filter.
 *
 *   conservative: never_contacted only (preserves threading on Smartlead side).
 *   aggressive:   never_contacted + stale_contact + completed,
 *                 plus recent_contact when includeRecent=true.
 *
 * `opted_out` is NEVER imported — customer explicitly halted those leads.
 */
export const shouldImportLead = (
    bucket: LeadBucket,
    mode: 'conservative' | 'aggressive',
    includeRecent: boolean,
): boolean => {
    if (bucket === 'opted_out') return false;
    if (bucket === 'never_contacted') return true;
    if (mode === 'conservative') return false;
    // aggressive
    if (bucket === 'stale_contact' || bucket === 'completed') return true;
    if (bucket === 'recent_contact') return includeRecent;
    return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Preview (read-only)
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewLeadBuckets {
    total: number;
    neverContacted: number;
    staleContact: number;       // older than threshold
    recentContact: number;      // within threshold
    completed: number;
    optedOut: number;
}

export interface PreviewResult {
    campaigns:    { total: number; byStatus: Record<string, number> };
    mailboxes:    { total: number; byProvider: Record<string, number> };
    leads:        PreviewLeadBuckets;
    sequenceSteps: number;
    /** How many days "recent" means — clients display this in the UI copy. */
    recentContactThresholdDays: number;
}

/**
 * Lightweight read pass — no writes. Used by step 2 of the wizard so the
 * customer sees the impact before committing.
 */
export const previewImport = async (orgId: string): Promise<PreviewResult> => {
    const keyEntry = await importJob.getDecryptedImportKey(orgId);
    if (!keyEntry || keyEntry.platform !== 'smartlead') {
        throw new Error('No Smartlead key on file. Paste your admin API key first.');
    }
    const apiKey = keyEntry.key;
    const now = Date.now();

    const campaigns = await smartlead.listCampaigns(apiKey);

    const result: PreviewResult = {
        campaigns: { total: campaigns.length, byStatus: {} },
        mailboxes: { total: 0, byProvider: {} },
        leads: {
            total: 0,
            neverContacted: 0,
            staleContact: 0,
            recentContact: 0,
            completed: 0,
            optedOut: 0,
        },
        sequenceSteps: 0,
        recentContactThresholdDays: RECENT_CONTACT_THRESHOLD_DAYS,
    };

    for (const c of campaigns) {
        result.campaigns.byStatus[c.status] = (result.campaigns.byStatus[c.status] || 0) + 1;
    }

    for (const c of campaigns) {
        const [steps, leads] = await Promise.all([
            smartlead.getCampaignSequences(apiKey, c.id),
            smartlead.listCampaignLeads(apiKey, c.id),
        ]);
        result.sequenceSteps += steps.length;
        for (const lead of leads) {
            result.leads.total++;
            const bucket = classifyLead(lead, now);
            switch (bucket) {
                case 'never_contacted': result.leads.neverContacted++; break;
                case 'stale_contact':   result.leads.staleContact++;   break;
                case 'recent_contact':  result.leads.recentContact++;  break;
                case 'completed':       result.leads.completed++;      break;
                case 'opted_out':       result.leads.optedOut++;       break;
            }
        }
    }

    const accounts = await smartlead.listEmailAccounts(apiKey);
    result.mailboxes.total = accounts.length;
    for (const a of accounts) {
        result.mailboxes.byProvider[a.type] = (result.mailboxes.byProvider[a.type] || 0) + 1;
    }

    return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Field translators (Smartlead → Superkabe)
// ─────────────────────────────────────────────────────────────────────────────

const DAY_INDEX_TO_SHORT: Record<number, string> = {
    1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat', 7: 'sun',
};

const mapTrackSettings = (settings: SmartleadCampaign['track_settings']) => ({
    track_opens:  !settings.includes('DONT_EMAIL_OPEN'),
    track_clicks: !settings.includes('DONT_LINK_CLICK'),
});

const mapStopRules = (stopSetting: SmartleadCampaign['stop_lead_settings']) => ({
    stop_on_reply: stopSetting === 'REPLY_TO_AN_EMAIL',
    // Note: OPENED_EMAIL / CLICKED_LINK don't have a direct equivalent in our
    // current Campaign schema — surfaced in import stats so the customer can
    // recreate manually if needed.
    stop_on_bounce: true,  // Always-on in our system; preserve safe default.
});

const mapScheduleDays = (days: number[]): string[] =>
    days.map(d => DAY_INDEX_TO_SHORT[d]).filter(Boolean);

/**
 * Compute a conservative initial daily-send cap (warmup_limit) for an imported
 * mailbox, based on the baseline snapshot from the source platform.
 *
 * Gated by USE_IMPORT_BASELINE env var (default off). When the flag is off, we
 * return the customer's configured target verbatim (legacy behavior). When on,
 * we cap based on observed source-side health:
 *
 *   - Warmup blocked at source       → 25/day  (hardest cap)
 *   - >5% spam rate over last 7d     → 50/day
 *   - Warmup reputation <70 / 100    → 100/day
 *   - Otherwise                      → customer's configured message_per_day
 *
 * Once native sends accumulate (window_sent_count >= 100), an admin can
 * raise the cap to the customer's target. Done deliberately by hand because
 * a non-baseline-aware bump-up would reset all the protection logic that
 * keeps shaky mailboxes throttled.
 */
function computeInitialWarmupLimit(
    baseline: { sent_7d: number | null; spam_7d: number | null; warmup_reputation: number | null; warmup_blocked: boolean },
    customerTarget: number,
): number {
    if (process.env.USE_IMPORT_BASELINE !== 'true') return customerTarget;

    if (baseline.warmup_blocked) return Math.min(25, customerTarget || 25);

    if (baseline.sent_7d && baseline.sent_7d > 0 && baseline.spam_7d != null) {
        const spamRate = baseline.spam_7d / baseline.sent_7d;
        if (spamRate > 0.05) return Math.min(50, customerTarget || 50);
    }

    if (baseline.warmup_reputation != null && baseline.warmup_reputation < 70) {
        return Math.min(100, customerTarget || 100);
    }

    return customerTarget;
}

/** Strip Smartlead-injected tracking pixels from imported HTML bodies. */
const stripTracking = (html: string): string => {
    if (!html) return html;
    return html
        // Tracking pixels — img tags pointing at smartlead.ai or slmail.me
        .replace(/<img[^>]*src=["'][^"']*(?:smartlead\.ai|slmail\.me)[^"']*["'][^>]*\/?>(?:<\/img>)?/gi, '')
        // Smartlead unsubscribe links — anchor tags pointing at smartlead unsub paths
        .replace(/<a[^>]*href=["'][^"']*(?:smartlead\.ai|slmail\.me)[^"']*(?:unsubscribe|unsub)[^"']*["'][^>]*>[^<]*<\/a>/gi, '');
};

/** Strip tracking from plain-text bodies (just remove unsub URL lines). */
const stripTrackingText = (text: string | null | undefined): string | null => {
    if (!text) return text || null;
    return text.replace(/^.*(?:smartlead\.ai|slmail\.me).*(?:unsubscribe|unsub).*$/gim, '').trim();
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-entity ingest helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Find-or-create a Domain row. Used for every imported mailbox. */
const ensureDomain = async (orgId: string, email: string): Promise<string> => {
    const domainPart = email.split('@')[1]?.toLowerCase();
    if (!domainPart) throw new Error(`Invalid email — no @ in ${email}`);

    const existing = await prisma.domain.findUnique({
        where: { organization_id_domain: { organization_id: orgId, domain: domainPart } },
        select: { id: true },
    });
    if (existing) return existing.id;

    const created = await prisma.domain.create({
        data: {
            domain: domainPart,
            organization_id: orgId,
            status: 'healthy',
        },
        select: { id: true },
    });
    return created.id;
};

interface IngestCampaignResult {
    localId: string;
    sourceCampaignId: number;
}

const ingestCampaign = async (
    orgId: string,
    sl: SmartleadCampaign,
): Promise<IngestCampaignResult> => {
    const externalId = String(sl.id);
    const cron = sl.scheduler_cron_value;

    const upserted = await prisma.campaign.upsert({
        where: {
            organization_id_import_external_id: {
                organization_id: orgId,
                import_external_id: externalId,
            },
        },
        create: {
            id: randomUUID(),
            name: sl.name,
            channel: 'email',
            // ALWAYS land paused — customer must explicitly launch after mailbox handoff.
            status: 'paused',
            paused_reason: 'imported_from_smartlead',
            paused_by: 'system',
            paused_at: new Date(),
            organization_id: orgId,
            import_external_id: externalId,
            schedule_timezone: cron?.tz || null,
            schedule_start_time: cron?.startHour || null,
            schedule_end_time: cron?.endHour || null,
            schedule_days: cron?.days ? mapScheduleDays(cron.days) : [],
            daily_limit: sl.max_leads_per_day || null,
            send_gap_minutes: sl.min_time_btwn_emails || null,
            ...mapTrackSettings(sl.track_settings || []),
            ...mapStopRules(sl.stop_lead_settings),
            include_unsubscribe: true,
            esp_routing: true,            // Always on — our infra owns routing
        },
        update: {
            name: sl.name,
            schedule_timezone: cron?.tz || null,
            schedule_start_time: cron?.startHour || null,
            schedule_end_time: cron?.endHour || null,
            schedule_days: cron?.days ? mapScheduleDays(cron.days) : [],
            daily_limit: sl.max_leads_per_day || null,
            send_gap_minutes: sl.min_time_btwn_emails || null,
            ...mapTrackSettings(sl.track_settings || []),
            ...mapStopRules(sl.stop_lead_settings),
        },
        select: { id: true },
    });

    return { localId: upserted.id, sourceCampaignId: sl.id };
};

const ingestSequence = async (
    localCampaignId: string,
    slSteps: SmartleadSequenceStep[],
): Promise<{ stepsImported: number; variantsImported: number }> => {
    let stepsImported = 0;
    let variantsImported = 0;

    for (const step of slSteps) {
        const stepExternalId = String(step.id);
        const upsertedStep = await prisma.sequenceStep.upsert({
            where: {
                campaign_id_import_external_id: {
                    campaign_id: localCampaignId,
                    import_external_id: stepExternalId,
                },
            },
            create: {
                campaign_id: localCampaignId,
                import_external_id: stepExternalId,
                step_number: step.seq_number,
                delay_days: step.seq_delay_details?.delayInDays ?? 0,
                delay_hours: 0,
                subject: step.subject || '',
                body_html: stripTracking(step.email_body || ''),
                body_text: null,
            },
            update: {
                step_number: step.seq_number,
                delay_days: step.seq_delay_details?.delayInDays ?? 0,
                subject: step.subject || '',
                body_html: stripTracking(step.email_body || ''),
            },
            select: { id: true },
        });
        stepsImported++;

        for (const variant of step.sequence_variants || []) {
            const variantExternalId = String(variant.id);
            await prisma.stepVariant.upsert({
                where: {
                    step_id_import_external_id: {
                        step_id: upsertedStep.id,
                        import_external_id: variantExternalId,
                    },
                },
                create: {
                    step_id: upsertedStep.id,
                    import_external_id: variantExternalId,
                    variant_label: variant.variant_name?.slice(0, 1)?.toUpperCase() || 'A',
                    subject: variant.subject || '',
                    body_html: stripTracking(variant.email_body || ''),
                    weight: 50,    // Equal split; our rotation owns assignment going forward.
                },
                update: {
                    variant_label: variant.variant_name?.slice(0, 1)?.toUpperCase() || 'A',
                    subject: variant.subject || '',
                    body_html: stripTracking(variant.email_body || ''),
                },
            });
            variantsImported++;
        }
    }

    return { stepsImported, variantsImported };
};

const ingestMailbox = async (
    orgId: string,
    sl: SmartleadEmailAccount,
    warmup: SmartleadWarmupStats | null,
): Promise<{ localId: string; email: string }> => {
    const externalId = String(sl.id);
    const domainId = await ensureDomain(orgId, sl.from_email);

    // Aggregate the 7-day warmup snapshot for state-machine seeding.
    const warmupAgg = warmup ? warmup.daily_stats.reduce(
        (acc, d) => ({
            sent: acc.sent + (d.sent || 0),
            spam: acc.spam + (d.spam || 0),
            replied: acc.replied + (d.replied || 0),
            delivered: acc.delivered + (d.delivered || 0),
            opened: acc.opened + (d.opened || 0),
        }),
        { sent: 0, spam: 0, replied: 0, delivered: 0, opened: 0 },
    ) : null;

    const importBaseline = {
        sent_7d: warmupAgg?.sent ?? null,
        spam_7d: warmupAgg?.spam ?? null,
        replied_7d: warmupAgg?.replied ?? null,
        delivered_7d: warmupAgg?.delivered ?? null,
        opened_7d: warmupAgg?.opened ?? null,
        warmup_reputation: warmup?.reputation_score ?? sl.warmup_reputation ?? null,
        warmup_blocked: sl.blocked_reason ? true : false,
        blocked_reason: sl.blocked_reason || null,
        provider: sl.type,
        imported_at: new Date().toISOString(),
    };

    // Conservative initial warmup_limit when baseline indicates source-side concern.
    // Existing execution-gate logic (executionGateService.ts:181) already filters
    // mailboxes whose window_sent_count >= warmup_limit, so capping here flows through
    // automatically with no state-machine changes. Once the mailbox accumulates
    // healthy native sends, an admin can raise warmup_limit to the customer-set target.
    const customerTarget = sl.message_per_day || 0;
    const initialWarmupLimit = computeInitialWarmupLimit(importBaseline, customerTarget);

    const upserted = await prisma.mailbox.upsert({
        where: {
            organization_id_import_external_id: {
                organization_id: orgId,
                import_external_id: externalId,
            },
        },
        create: {
            id: randomUUID(),
            email: sl.from_email.toLowerCase(),
            organization_id: orgId,
            domain_id: domainId,
            import_external_id: externalId,
            import_baseline: importBaseline,
            status: 'healthy',
            // No connected_account_id — set when user reconnects natively in step 4.
            warmup_reputation: warmup?.reputation_score != null
                ? String(warmup.reputation_score)
                : (sl.warmup_reputation != null ? String(sl.warmup_reputation) : null),
            warmup_status: sl.status === 'ACTIVE' ? 'platform_active' : null,
            warmup_limit: initialWarmupLimit,
            initial_bounce_rate: warmupAgg && warmupAgg.sent > 0
                ? warmupAgg.spam / warmupAgg.sent
                : null,
            initial_assessment_at: new Date(),
        },
        update: {
            email: sl.from_email.toLowerCase(),
            domain_id: domainId,
            import_baseline: importBaseline,
            warmup_reputation: warmup?.reputation_score != null
                ? String(warmup.reputation_score)
                : (sl.warmup_reputation != null ? String(sl.warmup_reputation) : null),
            warmup_status: sl.status === 'ACTIVE' ? 'platform_active' : null,
            warmup_limit: initialWarmupLimit,
        },
        select: { id: true, email: true },
    });

    return { localId: upserted.id, email: upserted.email };
};

const linkCampaignMailboxes = async (
    localCampaignId: string,
    localMailboxIds: string[],
): Promise<void> => {
    if (localMailboxIds.length === 0) return;
    await prisma.campaign.update({
        where: { id: localCampaignId },
        data: {
            mailboxes: {
                connect: localMailboxIds.map(id => ({ id })),
            },
        },
    });
};

interface IngestLeadsResult {
    imported: number;
    skippedRecentContact: number;     // aggressive mode w/ includeRecent=false
    skippedInFlight: number;          // conservative mode skipping mid-sequence
    skippedOptedOut: number;          // PAUSED/STOPPED — never imported
    skippedInvalidEmail: number;
}

const ingestLeads = async (
    orgId: string,
    localCampaignId: string,
    slLeads: SmartleadLead[],
    mode: 'conservative' | 'aggressive',
    includeRecent: boolean,
    now: number = Date.now(),
): Promise<IngestLeadsResult> => {
    const result: IngestLeadsResult = {
        imported: 0,
        skippedRecentContact: 0,
        skippedInFlight: 0,
        skippedOptedOut: 0,
        skippedInvalidEmail: 0,
    };

    for (const lead of slLeads) {
        const bucket = classifyLead(lead, now);
        const importThis = shouldImportLead(bucket, mode, includeRecent);

        if (!importThis) {
            // Per-bucket skip counter so the wizard can show meaningful detail.
            if (bucket === 'opted_out') result.skippedOptedOut++;
            else if (bucket === 'recent_contact') result.skippedRecentContact++;
            else result.skippedInFlight++;     // stale_contact / completed in conservative mode
            continue;
        }

        if (!lead.email || !lead.email.includes('@')) {
            result.skippedInvalidEmail++;
            continue;
        }

        const email = lead.email.toLowerCase().trim();
        const externalId = String(lead.id);

        // Lead row (org-scoped). Upsert on (org, email) to dedup with prior
        // Clay/CSV ingests; record the Smartlead id for retry idempotency.
        await prisma.lead.upsert({
            where: { organization_id_email: { organization_id: orgId, email } },
            create: {
                email,
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company_name || null,
                persona: 'imported',                // Required field — placeholder for routing
                lead_score: 50,                     // Default — we don't import their scoring
                organization_id: orgId,
                source: 'smartlead_import',
                import_external_id: externalId,
                status: 'pending',
            },
            update: {
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company_name || null,
                import_external_id: externalId,
            },
        });

        // CampaignLead row (campaign-scoped membership). Upsert on
        // (campaign_id, email) — multiple campaigns may carry the same lead.
        await prisma.campaignLead.upsert({
            where: { campaign_id_email: { campaign_id: localCampaignId, email } },
            create: {
                campaign_id: localCampaignId,
                email,
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company_name || null,
                custom_variables: lead.custom_fields as object || null,
                status: 'active',
                current_step: 0,                    // Always start from step 1 (current_step=0 = not started)
                import_external_id: externalId,
            },
            update: {
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company_name || null,
                custom_variables: lead.custom_fields as object || null,
                import_external_id: externalId,
            },
        });

        result.imported++;
    }

    return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// runImport — the long-running orchestration entry point
// ─────────────────────────────────────────────────────────────────────────────

export const runImport = async (orgId: string, jobId: string): Promise<void> => {
    const keyEntry = await importJob.getDecryptedImportKey(orgId);
    if (!keyEntry || keyEntry.platform !== 'smartlead') {
        await importJob.updateImportJob(jobId, {
            status: 'failed',
            error: 'No Smartlead key on file (or expired). Re-paste and retry.',
            markCompleted: true,
        });
        return;
    }
    const apiKey = keyEntry.key;

    // Read the customer's chosen migration mode + recent-contact toggle from the
    // ImportJob row. The wizard wrote these when the customer pressed Start.
    const jobRow = await prisma.importJob.findUnique({
        where: { id: jobId },
        select: { mode: true, include_recent_contacts: true },
    });
    const mode: 'conservative' | 'aggressive' =
        jobRow?.mode === 'aggressive' ? 'aggressive' : 'conservative';
    const includeRecent = !!jobRow?.include_recent_contacts;

    await importJob.updateImportJob(jobId, {
        status: 'running',
        markStarted: true,
        statsPatch: { mode, includeRecentContacts: includeRecent },
    });

    try {
        // Step 1: discover campaigns
        const campaigns = await smartlead.listCampaigns(apiKey);
        await importJob.updateImportJob(jobId, {
            statsPatch: { campaignsFound: campaigns.length },
        });

        // Step 2: pause any ACTIVE campaign on Smartlead BEFORE ingesting leads,
        // so they don't keep sending while we read. Do this before the heavy
        // fetch loop — if the pause itself fails, we abort early.
        const activeCampaigns = campaigns.filter(c => c.status === 'ACTIVE');
        let pausedCount = 0;
        for (const c of activeCampaigns) {
            try {
                await smartlead.pauseCampaign(apiKey, c.id);
                pausedCount++;
            } catch (err: any) {
                logger.warn(`[SMARTLEAD-IMPORT] Failed to pause campaign ${c.id}`, err);
                // Don't abort — best-effort. Customer still benefits if some pause.
            }
        }
        await importJob.updateImportJob(jobId, {
            status: 'paused_source',
            statsPatch: { sourceActiveCount: activeCampaigns.length, sourcePausedCount: pausedCount },
        });

        // Step 3: pull mailboxes (org-wide) up front so we can link campaigns to mailboxes by id.
        const accounts = await smartlead.listEmailAccounts(apiKey);
        const sourceMailboxIdToLocal = new Map<number, string>();
        const importedMailboxEmails: string[] = [];
        let warmupNullCount = 0;

        for (const acc of accounts) {
            // Best-effort warmup pull — null on 404/422 (not every mailbox has warmup enabled).
            let warmup: SmartleadWarmupStats | null = null;
            try {
                warmup = await smartlead.getWarmupStats(apiKey, acc.id);
                if (!warmup) warmupNullCount++;
            } catch (err: any) {
                logger.warn(`[SMARTLEAD-IMPORT] warmup-stats failed for account ${acc.id}`, err);
                warmupNullCount++;
            }
            const { localId, email } = await ingestMailbox(orgId, acc, warmup);
            sourceMailboxIdToLocal.set(acc.id, localId);
            importedMailboxEmails.push(email);
        }
        await importJob.updateImportJob(jobId, {
            statsPatch: {
                mailboxesImported: accounts.length,
                warmupSnapshotsMissing: warmupNullCount,
            },
        });

        // Step 4: per-campaign ingest — sequences, leads, mailbox-pool linkage.
        let stepsImportedTotal = 0;
        let variantsImportedTotal = 0;
        const leadsAgg: IngestLeadsResult = {
            imported: 0,
            skippedRecentContact: 0,
            skippedInFlight: 0,
            skippedOptedOut: 0,
            skippedInvalidEmail: 0,
        };

        for (const sl of campaigns) {
            // Skip terminal campaigns — STOPPED/ARCHIVED bring no value.
            if (sl.status === 'STOPPED' || sl.status === 'ARCHIVED') continue;

            const { localId } = await ingestCampaign(orgId, sl);

            // Sequences (steps + variants)
            const slSteps = await smartlead.getCampaignSequences(apiKey, sl.id);
            const seqResult = await ingestSequence(localId, slSteps);
            stepsImportedTotal += seqResult.stepsImported;
            variantsImportedTotal += seqResult.variantsImported;

            // Mailbox pool — only link mailboxes we successfully imported.
            const poolFromSource = await smartlead.getCampaignMailboxes(apiKey, sl.id);
            const localMailboxIds = poolFromSource
                .map(m => sourceMailboxIdToLocal.get(m.id))
                .filter((id): id is string => !!id);
            await linkCampaignMailboxes(localId, localMailboxIds);

            // Leads — filter logic depends on customer-chosen mode.
            const slLeads = await smartlead.listCampaignLeads(apiKey, sl.id);
            const leadResult = await ingestLeads(orgId, localId, slLeads, mode, includeRecent);
            leadsAgg.imported += leadResult.imported;
            leadsAgg.skippedRecentContact += leadResult.skippedRecentContact;
            leadsAgg.skippedInFlight += leadResult.skippedInFlight;
            leadsAgg.skippedOptedOut += leadResult.skippedOptedOut;
            leadsAgg.skippedInvalidEmail += leadResult.skippedInvalidEmail;

            // Live progress so the wizard can show "12/47 campaigns done."
            await importJob.updateImportJob(jobId, {
                statsPatch: {
                    sequenceStepsImported: stepsImportedTotal,
                    variantsImported: variantsImportedTotal,
                    leadsImported: leadsAgg.imported,
                    leadsSkippedRecentContact: leadsAgg.skippedRecentContact,
                    leadsSkippedInFlight: leadsAgg.skippedInFlight,
                    leadsSkippedOptedOut: leadsAgg.skippedOptedOut,
                    leadsSkippedInvalidEmail: leadsAgg.skippedInvalidEmail,
                },
            });
        }

        // Step 5: mark complete + shrink TTL to 24h post-completion.
        await importJob.updateImportJob(jobId, {
            status: 'complete',
            markCompleted: true,
            statsPatch: {
                importedMailboxEmails,
            },
        });
        await importJob.shrinkTtlAfterCompletion(orgId);

        logger.info('[SMARTLEAD-IMPORT] Import complete', {
            orgId,
            jobId,
            ...leadsAgg,
            campaignsFound: campaigns.length,
            mailboxesImported: accounts.length,
        });

        SlackAlertService.sendAlert({
            organizationId: orgId,
            eventType: 'import.smartlead_completed',
            entityId: jobId,
            severity: 'info',
            title: '📥 Smartlead import completed',
            message: [
                `Imported from Smartlead:`,
                `• *${leadsAgg.imported}* leads`,
                `• *${accounts.length}* mailboxes`,
                `• *${campaigns.length}* campaigns scanned`,
                leadsAgg.skippedRecentContact ? `• Skipped (recent contact): ${leadsAgg.skippedRecentContact}` : null,
                leadsAgg.skippedInFlight ? `• Skipped (in-flight): ${leadsAgg.skippedInFlight}` : null,
                leadsAgg.skippedOptedOut ? `• Skipped (opted out): ${leadsAgg.skippedOptedOut}` : null,
                leadsAgg.skippedInvalidEmail ? `• Skipped (invalid email): ${leadsAgg.skippedInvalidEmail}` : null,
            ].filter(Boolean).join('\n'),
        }).catch((err) => logger.warn('[SMARTLEAD-IMPORT] Slack alert failed', { error: err?.message }));
    } catch (err: any) {
        const errMsg = err?.message?.slice(0, 1000) || 'unknown error';
        logger.error('[SMARTLEAD-IMPORT] Import failed', err, { orgId, jobId });
        await importJob.updateImportJob(jobId, {
            status: 'failed',
            error: errMsg,
            markCompleted: true,
        });
        // Do NOT shrink TTL on failure — customer needs the full 72h window to retry.
    }
};

// Re-export key utility for callers that need plaintext-key validation before
// `setImportKey` is called (i.e., the validate-key endpoint).
export { stripTracking, stripTrackingText };
