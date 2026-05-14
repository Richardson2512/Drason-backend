/**
 * Topics watchlist scan engine â€” runs one watchlist's scan cycle.
 *
 * Pipeline per cycle:
 *   1. For each keyword (capped at 5): Unipile `searchClassicPosts`,
 *      return up to 50 recent posts.
 *   2. Filter posts: drop anything below `min_reaction_count`, drop
 *      anything we've already processed within the dedup window
 *      (24h on the same source_post_unipile_id).
 *   3. For each surviving post, hydrate engagers via reactions +
 *      comments. Drop engagers in excluded_profile_slugs /
 *      excluded_company_terms.
 *   4. Upsert each engager into LinkedInProfile (org-scoped).
 *   5. ICP-match against the watchlist's icp_profile_id (when set).
 *   6. Insert SignalWatchlistMatch rows (status pending_review or, in
 *      auto_push mode, status='pushed' + CampaignLead.upsert into
 *      target_campaign_id).
 *
 * Hard ceiling: the worker stops as soon as it's logged
 * watchlist.daily_signal_budget matches for the current day. Combined
 * with min_reaction_count + the per-keyword limit, this protects us
 * from blowing past Unipile's 100/day per-account budget on the search
 * + hydrate calls.
 *
 * Cost: ZERO incremental. Unipile pricing is flat per linked account,
 * so we don't pay per call â€” we just have to stay under LinkedIn's
 * action ceilings to avoid an account block.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import { searchClassicPosts, listPostReactions, listPostComments } from '../unipile/posts';
import { Prisma } from '@prisma/client';
import { matchProfile } from '../agents/icpMatcher';
import { promoteProfileToCampaign } from './profilePromotionService';

const MAX_KEYWORDS = 5;
const MAX_POSTS_PER_KEYWORD = 30;       // already filtered by min_reaction below
const MAX_DAILY_SIGNAL_BUDGET = 100;    // server-side ceiling regardless of user setting
const DEDUP_WINDOW_HOURS = 24;
const COMPANY_SLUG_RE = /linkedin\.com\/company\/([^/?#]+)/i;

interface WatchlistRow {
    id: string;
    organization_id: string;
    name: string;
    keywords: string[];
    icp_profile_id: string | null;
    excluded_profile_slugs: string[];
    excluded_company_terms: string[];
    min_reaction_count: number;
    daily_signal_budget: number;
    routing_mode: string;
    target_campaign_id: string | null;
    enabled: boolean;
}

interface ScanSummary {
    keywords_searched: number;
    posts_examined: number;
    posts_skipped_low_engagement: number;
    posts_skipped_already_seen: number;
    engagers_hydrated: number;
    engagers_skipped_excluded: number;
    engagers_skipped_icp: number;
    matches_recorded: number;
    matches_auto_pushed: number;
    stopped_reason?: string;
}

/**
 * Run one scan of one watchlist. Idempotent enough â€” the (watchlist,
 * post, engager) unique index prevents duplicate match rows even if the
 * scan re-runs the same window.
 */
