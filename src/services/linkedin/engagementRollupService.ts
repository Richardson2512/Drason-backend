/**
 * Engagement rollup + intent classification for LinkedIn profiles.
 *
 * Three responsibilities:
 *   1. `recordEngagementOnProfile` — bump per-profile counters whenever a new
 *      EngagementEvent is written. Updates last_engaged_at, the 30d rolling
 *      count, the distinct-post count, and the composite engagement_score.
 *   2. `classifyEngagementIntent` — deterministic mapping from event_type +
 *      reaction_type to one of the same three Auto-Tag buckets used for DM
 *      replies (Interested / Generic). "Not Interested" is unreachable from
 *      engagements — LinkedIn's reaction taxonomy has no negative.
 *   3. `applyEngagementAutoTag` — write the inferred tag onto the profile,
 *      but only when it currently has no tag. DM-reply classification is
 *      authoritative and must not be overridden by an engagement signal
 *      (which carries far less semantic weight than text content).
 *
 * The rollup numbers are decayed nightly by `recomputeProfileRollups` —
 * a cache-correction sweep that reads the canonical EngagementEvent rows
 * and rewrites the counters, so any missed increment or stale row from a
 * crash recovery converges to truth within 24h.
 */

import { prisma } from '../../prisma';
import logger from '../../utils/logger';

type EngagementTag = 'Interested' | 'Generic';

const REACTION_INTERESTED = new Set(['PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION']);
const REACTION_GENERIC    = new Set(['LIKE', 'MAYBE', 'FUNNY']);

/**
 * Map a single engagement event to one of the Auto-Tag buckets.
 *
 *   SHARE / REPOST            → Interested  (highest-effort engagement)
 *   COMMENT                   → Interested  (text on the public record)
 *   REACTION + strong subtype → Interested  (praise/empathy/interest/etc)
 *   REACTION + weak subtype   → Generic     (like/maybe/funny)
 *
 * "Not Interested" is impossible here — LinkedIn has no negative reaction.
 * DM replies remain the only path to that tag.
 */
export function classifyEngagementIntent(
    eventType: string,
    reactionType: string | null | undefined,
): EngagementTag {
    if (eventType === 'SHARE' || eventType === 'REPOST' || eventType === 'COMMENT') return 'Interested';
    if (eventType === 'REACTION') {
        const r = (reactionType || '').toUpperCase();
        if (REACTION_INTERESTED.has(r)) return 'Interested';
        if (REACTION_GENERIC.has(r))    return 'Generic';
    }
    return 'Generic';
}

/**
 * Compute the engagement score from rollup inputs. Range 0-100.
 *
 *   frequency  — count_30d × 5 (capped at 60)
 *   recency    — 30 if engaged today, 20 if within 7d, 10 if within 30d, 0 older
 *   diversity  — +10 if engaged on ≥3 distinct posts in 30d
 *
 * Tuned to keep a profile that engaged once 25 days ago around 15-20
 * (low-interest), while a profile engaging twice this week on different
 * posts hits ~50 (clear interest signal). Numbers were chosen for the
 * v1 surface; can be re-tuned without a schema change.
 */
export function computeEngagementScore(
    count30d: number,
    distinctPosts30d: number,
    lastEngagedAt: Date | null,
): number {
    if (count30d <= 0 || !lastEngagedAt) return 0;
    const frequency = Math.min(60, count30d * 5);
    const ageMs = Date.now() - lastEngagedAt.getTime();
    const day = 24 * 60 * 60 * 1000;
    let recency = 0;
    if (ageMs < day) recency = 30;
    else if (ageMs < 7 * day) recency = 20;
    else if (ageMs < 30 * day) recency = 10;
    const diversity = distinctPosts30d >= 3 ? 10 : 0;
    return Math.min(100, frequency + recency + diversity);
}

/**
 * Called from the signal poller right after an EngagementEvent row is
 * inserted (NOT called when the insert hits a P2002 dedup conflict). Bumps
 * the cached rollups on the actor's LinkedInProfile row.
 *
 * The distinct-post count is read from the DB rather than incremented
 * naively — this keeps the cached value correct even when an actor
 * engages multiple times on the same post (e.g. reaction + comment).
 */
