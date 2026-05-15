/**
 * Customer registry - resolves whether an engager on a LinkedIn post
 * works at a company that is already our customer (and the wider
 * relationship: active prospect, past lead, or net-new).
 *
 * The registry is COMPANY-LEVEL by design (B2B): a customer is an
 * account/company, not an individual person. The resolver matches the
 * engager's current company against the Customer table by:
 *
 *   1. Company LinkedIn slug - most reliable, exact match
 *   2. Normalised company_name (lowercased, trimmed)
 *
 * The table is populated from three sources:
 *   1. CRM sync (HubSpot Company / Salesforce Account, source='hubspot' | 'salesforce')
 *   2. CSV upload (source='csv') for orgs without a CRM connected
 *   3. Manual flag from an engager card (source='manual')
 *
 * The resolver returns one of four buckets per engager so the UI can
 * label the card and the operator knows whether to enroll, re-engage,
 * or skip:
 *
 *   - 'customer'         - Engager's company is in the Customer table.
 *   - 'active_prospect'  - Has Lead row + at least one ACTIVE CampaignLead.
 *   - 'past_lead'        - Has Lead row but no active CampaignLead.
 *   - 'new'              - No company match, no Lead row.
 *
 * A `confidence_note` string explains how the bucket was reached so the
 * operator can trust or interrogate the label ("matched Acme Corp via
 * HubSpot lifecycle_stage", "no CRM connected - inferred from outreach
 * history").
 */

import { prisma } from '../../prisma';

export type EngagerRelationship = 'customer' | 'active_prospect' | 'past_lead' | 'new';

export interface RelationshipInfo {
    relationship: EngagerRelationship;
    /** Short explainer the UI shows under the badge on hover. */
    confidence_note: string;
    /** Which source labelled this person a customer. NULL when not a customer. */
    customer_source?: 'hubspot' | 'salesforce' | 'csv' | 'manual' | null;
    /** The matched customer company name - surfaced on the engager card. */
    matched_company?: string | null;
}

interface ProfileLite {
    id: string;
    public_identifier: string;
    lead_id: string | null;
    /** LinkedIn-reported current employer name. The poller writes this on
     *  every profile snapshot. May be NULL for stale or anonymised profiles. */
    company: string | null;
}

