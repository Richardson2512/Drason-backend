/**
 * /api/linkedin/signals/feed - engagement-event feed for the Signals page.
 *
 * Returns rows shaped like the operator UI expects: who engaged, on what
 * post, ICP match snapshot, mode decision (OBSERVE/SUGGEST/ENFORCE), and
 * the resolved action (added to list / added to campaign / queued for
 * review / observed-only).
 *
 * Filters mirror the UI controls:
 *   q             free-text against actor name + headline
 *   reaction      event_type === REACTION → reaction_type; else event_type
 *   mode          OBSERVE | SUGGEST | ENFORCE - resolved per-row from
 *                 SignalMonitoringRule using the same scope precedence as
 *                 supervisor.resolveRule (POST > ACCOUNT > WORKSPACE)
 *   icp_id        filter to events whose top-scoring ICP matches
 *   limit/offset  pagination (limit defaults to 50, max 200)
 *
 * Implementation note: we resolve mode in-memory using the org's rules so
 * we don't snapshot mode on EngagementEvent at write-time (rules can
 * change after the fact and the operator expects the feed to reflect
 * *current* policy). For the same reason, "action" is derived from
 * AgentRun.outcome when present, falling back to the mode default.
 */

import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { getOrgId } from '../middleware/orgContext';

interface RuleRow {
    id: string;
    scope_level: string;
    scope_targets: string[];
    mode: string;
    icp_profile_ids: string[];
}

function resolveModeForRow(
    rules: RuleRow[],
    postId: string,
    accountId: string,
): { mode: 'OBSERVE' | 'SUGGEST' | 'ENFORCE'; rule_id: string | null } {
    // POST > ACCOUNT > WORKSPACE - matches supervisor.resolveRule.
    const post = rules.find(r => r.scope_level === 'POST' && r.scope_targets.includes(postId));
    if (post) return { mode: post.mode as 'OBSERVE' | 'SUGGEST' | 'ENFORCE', rule_id: post.id };
    const account = rules.find(r => r.scope_level === 'ACCOUNT' && r.scope_targets.includes(accountId));
    if (account) return { mode: account.mode as 'OBSERVE' | 'SUGGEST' | 'ENFORCE', rule_id: account.id };
    const workspace = rules.find(r => r.scope_level === 'WORKSPACE');
    if (workspace) return { mode: workspace.mode as 'OBSERVE' | 'SUGGEST' | 'ENFORCE', rule_id: workspace.id };
    return { mode: 'OBSERVE', rule_id: null };
}

