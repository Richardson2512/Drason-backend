/**
 * ICP Matcher - deterministic rule engine (v1).
 *
 * Evaluates a hydrated profile snapshot against every enabled IcpProfile
 * in the organization. Returns the matching ICP(s) + a normalized score.
 *
 * Locked design from the project memory:
 *   - v1: structured filter sets (titles[], industries[], company_sizes[],
 *     geos[]). Match = profile matches at least one value in EVERY
 *     non-empty filter list ("AND across categories, OR within").
 *   - Score = #non-empty-categories-matched / #non-empty-categories.
 *     Hitting all 4 categories = 1.0; hitting 3 of 4 = 0.75; etc.
 *   - v2 (later): LLM swap for fuzzy / natural-language ICPs.
 *
 * Wired through agentRegistry.runAgent so every call writes an AgentRun
 * audit row with model='rule-engine'.
 */

import { prisma } from '../../prisma';
import { runAgent, AGENTS } from './agentRegistry';

export interface ProfileSnapshot {
    /** LinkedIn member URN or DB UUID - used for the AgentRun trigger_ref. */
    profile_id: string;
    title?: string | null;
    headline?: string | null;
    position?: string | null;
    company?: string | null;
    industry?: string | null;
    /** Free-form company-size string (e.g. "51-200 employees"). The matcher
     *  collapses this into the same enum buckets as IcpProfile.company_sizes. */
    company_size_raw?: string | null;
    location?: string | null;
    /** Geographic context - country or region inferred from location. */
    country?: string | null;
}

export interface IcpMatchResult {
    matched_icp_ids: string[];
    /** Highest match score across all evaluated ICPs (0..1). */
    top_score: number;
    /** Human-readable rationale referencing which fields matched. */
    rationale: string;
}

const SIZE_BUCKETS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'];

function bucketCompanySize(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const m = raw.match(/(\d[\d,]*)\s*[-–]?\s*(\d[\d,]*)?/);
    if (!m) return null;
    const lo = parseInt(m[1].replace(/,/g, ''), 10);
    if (Number.isNaN(lo)) return null;
    if (lo <= 10) return '1-10';
    if (lo <= 50) return '11-50';
    if (lo <= 200) return '51-200';
    if (lo <= 500) return '201-500';
    if (lo <= 1000) return '501-1000';
    if (lo <= 5000) return '1001-5000';
    return '5000+';
}

function caseInsensitiveContainsAny(haystack: string | null | undefined, needles: string[]): boolean {
    if (!haystack || needles.length === 0) return false;
    const h = haystack.toLowerCase();
    return needles.some(n => n && h.includes(n.toLowerCase()));
}

/**
 * Match a single profile against an organization's ICP profiles.
 * Pure function - does NOT write the AgentRun audit row directly.
 * Callers wrap with matchProfileWithAudit() when org-level audit is wanted.
 */
export async function matchProfile(organizationId: string, profile: ProfileSnapshot): Promise<IcpMatchResult> {
    const icps = await prisma.icpProfile.findMany({
        where: { organization_id: organizationId, enabled: true },
    });

    if (icps.length === 0) {
        return { matched_icp_ids: [], top_score: 0, rationale: 'No enabled ICP profiles' };
    }

    const profileSize = bucketCompanySize(profile.company_size_raw);
    const titleHaystack = [profile.title, profile.headline, profile.position].filter(Boolean).join(' | ');

    const matched: { id: string; score: number; reasons: string[] }[] = [];
    for (const icp of icps) {
        const reasons: string[] = [];
        let total = 0;
        let hit = 0;

        if (icp.titles.length > 0) {
            total++;
            if (caseInsensitiveContainsAny(titleHaystack, icp.titles)) {
                hit++;
                reasons.push('title');
            }
        }
        if (icp.industries.length > 0) {
            total++;
            if (caseInsensitiveContainsAny(profile.industry, icp.industries)) {
                hit++;
                reasons.push('industry');
            }
        }
        if (icp.company_sizes.length > 0) {
            total++;
            if (profileSize && icp.company_sizes.includes(profileSize)) {
                hit++;
                reasons.push('company_size');
            }
        }
        if (icp.geos.length > 0) {
            total++;
            const geoHay = [profile.country, profile.location].filter(Boolean).join(' | ');
            if (caseInsensitiveContainsAny(geoHay, icp.geos)) {
                hit++;
                reasons.push('geo');
            }
        }

        // A profile is considered a match when it hits EVERY non-empty
        // filter category. Partial hits get scored but don't go into
        // matched_icp_ids - the supervisor uses top_score for SUGGEST
        // mode hand-off and matched_icp_ids for ENFORCE mode actions.
        if (total > 0 && hit === total) {
            matched.push({ id: icp.id, score: 1.0, reasons });
        } else if (total > 0 && hit > 0) {
            // Track partial matches for the rationale even when below
            // the ENFORCE threshold.
            matched.push({ id: icp.id, score: hit / total, reasons });
        }
    }

    matched.sort((a, b) => b.score - a.score);
    const top = matched[0];
    const enforceable = matched.filter(m => m.score >= 1.0).map(m => m.id);

    return {
        matched_icp_ids: enforceable,
        top_score: top?.score ?? 0,
        rationale: top
            ? `Best match ${(top.score * 100).toFixed(0)}% on ${top.reasons.join(', ')}`
            : 'No ICP categories matched',
    };
}

