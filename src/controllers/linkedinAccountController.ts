/**
 * LinkedIn account controller - REST surface for the Super LinkedIn
 * Accounts page.
 *
 *   GET    /api/linkedin/accounts                 - list connected accounts
 *   POST   /api/linkedin/accounts/connect-link    - hosted-auth URL (new)
 *   POST   /api/linkedin/accounts/:id/reconnect   - hosted-auth URL (reconnect)
 *   PATCH  /api/linkedin/accounts/:id             - update caps / display name
 *   DELETE /api/linkedin/accounts/:id             - disconnect
 */

import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import { isUnipileConfigured, posts as unipilePosts } from '../services/unipile';
import { getUnipile429Stats } from '../services/unipile/rateLimitTracker';
import {
    listAccountsForOrg, generateConnectLink, generateReconnectLink,
    disconnectAccount, updateAccount,
} from '../services/linkedin/accountService';
import {
    getLimitSummary, purchaseAddon, AccountLimitExceededError,
} from '../services/linkedin/accountLimitService';
import {
    createLinkedInAddonCheckout, isPolarConfigured as isAddonPolarConfigured,
} from '../services/linkedin/polarAddonCheckout';

export const list = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const [accounts, limits] = await Promise.all([
            listAccountsForOrg(orgId),
            getLimitSummary(orgId),
        ]);
        return res.json({ success: true, data: { accounts, limits } });
    } catch (err) {
        logger.error('[LINKEDIN-ACCT] list failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to list LinkedIn accounts' });
    }
};

export const limits = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const data = await getLimitSummary(orgId);
        return res.json({ success: true, data });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

/**
 * Purchase LinkedIn account-slot add-on(s).
 *
 * Two modes:
 *   - When POLAR_LINKEDIN_ADDON_PRODUCT_ID is configured, we create a
 *     Polar checkout and return `{ checkout_url }` so the UI redirects
 *     the user to Polar's hosted page. Final increment happens on the
 *     Polar webhook (so the user pays before getting the slot).
 *   - Without the env var (dev/staging), we increment the counter
 *     directly and return the updated limit summary. Stub mode keeps
 *     the UX testable before the Polar product id is wired in.
 */
export const purchaseAddonSlot = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const userId = req.orgContext?.userId;
        if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });

        const quantity = Math.max(1, Math.min(20, Number(req.body?.quantity) || 1));

        if (isAddonPolarConfigured()) {
            const checkout = await createLinkedInAddonCheckout({
                organizationId: orgId,
                userId,
                quantity,
            });
            return res.status(201).json({
                success: true,
                data: {
                    mode: 'polar',
                    checkout_url: checkout.checkoutUrl,
                    checkout_id: checkout.checkoutId,
                    quantity: checkout.quantity,
                    unit_price_usd: checkout.unitPriceUsd,
                },
            });
        }

        // Stub mode - direct increment + audit row.
        const summary = await purchaseAddon({ organizationId: orgId, userId, quantity });
        return res.status(201).json({
            success: true,
            data: { mode: 'stub', limits: summary },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const connectLink = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        // Surface stub mode explicitly so the UI can show a meaningful
        // error instead of a silent "no URL returned" toast.
        if (!isUnipileConfigured()) {
            return res.status(503).json({
                success: false,
                code: 'UNIPILE_NOT_CONFIGURED',
                error: 'Unipile API is not configured on this environment. Set UNIPILE_API_KEY + UNIPILE_API_BASE_URL to enable LinkedIn account connections.',
            });
        }
        const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
        const data = await generateConnectLink({
            organizationId: orgId,
            successRedirectUrl: `${frontend}/dashboard/linkedin/accounts?connected=1`,
            failureRedirectUrl: `${frontend}/dashboard/linkedin/accounts?connect_failed=1`,
        });
        return res.json({ success: true, data });
    } catch (err) {
        // 402 + structured payload when the cap is hit so the UI can switch
        // its primary CTA to "Buy add-on" without re-fetching limits.
        if (err instanceof AccountLimitExceededError) {
            return res.status(402).json({
                success: false,
                error: err.message,
                code: 'LINKEDIN_LIMIT_REACHED',
                limits: err.summary,
            });
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[LINKEDIN-ACCT] connectLink failed', err instanceof Error ? err : new Error(msg));
        return res.status(500).json({ success: false, error: msg || 'Failed to generate connect link' });
    }
};

export const reconnect = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        if (!isUnipileConfigured()) {
            return res.status(503).json({
                success: false,
                code: 'UNIPILE_NOT_CONFIGURED',
                error: 'Unipile API is not configured on this environment.',
            });
        }
        const data = await generateReconnectLink(orgId, String(req.params.id));
        return res.json({ success: true, data });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /not found/i.test(msg) ? 404 : 500;
        return res.status(code).json({ success: false, error: msg });
    }
};

