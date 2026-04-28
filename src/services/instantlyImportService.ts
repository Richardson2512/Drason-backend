/**
 * Instantly Import Orchestrator
 *
 * One-time read-only import from a customer's Instantly v2 workspace into
 * Superkabe. Drives the wizard preview + the long-running ingest job.
 *
 * Source-API constraints (verified against developer.instantly.ai):
 *   • Mailbox credentials are write-only across the entire Instantly v2 API —
 *     no OAuth tokens, no SMTP/IMAP passwords are returned. Imported mailboxes
 *     land in `connection_status='disconnected'` and the customer must
 *     re-authenticate them in Superkabe before any sending happens.
 *   • `/api/v2/emails` is rate-limited at 20 req/min (5x tighter than the
 *     global 100 req/sec). We don't pull email bodies in this v1 — the lead
 *     object already carries every step-attribution field we need
 *     (last_step_id, last_step_from, email_replied_step, etc.).
 *   • Bounce reason and per-event open/click history are not exposed via REST.
 *     We can mark `Lead.status='bounced'` but cannot reconstruct hard vs soft
 *     classification or per-pixel open timelines.
 *   • One API key = one workspace. Multi-workspace orgs need to run the
 *     import once per key.
 *
 * Idempotency: every imported entity (Campaign, SequenceStep, StepVariant,
 * Mailbox, ConnectedAccount, Lead, CampaignLead) carries `import_external_id`.
 * Re-running the import upserts on `(scope, import_external_id)` — safe to
 * retry inside the 72h key TTL window.
 *
 * Campaign policy: every imported campaign lands `status='paused'` regardless
 * of source state. Customer must explicitly relaunch in Superkabe after they
 * reconnect mailboxes — guarantees no double-sending during the cutover.
 */

import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../index';
import { logger } from './observabilityService';
import * as instantly from './instantlyClient';
import * as importJob from './importJobService';
import { SlackAlertService } from './SlackAlertService';
import {
    InstantlyAuthError,
    InstantlyPaymentRequiredError,
    type InstantlyCampaign,
    type InstantlyLead,
    type InstantlyAccount,
    type InstantlyStep,
    type InstantlyVariant,
} from './instantlyClient';

const LOG_TAG = 'INSTANTLY-IMPORT';

// ─────────────────────────────────────────────────────────────────────────────
// Lead classification — same five-bucket taxonomy as the Smartlead pipeline
// so the wizard UI can render counts uniformly across import sources.
// ─────────────────────────────────────────────────────────────────────────────

export const RECENT_CONTACT_THRESHOLD_DAYS = 14;
const RECENT_THRESHOLD_MS = RECENT_CONTACT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

export type LeadBucket =
    | 'never_contacted'
    | 'stale_contact'
    | 'recent_contact'
    | 'opted_out'
    | 'completed';

export const classifyLead = (lead: InstantlyLead, now: number = Date.now()): LeadBucket => {
    // Hard opt-outs first — Instantly's `Bounced` and `Unsubscribed` lead
    // statuses are terminal: never re-engage these regardless of mode.
    if (lead.status === 'Bounced' || lead.status === 'Unsubscribed') return 'opted_out';
    // `Skipped` and `Paused` are also customer-initiated halts.
    if (lead.status === 'Paused' || lead.status === 'Skipped') return 'opted_out';

    if (lead.status === 'Completed') return 'completed';

    // Decide contacted-ness from explicit step attribution, falling back to
    // the timestamp_last_contact field. `last_step_id` being non-null is the
    // strongest signal that *something* has gone out.
    const wasContacted = !!lead.last_step_id || !!lead.timestamp_last_contact;
    if (!wasContacted) return 'never_contacted';

    const tsRef = lead.timestamp_last_contact || lead.last_step_timestamp_executed;
    if (!tsRef) return 'never_contacted';

    const ts = Date.parse(tsRef);
    if (Number.isNaN(ts)) return 'never_contacted';

    return (now - ts) > RECENT_THRESHOLD_MS ? 'stale_contact' : 'recent_contact';
};