/** Normalise a free-text company name for the match map. */
function normalizeCompany(name: string | null | undefined): string | null {
    if (!name) return null;
    return name
        .toLowerCase()
        .trim()
        // Strip common legal suffixes so "Acme, Inc." matches "Acme Inc".
        .replace(/[,.]/g, '')
        .replace(/\s+(inc|llc|ltd|gmbh|s\.?a\.?|sa|sas|plc|corp|corporation|company|co)\.?$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Bulk-resolve relationships for a batch of LinkedInProfile ids. Single
 * pass per data source - DO NOT call this per-row in a loop.
 */
export async function resolveRelationships(
    organizationId: string,
    profiles: ProfileLite[],
): Promise<Map<string, RelationshipInfo>> {
    const out = new Map<string, RelationshipInfo>();
    if (profiles.length === 0) return out;

    // Pull leads tied to these profiles so we can match outreach history.
    const leadIds = Array.from(new Set(profiles.map(p => p.lead_id).filter((x): x is string => Boolean(x))));
    const leads = leadIds.length > 0
        ? await prisma.lead.findMany({
            where: { id: { in: leadIds }, organization_id: organizationId },
            select: { id: true, email: true, company: true, company_linkedin_url: true },
        })
        : [];
    const leadById = new Map(leads.map(l => [l.id, l]));

    // Active campaign membership - pending/active/paused on this lead's
    // email counts as "still being worked." Suppressed/replied/completed
    // do not. Scoped via campaign.organization_id to stay tenant-safe.
    const activeRows = leadIds.length > 0
        ? await prisma.campaignLead.findMany({
            where: {
                campaign: { organization_id: organizationId },
                status: { in: ['pending', 'active', 'paused'] },
                email: { in: leads.map(l => l.email.toLowerCase()) },
            },
            select: { email: true },
            distinct: ['email'],
        })
        : [];
    const activeEmailSet = new Set(activeRows.map(r => r.email.toLowerCase()));

    // Customer lookup - load all rows for this org once. Keyed by
    // normalised company name (primary) and company LinkedIn slug
    // (secondary). At org-scale we expect <50k customer rows.
    const customers = await prisma.customer.findMany({
        where: { organization_id: organizationId },
        select: {
            company_name: true,
            company_linkedin_public_identifier: true,
            source: true,
            lifecycle_stage: true,
        },
    }) as Array<{ company_name: string; company_linkedin_public_identifier: string | null; source: string; lifecycle_stage: string | null }>;
    const customerByCompany = new Map<string, typeof customers[number]>();
    const customerBySlug = new Map<string, typeof customers[number]>();
    for (const c of customers) {
        const norm = normalizeCompany(c.company_name);
        if (norm) customerByCompany.set(norm, c);
        if (c.company_linkedin_public_identifier) {
            customerBySlug.set(c.company_linkedin_public_identifier.toLowerCase(), c);
        }
    }

    for (const p of profiles) {
        const lead = p.lead_id ? leadById.get(p.lead_id) : undefined;
        // Prefer the profile's current employer (most accurate for engagers
        // who may have changed jobs since the lead row was imported);
        // fall back to the lead's company field.
        const companyName = normalizeCompany(p.company) || normalizeCompany(lead?.company || null);
        const leadCompanySlug = lead?.company_linkedin_url
            ? extractCompanySlug(lead.company_linkedin_url)
            : null;

        const customer = (companyName && customerByCompany.get(companyName))
            || (leadCompanySlug && customerBySlug.get(leadCompanySlug))
            || null;

        if (customer) {
            const note = customer.source === 'csv'
                ? `Matched "${customer.company_name}" via uploaded customer list`
                : customer.source === 'manual'
                    ? `Marked "${customer.company_name}" as customer manually`
                    : `Matched "${customer.company_name}" via ${customer.source} (${customer.lifecycle_stage || 'customer'})`;
            out.set(p.id, {
                relationship: 'customer',
                confidence_note: note,
                customer_source: customer.source as RelationshipInfo['customer_source'],
                matched_company: customer.company_name,
            });
            continue;
        }

        const leadEmail = lead?.email?.toLowerCase();
        if (lead && leadEmail && activeEmailSet.has(leadEmail)) {
            out.set(p.id, {
                relationship: 'active_prospect',
                confidence_note: 'Currently enrolled in an active outreach sequence',
                customer_source: null,
                matched_company: null,
            });
            continue;
        }

        if (lead) {
            out.set(p.id, {
                relationship: 'past_lead',
                confidence_note: 'Touched by a prior campaign but not in any active sequence',
                customer_source: null,
                matched_company: null,
            });
            continue;
        }

        out.set(p.id, {
            relationship: 'new',
            confidence_note: 'No customer-company match and no prior outreach - net-new engager',
            customer_source: null,
            matched_company: null,
        });
    }

    return out;
}

// ────────────────────────────────────────────────────────────────────
// CSV ingest
//
// Accepts the parsed rows the controller has already extracted from the
// uploaded CSV. We do not parse the CSV here - keeping the multipart
// parsing in the controller layer.
//
// Match rule on re-import: source='csv' upserts by external_id when
// supplied (so the same upload doesn't double-insert); otherwise we
// fall back to (organization_id, company_name) and (organization_id,
// company slug) to dedupe across uploads with consistent identifiers.
// ────────────────────────────────────────────────────────────────────

export interface CustomerImportRow {
    company_name?: string | null;
    company_linkedin_url?: string | null;
    domain?: string | null;
    external_id?: string | null;
}

export interface ImportResult {
    inserted: number;
    updated: number;
    skipped: number;
    errors: Array<{ row_index: number; reason: string }>;
}

const COMPANY_SLUG_RE = /linkedin\.com\/company\/([^/?#]+)/i;

function extractCompanySlug(url: string | null | undefined): string | null {
    if (!url) return null;
    const m = url.match(COMPANY_SLUG_RE);
    return m ? m[1].toLowerCase().replace(/\/$/, '') : null;
}

export async function importCustomers(
    organizationId: string,
    rows: CustomerImportRow[],
    source: 'csv' | 'manual' | 'hubspot' | 'salesforce' = 'csv',
): Promise<ImportResult> {
    const result: ImportResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const company = r.company_name ? r.company_name.trim() : null;
        const slug = extractCompanySlug(r.company_linkedin_url || null);

        if (!company) {
            result.errors.push({ row_index: i, reason: 'Row needs a company_name' });
            result.skipped += 1;
            continue;
        }

        const normalized = normalizeCompany(company);

        // De-dup: same source+external_id is an exact resync; otherwise
        // match by slug (most reliable) and finally by company_name.
        const existing = await prisma.customer.findFirst({
            where: {
                organization_id: organizationId,
                OR: [
                    ...(r.external_id ? [{ source, external_id: r.external_id }] : []),
                    ...(slug ? [{ company_linkedin_public_identifier: slug }] : []),
                    ...(normalized ? [{ company_name: company }] : []),
                ],
            },
            select: { id: true },
        });

        if (existing) {
            await prisma.customer.update({
                where: { id: existing.id },
                data: {
                    company_name: company,
                    company_linkedin_public_identifier: slug ?? undefined,
                    domain: r.domain ?? undefined,
                    source,
                    external_id: r.external_id ?? undefined,
                },
            });
            result.updated += 1;
        } else {
            await prisma.customer.create({
                data: {
                    organization_id: organizationId,
                    company_name: company,
                    company_linkedin_public_identifier: slug,
                    domain: r.domain ?? null,
                    source,
                    external_id: r.external_id ?? null,
                },
            });
            result.inserted += 1;
        }
    }

    return result;
}
