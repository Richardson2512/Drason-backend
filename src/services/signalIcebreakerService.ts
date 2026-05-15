/**
 * Signal-context icebreaker generator.
 *
 * When a LinkedIn engagement signal promotes a prospect into a campaign,
 * this service generates a 1-3 sentence AI opener seeded by what the
 * prospect actually engaged with - the post body, their interaction type
 * (like / comment / share / repost), the literal comment text if they
 * commented, the post date, and the post author's name. The opener gets
 * written to Lead.signal_icebreaker; the Sequencer email renderer
 * substitutes {{signal_icebreaker}} at send time.
 *
 * Inspired by lemlist's `{{signalLinkedInTopicPostAuthorName}}` /
 * `{{signalLinkedInTopicCommentContent}}` variable family. We keep the
 * surface narrow on purpose - one workspace-wide prompt template,
 * triggered automatically on signal-promotion. v2 may add per-campaign
 * prompts and manual regenerate-from-UI controls.
 *
 * Stub-safe: if OPENAI_API_KEY is unset, the generator no-ops (returns
 * null) and the Sequencer renderer falls back to whatever default the
 * step author wrote inline - same way it falls back on any missing var.
 */

import { prisma } from '../prisma';
import { logger } from './observabilityService';
import { safeCompletion } from './openaiClient';

// Default prompt - kept here as a constant rather than a settings row
// for v1. The operator can override via a workspace setting in v2; for
// now this is what every org gets. Designed to produce a single-sentence
// opener that references the specific engagement without sounding
// AI-stitched.
const DEFAULT_PROMPT = `You write 1-2 sentence cold-outreach openers. The lead engaged with a LinkedIn post by my colleague. Write an opener that mentions the post naturally and references what the lead said or how they reacted. The opener will be the first sentence of an email - no greeting, no sign-off, no quotes. Don't say "I noticed" or "I saw" - make it feel like a peer-to-peer observation. Maximum 280 characters.`;

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

interface IcebreakerInput {
    organizationId: string;
    leadId: string;
    /** Engagement event id that's seeding the icebreaker. The service
     *  reads the post + comment text + interaction off this row. */
    engagementEventId: string;
}

interface IcebreakerResult {
    text: string | null;
    /** When the generator decided not to run - useful for telemetry +
     *  the UI's "why is the opener empty?" affordance. */
    skip_reason?: string;
}

const REACTION_PHRASING: Record<string, string> = {
    LIKE:         'liked',
    PRAISE:       'celebrated',
    EMPATHY:      'reacted with love to',
    INTEREST:     'flagged as insightful',
    APPRECIATION: 'supported',
    MAYBE:        'reacted with a "maybe" to',
    FUNNY:        'reacted with humour to',
};

function describeInteraction(eventType: string, reactionType: string | null): string {
    if (eventType === 'COMMENT') return 'commented on';
    if (eventType === 'SHARE')   return 'shared';
    if (eventType === 'REPOST')  return 'reposted';
    if (eventType === 'REACTION') {
        const k = (reactionType || 'LIKE').toUpperCase();
        return REACTION_PHRASING[k] || 'reacted to';
    }
    return 'engaged with';
}

/** Persist a skip-reason on the Lead so the operator-facing icebreaker
 *  panel can render "Couldn't auto-generate: {reason}" instead of a
 *  silent null. We don't clear `signal_icebreaker` if it was already
 *  set from a prior successful generation � a stale-but-real opener is
 *  better UX than a vacated field. */
async function recordSkip(leadId: string, reason: string): Promise<void> {
    try {
        await prisma.lead.update({
            where: { id: leadId },
            data: { signal_icebreaker_skip_reason: reason },
        });
    } catch {
        // Best-effort � failure to log a skip reason should never
        // propagate to the caller. Reason already lives in the
        // returned IcebreakerResult so the caller can still surface it.
    }
}

