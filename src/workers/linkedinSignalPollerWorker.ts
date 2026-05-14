/**
 * LinkedIn signal-monitoring poller (Phase 4).
 *
 * Unipile does NOT push engagement events on a user's own posts — their
 * webhook event list explicitly excludes likes / reactions / comments /
 * shares on the connected user's content (per the Unipile real-time
 * docs). The only way to detect them is to POLL.
 *
 * Their guidance: "few times per day, random spacing — don't fixed-time"
 * to avoid LinkedIn's bot-detection. We schedule 4 cycles/day per
 * organization with ±20min jitter on each cycle.
 *
 * Per cycle, for every connected LinkedIn account:
 *   1. Fetch the user's posts within the active window (last 14 days).
 *   2. For each post whose reaction_count / comment_count differs from
 *      our last_*_count, pull the full reactor / commenter lists and
 *      diff against EngagementEvent rows.
 *   3. New events are inserted (uniqueness enforced at DB level on
 *      (post_id, actor_profile_id, event_type, reaction_type)).
 *   4. Each new event is dispatched to the supervisor for ICP-match +
 *      enrichment + action (Phase 4 cont.).
 *
 * Stubbed when UNIPILE_API_KEY is unset — the worker still ticks but
 * skips the actual fetch, keeping logs quiet in dev.
 */

import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { isUnipileConfigured, posts as unipilePosts, users as unipileUsers } from '../services/unipile';
import {
    recordEngagementOnProfile,
    applyEngagementAutoTag,
} from '../services/linkedin/engagementRollupService';

// Hydrate richer profile fields (company / position / location / industry)
// at most once per week per profile. Each hydration costs one Unipile API
// call, so we cap to keep workspace-wide poll cycles bounded.
//
// Two-tier budget:
//   - MAX_PROFILE_HYDRATIONS_PER_CYCLE — workspace-wide ceiling. Caps
//     total Unipile spend across all accounts in one cycle.
//   - MAX_HYDRATIONS_PER_ACCOUNT_PER_CYCLE — per-account ceiling. Stops
//     a single high-volume account (1000+ reactions on a viral post)
//     from draining the global pool before other accounts get a turn.
//
// In practice the per-account cap kicks in well before the global one,
// keeping the poll cycle fair across senders even when one account is
// engagement-heavy. The global cap is the safety net for orgs with many
// active LinkedIn senders.
const PROFILE_HYDRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROFILE_HYDRATIONS_PER_CYCLE = 50;
const MAX_HYDRATIONS_PER_ACCOUNT_PER_CYCLE = 15;

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h between cycles ⇒ 4/day baseline
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;
const JITTER_MS = 20 * 60 * 1000; // ±20min random offset

const POST_LOOKBACK_DAYS = 14;

let scheduled: NodeJS.Timeout | null = null;
let nextRunAt: Date | null = null;
let totalCycles = 0;
let totalEventsIngested = 0;
let lastError: string | null = null;

function jitter(baseMs: number): number {
    return baseMs + Math.floor((Math.random() - 0.5) * JITTER_MS * 2);
}

/**
 * Run one complete polling cycle across every connected account in
 * every org. Idempotent: dedup happens at insert via the composite
 * unique on EngagementEvent.
 */