export async function feed(req: Request, res: Response) {
    const orgId = getOrgId(req);

    const q = (req.query.q as string | undefined)?.trim() || '';
    const reaction = (req.query.reaction as string | undefined) || 'all';
    const mode = (req.query.mode as string | undefined) || 'all';
    const icpId = (req.query.icp_id as string | undefined) || 'all';
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '50', 10) || 50));
    const offset = Math.max(0, parseInt((req.query.offset as string) || '0', 10) || 0);

    const where: any = { organization_id: orgId };
    if (reaction !== 'all') {
        if (['COMMENT', 'SHARE', 'REPOST'].includes(reaction)) {
            where.event_type = reaction;
        } else {
            where.event_type = 'REACTION';
            where.reaction_type = reaction;
        }
    }

    const [events, total, rules] = await Promise.all([
        prisma.engagementEvent.findMany({
            where,
            orderBy: { occurred_at: 'desc' },
            skip: offset,
            take: limit,
            include: {
                actor: {
                    select: {
                        id: true,
                        name: true,
                        headline: true,
                        company: true,
                        position: true,
                        profile_picture_url: true,
                        public_identifier: true,
                        icp_match_score: true,
                        icp_matched_at: true,
                        lead_id: true,
                    },
                },
                post: {
                    select: {
                        id: true,
                        linkedin_account_id: true,
                        text: true,
                        post_kind: true,
                        article_title: true,
                        posted_at: true,
                        account: { select: { id: true, display_name: true } },
                    },
                },
            },
        }),
        prisma.engagementEvent.count({ where }),
        prisma.signalMonitoringRule.findMany({ where: { organization_id: orgId } }),
    ]);

    const ruleRows = rules as unknown as RuleRow[];

    // Optional client-side filters that don't translate cleanly into the
    // SQL `where` (q searches a relation, mode/icp are post-derived).
    const lowered = q.toLowerCase();
    const filteredRows = events.filter((e: any) => {
        const actor = e.actor;
        if (q) {
            const hay = `${actor?.name || ''} ${actor?.headline || ''}`.toLowerCase();
            if (!hay.includes(lowered)) return false;
        }
        return true;
    });

    // Resolve mode per-row + look up "action" outcome from the most recent
    // supervisor AgentRun for this event when available. Outcome lives in
    // the decision JSON column - see supervisor.ts.
    const eventIds = filteredRows.map((e: any) => e.id);
    const agentRunsByEvent = new Map<string, { outcome: string | null; target_id: string | null }>();
    if (eventIds.length > 0) {
        const runs = await prisma.agentRun.findMany({
            where: {
                organization_id: orgId,
                trigger: 'engagement_event',
                trigger_ref_id: { in: eventIds },
                agent_name: 'supervisor',
            },
            orderBy: { created_at: 'desc' },
            select: { trigger_ref_id: true, decision: true },
        });
        for (const r of runs) {
            if (!r.trigger_ref_id || agentRunsByEvent.has(r.trigger_ref_id)) continue;
            const decision = (r.decision ?? {}) as any;
            agentRunsByEvent.set(r.trigger_ref_id, {
                outcome: typeof decision?.outcome === 'string' ? decision.outcome : null,
                target_id: typeof decision?.target_id === 'string' ? decision.target_id : null,
            });
        }
    }

    // Optional icp filter - match against IcpProfile of any AgentRun outcome that
    // referenced an ICP. For v1 we rely on the profile's icp_match_score being
    // populated; precise ICP-id filtering will become exact when ICP audit lands.
    const icpProfiles = icpId !== 'all'
        ? await prisma.icpProfile.findMany({ where: { organization_id: orgId }, select: { id: true, name: true } })
        : [];
    const icpName = icpProfiles.find((p: { id: string; name: string }) => p.id === icpId)?.name ?? null;

    const data = filteredRows
        .map((e: any) => {
            const post = e.post;
            const actor = e.actor;
            const resolved = resolveModeForRow(ruleRows, post.id, post.linkedin_account_id);
            const run = agentRunsByEvent.get(e.id);
            return {
                id: e.id,
                event_type: e.event_type,
                reaction_type: e.reaction_type,
                occurred_at: e.occurred_at,
                processed_at: e.processed_at,
                mode: resolved.mode,
                rule_id: resolved.rule_id,
                outcome: run?.outcome ?? null,
                target_id: run?.target_id ?? null,
                comment_text: e.comment_text,
                actor: actor ? {
                    id: actor.id,
                    name: actor.name,
                    headline: actor.headline,
                    company: actor.company,
                    position: actor.position,
                    profile_picture_url: actor.profile_picture_url,
                    public_identifier: actor.public_identifier,
                    icp_match_score: actor.icp_match_score,
                    icp_matched_at: actor.icp_matched_at,
                    lead_id: actor.lead_id,
                } : null,
                post: post ? {
                    id: post.id,
                    text: post.text,
                    post_kind: post.post_kind,
                    article_title: post.article_title,
                    posted_at: post.posted_at,
                    account: post.account ? {
                        id: post.account.id,
                        name: post.account.display_name,
                    } : null,
                } : null,
            };
        })
        .filter((row: any) => {
            if (mode !== 'all' && row.mode !== mode) return false;
            // ICP filter applies only when we can verify a match via the
            // profile's most-recent ICP snapshot - when icpName matches the
            // profile's stored icp_match score we treat it as a hit.
            if (icpId !== 'all' && icpName) {
                // Without per-event ICP id audit we approximate with score
                // presence. Future: join AgentRunIcpMatch when that table
                // lands.
                if (!row.actor?.icp_match_score) return false;
            }
            return true;
        });

    res.json({
        data,
        total,
        limit,
        offset,
        has_more: offset + filteredRows.length < total,
    });
}

// ────────────────────────────────────────────────────────────────────
// SUGGEST review queue
//
// When a SignalMonitoringRule is configured in SUGGEST mode and an
// engagement event ICP-matches, the supervisor writes an AgentRun with
// decision.outcome='suggested_for_review' but does NOT auto-enroll the
// lead. These endpoints surface those for operator approval:
//
//   GET  /api/linkedin/signals/review-queue                - list pending
//   POST /api/linkedin/signals/review-queue/:eventId/approve { campaign_id? }
//   POST /api/linkedin/signals/review-queue/:eventId/dismiss
//
// "Approve" runs the same shared promotion flow as ENFORCE - same
// enrichment, icebreaker, routing, audit. "Dismiss" just marks the
// AgentRun as reviewed without action.
// ────────────────────────────────────────────────────────────────────