/**
 * Convenience wrapper - writes the AgentRun audit row alongside the
 * match, plus a per-ICP `AgentRunIcpMatch` row for every ICP the
 * profile scored against (top_score in the AgentRun.decision JSON only
 * tells you the highest-scoring match - the SUGGEST review UI needs
 * the full breakdown to render "matched ICP A 100%, ICP C 75%").
 */
export async function matchProfileWithAudit(
    organizationId: string,
    profile: ProfileSnapshot,
    trigger: string,
    triggerRefId?: string,
): Promise<IcpMatchResult> {
    const { decision, runId } = await runAgent<IcpMatchResult & { _detailed_matches?: Array<{ id: string; score: number; reasons: string[] }> }>(
        {
            organization_id: organizationId,
            trigger,
            trigger_ref_id: triggerRefId ?? profile.profile_id,
            agent_name: 'icp_matcher',
            model: AGENTS.icp_matcher.model,
        },
        async () => {
            const result = await matchProfileDetailed(organizationId, profile);
            return { decision: result };
        },
    );

    // Write the per-ICP audit rows. We only record the matches that
    // actually scored above zero - zero-score rows would explode the
    // table at scale (every profile × every ICP) without adding signal.
    const detailed = decision._detailed_matches ?? [];
    if (detailed.length > 0 && runId) {
        try {
            await prisma.agentRunIcpMatch.createMany({
                data: detailed.map(m => ({
                    agent_run_id: runId,
                    icp_profile_id: m.id,
                    score: m.score,
                    rationale: m.reasons.length > 0 ? `matched on: ${m.reasons.join(', ')}` : null,
                })),
                skipDuplicates: true,
            });
        } catch (err) {
            // Best-effort - the AgentRun row + decision JSON still
            // carry the top match data. Failure here is an audit gap,
            // not a correctness issue.
            // eslint-disable-next-line no-console
            console.warn('[ICP-MATCHER] AgentRunIcpMatch write failed', err);
        }
    }

    // Return the public-API shape (drop the internal field).
    return {
        matched_icp_ids: decision.matched_icp_ids,
        top_score: decision.top_score,
        rationale: decision.rationale,
    };
}

/** Internal variant that preserves per-ICP match details for the
 *  audit-row writer. Re-implements matchProfile() but returns the full
 *  `matched` array on the result so the caller can persist it. */
async function matchProfileDetailed(
    organizationId: string,
    profile: ProfileSnapshot,
): Promise<IcpMatchResult & { _detailed_matches: Array<{ id: string; score: number; reasons: string[] }> }> {
    const result = await matchProfile(organizationId, profile);
    // matchProfile() drops the per-ICP breakdown. Re-run the inner
    // loop logic to recover it - cheap because we already have the
    // ICP list in memory (well, we re-fetch - see TODO). This is an
    // O(N_icps) recomputation, negligible at typical N=1-10 ICPs.
    const icps = await prisma.icpProfile.findMany({
        where: { organization_id: organizationId, enabled: true },
    });
    const profileSize = bucketCompanySize(profile.company_size_raw);
    const titleHaystack = [profile.title, profile.headline, profile.position].filter(Boolean).join(' | ');
    const detailed: Array<{ id: string; score: number; reasons: string[] }> = [];
    for (const icp of icps) {
        const reasons: string[] = [];
        let total = 0;
        let hit = 0;
        if (icp.titles.length > 0) {
            total++;
            if (caseInsensitiveContainsAny(titleHaystack, icp.titles)) { hit++; reasons.push('title'); }
        }
        if (icp.industries.length > 0) {
            total++;
            if (caseInsensitiveContainsAny(profile.industry, icp.industries)) { hit++; reasons.push('industry'); }
        }
        if (icp.company_sizes.length > 0) {
            total++;
            if (profileSize && icp.company_sizes.includes(profileSize)) { hit++; reasons.push('company_size'); }
        }
        if (icp.geos.length > 0) {
            total++;
            const geoHay = [profile.country, profile.location].filter(Boolean).join(' | ');
            if (caseInsensitiveContainsAny(geoHay, icp.geos)) { hit++; reasons.push('geo'); }
        }
        if (total > 0 && hit > 0) {
            detailed.push({ id: icp.id, score: total > 0 && hit === total ? 1.0 : hit / total, reasons });
        }
    }
    return { ...result, _detailed_matches: detailed };
}
