/**
 * Signal-event supervisor — the heart of the 4-agent topology.
 *
 * For each unprocessed EngagementEvent:
 *   1. Resolve the applicable SignalMonitoringRule via the stackable
 *      scope hierarchy (POST > ACCOUNT > WORKSPACE, most-specific wins).
 *      If no rule applies, default to OBSERVE.
 *   2. If mode = OBSERVE → mark processed, optionally notify, exit.
 *   3. Hydrate the actor profile.
 *   4. Run the ICP matcher (deterministic rule engine). If no match,
 *      mark processed with a no-match reason, exit.
 *   5. Mode = SUGGEST → write a queued-for-review marker (Phase 5 will
 *      surface this in the UI for human approval), exit.
 *   6. Mode = ENFORCE → run enrichment waterfall, upsert as Lead,
 *      execute rule actions (add to cold-call list / campaign / notify).
 *   7. Mark event processed, write the agent_run audit row at every
 *      LLM/rule call along the way (already handled inside the agents).
 *
 * Runs as a worker (see workers/agentSupervisorWorker.ts) that ticks
 * every 30 seconds; events ingested by the poller in cycle N are
 * processed within a minute, well within the 15-minute auto-tag SLA.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import { matchProfileWithAudit } from './icpMatcher';
import { runAgent } from './agentRegistry';
import { promoteProfileToCampaign } from '../linkedin/profilePromotionService';

interface EventRow {
    id: string;
    organization_id: string;
    linkedin_post_id: string;
    actor_profile_id: string;
    event_type: string;
    reaction_type: string | null;
    occurred_at: Date;
}

interface RuleRow {
    id: string;
    scope_level: string;
    scope_targets: string[];
    mode: string;
    icp_profile_ids: string[];
    add_to_cold_call_list_id: string | null;
    add_to_campaign_id: string | null;
    notify_user_ids: string[];
    enabled: boolean;
}

/**
 * Find the single most-specific rule that applies to this event.
 *
 * Resolution order: POST > ACCOUNT > WORKSPACE.
 * Within each tier, the first enabled rule whose scope_targets contains
 * the event's reference id wins (workspace rules have empty scope_targets
 * and apply universally).
 */
function resolveRule(rules: RuleRow[], postId: string, accountId: string): RuleRow | null {
    const enabled = rules.filter(r => r.enabled);
    // POST scope first.
    const postRule = enabled.find(r => r.scope_level === 'POST' && r.scope_targets.includes(postId));
    if (postRule) return postRule;
    // ACCOUNT scope next.
    const accountRule = enabled.find(r => r.scope_level === 'ACCOUNT' && r.scope_targets.includes(accountId));
    if (accountRule) return accountRule;
    // WORKSPACE scope (default for the org).
    const workspaceRule = enabled.find(r => r.scope_level === 'WORKSPACE');
    if (workspaceRule) return workspaceRule;
    return null;
}

/**
 * Process a single engagement event end-to-end. Returns the terminal
 * outcome label so the worker can aggregate statistics.
 */
