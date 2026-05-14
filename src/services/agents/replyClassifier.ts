/**
 * Reply classifier — the Auto-Tag pipeline.
 *
 * Behavior:
 *   - First reply only (subsequent replies don't re-tag)
 *   - 15-minute delay between reply and tag generation
 *   - One tag per lead, workspace-wide, latest-wins across campaigns
 *   - 3 classes: Interested / Not Interested / Generic
 *
 * Implementation: Kimi K2.5 via safeKimiCompletion (jsonMode for strict
 * output), wrapped in the agentRegistry.runAgent envelope so cost +
 * latency land in AgentRun. Returns the class label, a 0..1 confidence,
 * and a short reasoning trace (kept for analytics drill-down).
 */

import { runAgent } from './agentRegistry';
import { safeKimiCompletion, isKimiConfigured } from '../kimiClient';
import { prisma } from '../../prisma';
import { logger } from '../observabilityService';

export type ReplyTag = 'Interested' | 'Not Interested' | 'Generic';

export interface ReplyClassification {
    tag: ReplyTag;
    confidence: number;
    reasoning: string;
}

const SYSTEM = `You are a sales-reply classifier. Given the lead's first reply to a cold outbound message (LinkedIn DM or email), pick exactly one of three labels:

- "Interested": the lead is open to a conversation, asking pricing, asking for a meeting, expressing curiosity, or otherwise indicating positive intent.
- "Not Interested": the lead is declining, opting out, saying they're already on a competitor's tool, asking to be removed, or expressing irritation.
- "Generic": out-of-office, automatic forwarding, "thanks for connecting" with no engagement signal, unclear/neutral content.

Output STRICT JSON: { "tag": "Interested" | "Not Interested" | "Generic", "confidence": 0..1, "reasoning": "≤ 240 chars" }`;

/**
 * Rule-based pre-filter — runs before the LLM to catch obvious cases
 * cheaply (OOO replies, opt-outs, etc.). Returns NULL when no rule
 * matches and the LLM should be called.
 */
function ruleBasedShortcut(reply: string): ReplyClassification | null {
    const t = reply.toLowerCase().trim();
    if (!t) return { tag: 'Generic', confidence: 1.0, reasoning: 'Empty reply' };

    // OOO / auto-responses → Generic with high confidence.
    const oooMarkers = ['out of office', 'out of the office', 'on vacation', 'on holiday', 'currently away', 'will be back', 'limited access to email', 'auto-reply', 'automatic reply'];
    if (oooMarkers.some(m => t.includes(m))) {
        return { tag: 'Generic', confidence: 0.95, reasoning: 'Out-of-office / auto-reply markers detected' };
    }

    // Explicit opt-out → Not Interested.
    const optOut = ['unsubscribe', 'remove me', 'take me off', 'do not contact', 'stop emailing', 'no thanks', 'not interested', 'no thank you'];
    if (optOut.some(m => t.includes(m))) {
        return { tag: 'Not Interested', confidence: 0.92, reasoning: 'Opt-out phrasing detected' };
    }

    // Short "thanks for connecting" → Generic.
    if (t.length < 40 && (t.includes('thanks for connecting') || t.includes('thanks for the connection'))) {
        return { tag: 'Generic', confidence: 0.85, reasoning: 'Short connection-acknowledgement reply' };
    }

    return null;
}

/**
 * Classify a reply + persist the result on the LinkedInProfile when a
 * profile id is supplied (so the Unibox can render the auto-tag badge
 * without re-running the classifier on page load).
 *
 * Latest classification wins (workspace-wide). We always overwrite —
 * there's no "lock first tag" semantics.
 */
export async function classifyReply(
    organizationId: string,
    reply: string,
    opts: { triggerRefId?: string; senderName?: string; linkedinProfileId?: string } = {},
): Promise<ReplyClassification> {
    const { decision } = await runAgent<ReplyClassification>(
        {
            organization_id: organizationId,
            trigger: 'reply_received',
            trigger_ref_id: opts.triggerRefId,
            agent_name: 'reply_classifier',
        },
        async () => {
            // Fast path: rule-based shortcuts.
            const ruleResult = ruleBasedShortcut(reply);
            if (ruleResult) {
                return { decision: ruleResult };
            }

            // LLM path (Kimi K2.5).
            if (!isKimiConfigured()) {
                // Stub-safe fallback when Kimi isn't configured — neutral
                // Generic label with low confidence so downstream auto-
                // actions don't fire on guesses.
                return {
                    decision: { tag: 'Generic', confidence: 0.5, reasoning: 'Kimi unavailable; classifier in stub mode' } as ReplyClassification,
                };
            }

            const userMsg = `Sender: ${opts.senderName || 'our team'}\nLead's first reply:\n"""\n${reply.slice(0, 2000)}\n"""`;
            const completion = await safeKimiCompletion({
                messages: [
                    { role: 'system', content: SYSTEM },
                    { role: 'user', content: userMsg },
                ],
                jsonMode: true,
                temperature: 0.1,
                maxTokens: 200,
                tag: 'reply_classifier',
            });

            const parsed = safeParse(completion.text);
            return {
                decision: parsed,
                prompt_tokens: completion.promptTokens,
                completion_tokens: completion.completionTokens,
            };
        },
    );

    // Persist the tag on the profile so Unibox + analytics can read it
    // without re-running the classifier. Best-effort — failures here
    // don't surface to the caller since the audit row already has the
    // canonical record via AgentRun.
    if (opts.linkedinProfileId) {
        try {
            const updated = await prisma.linkedInProfile.update({
                where: { id: opts.linkedinProfileId },
                data: {
                    linkedin_auto_tag: decision.tag,
                    linkedin_auto_tagged_at: new Date(),
                },
                select: { lead_id: true },
            });
            // Push the Intent bucket to HubSpot when the lead has an email
            // on file. Stub-safe (no-ops without HUBSPOT_API_KEY).
            if (updated.lead_id) {
                const lead = await prisma.lead.findUnique({
                    where: { id: updated.lead_id }, select: { email: true },
                });
                if (lead?.email && !lead.email.endsWith('@unresolved.local')) {
                    const { pushIntent } = await import('../linkedin/hubspotSyncService');
                    await pushIntent({ email: lead.email, tag: decision.tag });
                }
            }
        } catch (err) {
            logger.warn('[REPLY-CLASSIFIER] profile tag persist failed', { profile_id: opts.linkedinProfileId, err: String(err).slice(0, 200) });
        }
    }

    return decision;
}

function safeParse(text: string): ReplyClassification {
    try {
        const obj = JSON.parse(text);
        const tag = ['Interested', 'Not Interested', 'Generic'].includes(obj.tag) ? obj.tag : 'Generic';
        const conf = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
        const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 240) : '';
        return { tag, confidence: conf, reasoning };
    } catch {
        return { tag: 'Generic', confidence: 0.3, reasoning: 'Parse error from classifier; defaulted to Generic' };
    }
}