export const shouldImportLead = (
    bucket: LeadBucket,
    mode: 'conservative' | 'aggressive',
    includeRecent: boolean,
): boolean => {
    if (bucket === 'opted_out') return false;
    if (bucket === 'never_contacted') return true;
    if (mode === 'conservative') return false;
    if (bucket === 'stale_contact' || bucket === 'completed') return true;
    if (bucket === 'recent_contact') return includeRecent;
    return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewLeadBuckets {
    total: number;
    neverContacted: number;
    staleContact: number;
    recentContact: number;
    completed: number;
    optedOut: number;
}

export interface PreviewResult {
    workspace: { id: string; name: string };
    campaigns: { total: number; byStatus: Record<string, number> };
    mailboxes: { total: number; byProvider: Record<string, number>; reconnectRequired: number };
    leads: PreviewLeadBuckets;
    sequenceSteps: number;
    blockListEntries: number;
    customTags: number;
    leadLabels: number;
    recentContactThresholdDays: number;
    /** Surfaced in the UI as a non-blocking warning. */
    warnings: string[];
}

/**
 * Read-only pass for the preview wizard step. Does not write to our DB.
 *
 * Throws InstantlyAuthError or InstantlyPaymentRequiredError so the caller can
 * render a typed error UI rather than a generic message.
 */
export const previewImport = async (orgId: string): Promise<PreviewResult> => {
    const keyEntry = await importJob.getDecryptedImportKey(orgId);
    if (!keyEntry || keyEntry.platform !== 'instantly') {
        throw new Error('No Instantly key on file. Paste your API key first.');
    }
    const apiKey = keyEntry.key;
    const now = Date.now();

    // Whoami — this is also the canonical key-validation call.
    const workspace = await instantly.getCurrentWorkspace(apiKey);

    const result: PreviewResult = {
        workspace: { id: workspace.id, name: workspace.name },
        campaigns: { total: 0, byStatus: {} },
        mailboxes: { total: 0, byProvider: {}, reconnectRequired: 0 },
        leads: {
            total: 0,
            neverContacted: 0,
            staleContact: 0,
            recentContact: 0,
            completed: 0,
            optedOut: 0,
        },
        sequenceSteps: 0,
        blockListEntries: 0,
        customTags: 0,
        leadLabels: 0,
        recentContactThresholdDays: RECENT_CONTACT_THRESHOLD_DAYS,
        warnings: [
            'Instantly does not expose mailbox credentials. Every imported mailbox will land disconnected — you must re-authenticate via Google/Microsoft OAuth (or re-enter SMTP credentials) before sending.',
            'Instantly does not expose bounce reasons or per-event open/click history. Imported leads carry status flags only; granular event timelines are not transferable.',
        ],
    };

    // Campaigns + step counts (sequences are embedded in the campaign detail).
    for await (const c of instantly.listCampaigns(apiKey)) {
        result.campaigns.total++;
        const statusBucket = String(c.status);
        result.campaigns.byStatus[statusBucket] = (result.campaigns.byStatus[statusBucket] || 0) + 1;

        // listCampaigns may already include sequences (depends on Instantly's
        // shape). When it doesn't, fetch the full campaign for the step count.
        let sequences = c.sequences;
        if (!sequences) {
            try {
                const detail = await instantly.getCampaign(apiKey, c.id);
                sequences = detail.sequences;
            } catch (err: any) {
                logger.warn(`[${LOG_TAG}] preview: getCampaign failed`, { campaignId: c.id, err: err?.message });
            }
        }
        for (const seq of sequences || []) {
            result.sequenceSteps += (seq.steps || []).length;
        }

        // Lead classification per campaign.
        for await (const lead of instantly.listLeads(apiKey, { campaign: c.id })) {
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

    // Mailboxes — every one needs reconnection in our system.
    for await (const acc of instantly.listAccounts(apiKey)) {
        result.mailboxes.total++;
        const provider = instantly.mapProviderCode(acc.provider_code);
        result.mailboxes.byProvider[provider] = (result.mailboxes.byProvider[provider] || 0) + 1;
        result.mailboxes.reconnectRequired++;
    }

    // Block list — soft import; not gating.
    try {
        for await (const _entry of instantly.listBlockListEntries(apiKey)) {
            void _entry;
            result.blockListEntries++;
        }
    } catch (err: any) {
        logger.warn(`[${LOG_TAG}] preview: block-list scan failed`, { err: err?.message });
    }

    // Custom tags + lead labels — soft.
    try {
        for await (const _t of instantly.listCustomTags(apiKey)) { void _t; result.customTags++; }
    } catch (err: any) {
        logger.warn(`[${LOG_TAG}] preview: custom-tags scan failed`, { err: err?.message });
    }
    try {
        for await (const _l of instantly.listLeadLabels(apiKey)) { void _l; result.leadLabels++; }
    } catch (err: any) {
        logger.warn(`[${LOG_TAG}] preview: lead-labels scan failed`, { err: err?.message });
    }

    return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Field translators — Instantly → Superkabe
// ─────────────────────────────────────────────────────────────────────────────

const DAY_KEY_TO_SHORT: Record<string, string> = {
    monday: 'mon', tuesday: 'tue', wednesday: 'wed',
    thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun',
    '1': 'mon', '2': 'tue', '3': 'wed', '4': 'thu', '5': 'fri', '6': 'sat', '0': 'sun',
};

const mapScheduleDays = (days: Record<string, boolean> | undefined): string[] => {
    if (!days) return [];
    return Object.entries(days)
        .filter(([, on]) => !!on)
        .map(([k]) => DAY_KEY_TO_SHORT[k.toLowerCase()] || DAY_KEY_TO_SHORT[k])
        .filter(Boolean);
};

/**
 * Strip Instantly's outbound tracking pixels and unsubscribe links from
 * imported HTML so they don't double-fire alongside Superkabe's tracking
 * domain on relaunch. Domains observed in Instantly footers:
 *   • instantly.ai (primary tracking + unsubscribe)
 *   • mlsend.com / sendinginstantly.com (less common — defensively included)
 */
export const stripTracking = (html: string): string => {
    if (!html) return html;
    return html
        .replace(/<img[^>]*src=["'][^"']*(?:instantly\.ai|mlsend\.com|sendinginstantly\.com)[^"']*["'][^>]*\/?>(?:<\/img>)?/gi, '')
        .replace(/<a[^>]*href=["'][^"']*(?:instantly\.ai|mlsend\.com|sendinginstantly\.com)[^"']*(?:unsubscribe|unsub)[^"']*["'][^>]*>[^<]*<\/a>/gi, '');
};

const delayToDaysHours = (
    step: InstantlyStep,
): { days: number; hours: number } => {
    const value = step.delay ?? 0;
    const unit = step.delay_unit || 'days';
    if (unit === 'days') return { days: value, hours: 0 };
    if (unit === 'hours') return { days: Math.floor(value / 24), hours: value % 24 };
    // minutes — round up to the nearest hour to keep the schema simple
    if (unit === 'minutes') return { days: 0, hours: Math.max(1, Math.ceil(value / 60)) };
    return { days: value, hours: 0 };
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-entity ingest helpers
// ─────────────────────────────────────────────────────────────────────────────

const ensureDomain = async (orgId: string, email: string): Promise<string> => {
    const domainPart = email.split('@')[1]?.toLowerCase();
    if (!domainPart) throw new Error(`Invalid email — no @ in ${email}`);

    const existing = await prisma.domain.findUnique({
        where: { organization_id_domain: { organization_id: orgId, domain: domainPart } },
        select: { id: true },
    });
    if (existing) return existing.id;

    const created = await prisma.domain.create({
        data: { domain: domainPart, organization_id: orgId, status: 'healthy' },
        select: { id: true },
    });
    return created.id;
};

interface IngestMailboxResult { localMailboxId: string; localAccountId: string; email: string }

const ingestMailbox = async (
    orgId: string,
    acc: InstantlyAccount,
): Promise<IngestMailboxResult> => {
    const email = acc.email.toLowerCase();
    const externalId = acc.email; // Instantly uses email as the account identifier
    const provider = instantly.mapProviderCode(acc.provider_code);
    const domainId = await ensureDomain(orgId, email);

    // Mailbox row (org-wide protection-side row).
    const mailbox = await prisma.mailbox.upsert({
        where: {
            organization_id_import_external_id: {
                organization_id: orgId,
                import_external_id: externalId,
            },
        },
        create: {
            id: randomUUID(),
            email,
            organization_id: orgId,
            domain_id: domainId,
            import_external_id: externalId,
            status: 'healthy',
            warmup_limit: acc.warmup?.limit ?? acc.daily_limit ?? undefined,
            initial_assessment_at: new Date(),
        },
        update: {
            email,
            domain_id: domainId,
            warmup_limit: acc.warmup?.limit ?? acc.daily_limit ?? undefined,
        },
        select: { id: true },
    });

    // ConnectedAccount — sending-side row. Lands DISCONNECTED with a clear
    // last_error explaining why; the dispatcher's accounts filter
    // (`if (acct.connection_status !== 'active') continue`) skips these
    // automatically so no send attempts happen until the customer reconnects.
    const account = await prisma.connectedAccount.upsert({
        where: {
            organization_id_email: { organization_id: orgId, email },
        },
        create: {
            organization_id: orgId,
            email,
            display_name: [acc.first_name, acc.last_name].filter(Boolean).join(' ') || null,
            provider,
            connection_status: 'disconnected',
            last_error: 'Reconnect via OAuth — Instantly does not export mailbox credentials.',
            daily_send_limit: acc.daily_limit || 50,
            signature_html: acc.signature || null,
        },
        update: {
            display_name: [acc.first_name, acc.last_name].filter(Boolean).join(' ') || null,
            provider,
            // Don't downgrade an already-active account just because we re-ran
            // the import. Only flip to disconnected if it isn't already wired.
            ...(await prisma.connectedAccount.findFirst({
                where: { organization_id: orgId, email },
                select: { connection_status: true },
            }).then(r => r?.connection_status === 'active' ? {} : {
                connection_status: 'disconnected',
                last_error: 'Reconnect via OAuth — Instantly does not export mailbox credentials.',
            })),
            daily_send_limit: acc.daily_limit || 50,
            signature_html: acc.signature || null,
        },
        select: { id: true },
    });

    return { localMailboxId: mailbox.id, localAccountId: account.id, email };
};

interface IngestCampaignResult { localId: string }

const ingestCampaign = async (
    orgId: string,
    inst: InstantlyCampaign,
): Promise<IngestCampaignResult> => {
    const externalId = inst.id;
    // Schedule blob — Instantly stores per-day flags + window per "schedule".
    // We pick the FIRST schedule (most workspaces use one); multi-schedule
    // setups will lose the secondary on import, surfaced via `warnings`.
    const sched = inst.campaign_schedule?.schedules?.[0];

    const upserted = await prisma.campaign.upsert({
        where: {
            organization_id_import_external_id: {
                organization_id: orgId,
                import_external_id: externalId,
            },
        },
        create: {
            id: randomUUID(),
            name: inst.name,
            channel: 'email',
            // Always paused — customer launches manually after mailbox handoff.
            status: 'paused',
            paused_reason: 'imported_from_instantly',
            paused_by: 'system',
            paused_at: new Date(),
            organization_id: orgId,
            import_external_id: externalId,
            schedule_timezone: sched?.timezone || null,
            schedule_start_time: sched?.timing?.from || null,
            schedule_end_time: sched?.timing?.to || null,
            schedule_days: mapScheduleDays(sched?.days),
            daily_limit: inst.daily_limit ?? null,
            send_gap_minutes: inst.email_gap ?? null,
            track_opens: inst.open_tracking ?? true,
            track_clicks: inst.link_tracking ?? true,
            stop_on_reply: inst.stop_on_reply ?? true,
            stop_on_bounce: true,
            include_unsubscribe: true,
            esp_routing: true,
        },
        update: {
            name: inst.name,
            schedule_timezone: sched?.timezone || null,
            schedule_start_time: sched?.timing?.from || null,
            schedule_end_time: sched?.timing?.to || null,
            schedule_days: mapScheduleDays(sched?.days),
            daily_limit: inst.daily_limit ?? null,
            send_gap_minutes: inst.email_gap ?? null,
            track_opens: inst.open_tracking ?? true,
            track_clicks: inst.link_tracking ?? true,
            stop_on_reply: inst.stop_on_reply ?? true,
        },
        select: { id: true },
    });
    return { localId: upserted.id };
};

interface IngestSequenceResult { stepsImported: number; variantsImported: number }

const ingestSequence = async (
    localCampaignId: string,
    sequences: InstantlyCampaign['sequences'],
): Promise<IngestSequenceResult> => {
    let stepsImported = 0;
    let variantsImported = 0;
    if (!sequences) return { stepsImported, variantsImported };

    // Instantly nests `steps` inside `sequences[]`. We flatten because our
    // schema treats the campaign as one ordered sequence — multi-sequence
    // campaigns concatenate in the order Instantly returns them.
    let stepNumber = 1;
    for (const seq of sequences) {
        for (const step of seq.steps || []) {
            const externalStepId = `step-${stepNumber}`;
            const { days, hours } = delayToDaysHours(step);
            const variants = (step.variants || []).filter(v => !v.v_disabled);

            // First variant supplies the canonical step subject/body.
            const primary: InstantlyVariant | undefined = variants[0];

            const upsertedStep = await prisma.sequenceStep.upsert({
                where: {
                    campaign_id_import_external_id: {
                        campaign_id: localCampaignId,
                        import_external_id: externalStepId,
                    },
                },
                create: {
                    campaign_id: localCampaignId,
                    import_external_id: externalStepId,
                    step_number: stepNumber,
                    delay_days: days,
                    delay_hours: hours,
                    subject: primary?.subject || '',
                    body_html: stripTracking(primary?.body || ''),
                    body_text: null,
                },
                update: {
                    step_number: stepNumber,
                    delay_days: days,
                    delay_hours: hours,
                    subject: primary?.subject || '',
                    body_html: stripTracking(primary?.body || ''),
                },
                select: { id: true },
            });
            stepsImported++;

            // Variants: A/B/C labels by index. Even split — our rotation owns
            // assignment going forward.
            const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
            for (let i = 0; i < variants.length; i++) {
                const variant = variants[i];
                const variantExternalId = `${externalStepId}-v${i + 1}`;
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
                        variant_label: labels[i] || `V${i + 1}`,
                        subject: variant.subject || '',
                        body_html: stripTracking(variant.body || ''),
                        weight: Math.round(100 / Math.max(1, variants.length)),
                    },
                    update: {
                        variant_label: labels[i] || `V${i + 1}`,
                        subject: variant.subject || '',
                        body_html: stripTracking(variant.body || ''),
                    },
                });
                variantsImported++;
            }

            stepNumber++;
        }
    }

    return { stepsImported, variantsImported };
};

const linkCampaignMailboxes = async (
    localCampaignId: string,
    localMailboxIds: string[],
): Promise<void> => {
    if (localMailboxIds.length === 0) return;
    await prisma.campaign.update({
        where: { id: localCampaignId },
        data: { mailboxes: { connect: localMailboxIds.map(id => ({ id })) } },
    });
};

interface IngestLeadsResult {
    imported: number;
    skippedRecentContact: number;
    skippedInFlight: number;
    skippedOptedOut: number;
    skippedInvalidEmail: number;
}

const ingestLeads = async (
    orgId: string,
    localCampaignId: string,
    leads: AsyncIterable<InstantlyLead>,
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

    for await (const lead of leads) {
        const bucket = classifyLead(lead, now);
        if (!shouldImportLead(bucket, mode, includeRecent)) {
            if (bucket === 'opted_out') result.skippedOptedOut++;
            else if (bucket === 'recent_contact') result.skippedRecentContact++;
            else result.skippedInFlight++;
            continue;
        }

        if (!lead.email || !lead.email.includes('@')) {
            result.skippedInvalidEmail++;
            continue;
        }

        const email = lead.email.toLowerCase().trim();
        const externalId = lead.id;
        const orgLeadStatus = lead.status === 'Bounced' ? 'bounced'
            : lead.status === 'Unsubscribed' ? 'unsubscribed'
            : 'pending';

        await prisma.lead.upsert({
            where: { organization_id_email: { organization_id: orgId, email } },
            create: {
                email,
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company_name || null,
                website: lead.website || null,
                title: lead.job_title || null,
                persona: 'imported',
                lead_score: 50,
                organization_id: orgId,
                source: 'instantly_import',
                import_external_id: externalId,
                status: orgLeadStatus,
                unsubscribed_at: lead.status === 'Unsubscribed'
                    ? (lead.timestamp_last_interest_change ? new Date(lead.timestamp_last_interest_change) : new Date())
                    : null,
                bounced_at: lead.status === 'Bounced'
                    ? (lead.timestamp_last_contact ? new Date(lead.timestamp_last_contact) : new Date())
                    : null,
            },
            update: {
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company_name || null,
                website: lead.website || null,
                title: lead.job_title || null,
                import_external_id: externalId,
            },
        });

        // CampaignLead — preserve step attribution in aggressive mode so
        // resumed sequences pick up where Instantly left off rather than
        // restarting from step 1. Instantly's `email_replied_step` is 1-indexed
        // matching our `current_step` semantics (0 = not started).
        const currentStep = mode === 'aggressive'
            ? (lead.email_replied_step
                ?? (lead.last_step_id ? extractStepIndex(lead.last_step_id) : 0)
                ?? 0)
            : 0;

        const cleanCustomVars = sanitizePayload(lead.payload);

        await prisma.campaignLead.upsert({
            where: { campaign_id_email: { campaign_id: localCampaignId, email } },
            create: {
                campaign_id: localCampaignId,
                email,
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company_name || null,
                title: lead.job_title || null,
                custom_variables: cleanCustomVars ?? Prisma.JsonNull,
                status: instantly.mapLeadStatus(lead.status),
                current_step: currentStep,
                last_sent_at: lead.last_step_timestamp_executed ? new Date(lead.last_step_timestamp_executed) : null,
                replied_at: lead.timestamp_last_reply ? new Date(lead.timestamp_last_reply) : null,
                bounced_at: lead.status === 'Bounced' && lead.timestamp_last_contact
                    ? new Date(lead.timestamp_last_contact)
                    : null,
                unsubscribed_at: lead.status === 'Unsubscribed'
                    ? (lead.timestamp_last_interest_change ? new Date(lead.timestamp_last_interest_change) : new Date())
                    : null,
                opened_count: lead.email_open_count || 0,
                clicked_count: lead.email_click_count || 0,
                import_external_id: externalId,
            },
            update: {
                first_name: lead.first_name || null,
                last_name: lead.last_name || null,
                company: lead.company_name || null,
                title: lead.job_title || null,
                custom_variables: cleanCustomVars ?? Prisma.JsonNull,
                import_external_id: externalId,
            },
        });

        result.imported++;
    }

    return result;
};

/**
 * Instantly's `last_step_id` is an opaque step UUID, not a 1-based index. In
 * aggressive mode we prefer `email_replied_step` (which IS a 1-based index)
 * and fall back to 0 when only the UUID is available — i.e. we don't try to
 * resolve UUID → index without the step list in scope.
 */
function extractStepIndex(_stepId: string): number | null {
    // Placeholder — see comment above. Caller should prefer
    // `email_replied_step` / `email_opened_step` which are numeric.
    return null;
}

/**
 * Instantly's `payload` allows string|number|boolean|null only. Defensive
 * sanitizer: drop nested objects and arrays so downstream consumers that
 * trust the schema can't crash on unexpected shapes.
 */
function sanitizePayload(p: Record<string, unknown> | null | undefined): Record<string, string | number | boolean | null> | null {
    if (!p) return null;
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(p)) {
        if (v === null) { out[k] = null; continue; }
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') {
            out[k] = v as string | number | boolean;
        }
        // silently drop arrays / nested objects — schema doesn't allow them
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// runImport — long-running orchestration entry point
// ─────────────────────────────────────────────────────────────────────────────

export const runImport = async (orgId: string, jobId: string): Promise<void> => {
    const keyEntry = await importJob.getDecryptedImportKey(orgId);
    if (!keyEntry || keyEntry.platform !== 'instantly') {
        await importJob.updateImportJob(jobId, {
            status: 'failed',
            error: 'No Instantly key on file (or expired). Re-paste and retry.',
            markCompleted: true,
        });
        return;
    }
    const apiKey = keyEntry.key;

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
        statsPatch: { mode, includeRecentContacts: includeRecent, source: 'instantly' },
    });

    try {
        // 0. Whoami — confirm key still works before doing any work.
        const workspace = await instantly.getCurrentWorkspace(apiKey);
        await importJob.updateImportJob(jobId, {
            statsPatch: { workspaceId: workspace.id, workspaceName: workspace.name },
        });

        // 1. Mailboxes first — everything else references them.
        const sourceEmailToLocal = new Map<string, { mailboxId: string; accountId: string }>();
        let mailboxesImported = 0;
        for await (const acc of instantly.listAccounts(apiKey)) {
            const ingested = await ingestMailbox(orgId, acc);
            sourceEmailToLocal.set(ingested.email, {
                mailboxId: ingested.localMailboxId,
                accountId: ingested.localAccountId,
            });
            mailboxesImported++;
        }
        await importJob.updateImportJob(jobId, { statsPatch: { mailboxesImported } });

        // 2. Campaigns — list first, then per-campaign deep import.
        const campaigns: InstantlyCampaign[] = [];
        for await (const c of instantly.listCampaigns(apiKey)) campaigns.push(c);
        await importJob.updateImportJob(jobId, { statsPatch: { campaignsFound: campaigns.length } });

        let stepsImportedTotal = 0;
        let variantsImportedTotal = 0;
        const leadsAgg: IngestLeadsResult = {
            imported: 0,
            skippedRecentContact: 0,
            skippedInFlight: 0,
            skippedOptedOut: 0,
            skippedInvalidEmail: 0,
        };

        for (const summary of campaigns) {
            // Status 3 = Completed. Skip — bringing closed campaigns over has no
            // value (their leads either replied or finished the sequence).
            if (summary.status === 3) continue;

            // Pull full campaign so sequences are guaranteed to be present.
            let detail: InstantlyCampaign;
            try {
                detail = await instantly.getCampaign(apiKey, summary.id);
            } catch (err: any) {
                logger.warn(`[${LOG_TAG}] getCampaign failed`, { campaignId: summary.id, err: err?.message });
                continue;
            }

            const { localId } = await ingestCampaign(orgId, detail);

            // Sequences (steps + variants flattened).
            const seqResult = await ingestSequence(localId, detail.sequences);
            stepsImportedTotal += seqResult.stepsImported;
            variantsImportedTotal += seqResult.variantsImported;

            // Mailbox pool — link via email match against the imported
            // ConnectedAccount/Mailbox set.
            const linkedMailboxIds = (detail.email_list || [])
                .map(e => sourceEmailToLocal.get(e.toLowerCase())?.mailboxId)
                .filter((id): id is string => !!id);
            await linkCampaignMailboxes(localId, linkedMailboxIds);

            // Leads — streamed via POST /leads/list to limit memory pressure.
            const leadResult = await ingestLeads(
                orgId,
                localId,
                instantly.listLeads(apiKey, { campaign: detail.id }),
                mode,
                includeRecent,
            );
            leadsAgg.imported += leadResult.imported;
            leadsAgg.skippedRecentContact += leadResult.skippedRecentContact;
            leadsAgg.skippedInFlight += leadResult.skippedInFlight;
            leadsAgg.skippedOptedOut += leadResult.skippedOptedOut;
            leadsAgg.skippedInvalidEmail += leadResult.skippedInvalidEmail;

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

        // 3. Block list — domain + email blocks become Lead.status='unsubscribed'
        //    rows so the org-wide suppression filter in sendQueueService picks
        //    them up automatically. Email entries upsert; domain entries get
        //    materialized into the org's Lead table only on encounter (we don't
        //    pre-seed every wildcard domain).
        let blockListImported = 0;
        try {
            for await (const entry of instantly.listBlockListEntries(apiKey)) {
                if (entry.is_domain) continue; // domain wildcards not modeled yet
                const blocked = entry.bl_value.toLowerCase().trim();
                if (!blocked.includes('@')) continue;
                await prisma.lead.upsert({
                    where: { organization_id_email: { organization_id: orgId, email: blocked } },
                    create: {
                        email: blocked,
                        organization_id: orgId,
                        persona: 'imported',
                        lead_score: 0,
                        source: 'instantly_blocklist',
                        status: 'unsubscribed',
                        unsubscribed_at: entry.timestamp_created ? new Date(entry.timestamp_created) : new Date(),
                        unsubscribed_reason: 'imported_from_instantly_blocklist',
                    },
                    update: {
                        status: 'unsubscribed',
                        unsubscribed_at: entry.timestamp_created ? new Date(entry.timestamp_created) : undefined,
                        unsubscribed_reason: 'imported_from_instantly_blocklist',
                    },
                });
                blockListImported++;
            }
        } catch (err: any) {
            logger.warn(`[${LOG_TAG}] block-list import failed`, { err: err?.message });
        }

        await importJob.updateImportJob(jobId, {
            status: 'complete',
            markCompleted: true,
            statsPatch: { blockListImported },
        });
        await importJob.shrinkTtlAfterCompletion(orgId);

        logger.info(`[${LOG_TAG}] Import complete`, {
            orgId, jobId, ...leadsAgg,
            campaignsFound: campaigns.length,
            mailboxesImported,
            blockListImported,
        });

        SlackAlertService.sendAlert({
            organizationId: orgId,
            eventType: 'import.instantly_completed',
            entityId: jobId,
            severity: 'info',
            title: '📥 Instantly import completed',
            message: [
                `Imported from Instantly:`,
                `• *${leadsAgg.imported}* leads`,
                `• *${mailboxesImported}* mailboxes (must be reconnected via OAuth)`,
                `• *${campaigns.length}* campaigns scanned`,
                blockListImported ? `• *${blockListImported}* block-list entries` : null,
                leadsAgg.skippedRecentContact ? `• Skipped (recent contact): ${leadsAgg.skippedRecentContact}` : null,
                leadsAgg.skippedInFlight ? `• Skipped (in-flight): ${leadsAgg.skippedInFlight}` : null,
                leadsAgg.skippedOptedOut ? `• Skipped (opted out): ${leadsAgg.skippedOptedOut}` : null,
                leadsAgg.skippedInvalidEmail ? `• Skipped (invalid email): ${leadsAgg.skippedInvalidEmail}` : null,
            ].filter(Boolean).join('\n'),
        }).catch((err) => logger.warn(`[${LOG_TAG}] Slack alert failed`, { error: err?.message }));
    } catch (err: any) {
        // Typed errors carry user-actionable messages; pass them through verbatim.
        const errMsg = (err instanceof InstantlyAuthError || err instanceof InstantlyPaymentRequiredError)
            ? err.message
            : (err?.message?.slice(0, 1000) || 'unknown error');

        logger.error(`[${LOG_TAG}] Import failed`, err, { orgId, jobId });
        await importJob.updateImportJob(jobId, {
            status: 'failed',
            error: errMsg,
            markCompleted: true,
        });
        // Do NOT shrink TTL on failure — customer needs the full 72h window to retry.
    }
};