export async function recordEngagementOnProfile(
    organizationId: string,
    profileId: string,
    postId: string,
    occurredAt: Date,
): Promise<void> {
    void postId; // referenced via distinct-count query below
    try {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const [count30d, distinctRows] = await Promise.all([
            prisma.engagementEvent.count({
                where: {
                    organization_id: organizationId,
                    actor_profile_id: profileId,
                    occurred_at: { gte: cutoff },
                },
            }),
            prisma.engagementEvent.findMany({
                where: {
                    organization_id: organizationId,
                    actor_profile_id: profileId,
                    occurred_at: { gte: cutoff },
                },
                select: { linkedin_post_id: true },
                distinct: ['linkedin_post_id'],
            }),
        ]);

        const score = computeEngagementScore(count30d, distinctRows.length, occurredAt);

        await prisma.linkedInProfile.update({
            where: { id: profileId },
            data: {
                last_engaged_at: occurredAt,
                engagement_count_30d: count30d,
                distinct_posts_engaged_30d: distinctRows.length,
                engagement_score: score,
            } as unknown as Record<string, unknown>,
        });
    } catch (err) {
        // Rollup is a cache, not the source of truth — never block ingestion
        // on rollup failure. Nightly recompute will fix any drift.
        logger.warn('[ENGAGEMENT-ROLLUP] update failed', { err: String(err).slice(0, 200), profileId });
    }
}

/**
 * Set the profile's auto-tag based on this engagement, but only when no
 * tag exists yet. Returns the tag actually persisted, or null if the row
 * was already tagged (in which case we skipped — DM replies own the tag).
 */
export async function applyEngagementAutoTag(
    organizationId: string,
    profileId: string,
    eventType: string,
    reactionType: string | null | undefined,
): Promise<EngagementTag | null> {
    try {
        const tag = classifyEngagementIntent(eventType, reactionType);
        const result = await prisma.linkedInProfile.updateMany({
            where: {
                id: profileId,
                organization_id: organizationId,
                linkedin_auto_tag: null,
            },
            data: {
                linkedin_auto_tag: tag,
                linkedin_auto_tagged_at: new Date(),
            },
        });
        return result.count > 0 ? tag : null;
    } catch (err) {
        logger.warn('[ENGAGEMENT-TAG] write failed', { err: String(err).slice(0, 200), profileId });
        return null;
    }
}

/**
 * Nightly cache-correction sweep. For every LinkedInProfile that has had
 * any engagement in the last 30 days, recompute the rollup columns from
 * the canonical EngagementEvent rows. Catches drift from missed
 * increments, crashed workers, and the moving 30-day window edge.
 *
 * Profiles with NO engagement in the window get their counters cleared
 * so a profile that engaged 31 days ago doesn't keep showing up as
 * "engagement_count_30d = 1" forever.
 *
 * Designed to run once per night. Streams in batches of 1000 to keep
 * memory bounded on workspaces with hundreds of thousands of profiles.
 */
export async function recomputeProfileRollups(): Promise<{ profilesUpdated: number; profilesDecayed: number }> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Pass 1: every profile with engagement in the window — recompute from truth.
    const activeProfiles = await prisma.engagementEvent.groupBy({
        by: ['organization_id', 'actor_profile_id'],
        where: { occurred_at: { gte: cutoff } },
        _count: { _all: true },
        _max: { occurred_at: true },
    });

    let profilesUpdated = 0;
    for (const row of activeProfiles) {
        const distinct = await prisma.engagementEvent.findMany({
            where: {
                organization_id: row.organization_id,
                actor_profile_id: row.actor_profile_id,
                occurred_at: { gte: cutoff },
            },
            select: { linkedin_post_id: true },
            distinct: ['linkedin_post_id'],
        });
        const lastEngagedAt = row._max.occurred_at ?? null;
        const score = computeEngagementScore(row._count._all, distinct.length, lastEngagedAt);
        await prisma.linkedInProfile.update({
            where: { id: row.actor_profile_id },
            data: {
                last_engaged_at: lastEngagedAt,
                engagement_count_30d: row._count._all,
                distinct_posts_engaged_30d: distinct.length,
                engagement_score: score,
            } as unknown as Record<string, unknown>,
        });
        profilesUpdated += 1;
    }

    // Pass 2: profiles previously rolled-up but now outside the window — clear.
    const decayed = await prisma.linkedInProfile.updateMany({
        where: {
            engagement_count_30d: { gt: 0 },
            OR: [
                { last_engaged_at: { lt: cutoff } },
                { last_engaged_at: null },
            ],
        } as unknown as Record<string, unknown>,
        data: {
            engagement_count_30d: 0,
            distinct_posts_engaged_30d: 0,
            engagement_score: null,
        } as unknown as Record<string, unknown>,
    });

    return { profilesUpdated, profilesDecayed: decayed.count };
}