export async function reviewQueue(req: Request, res: Response) {
    const orgId = getOrgId(req);
    const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '50', 10) || 50));
    const offset = Math.max(0, parseInt((req.query.offset as string) || '0', 10) || 0);

    // Pull AgentRun rows with the SUGGEST outcome that the operator
    // hasn't acted on yet. We mark "reviewed" by setting status to
    // 'REVIEWED_APPROVED' or 'REVIEWED_DISMISSED' below. Until then,
    // status stays 'SUCCESS' (the supervisor wrote a successful decision)
    // and the decision JSON carries `reviewed_at` if/when an operator
    // acts on it.
    const runs = await prisma.agentRun.findMany({
        where: {
            organization_id: orgId,
            agent_name: 'supervisor',
            trigger: 'engagement_event',
            status: 'SUCCESS',
            // Filter to SUGGEST outcomes in the JSON. Postgres path query.
            decision: { path: ['outcome'], equals: 'suggested_for_review' },
            // NOT yet reviewed.
            NOT: { decision: { path: ['reviewed_at'], not: null as unknown as undefined } },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
        select: {
            id: true,
            trigger_ref_id: true,
            created_at: true,
            decision: true,
        },
    });

    // Hydrate each row with the actor + post for the UI to render.
    // Single batched fetch keyed by event id.
    const eventIds = runs.map(r => r.trigger_ref_id).filter((s): s is string => !!s);
    const events = eventIds.length > 0
        ? await prisma.engagementEvent.findMany({
            where: { id: { in: eventIds }, organization_id: orgId },
            include: {
                actor: { select: { id: true, name: true, headline: true, company: true, position: true, public_identifier: true, icp_match_score: true, lead_id: true } },
                post: {
                    select: {
                        id: true, text: true, post_kind: true, article_title: true, posted_at: true,
                        account: { select: { id: true, display_name: true } },
                    },
                },
            },
        })
        : [];
    const eventById = new Map(events.map(e => [e.id, e]));

    const data = runs.map(r => {
        const ev = r.trigger_ref_id ? eventById.get(r.trigger_ref_id) ?? null : null;
        return {
            agent_run_id: r.id,
            event_id: r.trigger_ref_id,
            created_at: r.created_at,
            decision: r.decision,
            event: ev ? {
                id: ev.id,
                event_type: ev.event_type,
                reaction_type: ev.reaction_type,
                occurred_at: ev.occurred_at,
                comment_text: ev.comment_text,
                actor: ev.actor,
                post: ev.post,
            } : null,
        };
    });

    res.json({ data, limit, offset });
}

export async function approveReview(req: Request, res: Response) {
    const orgId = getOrgId(req);
    const eventId = String(req.params.eventId);
    const targetCampaignId = (req.body?.campaign_id as string | undefined) || undefined;

    // Load the event + its actor profile.
    const event = await prisma.engagementEvent.findFirst({
        where: { id: eventId, organization_id: orgId },
        select: { id: true, actor_profile_id: true },
    });
    if (!event) {
        return res.status(404).json({ success: false, error: 'Event not found' });
    }

    // Run the same shared promotion flow ENFORCE uses. If the operator
    // didn't specify a campaign, we skip campaign enrollment (the lead
    // still gets enriched + icebreaker + routing tags + Sequencer
    // source='signal'). Operators can pick a campaign in the UI.
    const { promoteProfileToCampaign } = await import('../services/linkedin/profilePromotionService');
    const result = await promoteProfileToCampaign({
        organizationId: orgId,
        profileId: event.actor_profile_id,
        campaignId: targetCampaignId ?? null,
        coldCallListId: null,
        engagementEventId: event.id,
        trigger: 'engagement_event',
        triggerRefId: event.id,
    });

    // Mark the AgentRun as reviewed so it disappears from the queue.
    // We patch the decision JSON with reviewed_at + reviewer; the list
    // query filters out anything with reviewed_at set.
    await prisma.agentRun.updateMany({
        where: {
            organization_id: orgId,
            trigger_ref_id: event.id,
            agent_name: 'supervisor',
            decision: { path: ['outcome'], equals: 'suggested_for_review' },
        },
        data: {
            decision: {
                outcome: 'reviewed_approved',
                approved_at: new Date().toISOString(),
                approved_by_user_id: req.orgContext?.userId ?? null,
                target_campaign_id: targetCampaignId ?? null,
                lead_id: result.lead_id,
            } as unknown as object,
        },
    });

    return res.json({ success: true, data: result });
}