export async function runOnce(): Promise<{ accountsScanned: number; eventsInserted: number }> {
    if (!isUnipileConfigured()) {
        logger.debug('[LINKEDIN-POLLER] Unipile not configured — skipping cycle');
        return { accountsScanned: 0, eventsInserted: 0 };
    }

    const lookbackCutoff = new Date(Date.now() - POST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    // Only poll accounts in OK / SYNC_SUCCESS status. Disconnected
    // accounts will throw on the Unipile API call anyway.
    const accounts = await prisma.linkedInAccount.findMany({
        where: { status: { in: ['OK', 'SYNC_SUCCESS'] } },
        select: { id: true, organization_id: true, unipile_account_id: true },
    });

    let eventsInserted = 0;
    // Workspace-wide hydration budget — safety net so a cycle never spends
    // more than MAX_PROFILE_HYDRATIONS_PER_CYCLE Unipile profile calls
    // across all orgs.
    const globalHydrationBudget = { remaining: MAX_PROFILE_HYDRATIONS_PER_CYCLE };
    for (const acct of accounts) {
        if (globalHydrationBudget.remaining <= 0) {
            // Still poll the rest of the accounts (ingestion needs to
            // continue) but disable hydration with an exhausted local
            // budget. Engagers will be upserted with sparse fields and
            // get richer data on the next cycle.
        }
        // Each account gets its own slice — capped at the per-account
        // ceiling and also clamped by whatever's left in the global pool.
        const perAccountBudget = {
            remaining: Math.min(MAX_HYDRATIONS_PER_ACCOUNT_PER_CYCLE, globalHydrationBudget.remaining),
        };
        try {
            const before = perAccountBudget.remaining;
            eventsInserted += await pollOneAccount(acct, lookbackCutoff, perAccountBudget);
            // Drain whatever this account used out of the global pool.
            const used = before - perAccountBudget.remaining;
            globalHydrationBudget.remaining = Math.max(0, globalHydrationBudget.remaining - used);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('[LINKEDIN-POLLER] Per-account cycle failed', {
                account_id: acct.id,
                err: msg.slice(0, 200),
            });
        }
    }

    return { accountsScanned: accounts.length, eventsInserted };
}

async function pollOneAccount(
    acct: { id: string; organization_id: string; unipile_account_id: string },
    lookbackCutoff: Date,
    hydrationBudget: { remaining: number },
): Promise<number> {
    // List recent posts; cap at one page (50) per cycle — we'll catch
    // older posts on subsequent cycles if they continue accruing reactions.
    const postsResp = await unipilePosts.listAccountPosts(acct.unipile_account_id, {
        limit: 50,
        localAccountId: acct.id,
    });
    const items = postsResp.items || [];

    let inserted = 0;
    for (const p of items) {
        const postedAt = new Date(p.posted_at);
        if (postedAt < lookbackCutoff) continue;

        // Upsert the post row so we can diff against the previous cycle.
        // Capture post text + post_kind so the signal-icebreaker generator
        // can ground its prompt in what the post actually said. We only
        // write `text` on create (not update) to avoid clobbering an
        // operator-curated value, but refresh on every cycle if it's
        // still null in the DB.
        const postKind = inferPostKindForPoller(p);
        const local = await prisma.linkedInPost.upsert({
            where: { unipile_post_id: p.id },
            create: {
                linkedin_account_id: acct.id,
                unipile_post_id: p.id,
                posted_at: postedAt,
                text: p.text ?? null,
                post_kind: postKind,
                last_reaction_count: p.reaction_count ?? 0,
                last_comment_count: p.comment_count ?? 0,
                last_share_count: p.share_count ?? 0,
                last_polled_at: new Date(),
            } as any,
            update: {
                last_polled_at: new Date(),
                // Refresh text if it was null (older row predating this
                // capture). Don't overwrite when already set — operators
                // may have inline-edited it via a tools surface later.
                ...(p.text ? { text: p.text } : {}),
                ...(postKind ? { post_kind: postKind } : {}),
            } as any,
        });

        const reactionDelta = (p.reaction_count ?? 0) - local.last_reaction_count;
        const commentDelta = (p.comment_count ?? 0) - local.last_comment_count;

        if (reactionDelta > 0) inserted += await ingestReactions(acct.organization_id, local.id, acct.unipile_account_id, p.id, hydrationBudget);
        if (commentDelta > 0) inserted += await ingestComments(acct.organization_id, local.id, acct.unipile_account_id, p.id, hydrationBudget);

        // Persist the new totals so the next cycle's diff is correct.
        await prisma.linkedInPost.update({
            where: { id: local.id },
            data: {
                last_reaction_count: p.reaction_count ?? 0,
                last_comment_count: p.comment_count ?? 0,
                last_share_count: p.share_count ?? 0,
            },
        });
    }

    return inserted;
}

async function ingestReactions(orgId: string, localPostId: string, accountId: string, postId: string, hydrationBudget: { remaining: number }): Promise<number> {
    const resp = await unipilePosts.listPostReactions(postId, { limit: 100 });
    const items = resp.items || [];
    let inserted = 0;
    for (const r of items) {
        if (!r.actor_public_identifier && !r.actor_member_urn) continue;
        const profile = await upsertProfileSnapshot(orgId, r.actor_public_identifier, r.actor_member_urn, r.actor_full_name, r.actor_headline, r.actor_picture_url);
        const occurredAt = r.reacted_at ? new Date(r.reacted_at) : new Date();
        try {
            await prisma.engagementEvent.create({
                data: {
                    organization_id: orgId,
                    linkedin_post_id: localPostId,
                    actor_profile_id: profile.id,
                    event_type: 'REACTION',
                    reaction_type: r.type,
                    occurred_at: occurredAt,
                },
            });
            inserted++;
            await recordEngagementOnProfile(orgId, profile.id, localPostId, occurredAt);
            await applyEngagementAutoTag(orgId, profile.id, 'REACTION', r.type);
            await maybeHydrateProfile(orgId, accountId, profile, hydrationBudget);
        } catch (err) {
            // Unique constraint violation on (post, actor, event, reaction) is
            // the expected dedup signal — skip silently. Anything else logged.
            const code = (err as { code?: string })?.code;
            if (code !== 'P2002') logger.warn('[LINKEDIN-POLLER] reaction insert failed', { err: String(err).slice(0, 200) });
        }
    }
    return inserted;
}

async function ingestComments(orgId: string, localPostId: string, accountId: string, postId: string, hydrationBudget: { remaining: number }): Promise<number> {
    const resp = await unipilePosts.listPostComments(postId, { limit: 100 });
    const items = resp.items || [];
    let inserted = 0;
    for (const c of items) {
        if (!c.actor_public_identifier && !c.actor_member_urn) continue;
        const profile = await upsertProfileSnapshot(orgId, c.actor_public_identifier, c.actor_member_urn, c.actor_full_name, null, null);
        const occurredAt = c.commented_at ? new Date(c.commented_at) : new Date();
        try {
            await prisma.engagementEvent.create({
                data: {
                    organization_id: orgId,
                    linkedin_post_id: localPostId,
                    actor_profile_id: profile.id,
                    event_type: 'COMMENT',
                    reaction_type: null,
                    occurred_at: occurredAt,
                    // Comment text is the strongest grounding signal for
                    // the AI icebreaker — quotes the engager's own words.
                    // Cap at 1000 chars; longer comments are paragraphs
                    // we don't need verbatim.
                    comment_text: c.text ? c.text.slice(0, 1000) : null,
                } as any,
            });
            inserted++;
            await recordEngagementOnProfile(orgId, profile.id, localPostId, occurredAt);
            await applyEngagementAutoTag(orgId, profile.id, 'COMMENT', null);
            await maybeHydrateProfile(orgId, accountId, profile, hydrationBudget);
        } catch (err) {
            const code = (err as { code?: string })?.code;
            if (code !== 'P2002') logger.warn('[LINKEDIN-POLLER] comment insert failed', { err: String(err).slice(0, 200) });
        }
    }
    return inserted;
}

interface ProfileShape {
    id: string;
    public_identifier: string;
    last_profile_fetch: Date | null;
    company: string | null;
    position: string | null;
    location: string | null;
    industry: string | null;
}

async function upsertProfileSnapshot(
    organizationId: string,
    publicId: string | undefined,
    memberUrn: string | undefined,
    name: string | undefined,
    headline: string | null | undefined,
    pictureUrl: string | null | undefined,
): Promise<ProfileShape> {
    const identifier = publicId || memberUrn || 'unknown';
    const now = new Date();
    // Stamp last_profile_fetch on every upsert so the hydration scheduler
    // can decide when the row is due for a richer refresh.
    const row = await prisma.linkedInProfile.upsert({
        where: { organization_id_public_identifier: { organization_id: organizationId, public_identifier: identifier } },
        create: {
            organization_id: organizationId,
            public_identifier: identifier,
            member_urn: memberUrn,
            name: name || identifier,
            headline: headline || null,
            profile_picture_url: pictureUrl || null,
            last_profile_fetch: now,
        },
        update: {
            // Only refresh display fields when we have new data — keeps
            // the cache stable for the rest of the pipeline.
            ...(name ? { name } : {}),
            ...(headline ? { headline } : {}),
            ...(memberUrn ? { member_urn: memberUrn } : {}),
            ...(pictureUrl ? { profile_picture_url: pictureUrl } : {}),
            last_profile_fetch: now,
        },
        select: {
            id: true, public_identifier: true, last_profile_fetch: true,
            company: true, position: true, location: true, industry: true,
        },
    });
    return row as ProfileShape;
}

/**
 * Hydrate the richer profile fields (company / position / location /
 * industry) from Unipile's getProfile endpoint. The reaction / comment
 * payloads only carry display-name + headline + picture, so without this
 * call the schema columns for those fields would stay empty forever.
 *
 * Budget-controlled: each cycle is capped at MAX_PROFILE_HYDRATIONS_PER_CYCLE
 * extra API calls, and we only refresh profiles that haven't been
 * hydrated in the last week (or that have all rich fields empty).
 */
async function maybeHydrateProfile(
    orgId: string,
    accountId: string,
    profile: ProfileShape,
    budget: { remaining: number },
): Promise<void> {
    if (budget.remaining <= 0) return;

    const ageMs = profile.last_profile_fetch ? Date.now() - profile.last_profile_fetch.getTime() : Infinity;
    const isStale = ageMs > PROFILE_HYDRATION_TTL_MS;
    const isEmpty = !profile.company && !profile.position && !profile.location && !profile.industry;
    // Always hydrate a freshly-created profile (all rich fields empty)
    // even if we just bumped its last_profile_fetch in the upsert.
    if (!isEmpty && !isStale) return;

    budget.remaining -= 1;
    try {
        const full = await unipileUsers.getProfile(accountId, profile.public_identifier);
        await prisma.linkedInProfile.update({
            where: { id: profile.id },
            data: {
                ...(full.full_name ? { name: full.full_name } : {}),
                ...(full.headline ? { headline: full.headline } : {}),
                ...(full.company ? { company: full.company } : {}),
                ...(full.position ? { position: full.position } : {}),
                ...(full.location ? { location: full.location } : {}),
                ...(full.industry ? { industry: full.industry } : {}),
                ...(full.picture_url ? { profile_picture_url: full.picture_url } : {}),
                ...(full.member_urn ? { member_urn: full.member_urn } : {}),
                last_profile_fetch: new Date(),
            },
        });
    } catch (err) {
        // Profile hydration is best-effort; ingestion must continue. A
        // common failure mode is the actor's profile being un-fetchable
        // for the polling account (Unipile permissions / privacy).
        logger.debug('[LINKEDIN-POLLER] profile hydration skipped', { err: String(err).slice(0, 200), publicId: profile.public_identifier });
    }
}

async function tick(): Promise<void> {
    totalCycles += 1;
    const startedAt = Date.now();
    try {
        const result = await runOnce();
        totalEventsIngested += result.eventsInserted;
        lastError = null;
        if (result.accountsScanned > 0 || result.eventsInserted > 0) {
            logger.info('[LINKEDIN-POLLER] Cycle complete', {
                accounts: result.accountsScanned,
                events: result.eventsInserted,
                latencyMs: Date.now() - startedAt,
            });
        }
    } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('[LINKEDIN-POLLER] Cycle failed', err instanceof Error ? err : new Error(lastError));
    }
}

