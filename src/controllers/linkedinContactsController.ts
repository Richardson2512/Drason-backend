/**
 * LinkedIn Contacts controller.
 *
 * Super LinkedIn shares the workspace-level `Lead` table with Super
 * Sequencer - there's no separate `LinkedInContact` model. The LinkedIn
 * contacts page renders the subset of Leads that carry a `linkedin_url`
 * plus three LinkedIn-specific facets joined from the connection-edge
 * graph and campaign-enrollment counts:
 *
 *   - `connection_status` - derived from LinkedInConnectionEdge with any
 *     of the org's connected LinkedIn accounts (priority: CONNECTED >
 *     INVITE_ACCEPTED > INVITE_SENT > NOT_CONNECTED > unknown).
 *   - `via_account` - the LinkedInAccount that last issued an invite or
 *     established the connection (display_name).
 *   - `linkedin_campaign_count` - number of LinkedIn-channel campaigns
 *     this lead is enrolled in.
 *
 * Endpoints:
 *   GET    /api/linkedin/contacts                 - paginated list
 *   GET    /api/linkedin/contacts/facets          - distinct filter values
 *   POST   /api/linkedin/contacts                 - add single contact
 *   POST   /api/linkedin/contacts/bulk            - CSV / batch import
 *   POST   /api/linkedin/contacts/delete          - bulk delete
 *   POST   /api/linkedin/contacts/enroll-in-campaign
 *                                                 - push existing leads
 *                                                   into a LinkedIn
 *                                                   campaign (the "From
 *                                                   Sequencer" flow)
 *
 * Tag operations (per-row PUT + bulk-tag) reuse the unified sequencer
 * endpoints - leads are shared identity, so /api/sequencer/contacts/:id/
 * tags works for both channels.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { eraseLeadPII } from '../services/piiErasureService';

function parseCsv(raw: string | undefined): string[] {
    if (!raw || typeof raw !== 'string') return [];
    const seen = new Set<string>();
    for (const part of raw.split(',')) {
        const t = part.trim();
        if (t) seen.add(t);
    }
    return Array.from(seen);
}

/** Extract a LinkedIn slug from a full profile URL. */
function slugFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : null;
}

/**
 * Reduce a set of connection edges down to one canonical status per
 * profile. We prefer CONNECTED > INVITE_ACCEPTED > INVITE_SENT >
 * NOT_CONNECTED > NOT_DETERMINED. UI-facing status taxonomy collapses
 * these to a smaller set that mirrors what the page renders.
 */
type UiConnStatus = 'connected' | 'invite_sent' | 'not_connected' | 'unknown';
function rollupStatus(statuses: string[]): UiConnStatus {
    if (statuses.includes('CONNECTED') || statuses.includes('INVITE_ACCEPTED')) return 'connected';
    if (statuses.includes('INVITE_SENT')) return 'invite_sent';
    if (statuses.includes('NOT_CONNECTED') || statuses.includes('INVITE_REJECTED') || statuses.includes('INVITE_WITHDRAWN')) return 'not_connected';
    return 'unknown';
}

// ────────────────────────────────────────────────────────────────────
// GET /api/linkedin/contacts
// ────────────────────────────────────────────────────────────────────