/**
 * Validate + normalize the PATCH body for an account update. Without
 * this, a client could send `{ max_invites_per_day: -1000 }` or a non-
 * numeric value and the dispatcher would later compare against NaN or
 * a negative cap - both produce broken capacity behavior:
 *   - Negative cap → `used >= cap` is always true → account gets
 *     starved forever, no sends.
 *   - NaN cap → comparison always false → account dispatches
 *     unbounded, risks a LinkedIn block.
 *
 * Caps are clamped to LinkedIn's published ceilings + a safe floor so
 * an operator can't shoot themselves in the foot. We're intentionally
 * conservative - Drason chooses safe defaults over flexibility here.
 */
const CAP_LIMITS = {
    max_invites_per_day:        { min: 0, max: 100  },
    max_invites_per_week:       { min: 0, max: 200  },
    max_messages_per_day:       { min: 0, max: 200  },
    max_inmails_per_day:        { min: 0, max: 150  },
    max_profile_views_per_day:  { min: 0, max: 500  },
    // Daily Unipile read+write action budget. LinkedIn rumors a soft
    // block around 100/day; we cap operator-tunable values at 95 so
    // even an aggressive setting can't blow past the platform's
    // tolerance. Default (in schema) is 80.
    max_unipile_actions_per_day: { min: 0, max: 95  },
} as const;

interface AccountPatchInput {
    display_name?: string;
    inbox_sync_mode?: 'all' | 'sequence_only';
    max_invites_per_day?: number;
    max_invites_per_week?: number;
    max_messages_per_day?: number;
    max_inmails_per_day?: number;
    max_profile_views_per_day?: number;
    max_unipile_actions_per_day?: number;
}

function validateAccountPatch(body: unknown): { ok: true; data: AccountPatchInput } | { ok: false; error: string } {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Request body must be an object' };
    const src = body as Record<string, unknown>;
    const out: AccountPatchInput = {};

    if (src.display_name !== undefined) {
        if (typeof src.display_name !== 'string') return { ok: false, error: 'display_name must be a string' };
        const trimmed = src.display_name.trim();
        if (trimmed.length === 0) return { ok: false, error: 'display_name cannot be empty' };
        if (trimmed.length > 120) return { ok: false, error: 'display_name max 120 characters' };
        out.display_name = trimmed;
    }
    if (src.inbox_sync_mode !== undefined) {
        if (src.inbox_sync_mode !== 'all' && src.inbox_sync_mode !== 'sequence_only') {
            return { ok: false, error: "inbox_sync_mode must be 'all' or 'sequence_only'" };
        }
        out.inbox_sync_mode = src.inbox_sync_mode;
    }
    for (const key of Object.keys(CAP_LIMITS) as Array<keyof typeof CAP_LIMITS>) {
        if (src[key] === undefined) continue;
        const raw = src[key];
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
            return { ok: false, error: `${key} must be a finite integer` };
        }
        const { min, max } = CAP_LIMITS[key];
        if (n < min || n > max) {
            return { ok: false, error: `${key} must be between ${min} and ${max} (LinkedIn safety bounds)` };
        }
        (out as Record<string, unknown>)[key] = n;
    }
    return { ok: true, data: out };
}

export const update = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const parsed = validateAccountPatch(req.body);
        if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.error });
        const data = await updateAccount(orgId, String(req.params.id), parsed.data);
        if (!data) return res.status(404).json({ success: false, error: 'Account not found' });
        return res.json({ success: true, data });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ success: false, error: msg });
    }
};