export function scheduleLinkedInSignalPoller(): void {
    if (scheduled) return;
    // Recurring-jitter loop. setInterval(..., jitter(X)) only evaluates
    // the jitter once at scheduling time — every subsequent fire uses
    // the same offset, which means N orgs running the same worker land
    // on Unipile at the same relative cadence. Replace with a
    // setTimeout chain that re-rolls jitter on each cycle, so the
    // distribution across orgs stays uniform-random instead of clumping.
    const scheduleNext = () => {
        const delay = jitter(RUN_INTERVAL_MS);
        nextRunAt = new Date(Date.now() + delay);
        scheduled = setTimeout(async () => {
            try { await tick(); } finally { scheduleNext(); }
        }, delay);
    };
    setTimeout(() => {
        void (async () => {
            await tick();
            scheduleNext();
        })();
    }, FIRST_RUN_DELAY_MS);
    logger.info('[LINKEDIN-POLLER] Scheduled', { baseIntervalMs: RUN_INTERVAL_MS, jitterMs: JITTER_MS });
}

export function stopLinkedInSignalPoller(): void {
    if (scheduled) {
        // setTimeout / setInterval handles are interchangeable for
        // clearTimeout/clearInterval at the runtime level; we use
        // clearTimeout because the new scheduler is setTimeout-based.
        clearTimeout(scheduled);
        scheduled = null;
    }
}

export function getSignalPollerStatus() {
    return { totalCycles, totalEventsIngested, lastError, scheduled: Boolean(scheduled), nextRunAt };
}

/**
 * Local mirror of the inferPostKind in linkedinAccountController. Kept
 * here as a private helper so the poller can stamp post_kind on the
 * LinkedInPost row at ingest time — the AI-icebreaker generator reads
 * this to phrase article references differently from short posts.
 */
function inferPostKindForPoller(p: { post_urn?: string; text?: string }): 'post' | 'article' | 'repost' {
    const urn = (p.post_urn ?? '').toLowerCase();
    if (urn.includes(':article:') || urn.includes('article')) return 'article';
    if (urn.includes(':repost:') || urn.includes(':share:')) return 'repost';
    return 'post';
}