export async function runWatchlistScan(watchlistId: string): Promise<ScanSummary> {
    const summary: ScanSummary = {
        keywords_searched: 0,
        posts_examined: 0,
        posts_skipped_low_engagement: 0,
        posts_skipped_already_seen: 0,
        engagers_hydrated: 0,
        engagers_skipped_excluded: 0,
        engagers_skipped_icp: 0,
        matches_recorded: 0,
        matches_auto_pushed: 0,
    };

    const wl = await prisma.signalWatchlist.findUnique({
        where: { id: watchlistId },
    }) as WatchlistRow | null;

    if (!wl) {
        summary.stopped_reason = 'watchlist_not_found';
        return summary;
    }
    if (!wl.enabled) {
        summary.stopped_reason = 'watchlist_disabled';
        return summary;
    }
    if (wl.keywords.length === 0) {
        summary.stopped_reason = 'no_keywords';
        return summary;
    }

    // Pick a LinkedIn account in the workspace to make calls through.
    // Rotate by least-recent usage AND lowest action burn so a workspace
    // with multiple connected accounts spreads load — protecting any
    // single account from hitting LinkedIn's daily action ceiling and
    // triggering a soft block.
    const account = await prisma.linkedInAccount.findFirst({
        where: {
            organization_id: wl.organization_id,
            status: 'OK',
            // Only consider accounts with headroom on the daily action
            // budget — others will eventually be picked up tomorrow.
            unipile_actions_today: { lt: prisma.linkedInAccount.fields.max_unipile_actions_per_day },
        },
        orderBy: [
            { unipile_actions_today: 'asc' },
            { last_status_at: 'asc' },
        ],
        select: {
            id: true, unipile_account_id: true,
            unipile_actions_today: true, max_unipile_actions_per_day: true,
        },
    });
    if (!account) {
        summary.stopped_reason = 'no_active_linkedin_account_with_action_budget';
        return summary;
    }

    const dailyBudget = Math.min(wl.daily_signal_budget, MAX_DAILY_SIGNAL_BUDGET);
    const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const recordedToday = await prisma.signalWatchlistMatch.count({
        where: { watchlist_id: wl.id, created_at: { gte: todayStart } },
    }) as number;
    let remaining = Math.max(0, dailyBudget - recordedToday);
    if (remaining === 0) {
        summary.stopped_reason = 'daily_budget_exhausted';
        return summary;
    }

    // In-memory action-budget tracker. The schema's
    // `unipile_actions_today` is updated periodically (every 10 actions
    // and at scan end) — between flushes we count in memory so we don't
    // burn one DB write per Unipile call. The watchlist scan stops as
    // soon as `actionsUsed + actionsBurnedThisScan >= max`, which
    // happens well below LinkedIn's true 100/day ceiling because of the
    // conservative `max_unipile_actions_per_day` default of 80.
    let actionsUsed = account.unipile_actions_today;
    const actionsMax = account.max_unipile_actions_per_day;
    let actionsBurnedThisScan = 0;
    const flushActions = async () => {
        if (actionsBurnedThisScan === 0) return;
        await prisma.linkedInAccount.update({
            where: { id: account.id },
            data: { unipile_actions_today: { increment: actionsBurnedThisScan } },
        });
        actionsBurnedThisScan = 0;
    };
    /** Returns true and increments the counter when budget allows;
     *  returns false when the account has no headroom (caller halts). */
    const tryBurnAction = (n = 1): boolean => {
        if (actionsUsed + n > actionsMax) return false;
        actionsUsed += n;
        actionsBurnedThisScan += n;
        return true;
    };

    const minReactions = Math.max(0, wl.min_reaction_count);
    const dedupCutoff = new Date(Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000);
    const keywords = wl.keywords.slice(0, MAX_KEYWORDS);
    const excludedSlugSet = new Set(wl.excluded_profile_slugs.map(s => s.toLowerCase()));
    const excludedCompanyTerms = wl.excluded_company_terms.map(s => s.toLowerCase());

    // ICP filter â€” when an icp_profile_id is configured, we delegate to
    // the canonical icpMatcher.matchProfile() service rather than
    // reimplementing the heuristic. Two reasons:
    //   1. Consistency: an engager that passes the ICP gate in the
    //      signal-monitoring path must also pass it here, and vice
    //      versa. Forking the logic was an alignment risk.
    //   2. Future-proofing: when v2 lands the LLM-backed matcher, this
    //      path picks up the upgrade for free.
    // matchProfile is pure (no AgentRun audit) and rule-engine in v1, so
    // cost stays at zero tokens â€” preserving the watchlist's
    // no-incremental-spend promise.
    const watchlistIcpId = wl.icp_profile_id || null;

    for (const keyword of keywords) {
        if (remaining <= 0) { summary.stopped_reason = 'daily_budget_exhausted'; break; }
        // Halt the scan immediately when the account is at action budget.
        // Each search burns 1 action; if we can't afford it, stop now
        // rather than blow past LinkedIn's soft block.
        if (!tryBurnAction(1)) {
            summary.stopped_reason = 'unipile_action_budget_exhausted';
            break;
        }
        summary.keywords_searched += 1;

        let searchResp;
        try {
            searchResp = await searchClassicPosts(
                account.unipile_account_id,
                { keywords: keyword, sort_by: 'date', date_posted: 'past_week' },
                { limit: 50 },
            );
        } catch (err) {
            logger.warn('[WATCHLIST] search call failed', {
                watchlist_id: wl.id, keyword,
                err: err instanceof Error ? err.message : String(err),
            });
            continue; // try next keyword
        }

        const posts = (searchResp.items || []).slice(0, MAX_POSTS_PER_KEYWORD);
        for (const post of posts) {
            if (remaining <= 0) break;
            summary.posts_examined += 1;

            const reactionCount = post.reaction_counter ?? 0;
            if (reactionCount < minReactions) {
                summary.posts_skipped_low_engagement += 1;
                continue;
            }

            // Dedup within 24h on (watchlist, post). The unique index
            // protects per-engager dedup; this guard saves an entire
            // reaction-fetch call when we've already processed the post
            // recently.
            const recentMatchOnPost = await prisma.signalWatchlistMatch.findFirst({
                where: {
                    watchlist_id: wl.id,
                    source_post_unipile_id: post.id,
                    created_at: { gte: dedupCutoff },
                },
                select: { id: true },
            }) as { id: string } | null;
            if (recentMatchOnPost) {
                summary.posts_skipped_already_seen += 1;
                continue;
            }

            // Hydrate the engagers. Reactions cap at 100/call, comments
            // at 100/call — sufficient for v1. Each call burns 1 action,
            // so we account for 2 actions before issuing the hydrate
            // request pair. If we can't afford both, halt the scan
            // cleanly rather than partially fetch.
            if (!tryBurnAction(2)) {
                summary.stopped_reason = 'unipile_action_budget_exhausted';
                break;
            }
            let reactions: Awaited<ReturnType<typeof listPostReactions>>['items'] = [];
            let comments:  Awaited<ReturnType<typeof listPostComments>>['items']  = [];
            try {
                const [r, c] = await Promise.all([
                    listPostReactions(post.id, { limit: 100 }),
                    listPostComments(post.id, { limit: 100 }),
                ]);
                reactions = r.items || [];
                comments  = c.items  || [];
            } catch (err) {
                logger.warn('[WATCHLIST] hydrate engagers failed', {
                    watchlist_id: wl.id, post_id: post.id,
                    err: err instanceof Error ? err.message : String(err),
                });
                continue;
            }
            // Flush action counter every ~10 burned actions so a crash
            // mid-scan still reflects most of the burn in the DB.
            if (actionsBurnedThisScan >= 10) await flushActions();

            const engagers: Array<{
                type: 'REACTION' | 'COMMENT';
                reaction_type: string | null;
                comment_text: string | null;
                actor_slug: string;
                actor_name: string | null;
                actor_headline: string | null;
                actor_company: string | null;
            }> = [];

            for (const r of reactions) {
                const slug = (r.actor_public_identifier || '').toLowerCase();
                if (!slug) continue;
                engagers.push({
                    type: 'REACTION',
                    reaction_type: r.type ?? null,
                    comment_text: null,
                    actor_slug: slug,
                    actor_name: r.actor_full_name ?? null,
                    actor_headline: r.actor_headline ?? null,
                    actor_company: null,
                });
            }
            for (const c of comments) {
                const slug = (c.actor_public_identifier || '').toLowerCase();
                if (!slug) continue;
                engagers.push({
                    type: 'COMMENT',
                    reaction_type: null,
                    comment_text: c.text ? c.text.slice(0, 1000) : null,
                    actor_slug: slug,
                    actor_name: c.actor_full_name ?? null,
                    actor_headline: null,
                    actor_company: null,
                });
            }

            for (const eng of engagers) {
                if (remaining <= 0) break;

                // Exclusions â€” operator-curated slug list + free-text
                // company keyword exclusion (e.g. "Acme", "Boltgrid").
                if (excludedSlugSet.has(eng.actor_slug)) {
                    summary.engagers_skipped_excluded += 1;
                    continue;
                }
                const companyHay = (eng.actor_company || eng.actor_headline || '').toLowerCase();
                if (excludedCompanyTerms.length > 0 && excludedCompanyTerms.some(t => companyHay.includes(t))) {
                    summary.engagers_skipped_excluded += 1;
                    continue;
                }

                // Upsert the engager into LinkedInProfile so the rest of
                // the platform (ICP matcher, Customer registry, signal
                // icebreaker) has a stable handle on them.
                const profile = await prisma.linkedInProfile.upsert({
                    where: { organization_id_public_identifier: { organization_id: wl.organization_id, public_identifier: eng.actor_slug } },
                    create: {
                        organization_id: wl.organization_id,
                        public_identifier: eng.actor_slug,
                        name: eng.actor_name || eng.actor_slug,
                        headline: eng.actor_headline,
                    },
                    update: {
                        // Refresh name/headline if newer (caller may have
                        // staler info than the search result).
                        ...(eng.actor_name ? { name: eng.actor_name } : {}),
                        ...(eng.actor_headline ? { headline: eng.actor_headline } : {}),
                    },
                });
                summary.engagers_hydrated += 1;

                // ICP gate â€” delegate to icpMatcher.matchProfile() so this
                // path stays bit-for-bit consistent with supervisor's
                // signal-monitoring filter. matchProfile returns the full
                // set of matched ICP ids; we only require that the
                // watchlist's configured ICP is in that set.
                if (watchlistIcpId) {
                    const matchResult = await matchProfile(wl.organization_id, {
                        profile_id: profile.id,
                        title: profile.position,
                        headline: profile.headline,
                        position: profile.position,
                        company: profile.company,
                        industry: profile.industry,
                        location: profile.location,
                    });
                    if (!matchResult.matched_icp_ids.includes(watchlistIcpId)) {
                        await prisma.signalWatchlistMatch.create({
                            data: {
                                organization_id: wl.organization_id,
                                watchlist_id: wl.id,
                                matched_keyword: keyword,
                                source_post_unipile_id: post.id,
                                source_post_url: post.share_url ?? null,
                                source_post_preview: post.text ? post.text.slice(0, 280) : null,
                                engager_profile_id: profile.id,
                                engagement_type: eng.type,
                                reaction_type: eng.reaction_type,
                                comment_text: eng.comment_text,
                                status: 'skipped_icp',
                            } as any,
                        }).catch(() => { /* unique-index dup â€” fine */ });
                        summary.engagers_skipped_icp += 1;
                        continue;
                    }
                }

                // Insert the match. Unique index on (watchlist, post,
                // engager) makes this idempotent across re-runs.
                let createdMatchId: string | null = null;
                try {
                    const created = await prisma.signalWatchlistMatch.create({
                        data: {
                            organization_id: wl.organization_id,
                            watchlist_id: wl.id,
                            matched_keyword: keyword,
                            source_post_unipile_id: post.id,
                            source_post_url: post.share_url ?? null,
                            source_post_preview: post.text ? post.text.slice(0, 280) : null,
                            engager_profile_id: profile.id,
                            engagement_type: eng.type,
                            reaction_type: eng.reaction_type,
                            comment_text: eng.comment_text,
                            status: wl.routing_mode === 'auto_push' && wl.target_campaign_id ? 'pushed' : 'pending_review',
                            pushed_campaign_id: wl.routing_mode === 'auto_push' ? wl.target_campaign_id : null,
                            pushed_at: wl.routing_mode === 'auto_push' && wl.target_campaign_id ? new Date() : null,
                        } as any,
                        select: { id: true },
                    });
                    createdMatchId = created.id;
                } catch (err) {
                    // P2002 = dup; treat as already-processed and skip the budget decrement.
                    if ((err as { code?: string })?.code !== 'P2002') {
                        logger.warn('[WATCHLIST] match insert failed', {
                            watchlist_id: wl.id, engager_slug: eng.actor_slug,
                            err: err instanceof Error ? err.message : String(err),
                        });
                    }
                    continue;
                }

                summary.matches_recorded += 1;
                remaining -= 1;

                if (wl.routing_mode === 'auto_push' && wl.target_campaign_id && createdMatchId) {
                    // Push via the supervisor-equivalent flow so the lead
                    // gets enriched + has cold-call/Sequencer routing
                    // applied + lands on the AgentRun audit trail. This
                    // replaces the old direct CampaignLead.upsert path.
                    await pushEngagerToCampaign(wl.organization_id, wl.target_campaign_id, profile, createdMatchId)
                        .then(() => { summary.matches_auto_pushed += 1; })
                        .catch(err => {
                            logger.warn('[WATCHLIST] auto-push via supervisor flow failed', {
                                watchlist_id: wl.id, campaign_id: wl.target_campaign_id,
                                err: err instanceof Error ? err.message : String(err),
                            });
                        });
                }
            }
        }
    }

    // Final action-counter flush before we return — captures any
    // burned actions since the last 10-action flush so the DB reflects
    // the full scan's spend.
    await flushActions();

    // Schedule the next tick. We re-run hourly so a watchlist that found
    // matches today still gets a fresh sweep tomorrow, and so an operator
    // who lifted a budget mid-day picks up the slack on the next cycle.
    const nextRunAt = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.signalWatchlist.update({
        where: { id: wl.id },
        data: {
            last_run_at: new Date(),
            last_run_summary: summary as unknown as Prisma.InputJsonValue,
            next_run_at: nextRunAt,
        },
    });

    return summary;
}

