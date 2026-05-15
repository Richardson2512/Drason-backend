/**
 * Enrichment agent - wraps the waterfall service in the same agent-audit
 * envelope as the rest of the 5-agent topology.
 *
 * Cost tracking: agent_run.cost_usd captures LLM-side reasoning cost
 * (used in v2 when we layer Kimi judgment on top). Enrichment provider
 * spend itself is NOT tracked - the platform is strict BYOK for
 * enrichment, so the customer's vendor dashboards (Apollo, Clay, etc.)
 * are the source of truth for spend.
 *
 * v1 is a pure pass-through (no LLM call) - the waterfall is deterministic
 * by design. v2 may layer an LLM "did we get enough fields to bother with
 * outreach?" judgment on top, at which point agent_run.cost_usd starts
 * recording the LLM tokens consumed.
 */

import { runAgent } from './agentRegistry';
import { runWaterfall, type WaterfallResult } from '../enrichment/waterfallService';
import type { ProfileInput, EnrichedFields } from '../enrichment/providerInterface';

export interface EnrichInput {
    organization_id: string;
    lead_id: string;
    profile: ProfileInput;
    /** What triggered the enrichment - surfaced on AgentRun for analytics. */
    trigger: string;
    trigger_ref_id?: string;
    /** Which fields cause the waterfall to early-exit. Defaults to ['email'];
     *  the `find_linkedin_url` sequencer step passes ['linkedin_url']. */
    required_fields?: (keyof EnrichedFields)[];
}

export async function runEnrichmentAgent(input: EnrichInput): Promise<WaterfallResult> {
    const { decision } = await runAgent<WaterfallResult>(
        {
            organization_id: input.organization_id,
            trigger: input.trigger,
            trigger_ref_id: input.trigger_ref_id ?? input.lead_id,
            agent_name: 'enrichment',
            model: 'rule-engine', // v1 deterministic
        },
        async () => {
            const result = await runWaterfall(
                input.organization_id,
                input.lead_id,
                input.profile,
                input.required_fields,
            );
            return { decision: result };
        },
    );
    return decision;
}