export async function processEvent(event: EventRow): Promise<string> {
    // Inside the supervisor agent envelope so the routing decision itself
    // is auditable. The decision payload captures the resolved rule +
    // mode + downstream agent calls for replay.
    const { decision } = await runAgent<{ outcome: string; rule_id: string | null; mode: string }>(
        {
            organization_id: event.organization_id,
            trigger: 'engagement_event',
            trigger_ref_id: event.id,
            agent_name: 'supervisor',
            model: 'rule-engine',
        },
        async () => {
            // Look up the post (need linkedin_account_id for ACCOUNT-scope rules).
            const post = await prisma.linkedInPost.findUnique({
                where: { id: event.linkedin_post_id },
                select: { id: true, linkedin_account_id: true },
            });
            if (!post) {
                return { decision: { outcome: 'post_not_found', rule_id: null, mode: 'OBSERVE' } };
            }

            // Load all rules for the org in one shot; resolve in-memory.
            const rules = await prisma.signalMonitoringRule.findMany({
                where: { organization_id: event.organization_id },
            });
            const rule = resolveRule(rules as RuleRow[], post.id, post.linkedin_account_id);
            const mode = (rule?.mode || 'OBSERVE') as 'OBSERVE' | 'SUGGEST' | 'ENFORCE';

            if (mode === 'OBSERVE') {
                return { decision: { outcome: 'observed', rule_id: rule?.id ?? null, mode } };
            }

            // For SUGGEST / ENFORCE we always run ICP. SUGGEST stops at the
            // match result + notification; ENFORCE goes the full distance.
            const profile = await prisma.linkedInProfile.findUnique({
                where: { id: event.actor_profile_id },
            });
            if (!profile) {
                return { decision: { outcome: 'profile_not_found', rule_id: rule?.id ?? null, mode } };
            }

            const allowedIcpIds = rule?.icp_profile_ids ?? [];
            const match = await matchProfileWithAudit(
                event.organization_id,
                {
                    profile_id: profile.id,
                    title: profile.position,
                    headline: profile.headline,
                    position: profile.position,
                    company: profile.company,
                    industry: profile.industry,
                    location: profile.location,
                },
                'engagement_event',
                event.id,
            );

            // Filter to rule-allowed ICPs if specified.
            const effectiveMatches = allowedIcpIds.length > 0
                ? match.matched_icp_ids.filter(id => allowedIcpIds.includes(id))
                : match.matched_icp_ids;

            if (effectiveMatches.length === 0) {
                return { decision: { outcome: 'no_icp_match', rule_id: rule?.id ?? null, mode } };
            }

            // Mark the profile's ICP snapshot regardless of mode.
            await prisma.linkedInProfile.update({
                where: { id: profile.id },
                data: { icp_matched_at: new Date(), icp_match_score: match.top_score },
            });

            if (mode === 'SUGGEST') {
                // SUGGEST is queue-for-review. We leave the engagement
                // event with processed_at set + a marker on agent_run for
                // the UI to surface. Phase 5's review queue API reads
                // AgentRun rows with this outcome.
                return { decision: { outcome: 'suggested_for_review', rule_id: rule?.id ?? null, mode } };
            }

            // ENFORCE — delegate the full lead-promotion flow to the
            // shared profilePromotionService. This is the same function
            // the watchlist auto-push path calls, so the rule-triggered
            // and watchlist-triggered enrollments produce identical
            // audit trails + routing semantics. The service handles:
            //   • Lead row creation (idempotent, source='signal')
            //   • Enrichment waterfall via BYOK providers
            //   • Icebreaker generation (non-blocking)
            //   • Phone→cold-call / Email→Sequencer routing per spec
            //   • CampaignLead upsert if rule specifies a target
            //   • Custom cold-call list tag if rule specifies one
            const result = await promoteProfileToCampaign({
                organizationId: event.organization_id,
                profileId: profile.id,
                campaignId: rule?.add_to_campaign_id ?? null,
                coldCallListId: rule?.add_to_cold_call_list_id ?? null,
                engagementEventId: event.id,
                trigger: 'engagement_event',
                triggerRefId: event.id,
            });

            // Surface warnings + routing outcome in the supervisor log.
            // The audit row's decision JSON below also carries them so
            // operator dashboards can render "why this lead ended up
            // here" without reading service logs.
            if (result.warnings.length > 0) {
                logger.warn('[SUPERVISOR] ENFORCE completed with warnings', {
                    lead_id: result.lead_id,
                    event_id: event.id,
                    warnings: result.warnings,
                });
            }

            // Notify users on the rule (in-app + Slack via dispatcher).
            if (rule?.notify_user_ids && rule.notify_user_ids.length > 0) {
                const { notifyIcpMatch } = await import('./../linkedin/notificationDispatcher');
                await notifyIcpMatch(
                    event.organization_id,
                    profile.name,
                    match.top_score,
                    `ICP ${effectiveMatches.length} match`,
                );
            }

            return {
                decision: {
                    outcome: 'enforced',
                    rule_id: rule?.id ?? null,
                    mode,
                    lead_id: result.lead_id,
                    icebreaker_status: result.icebreaker_status,
                    routed: result.routed,
                    warnings: result.warnings,
                },
            };
        },
    );

    // Always mark processed so we don't re-pick the same event.
    await prisma.engagementEvent.update({
        where: { id: event.id },
        data: { processed_at: new Date() },
    });

    return decision.outcome;
}