export const list = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
        const search = (req.query.search as string)?.trim() || undefined;
        const status = (req.query.status as string) || undefined;
        const companies = parseCsv(req.query.companies as string | undefined);
        const titles = parseCsv(req.query.titles as string | undefined);
        const sources = parseCsv(req.query.sources as string | undefined);
        const tagIds = parseCsv(req.query.tag_ids as string | undefined);
        const connectionFilter = (req.query.connection_status as string) || 'all';

        // Base filter: org-scoped, has a LinkedIn URL, not PII-erased.
        const leadWhere: any = {
            organization_id: orgId,
            linkedin_url: { not: null },
            AND: [{ status: { not: 'erased' } }],
        };
        if (status && status !== 'all' && status !== 'erased') leadWhere.status = status;
        if (companies.length > 0) leadWhere.company = { in: companies };
        if (titles.length > 0) leadWhere.title = { in: titles };
        if (sources.length > 0) leadWhere.source = { in: sources };
        if (tagIds.length > 0) leadWhere.tags = { some: { tag_id: { in: tagIds } } };
        if (search) {
            leadWhere.OR = [
                { email: { contains: search, mode: 'insensitive' } },
                { first_name: { contains: search, mode: 'insensitive' } },
                { last_name: { contains: search, mode: 'insensitive' } },
                { full_name: { contains: search, mode: 'insensitive' } },
                { company: { contains: search, mode: 'insensitive' } },
                { title: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [leads, total] = await Promise.all([
            prisma.lead.findMany({
                where: leadWhere,
                orderBy: { created_at: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
                },
            }),
            prisma.lead.count({ where: leadWhere }),
        ]);

        // ── LinkedIn-specific joins ────────────────────────────────
        // Profile lookup by slug (org-scoped). Many leads may map to one
        // profile; the join key is `public_identifier`.
        const slugs = leads.map(l => slugFromUrl(l.linkedin_url)).filter((s): s is string => !!s);
        const profiles = slugs.length > 0
            ? await prisma.linkedInProfile.findMany({
                where: { organization_id: orgId, public_identifier: { in: slugs } },
                select: { id: true, public_identifier: true },
            })
            : [];
        const profileBySlug = new Map(profiles.map(p => [p.public_identifier.toLowerCase(), p]));

        // Pull connection edges for those profiles across all the org's
        // LinkedIn accounts in one shot. Then resolve account display
        // names so we can show "via Sarah".
        const profileIds = profiles.map(p => p.id);
        const orgAccounts = await prisma.linkedInAccount.findMany({
            where: { organization_id: orgId },
            select: { id: true, display_name: true },
        });
        const accountNameById = new Map(orgAccounts.map(a => [a.id, a.display_name]));

        const edges = profileIds.length > 0
            ? await prisma.linkedInConnectionEdge.findMany({
                where: {
                    linkedin_profile_id: { in: profileIds },
                    linkedin_account_id: { in: orgAccounts.map(a => a.id) },
                },
                select: {
                    linkedin_profile_id: true,
                    linkedin_account_id: true,
                    status: true,
                    invited_at: true,
                    accepted_at: true,
                },
            })
            : [];
        const edgesByProfile = new Map<string, typeof edges>();
        for (const e of edges) {
            const arr = edgesByProfile.get(e.linkedin_profile_id) ?? [];
            arr.push(e);
            edgesByProfile.set(e.linkedin_profile_id, arr);
        }

        // ── LinkedIn campaign enrollment count per lead ────────────
        // Count CampaignLead rows for each lead's email where the
        // campaign has at least one linkedin_* step (a campaign
        // operating on LinkedIn channel, even if channel='multi').
        const emails = leads.map(l => l.email);
        let enrollmentCounts = new Map<string, number>();
        if (emails.length > 0) {
            // Find LinkedIn-relevant campaign IDs for this org.
            const linkedInCampaigns = await prisma.campaign.findMany({
                where: {
                    organization_id: orgId,
                    deleted_at: null,
                    OR: [
                        { channel: 'linkedin' },
                        { channel: 'multi', steps: { some: { step_type: { startsWith: 'linkedin_' } } } },
                    ],
                },
                select: { id: true },
            });
            const linkedInCampaignIds = linkedInCampaigns.map(c => c.id);
            if (linkedInCampaignIds.length > 0) {
                const counts = await prisma.campaignLead.groupBy({
                    by: ['email'],
                    where: { campaign_id: { in: linkedInCampaignIds }, email: { in: emails } },
                    _count: true,
                });
                enrollmentCounts = new Map(counts.map(c => [c.email, c._count]));
            }
        }

        // Apply the connection_status filter post-join. (Could be pushed
        // down to SQL, but the row count is bounded by `limit` so the
        // in-memory pass is negligible.)
        type Row = ReturnType<typeof shape>;
        const shape = (lead: typeof leads[number]) => {
            const slug = slugFromUrl(lead.linkedin_url);
            const profile = slug ? profileBySlug.get(slug) : undefined;
            const profileEdges = profile ? (edgesByProfile.get(profile.id) ?? []) : [];
            const connection_status: UiConnStatus = profileEdges.length > 0
                ? rollupStatus(profileEdges.map(e => e.status))
                : 'unknown';
            // Pick the freshest edge (accepted_at > invited_at > undefined)
            // and resolve its account display name.
            const sortedEdges = [...profileEdges].sort((a, b) => {
                const aT = (a.accepted_at ?? a.invited_at ?? new Date(0)).getTime();
                const bT = (b.accepted_at ?? b.invited_at ?? new Date(0)).getTime();
                return bT - aT;
            });
            const via_account = sortedEdges[0]
                ? accountNameById.get(sortedEdges[0].linkedin_account_id) ?? null
                : null;

            return {
                id: lead.id,
                name: lead.full_name || `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || lead.email,
                headline: null as string | null, // not stored on Lead; UI tolerates null
                company: lead.company,
                title: lead.title,
                linkedin_url: lead.linkedin_url,
                email: lead.email && !lead.email.endsWith('@unresolved.local') ? lead.email : null,
                phone: lead.phone,
                connection_status,
                via_account,
                source: lead.source,
                campaign_count: enrollmentCounts.get(lead.email) ?? 0,
                lead_score: lead.lead_score,
                tags: lead.tags.map(lt => ({ id: lt.tag.id, name: lt.tag.name, color: lt.tag.color })),
                created_at: lead.created_at,
            };
        };

        let data: Row[] = leads.map(shape);
        if (connectionFilter !== 'all') {
            data = data.filter(r => r.connection_status === connectionFilter);
        }

        return res.json({
            success: true,
            contacts: data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (err) {
        logger.error('[LINKEDIN-CONTACTS] list failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to list contacts' });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/linkedin/contacts/facets
// ────────────────────────────────────────────────────────────────────

const FACET_LIMIT = 200;

export const facets = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const baseWhere: any = {
            organization_id: orgId,
            linkedin_url: { not: null },
            AND: [{ status: { not: 'erased' } }],
        };
        const [companyGroups, titleGroups, sourceGroups] = await Promise.all([
            prisma.lead.groupBy({
                by: ['company'],
                where: { ...baseWhere, company: { not: null } },
                _count: { _all: true },
                orderBy: { _count: { email: 'desc' } },
                take: FACET_LIMIT,
            }),
            prisma.lead.groupBy({
                by: ['title'],
                where: { ...baseWhere, title: { not: null } },
                _count: { _all: true },
                orderBy: { _count: { email: 'desc' } },
                take: FACET_LIMIT,
            }),
            prisma.lead.groupBy({
                by: ['source'],
                where: baseWhere,
                _count: { _all: true },
                orderBy: { _count: { email: 'desc' } },
                take: FACET_LIMIT,
            }),
        ]);
        return res.json({
            success: true,
            facets: {
                companies: companyGroups.filter(g => g.company).map(g => ({ value: g.company as string, count: g._count._all })),
                titles: titleGroups.filter(g => g.title).map(g => ({ value: g.title as string, count: g._count._all })),
                sources: sourceGroups.filter(g => g.source).map(g => ({ value: g.source as string, count: g._count._all })),
            },
        });
    } catch (err) {
        logger.error('[LINKEDIN-CONTACTS] facets failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to load facets' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/linkedin/contacts - single contact create
//
// A LinkedIn contact MUST carry a linkedin_url. Email is optional -
// many LinkedIn-only contacts won't have one (enrichment lands later).
// We follow the same Lead-row contract as the sequencer create, just
// with relaxed email validation.
// ────────────────────────────────────────────────────────────────────

interface IncomingContact {
    email?: string;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    company?: string;
    title?: string;
    persona?: string;
    phone?: string;
    linkedin_url: string;
    source?: string;
    tags?: string[]; // tag ids
}

function normalizeIncoming(c: IncomingContact, orgId: string): any {
    const linkedin_url = String(c.linkedin_url || '').trim();
    if (!linkedin_url) throw Object.assign(new Error('linkedin_url is required'), { http: 400 });
    if (!/linkedin\.com\/in\//i.test(linkedin_url)) {
        throw Object.assign(new Error('linkedin_url must be a https://www.linkedin.com/in/<slug> URL'), { http: 400 });
    }

    // Email is optional. If absent we synthesize a sentinel one so the
    // CampaignLead.email FK + the unique (campaign_id, email) index
    // still work - the dispatcher already understands @unresolved.local
    // as "pre-enrichment placeholder" (see signal-promotion path).
    const slug = slugFromUrl(linkedin_url) ?? `unknown-${Date.now()}`;
    const email = (c.email && c.email.includes('@')) ? c.email.trim().toLowerCase() : `lin_${slug}@unresolved.local`;

    return {
        organization_id: orgId,
        email,
        first_name: c.first_name?.trim() || null,
        last_name: c.last_name?.trim() || null,
        full_name: c.full_name?.trim() || ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || null,
        company: c.company?.trim() || null,
        title: c.title?.trim() || null,
        persona: c.persona?.trim() || c.title?.trim()?.toLowerCase() || 'general',
        phone: c.phone?.trim() || null,
        linkedin_url,
        source: c.source || 'manual',
        lead_score: 50,
        status: 'active',
    };
}

export const create = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const body = (req.body ?? {}) as IncomingContact;
        const data = normalizeIncoming(body, orgId);

        const lead = await prisma.lead.upsert({
            where: { organization_id_email: { organization_id: orgId, email: data.email } },
            create: data,
            update: {
                // Only fill in fields the operator provided - don't blow
                // away enriched values with placeholder nulls.
                ...(data.first_name ? { first_name: data.first_name } : {}),
                ...(data.last_name ? { last_name: data.last_name } : {}),
                ...(data.full_name ? { full_name: data.full_name } : {}),
                ...(data.company ? { company: data.company } : {}),
                ...(data.title ? { title: data.title } : {}),
                ...(data.phone ? { phone: data.phone } : {}),
                linkedin_url: data.linkedin_url,
            },
        });

        // Tags - validate they belong to this org, then upsert link rows.
        if (Array.isArray(body.tags) && body.tags.length > 0) {
            const validTags = await prisma.tag.findMany({
                where: { id: { in: body.tags }, organization_id: orgId },
                select: { id: true },
            });
            for (const t of validTags) {
                await prisma.leadTag.upsert({
                    where: { lead_id_tag_id: { lead_id: lead.id, tag_id: t.id } },
                    create: { lead_id: lead.id, tag_id: t.id },
                    update: {},
                });
            }
        }

        return res.status(201).json({ success: true, data: { id: lead.id, email: lead.email } });
    } catch (err: any) {
        if (err?.http) return res.status(err.http).json({ success: false, error: err.message });
        logger.error('[LINKEDIN-CONTACTS] create failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to create contact' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/linkedin/contacts/bulk - CSV / batch import
// ────────────────────────────────────────────────────────────────────

export const bulk = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const body = req.body as { contacts?: IncomingContact[] };
        const incoming = Array.isArray(body?.contacts) ? body.contacts : [];
        if (incoming.length === 0) {
            return res.status(400).json({ success: false, error: 'contacts array is required' });
        }
        if (incoming.length > 5000) {
            return res.status(400).json({ success: false, error: 'Maximum 5000 contacts per import. Split larger files.' });
        }

        let created = 0;
        let updated = 0;
        let skipped = 0;
        const errors: Array<{ index: number; error: string }> = [];

        for (let i = 0; i < incoming.length; i++) {
            try {
                const data = normalizeIncoming(incoming[i], orgId);
                const existing = await prisma.lead.findUnique({
                    where: { organization_id_email: { organization_id: orgId, email: data.email } },
                    select: { id: true },
                });
                if (existing) {
                    await prisma.lead.update({
                        where: { id: existing.id },
                        data: {
                            ...(data.first_name ? { first_name: data.first_name } : {}),
                            ...(data.last_name ? { last_name: data.last_name } : {}),
                            ...(data.full_name ? { full_name: data.full_name } : {}),
                            ...(data.company ? { company: data.company } : {}),
                            ...(data.title ? { title: data.title } : {}),
                            ...(data.phone ? { phone: data.phone } : {}),
                            linkedin_url: data.linkedin_url,
                        },
                    });
                    updated += 1;
                } else {
                    await prisma.lead.create({ data });
                    created += 1;
                }
            } catch (e: any) {
                skipped += 1;
                errors.push({ index: i, error: e?.message ?? 'Unknown error' });
            }
        }
        return res.status(201).json({
            success: true,
            data: { created, updated, skipped, total: incoming.length },
            errors: errors.slice(0, 50),
        });
    } catch (err) {
        logger.error('[LINKEDIN-CONTACTS] bulk failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Bulk import failed' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/linkedin/contacts/delete - bulk delete
//
// Routes through eraseLeadPII - the SINGLE erasure source of truth shared
// with the sequencer delete, recipient-DSAR, and full-account erasure.
// Previously this did a raw prisma.lead.deleteMany, which left the
// email-keyed PII (BounceEvent / SendEvent / EmailMessage) un-scrubbed
// for any LinkedIn contact that also had email activity - and leads are
// cross-channel, so that residue was real. Erasure tombstones the Lead
// in place (status='erased'); the list/facets endpoints already exclude
// status='erased', so the contact disappears from the UI exactly as it
// did before. LinkedIn contacts always carry a unique real-or-synthetic
// email (lin_<slug>@unresolved.local) so the (org,email) erasure lookup
// always resolves - there is no null-email edge here.
// ────────────────────────────────────────────────────────────────────

export const remove = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
        if (ids.length === 0) {
            return res.status(400).json({ success: false, error: 'ids array is required' });
        }
        // Resolve emails for the ids, then run the canonical per-recipient
        // erasure - identical loop to eraseOrganization and the sequencer
        // deleteContacts path, so all four delete entry points behave the
        // same and there is exactly one erasure implementation to maintain.
        const leads = await prisma.lead.findMany({
            where: { id: { in: ids }, organization_id: orgId },
            select: { email: true },
        });
        let deleted = 0;
        for (const row of leads) {
            // Skip already-erased rows (tombstone email prefix).
            if (row.email.startsWith('erased-')) continue;
            const r = await eraseLeadPII(orgId, row.email);
            if (r.leadFound) deleted++;
        }
        return res.json({ success: true, data: { deleted } });
    } catch (err) {
        logger.error('[LINKEDIN-CONTACTS] delete failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Delete failed' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/linkedin/contacts/enroll-in-campaign
//
// The "From Super Sequencer" workflow. Takes a list of lead ids + a
// target LinkedIn campaign and upserts CampaignLead rows for each.
// Idempotent - leads already enrolled are skipped (not duplicated).
//
// Body:
//   { lead_ids: string[], campaign_id: string }
// Returns:
//   { enrolled, already_in_campaign, skipped_no_linkedin, errors }
// ────────────────────────────────────────────────────────────────────

export const enrollInCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const leadIds = Array.isArray(req.body?.lead_ids) ? (req.body.lead_ids as unknown[]).map(String) : [];
        const campaignId = String(req.body?.campaign_id || '');
        if (leadIds.length === 0) return res.status(400).json({ success: false, error: 'lead_ids array is required' });
        if (!campaignId) return res.status(400).json({ success: false, error: 'campaign_id is required' });
        if (leadIds.length > 5000) return res.status(400).json({ success: false, error: 'Maximum 5000 leads per enroll. Split.' });

        // Validate the campaign is a LinkedIn-relevant one in this org.
        const campaign = await prisma.campaign.findFirst({
            where: {
                id: campaignId,
                organization_id: orgId,
                deleted_at: null,
                OR: [
                    { channel: 'linkedin' },
                    { channel: 'multi', steps: { some: { step_type: { startsWith: 'linkedin_' } } } },
                ],
            },
            select: { id: true },
        });
        if (!campaign) {
            return res.status(400).json({ success: false, error: 'Campaign not found or is not a LinkedIn campaign in this org' });
        }

        // Fetch the leads - must be org-owned + have a linkedin_url.
        const leads = await prisma.lead.findMany({
            where: { id: { in: leadIds }, organization_id: orgId },
            select: { id: true, email: true, first_name: true, last_name: true, company: true, title: true, linkedin_url: true },
        });
        const enrollable = leads.filter(l => l.linkedin_url);
        const skipped_no_linkedin = leads.length - enrollable.length;

        // Existing enrollments - avoid double-counting.
        const existingByEmail = new Set(
            (await prisma.campaignLead.findMany({
                where: { campaign_id: campaignId, email: { in: enrollable.map(l => l.email) } },
                select: { email: true },
            })).map(r => r.email),
        );

        let enrolled = 0;
        let already = 0;
        const errors: Array<{ lead_id: string; error: string }> = [];
        for (const l of enrollable) {
            if (existingByEmail.has(l.email)) { already += 1; continue; }
            try {
                await prisma.campaignLead.create({
                    data: {
                        campaign_id: campaignId,
                        email: l.email,
                        first_name: l.first_name,
                        last_name: l.last_name,
                        company: l.company,
                        title: l.title,
                        status: 'active',
                        current_step: 0,
                        // next_send_at left null - the launch endpoint
                        // seeds it on first start, and the dispatcher
                        // ignores nulls.
                    },
                });
                enrolled += 1;
            } catch (e: any) {
                errors.push({ lead_id: l.id, error: e?.message ?? 'Insert failed' });
            }
        }

        return res.json({
            success: true,
            data: {
                enrolled,
                already_in_campaign: already,
                skipped_no_linkedin,
                total_requested: leadIds.length,
            },
            errors: errors.slice(0, 50),
        });
    } catch (err) {
        logger.error('[LINKEDIN-CONTACTS] enroll failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Enroll failed' });
    }
};