export const remove = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        await disconnectAccount(orgId, String(req.params.id));
        return res.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /not found/i.test(msg) ? 404 : 500;
        return res.status(code).json({ success: false, error: msg });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/linkedin/accounts/:id - single account detail
//
// Returns the account row + a summary of the cached LinkedInPost rows
// (count, last_polled_at, post-type breakdown). The full post list is
// fetched separately via the /posts route below - keeps this endpoint
// small for the page header.
// ────────────────────────────────────────────────────────────────────

export const detail = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const account = await prisma.linkedInAccount.findFirst({
            where: { id, organization_id: orgId },
        });
        if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

        const [postCount, latestPost] = await Promise.all([
            prisma.linkedInPost.count({ where: { linkedin_account_id: id } }),
            prisma.linkedInPost.findFirst({
                where: { linkedin_account_id: id },
                orderBy: { posted_at: 'desc' },
                select: { posted_at: true, last_polled_at: true },
            }),
        ]);

        return res.json({
            success: true,
            data: {
                account: {
                    id: account.id,
                    unipile_account_id: account.unipile_account_id,
                    display_name: account.display_name,
                    account_type: account.account_type,
                    status: account.status,
                    status_detail: account.status_detail,
                    inbox_sync_mode: account.inbox_sync_mode,
                    invites_today: account.invites_today,
                    invites_this_week: account.invites_this_week,
                    messages_today: account.messages_today,
                    inmails_today: account.inmails_today,
                    profile_views_today: account.profile_views_today,
                    max_invites_per_day: account.max_invites_per_day,
                    max_invites_per_week: account.max_invites_per_week,
                    max_messages_per_day: account.max_messages_per_day,
                    max_inmails_per_day: account.max_inmails_per_day,
                    max_profile_views_per_day: account.max_profile_views_per_day,
                    connected_at: account.connected_at?.toISOString() ?? null,
                    last_status_at: account.last_status_at?.toISOString() ?? null,
                },
                post_stats: {
                    cached_post_count: postCount,
                    latest_posted_at: latestPost?.posted_at?.toISOString() ?? null,
                    latest_polled_at: latestPost?.last_polled_at?.toISOString() ?? null,
                },
                unipile_rate_limit: getUnipile429Stats(id),
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/linkedin/accounts/:id/posts - proxy Unipile's post listing
//
// Two-tier strategy:
//   1. Fetch live from Unipile (the source of truth for engagement counts)
//      so the UI always reflects reality even between poll cycles.
//   2. Hydrate each item with the cached LinkedInPost row we already keep
//      around for the signal poller, so reactions/comments/shares counts
//      use the diff-tracked snapshot if Unipile is rate-limited.
//
// Filters:
//   ?type=all|post|article|repost   - server-side filter on post kind
//   ?cursor=...                     - Unipile cursor for pagination
//   ?limit=N                        - Unipile page size (default 25, max 100)
// ────────────────────────────────────────────────────────────────────

export const listPosts = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const account = await prisma.linkedInAccount.findFirst({
            where: { id, organization_id: orgId },
            select: { id: true, unipile_account_id: true, status: true },
        });
        if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

        if (!isUnipileConfigured()) {
            return res.status(503).json({ success: false, error: 'Unipile not configured' });
        }

        const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
        const typeFilter = String(req.query.type ?? 'all').toLowerCase();

        let resp: Awaited<ReturnType<typeof unipilePosts.listAccountPosts>>;
        try {
            resp = await unipilePosts.listAccountPosts(account.unipile_account_id, { cursor, limit });
        } catch (unipileErr) {
            // Fallback: serve the cached posts so the UI isn't empty when
            // Unipile is rate-limited or transiently unavailable.
            const cached = await prisma.linkedInPost.findMany({
                where: { linkedin_account_id: id },
                orderBy: { posted_at: 'desc' },
                take: limit,
            });
            return res.json({
                success: true,
                data: {
                    items: cached.map(c => ({
                        id: c.unipile_post_id,
                        post_urn: undefined,
                        posted_at: c.posted_at.toISOString(),
                        text: undefined,
                        reaction_count: c.last_reaction_count,
                        comment_count: c.last_comment_count,
                        share_count: c.last_share_count,
                        source: 'cache' as const,
                        post_kind: 'post' as const, // can't infer without text/URN; sane default
                        is_thought_leadership: false, // not derivable from cache (no text)
                    })),
                    cursor: undefined,
                    served_from: 'cache',
                    upstream_error: unipileErr instanceof Error ? unipileErr.message : String(unipileErr),
                },
            });
        }

        // Hydrate with any cached engagement counts so we don't show zeros if
        // Unipile occasionally omits counts on the listing endpoint (it caps
        // some fields at the detail call). We trust Unipile's count when
        // provided; cache fills only the gaps.
        const idsFromLive = resp.items.map(p => p.id);
        const cached = idsFromLive.length > 0
            ? await prisma.linkedInPost.findMany({
                where: { linkedin_account_id: id, unipile_post_id: { in: idsFromLive } },
                select: { unipile_post_id: true, last_reaction_count: true, last_comment_count: true, last_share_count: true },
            })
            : [];
        const cacheByPostId = new Map(cached.map(c => [c.unipile_post_id, c]));

        const items = resp.items.map(p => {
            const c = cacheByPostId.get(p.id);
            const reaction_count = p.reaction_count ?? c?.last_reaction_count ?? 0;
            const comment_count  = p.comment_count  ?? c?.last_comment_count  ?? 0;
            const share_count    = p.share_count    ?? c?.last_share_count    ?? 0;
            const kind = inferPostKind(p);
            const tl = isThoughtLeadership({ post_urn: p.post_urn, text: p.text, reaction_count, comment_count });
            return {
                id: p.id,
                post_urn: p.post_urn,
                posted_at: p.posted_at,
                text: p.text,
                reaction_count,
                comment_count,
                share_count,
                source: 'live' as const,
                post_kind: kind,
                is_thought_leadership: tl,
            };
        });

        // Client-side filter - Unipile doesn't expose a server-side `type`
        // query parameter, so we infer (post / article / repost) from the
        // post body shape, and derive thought_leadership from the post +
        // engagement heuristic. When the operator picks the "post" bucket
        // we exclude thought-leadership rows so they don't double-count
        // across the two tabs.
        const filtered = (() => {
            switch (typeFilter) {
                case 'all':
                    return items;
                case 'thought_leadership':
                    return items.filter(p => p.is_thought_leadership);
                case 'post':
                    return items.filter(p => p.post_kind === 'post' && !p.is_thought_leadership);
                case 'article':
                case 'repost':
                    return items.filter(p => p.post_kind === typeFilter);
                default:
                    return items;
            }
        })();

        return res.json({
            success: true,
            data: {
                items: filtered,
                cursor: resp.cursor ?? null,
                served_from: 'live',
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

function inferPostKind(p: { post_urn?: string; text?: string }): 'post' | 'article' | 'repost' {
    const urn = (p.post_urn ?? '').toLowerCase();
    if (urn.includes(':article:') || urn.includes('article')) return 'article';
    if (urn.includes(':repost:') || urn.includes(':share:')) return 'repost';
    return 'post';
}

/**
 * Thought-leadership heuristic.
 *
 * Thought-leadership ≠ a distinct LinkedIn post type - it's an editorial
 * subset of plain posts (the long-form, opinion-bearing pieces that
 * generate meaningful conversation). v1 heuristic: kind='post', text is
 * substantive (≥ 500 chars), and the post earned meaningful engagement
 * (≥ 25 reactions). The thresholds intentionally exclude short status
 * updates and shares; we'll surface a "tune thresholds" UI later when
 * operators want to widen or tighten the bucket.
 */
function isThoughtLeadership(p: {
    post_urn?: string;
    text?: string;
    reaction_count?: number;
    comment_count?: number;
}): boolean {
    if (inferPostKind(p) !== 'post') return false;
    const len = (p.text ?? '').length;
    if (len < 500) return false;
    const reactions = p.reaction_count ?? 0;
    if (reactions < 25) return false;
    return true;
}

// ────────────────────────────────────────────────────────────────────
// GET /api/linkedin/accounts/:id/posts/:postId/engagements
//
// Per-post engagement drill-down. Takes the Unipile post id (the same
// id we surface in /posts) and returns the list of engagers we've
// observed for that post via the signal poller - the EngagementEvent
// rows joined with the actor LinkedInProfile, grouped per actor.
//
// One actor may have multiple events on the same post (reaction +
// comment counts separately under the schema's composite unique key).
// We collapse to one row per actor with an `events[]` summary so the
// UI shows "Priya - reacted PRAISE + commented" rather than two rows.
//
// Includes ICP match status, engagement score, connection state, and
// lead linkage so the page can render rich actor cards with single-
// click actions ("add to campaign / add to cold-call list").
// ────────────────────────────────────────────────────────────────────

export const listPostEngagements = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const accountId = String(req.params.id);
        const unipilePostId = String(req.params.postId);

        const account = await prisma.linkedInAccount.findFirst({
            where: { id: accountId, organization_id: orgId },
            select: { id: true },
        });
        if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

        // Resolve the LinkedInPost row (the signal poller upserts these).
        const post = await prisma.linkedInPost.findFirst({
            where: { linkedin_account_id: accountId, unipile_post_id: unipilePostId },
            select: { id: true, posted_at: true, last_polled_at: true, last_reaction_count: true, last_comment_count: true, last_share_count: true },
        });

        if (!post) {
            // Post not yet polled - we have no engagement events. Surface a
            // soft empty rather than a 404 so the UI can render an explanation.
            return res.json({
                success: true,
                data: {
                    post: null,
                    engagers: [],
                    totals: { unique_actors: 0, reactions: 0, comments: 0, shares: 0, reposts: 0 },
                    note: 'Post not yet polled by the signal monitoring worker. Engagement detail becomes available after the next poll cycle (≤ 6 hours).',
                },
            });
        }

        // All engagement events on this post, joined with the actor profile.
        const events = await prisma.engagementEvent.findMany({
            where: { linkedin_post_id: post.id, organization_id: orgId },
            orderBy: { occurred_at: 'desc' },
            include: {
                actor: {
                    select: {
                        id: true,
                        name: true,
                        headline: true,
                        company: true,
                        position: true,
                        location: true,
                        industry: true,
                        profile_picture_url: true,
                        public_identifier: true,
                        icp_match_score: true,
                        icp_matched_at: true,
                        linkedin_auto_tag: true,
                        linkedin_auto_tagged_at: true,
                        lead_id: true,
                        last_engaged_at: true,
                        engagement_count_30d: true,
                        engagement_score: true,
                    },
                },
            },
            take: 500, // sane cap; pagination can land later if a post goes viral
        });

        // Connection state for every actor (per the polling account's relation).
        const actorIds = Array.from(new Set(events.map(e => e.actor_profile_id)));
        const edges = actorIds.length > 0
            ? await prisma.linkedInConnectionEdge.findMany({
                where: {
                    linkedin_account_id: accountId,
                    linkedin_profile_id: { in: actorIds },
                },
                select: {
                    linkedin_profile_id: true,
                    status: true,
                    accepted_at: true,
                    invited_at: true,
                },
            })
            : [];
        const edgeByProfileId = new Map(edges.map(e => [e.linkedin_profile_id, e]));

        // Relationship resolution - joins each actor against the Customer
        // table, the Lead table, and active CampaignLead rows to bucket
        // them as customer / active_prospect / past_lead / new. Done in
        // bulk to keep this endpoint O(1) DB-roundtrips on the lookup.
        const { resolveRelationships } = await import('../services/linkedin/customerRegistryService');
        // Dedup by profile id - multiple events from the same actor on one
        // post would otherwise drive duplicate resolver entries.
        const uniqueProfiles = new Map<string, { id: string; public_identifier: string; lead_id: string | null; company: string | null }>();
        for (const e of events) {
            if (uniqueProfiles.has(e.actor_profile_id)) continue;
            uniqueProfiles.set(e.actor_profile_id, {
                id: e.actor_profile_id,
                public_identifier: e.actor.public_identifier,
                lead_id: e.actor.lead_id,
                company: e.actor.company,
            });
        }
        const relationshipByProfileId = await resolveRelationships(
            orgId,
            Array.from(uniqueProfiles.values()),
        );

        // Collapse per actor - one row each, with an events[] summary.
        interface EngagerRow {
            actor_profile_id: string;
            name: string;
            headline: string | null;
            company: string | null;
            position: string | null;
            location: string | null;
            industry: string | null;
            profile_picture_url: string | null;
            public_identifier: string;
            icp_match_score: number | null;
            icp_matched_at: string | null;
            linkedin_auto_tag: string | null;
            lead_id: string | null;
            last_engaged_at: string | null;
            engagement_count_30d: number;
            engagement_score: number | null;
            connection_status: string;
            connection_accepted_at: string | null;
            /** Customer / active_prospect / past_lead / new - see customerRegistryService. */
            relationship: 'customer' | 'active_prospect' | 'past_lead' | 'new';
            relationship_note: string;
            customer_source: string | null;
            events: Array<{ event_type: string; reaction_type: string | null; occurred_at: string }>;
        }

        const byActor = new Map<string, EngagerRow>();
        const totals = { reactions: 0, comments: 0, shares: 0, reposts: 0 };
        for (const e of events) {
            if (e.event_type === 'REACTION') totals.reactions += 1;
            else if (e.event_type === 'COMMENT') totals.comments += 1;
            else if (e.event_type === 'SHARE') totals.shares += 1;
            else if (e.event_type === 'REPOST') totals.reposts += 1;

            const existing = byActor.get(e.actor_profile_id);
            if (existing) {
                existing.events.push({
                    event_type: e.event_type,
                    reaction_type: e.reaction_type,
                    occurred_at: e.occurred_at.toISOString(),
                });
                continue;
            }
            const edge = edgeByProfileId.get(e.actor_profile_id);
            const rel = relationshipByProfileId.get(e.actor_profile_id);
            byActor.set(e.actor_profile_id, {
                actor_profile_id: e.actor_profile_id,
                name: e.actor.name,
                headline: e.actor.headline,
                company: e.actor.company,
                position: e.actor.position,
                location: e.actor.location,
                industry: e.actor.industry,
                profile_picture_url: e.actor.profile_picture_url,
                public_identifier: e.actor.public_identifier,
                icp_match_score: e.actor.icp_match_score,
                icp_matched_at: e.actor.icp_matched_at?.toISOString() ?? null,
                linkedin_auto_tag: e.actor.linkedin_auto_tag,
                lead_id: e.actor.lead_id,
                last_engaged_at: e.actor.last_engaged_at?.toISOString() ?? null,
                engagement_count_30d: e.actor.engagement_count_30d,
                engagement_score: e.actor.engagement_score,
                connection_status: edge?.status ?? 'NOT_CONNECTED',
                connection_accepted_at: edge?.accepted_at?.toISOString() ?? null,
                relationship: rel?.relationship ?? 'new',
                relationship_note: rel?.confidence_note ?? '',
                customer_source: rel?.customer_source ?? null,
                events: [{
                    event_type: e.event_type,
                    reaction_type: e.reaction_type,
                    occurred_at: e.occurred_at.toISOString(),
                }],
            });
        }

        const engagers = Array.from(byActor.values()).sort((a, b) => {
            // Most engagement, highest ICP score, then most recent.
            const eDiff = b.events.length - a.events.length;
            if (eDiff !== 0) return eDiff;
            const iDiff = (b.icp_match_score ?? 0) - (a.icp_match_score ?? 0);
            if (iDiff !== 0) return iDiff;
            const aLast = a.events[0]?.occurred_at ?? '';
            const bLast = b.events[0]?.occurred_at ?? '';
            return bLast.localeCompare(aLast);
        });

        return res.json({
            success: true,
            data: {
                post: {
                    unipile_post_id: unipilePostId,
                    posted_at: post.posted_at.toISOString(),
                    last_polled_at: post.last_polled_at?.toISOString() ?? null,
                    last_reaction_count: post.last_reaction_count,
                    last_comment_count: post.last_comment_count,
                    last_share_count: post.last_share_count,
                },
                engagers,
                totals: { ...totals, unique_actors: engagers.length },
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};