/**
 * Diagnostic: list SignalMonitoringRule rows that reference deleted
 * entities (campaign, cold-call list). The supervisor logs warnings
 * each time it tries to act on a dangling ref, but ops don't read
 * worker logs - the page does. The signals UI calls this on mount to
 * render a "1 of your monitoring rules points at a deleted campaign"
 * banner with a deep-link to fix.
 *
 * Cheap to run: 1 SignalMonitoringRule.findMany + at most 2 in-set
 * lookups per non-empty ref. No N+1.
 */
export async function ruleHealth(req: Request, res: Response) {
    const orgId = getOrgId(req);
    const rules = await prisma.signalMonitoringRule.findMany({
        where: { organization_id: orgId, enabled: true },
        select: {
            id: true, scope_level: true, scope_targets: true, mode: true,
            add_to_campaign_id: true, add_to_cold_call_list_id: true,
            icp_profile_ids: true,
        },
    });

    const campaignIds = rules.map(r => r.add_to_campaign_id).filter((s): s is string => !!s);
    const liveCampaigns = campaignIds.length > 0
        ? await prisma.campaign.findMany({
            where: { id: { in: campaignIds }, organization_id: orgId, deleted_at: null },
            select: { id: true },
        })
        : [];
    const liveCampaignSet = new Set(liveCampaigns.map(c => c.id));

    // ICP references - SignalMonitoringRule.icp_profile_ids is a text
    // array, not a FK, so deleted ICPs leave silent dangling refs.
    // With ICP soft-delete in place we check both deleted_at != null
    // and "row doesn't exist at all" - either way the rule's filter
    // silently no-ops for that ICP.
    const allIcpIds = Array.from(new Set(rules.flatMap(r => r.icp_profile_ids)));
    const liveIcps = allIcpIds.length > 0
        ? await prisma.icpProfile.findMany({
            where: { id: { in: allIcpIds }, organization_id: orgId, deleted_at: null },
            select: { id: true },
        })
        : [];
    const liveIcpSet = new Set(liveIcps.map(i => i.id));

    // Cold-call lists live on the protection side; we can't validate
    // them with absolute certainty without crossing service boundaries.
    // For now we just report which rules carry a list ref; future work
    // can extend this with a real existence check.
    const issues = rules.flatMap(r => {
        const out: Array<{ rule_id: string; mode: string; scope: string; kind: 'missing_campaign' | 'missing_list' | 'missing_icp'; ref_id: string }> = [];
        if (r.add_to_campaign_id && !liveCampaignSet.has(r.add_to_campaign_id)) {
            out.push({
                rule_id: r.id, mode: r.mode, scope: r.scope_level,
                kind: 'missing_campaign', ref_id: r.add_to_campaign_id,
            });
        }
        for (const icpId of r.icp_profile_ids) {
            if (!liveIcpSet.has(icpId)) {
                out.push({
                    rule_id: r.id, mode: r.mode, scope: r.scope_level,
                    kind: 'missing_icp', ref_id: icpId,
                });
            }
        }
        return out;
    });

    res.json({
        success: true,
        data: {
            rules_checked: rules.length,
            issues,
        },
    });
}

export async function dismissReview(req: Request, res: Response) {
    const orgId = getOrgId(req);
    const eventId = String(req.params.eventId);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : null;

    const updated = await prisma.agentRun.updateMany({
        where: {
            organization_id: orgId,
            trigger_ref_id: eventId,
            agent_name: 'supervisor',
            decision: { path: ['outcome'], equals: 'suggested_for_review' },
        },
        data: {
            decision: {
                outcome: 'reviewed_dismissed',
                dismissed_at: new Date().toISOString(),
                dismissed_by_user_id: req.orgContext?.userId ?? null,
                reason,
            } as unknown as object,
        },
    });

    if (updated.count === 0) {
        return res.status(404).json({ success: false, error: 'No pending review found for this event' });
    }
    return res.json({ success: true });
}