export async function generateIcebreakerFromSignal(
    input: IcebreakerInput,
): Promise<IcebreakerResult> {
    if (!process.env.OPENAI_API_KEY) {
        await recordSkip(input.leadId, 'openai_not_configured');
        return { text: null, skip_reason: 'openai_not_configured' };
    }

    // Pull the engagement event + post + author.
    const event = await prisma.engagementEvent.findFirst({
        where: { id: input.engagementEventId, organization_id: input.organizationId },
        include: {
            post: { include: { account: { select: { display_name: true } } } },
            actor: { select: { name: true } },
        },
    });

    if (!event) {
        await recordSkip(input.leadId, 'event_not_found');
        return { text: null, skip_reason: 'event_not_found' };
    }

    const postText = (event.post?.text as string | null | undefined) || '';
    const articleTitle = (event.post?.article_title as string | null | undefined) || '';
    const commentText = (event.comment_text as string | null | undefined) || '';
    const authorName = event.post?.account?.display_name || 'the post author';
    const interaction = describeInteraction(event.event_type, event.reaction_type);
    const actorName = event.actor?.name || 'the lead';
    const postedAt = event.post?.posted_at ? new Date(event.post.posted_at) : null;

    // Skip when we have neither post body nor a comment to ground on �
    // an AI opener with nothing to reference is just hallucinated filler.
    if (!postText && !articleTitle && !commentText) {
        await recordSkip(input.leadId, 'no_grounding_context');
        return { text: null, skip_reason: 'no_grounding_context' };
    }

    const contextLines: string[] = [
        `Lead: ${actorName}`,
        `Interaction: ${actorName} ${interaction} a post by ${authorName}.`,
    ];
    if (postedAt) {
        const daysAgo = Math.max(0, Math.floor((Date.now() - postedAt.getTime()) / (24 * 60 * 60 * 1000)));
        contextLines.push(`Posted ${daysAgo === 0 ? 'today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`}.`);
    }
    if (articleTitle) {
        contextLines.push(`Article title: ${articleTitle}`);
    }
    if (postText) {
        contextLines.push(`Post body: ${postText.slice(0, 1200)}`);
    }
    if (commentText) {
        contextLines.push(`What ${actorName} commented: ${commentText.slice(0, 600)}`);
    }

    try {
        const completion = await safeCompletion({
            model: MODEL,
            messages: [
                { role: 'system', content: DEFAULT_PROMPT },
                { role: 'user', content: contextLines.join('\n') },
            ],
            max_tokens: 160,
            temperature: 0.55,
        }, { tag: 'signal-icebreaker' });

        const text = (completion.choices?.[0]?.message?.content ?? '').trim();
        if (!text) { await recordSkip(input.leadId, 'empty_completion'); return { text: null, skip_reason: 'empty_completion' }; }

        // Strip stray surrounding quotes - the model occasionally wraps.
        const cleaned = text.replace(/^["“]/, '').replace(/["”]$/, '').trim();

        // Success � clear any prior skip_reason so the panel renders the
        // opener cleanly instead of "Couldn't auto-generate" alongside
        // the generated text.
        await prisma.lead.update({
            where: { id: input.leadId },
            data: {
                signal_icebreaker: cleaned,
                signal_icebreaker_generated_at: new Date(),
                signal_icebreaker_event_id: input.engagementEventId,
                signal_icebreaker_skip_reason: null,
            },
        });

        logger.info('[SIGNAL_ICEBREAKER] generated', {
            leadId: input.leadId,
            eventId: input.engagementEventId,
            chars: cleaned.length,
        });

        return { text: cleaned };
    } catch (err) {
        logger.warn('[SIGNAL_ICEBREAKER] generation failed', {
            leadId: input.leadId,
            error: err instanceof Error ? err.message : String(err),
        });
        const reason = err instanceof Error && /rate.?limit/i.test(err.message) ? 'rate_limited' : 'generation_error';
        await recordSkip(input.leadId, reason);
        return { text: null, skip_reason: reason };
    }
}

/**
 * Convenience: given a lead promoted from a signal, find the most-recent
 * relevant engagement event for that lead's profile and generate.
 *
 * Caller-friendly because most promotion paths know the lead but not the
 * specific event - they just know "this person engaged."
 */
export async function generateIcebreakerForLead(
    organizationId: string,
    leadId: string,
): Promise<IcebreakerResult> {
    const lead = await prisma.lead.findFirst({
        where: { id: leadId, organization_id: organizationId },
        select: { linkedin_url: true },
    });
    if (!lead?.linkedin_url) {
        return { text: null, skip_reason: 'lead_has_no_linkedin_url' };
    }

    // Extract the slug from /in/<slug>.
    const slug = lead.linkedin_url.match(/\/in\/([^/?#]+)/i)?.[1]?.toLowerCase();
    if (!slug) return { text: null, skip_reason: 'unparseable_linkedin_url' };

    const profile = await prisma.linkedInProfile.findFirst({
        where: { organization_id: organizationId, public_identifier: slug },
        select: { id: true },
    });
    if (!profile) return { text: null, skip_reason: 'no_profile_for_slug' };

    const event = await prisma.engagementEvent.findFirst({
        where: { organization_id: organizationId, actor_profile_id: profile.id },
        orderBy: { occurred_at: 'desc' },
        select: { id: true },
    });
    if (!event) return { text: null, skip_reason: 'no_engagement_events_for_lead' };

    return generateIcebreakerFromSignal({
        organizationId,
        leadId,
        engagementEventId: event.id,
    });
}
