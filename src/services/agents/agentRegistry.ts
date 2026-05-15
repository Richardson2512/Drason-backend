/**
 * Agent registry - codifies the 5-agent topology described in
 * project_linkedin_outreach_initiative memory:
 *
 *   supervisor          - routes events; decides which agent handles what
 *   signal_monitoring   - owns the poller; emits engagement_event objects
 *   icp_matcher         - deterministic rule engine (v1); becomes LLM in v2
 *   enrichment          - runs the waterfall providers; merges fields
 *   reply_classifier    - auto-tag equivalent (Interested / Not Interested / Generic)
 *
 * Each agent invocation writes an AgentRun audit row so cost + latency
 * are queryable and replayable. The dispatcher (Phase 4 cont.) reads
 * these definitions to pick the right model + prompt + tool set.
 */

import { Prisma } from '@prisma/client';
import { logger } from '../observabilityService';
import { prisma } from '../../prisma';

export type AgentName =
    | 'supervisor'
    | 'signal_monitoring'
    | 'icp_matcher'
    | 'enrichment'
    | 'reply_classifier';

export type ModelName =
    | 'kimi-k2-0905-preview'
    | 'kimi-k2-5'
    | 'gpt-5'
    | 'gemini-2.0-flash'
    | 'rule-engine';

export interface AgentDef {
    name: AgentName;
    /** Default model - overridable at call site. */
    model: ModelName;
    description: string;
    /** What the agent's structured output looks like. Used for schema-checking
     *  decisions stored in AgentRun.decision. */
    output_keys: string[];
}

export const AGENTS: Record<AgentName, AgentDef> = {
    supervisor: {
        name: 'supervisor',
        model: 'kimi-k2-0905-preview',
        description: 'Routes engagement events through the agent chain. Decides ICP-match → enrichment → action.',
        output_keys: ['next_agent', 'action', 'reason'],
    },
    signal_monitoring: {
        name: 'signal_monitoring',
        model: 'kimi-k2-0905-preview',
        description: 'Interprets polling-cycle results: noteworthy engagement, dedup decisions, scope-rule application.',
        output_keys: ['emit_events', 'skip_reason'],
    },
    icp_matcher: {
        name: 'icp_matcher',
        model: 'rule-engine',
        description: 'v1 deterministic predicate match across titles / industries / sizes / geos. v2: LLM judgment over fuzzy ICPs.',
        output_keys: ['matched_icp_ids', 'top_score', 'rationale'],
    },
    enrichment: {
        name: 'enrichment',
        model: 'kimi-k2-0905-preview',
        description: 'Drives the waterfall providers, decides when to short-circuit, merges fields back into the lead.',
        output_keys: ['fields_filled', 'provider_attempts', 'final_lead_state'],
    },
    reply_classifier: {
        name: 'reply_classifier',
        model: 'kimi-k2-0905-preview',
        description: 'Auto-Tag - classifies the first reply into Interested / Not Interested / Generic.',
        output_keys: ['class', 'confidence', 'reasoning'],
    },
};

// ────────────────────────────────────────────────────────────────────
// Audit-row writer - every agent call goes through this so cost,
// latency, and decisions are queryable from one table.
// ────────────────────────────────────────────────────────────────────

export interface AgentRunInput {
    organization_id: string;
    /** What triggered the run (event type - e.g. 'engagement_event'). */
    trigger: string;
    trigger_ref_id?: string;
    agent_name: AgentName;
    /** Model used for THIS specific call - may differ from the default. */
    model?: ModelName;
}

export interface AgentRunOutcome {
    decision?: object | null;
    prompt_tokens?: number;
    completion_tokens?: number;
    cost_usd?: number;
    status?: 'SUCCESS' | 'ERROR' | 'SKIPPED';
    error_message?: string;
}

/**
 * Run an agent function and persist the result.
 *
 * Wraps the agent call so the same telemetry is captured no matter who
 * the caller is. Returns the agent's decision + audit row id.
 */
export async function runAgent<T extends object>(
    input: AgentRunInput,
    fn: () => Promise<{ decision: T } & Omit<AgentRunOutcome, 'decision'>>,
): Promise<{ runId: string; decision: T }> {
    const def = AGENTS[input.agent_name];
    const model = input.model || def.model;
    const startedAt = Date.now();
    let outcome: AgentRunOutcome = { status: 'SUCCESS' };
    let decision: T | null = null;

    try {
        const result = await fn();
        decision = result.decision;
        outcome = {
            decision: result.decision,
            prompt_tokens: result.prompt_tokens,
            completion_tokens: result.completion_tokens,
            cost_usd: result.cost_usd,
            status: result.status ?? 'SUCCESS',
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome = { status: 'ERROR', error_message: msg.slice(0, 1000) };
        logger.error(`[AGENT:${input.agent_name}] Failed`, err instanceof Error ? err : new Error(msg));
    }

    const latencyMs = Date.now() - startedAt;
    const row = await prisma.agentRun.create({
        data: {
            organization_id: input.organization_id,
            trigger: input.trigger,
            trigger_ref_id: input.trigger_ref_id,
            agent_name: input.agent_name,
            model,
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
            latency_ms: latencyMs,
            // Prisma's Json input type is narrower than `object`; cast at
            // the boundary so callers can pass their typed decisions.
            decision: outcome.decision as Prisma.InputJsonValue | undefined,
            cost_usd: outcome.cost_usd ?? undefined,
            status: outcome.status || 'SUCCESS',
            error_message: outcome.error_message,
        },
        select: { id: true },
    });

    if (outcome.status === 'ERROR') {
        throw new Error(outcome.error_message || `[AGENT:${input.agent_name}] failed`);
    }
    return { runId: row.id, decision: decision as T };
}