/**
 * Push a watchlist engager through the full supervisor-equivalent
 * promotion flow.
 *
 * Previously this function did a direct `CampaignLead.upsert` with a
 * placeholder email and called it a day — that bypassed enrichment,
 * icebreaker generation, the post-enrichment routing (phone?cold-call,
 * email?Sequencer source=signal), and the AgentRun audit trail. Auto-
 * pushed leads stayed at `lin_<slug>@unresolved.local` forever.
 *
 * Now we delegate to `promoteProfileToCampaign` — the same function the
 * supervisor's ENFORCE path uses for engagement-event-triggered
 * enrollments. Watchlist auto-pushes and rule-driven enrollments
 * produce identical artifacts: enriched Lead row, AI opener, routing
 * tags, AgentRun audit, CampaignLead enrollment.
 *
 * No engagement_event id is passed (watchlist matches don't always have
 * one — the post may not be in our LinkedInPost table yet) so the
 * icebreaker step is skipped. A nightly worker can revisit watchlist-
 * enrolled leads and generate openers when the poller's later cycle
 * captures the post text.
 */
async function pushEngagerToCampaign(
    organizationId: string,
    campaignId: string,
    profile: { id: string; name: string; headline: string | null; company: string | null; position: string | null; public_identifier: string },
    matchId: string,
): Promise<void> {
    await promoteProfileToCampaign({
        organizationId,
        profileId: profile.id,
        campaignId,
        coldCallListId: null,
        engagementEventId: null,
        trigger: 'watchlist_match',
        triggerRefId: matchId,
    });
}
