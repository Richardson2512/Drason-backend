/**
 * Reply Classifier — rule-based, no AI.
 *
 * Categorizes inbound replies into nine buckets so analytics can show what
 * actually works versus what burns relationships:
 *
 *   positive      — clearly interested ("yes let's chat", "send more info")
 *   qualified     — booking-intent or concrete next step ("here's my calendar")
 *   objection     — questions about price / fit / integrations / timing
 *   referral      — points to someone else ("Sarah handles this")
 *   soft_no       — polite no, not now ("circle back next quarter")
 *   hard_no       — firm refusal, not unsubscribe-flavored
 *   angry         — hostile or profane response
 *   auto          — out-of-office, vacation, autoresponder
 *   unclassified  — none of the above triggered with sufficient confidence
 *
 * RULES OVER MODELS (DELIBERATE)
 *   We chose explicit rules over an ML model so that:
 *     1. Every classification is auditable (signals[] shows why)
 *     2. There's no per-reply API cost
 *     3. Latency is sub-millisecond — we can classify on the IMAP worker hot path
 *     4. Operators can tune the lexicons in prod without retraining anything
 *   Tradeoff: ~30% of replies will land in unclassified or low-confidence.
 *   When we add an AI fallback later, this service stays — AI runs only on
 *   the residue, not on every reply.
 *
 * Pure function — no DB, no fetch, no logging side effects. Every decision
 * is derivable from the inputs, which makes this trivially unit-testable.
 */

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export type ReplyQualityClass =
    | 'positive'
    | 'qualified'
    | 'objection'
    | 'referral'
    | 'soft_no'
    | 'hard_no'
    | 'angry'
    | 'auto'
    | 'unclassified';

export type ReplyConfidence = 'high' | 'medium' | 'low';

export interface ReplyClassifierInput {
    subject?: string | null;
    body_text?: string | null;
    body_html?: string | null;
    /** Optional raw header bag (lowercase keys) for auto-reply detection. */
    headers?: Record<string, string | undefined>;
}

export interface ReplyClassification {
    class: ReplyQualityClass;
    confidence: ReplyConfidence;
    /** Rule names that triggered, in firing order — used in the UI tooltip. */
    signals: string[];
    /** First snippet (≤140 chars) that supports the classification. */
    evidence?: string;
}

// ────────────────────────────────────────────────────────────────────
// Lexicons + patterns
// ────────────────────────────────────────────────────────────────────

/**
 * Phrases that, on their own, are strong enough to commit to a class.
 * Each entry is a precompiled regex. Longest / most specific first so we
 * don't shadow ("not interested" before "interested").
 */
const HARD_NO_PHRASES = [
    /\bnot\s+interest(?:ed)?\b/i,
    /\bplease\s+(?:remove|stop|unsubscribe)\b/i,
    /\bremove\s+me\s+from\s+(?:your|this)\s+list\b/i,
    /\bunsubscribe\s+me\b/i,
    /\bdo\s+not\s+(?:contact|email|message)\b/i,
    /\bstop\s+(?:contacting|emailing|messaging)\b/i,
    /\bno\s+(?:thank\s*you|thanks)\b/i,
    /\bnot\s+a\s+fit\b/i,
    /\bwe\s+(?:already|already've)\s+(?:have|use|got)\b/i,
    /\bnot\s+looking\s+for\s+this\b/i,
    /\bwe['’]re\s+(?:all\s+)?set\b/i,
    /\bpass\b/i,                                // "pass" alone — risky but useful
];

const SOFT_NO_PHRASES = [
    /\bnot\s+(?:right\s+)?now\b/i,
    /\bmaybe\s+(?:later|next)\b/i,
    /\b(?:circle|come|reach\s+out|check)\s+back\s+(?:in|next|later)\b/i,
    /\bping\s+me\s+(?:in|next|later)\b/i,
    /\bnext\s+(?:quarter|year|month|q[1-4])\b/i,
    /\bmaybe\s+next\b/i,
    /\b(?:slammed|swamped|busy)\s+(?:right\s+now|this\s+(?:quarter|month|week))\b/i,
    /\bwe\s+just\s+(?:signed|moved|switched)\s+(?:to|with)\b/i,
    /\bbad\s+(?:timing|time)\b/i,
];

const REFERRAL_PHRASES = [
    /\bnot\s+the\s+right\s+person\b/i,
    /\b(?:talk|reach\s+out|email|ping|cc)\s+(?:to\s+)?(?:our|my|the)\s+(?:colleague|cto|cmo|cfo|ceo|head|vp|director|manager)\b/i,
    /\b(?:adding|cc[’']?ing|cc'd)\s+(?:in\s+)?(?:our|my|the|sarah|john|alex|chris|dave|david|mike|matt|emily|jen|jenny)\b/i,
    /\bwrong\s+(?:person|contact|department)\b/i,
    /\bthis\s+is\s+(?:more\s+)?(?:our|my|a)\s+\w+['’]?s?\s+(?:area|department|domain|role)\b/i,
    /\bplease\s+contact\s+(\w+@\w+|.{3,30}@\w)/i,  // "please contact alex@…"
];

const QUALIFIED_PHRASES = [
    /\b(?:let['’]?s|let\s+us)\s+(?:chat|talk|connect|hop\s+on|jump\s+on)\b/i,
    /\b(?:send|share)\s+(?:me\s+)?(?:more\s+)?(?:info|details|deck|pricing|a\s+demo|a\s+link)\b/i,
    /\b(?:happy|glad|interested)\s+to\s+(?:chat|talk|connect|hear\s+more)\b/i,
    /\bbook\s+(?:a|some)\s+time\b/i,
    /\bschedule\s+a\s+(?:call|meeting|demo)\b/i,
    /\bgrab\s+(?:some\s+)?time\b/i,
    /\bwhen\s+(?:works|is\s+good)\s+for\s+you\b/i,
    /\b(?:works|sounds)\s+good\b/i,
    /\bcalendly\.com/i,
    /\bcal\.com/i,
    /\bsavvycal\.com/i,
    /\bzcal\.co/i,
    /\bzoom\.us\/j\//i,
    /\bmeet\.google\.com/i,
];

const POSITIVE_PHRASES = [
    /\bsounds\s+(?:great|good|interesting)\b/i,
    /\bi[’']?(?:m|d)\s+(?:interested|keen|down|in)\b/i,
    /\bthat\s+(?:sounds|is|would\s+be)\s+(?:great|interesting|helpful|useful)\b/i,
    /\bcurious\s+to\s+(?:hear|learn|see)\b/i,
    /\bworth\s+(?:a\s+)?(?:chat|conversation)\b/i,
    /\btell\s+me\s+more\b/i,
    /\bwould\s+love\s+to\s+(?:learn|hear|see)\b/i,
];

const OBJECTION_PHRASES = [
    /\bhow\s+much\s+(?:does|is|do)\b/i,
    /\bwhat['’]?s?\s+(?:the|your)\s+pricing\b/i,
    /\bdo\s+you\s+(?:integrate|work)\s+with\b/i,
    /\bdoes\s+(?:it|this)\s+(?:work|integrate)\s+with\b/i,
    /\bwhat\s+about\s+(?:security|gdpr|hipaa|compliance|sso)\b/i,
    /\bcan\s+you\s+(?:show|prove|demonstrate)\b/i,
    /\bhow\s+(?:are\s+you|do\s+you)\s+different(?:\s+from|\s+than)?\b/i,
    /\bwe['’]re\s+already\s+using\s+\w+/i,            // both objection + soft_no signal — context decides
];

const ANGRY_PHRASES = [
    /\bf+(?:u+ck|\W+u+ck)\b/i,           // f-bomb variants
    /\bshit\b/i,
    /\bbullshit\b/i,
    /\bspam(?:mer|ming)?\b/i,
    /\bgo\s+to\s+hell\b/i,
    /\bpiece\s+of\s+(?:shit|crap)\b/i,
    /\bstop\s+(?:fucking|damn|f-?ing)\s+(?:emailing|messaging|contacting)/i,
    /\bharass(?:ing|ment)\b/i,
    /\b(?:idiot|moron|asshole)/i,
];

/**
 * Auto-reply detection — RFC 3834 headers first, then phrasal fallback.
 * Inbox autoresponders (vacation / OOO / new role / "I'm leaving the company")
 * shouldn't pollute reply-rate analytics.
 */
const AUTO_REPLY_HEADERS = ['auto-submitted', 'x-autorespond', 'x-autoreply', 'precedence'];
const AUTO_REPLY_PHRASES = [
    /\bout\s+of\s+(?:the\s+)?office\b/i,
    /\bauto[-\s]?reply\b/i,
    /\bautomatic(?:ally)?\s+(?:generated|reply)/i,
    /\bon\s+(?:vacation|holiday|leave|maternity|paternity)\b/i,
    /\bwill\s+be\s+out\s+of\s+(?:the\s+)?office\b/i,
    /\b(?:i|i['’]m)\s+no\s+longer\s+(?:with|at)\b/i,
    /\b(?:left|leaving)\s+(?:the\s+)?company\b/i,
    /\b(?:limited|no)\s+access\s+to\s+email\b/i,
    /\bcurrently\s+(?:traveling|on\s+leave|away)\b/i,
];

/**
 * Lexicon words for residual sentiment — used only when no phrase rule
 * decisively hit. Tiny bias so positive lexicons can tip an ambiguous
 * short reply into `positive` rather than `unclassified`.
 */
const POSITIVE_WORDS = ['great', 'awesome', 'excellent', 'love', 'fantastic', 'helpful', 'useful', 'interested', 'curious', 'thanks', 'appreciate', 'yes'];
const NEGATIVE_WORDS = ['no', 'never', 'wont', "won't", 'cant', "can't", 'sorry', 'unfortunately', 'pass'];

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function stripHtmlToText(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<br\s*\/?>(\s*)/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Strip common quoted-reply boilerplate ("On Mon, X wrote:", "—Original
 * Message—", `>` prefixes) so we only classify the user's actual response.
 * Without this, an angry reply like "fuck off" in a quoted earlier message
 * would pollute the analysis of the new message.
 */
function stripQuotedHistory(text: string): string {
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    for (const line of lines) {
        // Stop at common quoted-history headers.
        if (/^on\s.*\bwrote:\s*$/i.test(line.trim())) break;
        if (/^-{2,}\s*original\s+message\s*-{2,}/i.test(line.trim())) break;
        if (/^from:\s+/i.test(line.trim()) && out.length > 0) break;
        if (/^>+/.test(line.trim())) continue;
        out.push(line);
    }
    return out.join('\n').trim();
}

function firstSnippet(text: string, max = 140): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > max ? compact.slice(0, max - 1) + '…' : compact;
}

function countMatches(text: string, words: string[]): number {
    const lower = ` ${text.toLowerCase()} `;
    let n = 0;
    for (const w of words) {
        const re = new RegExp(`(?:^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'i');
        if (re.test(lower)) n++;
    }
    return n;
}

function anyPhraseMatches(text: string, patterns: RegExp[]): { match: string; pattern: string } | null {
    for (const re of patterns) {
        const m = text.match(re);
        if (m) return { match: m[0], pattern: re.source };
    }
    return null;
}

// ────────────────────────────────────────────────────────────────────
// Classification
// ────────────────────────────────────────────────────────────────────

export function classifyReply(input: ReplyClassifierInput): ReplyClassification {
    const signals: string[] = [];

    // Resolve a working text. Prefer body_text (already stripped by IMAP),
    // otherwise convert HTML. Either way, drop quoted history.
    const rawText = input.body_text && input.body_text.trim().length > 0
        ? input.body_text
        : stripHtmlToText(input.body_html || '');
    const text = stripQuotedHistory(rawText);

    if (!text || text.length < 2) {
        return { class: 'unclassified', confidence: 'low', signals: ['empty_body'] };
    }

    // ── 1. Auto-replies (highest priority, header-based wins instantly) ──
    if (input.headers) {
        for (const h of AUTO_REPLY_HEADERS) {
            const v = (input.headers[h] || '').toLowerCase();
            if (v.includes('auto-replied') || v.includes('auto-generated') || v.includes('vacation') || v === 'auto_reply') {
                signals.push(`auto_header:${h}`);
                return { class: 'auto', confidence: 'high', signals, evidence: firstSnippet(text) };
            }
        }
    }
    const autoPhraseHit = anyPhraseMatches(text, AUTO_REPLY_PHRASES);
    if (autoPhraseHit) {
        signals.push('auto_phrase');
        return { class: 'auto', confidence: 'high', signals, evidence: firstSnippet(autoPhraseHit.match) };
    }

    // ── 2. Angry beats everything below — hostile replies are always urgent ──
    const angryHit = anyPhraseMatches(text, ANGRY_PHRASES);
    const allCapsRatio = (text.replace(/[^A-Za-z]/g, '').match(/[A-Z]/g)?.length || 0)
        / Math.max(1, text.replace(/[^A-Za-z]/g, '').length);
    const isShouting = text.length > 20 && allCapsRatio > 0.6;
    if (angryHit) {
        signals.push('angry_phrase');
        if (isShouting) signals.push('all_caps_shouting');
        return { class: 'angry', confidence: 'high', signals, evidence: firstSnippet(angryHit.match) };
    }
    if (isShouting && countMatches(text, NEGATIVE_WORDS) >= 1) {
        signals.push('all_caps_shouting');
        return { class: 'angry', confidence: 'medium', signals, evidence: firstSnippet(text) };
    }

    // ── 3. Hard nos / unsubscribe-style refusals ──
    const hardNoHit = anyPhraseMatches(text, HARD_NO_PHRASES);
    if (hardNoHit) {
        signals.push('hard_no_phrase');
        return { class: 'hard_no', confidence: 'high', signals, evidence: firstSnippet(hardNoHit.match) };
    }

    // ── 4. Referrals ──
    const referralHit = anyPhraseMatches(text, REFERRAL_PHRASES);
    if (referralHit) {
        signals.push('referral_phrase');
        return { class: 'referral', confidence: 'high', signals, evidence: firstSnippet(referralHit.match) };
    }

    // ── 5. Qualified — booking intent / explicit "let's connect" ──
    const qualifiedHit = anyPhraseMatches(text, QUALIFIED_PHRASES);
    if (qualifiedHit) {
        signals.push('qualified_phrase');
        return { class: 'qualified', confidence: 'high', signals, evidence: firstSnippet(qualifiedHit.match) };
    }

    // ── 6. Soft nos (after qualified — "let's chat next quarter" should be
    //      caught as qualified above, not as a soft no on its own) ──
    const softNoHit = anyPhraseMatches(text, SOFT_NO_PHRASES);
    if (softNoHit) {
        signals.push('soft_no_phrase');
        return { class: 'soft_no', confidence: 'high', signals, evidence: firstSnippet(softNoHit.match) };
    }

    // ── 7. Objections — questions about pricing / fit / integrations ──
    const objectionHit = anyPhraseMatches(text, OBJECTION_PHRASES);
    const hasQuestionMark = /\?/.test(text);
    if (objectionHit) {
        signals.push('objection_phrase');
        if (hasQuestionMark) signals.push('question_mark');
        return { class: 'objection', confidence: hasQuestionMark ? 'high' : 'medium', signals, evidence: firstSnippet(objectionHit.match) };
    }

    // ── 8. Positive (explicit phrases) ──
    const positiveHit = anyPhraseMatches(text, POSITIVE_PHRASES);
    if (positiveHit) {
        signals.push('positive_phrase');
        return { class: 'positive', confidence: 'high', signals, evidence: firstSnippet(positiveHit.match) };
    }

    // ── 9. Lexicon-only fallback. Bias toward positive only when there's a
    //      meaningful positive surplus, otherwise unclassified.
    const positives = countMatches(text, POSITIVE_WORDS);
    const negatives = countMatches(text, NEGATIVE_WORDS);
    if (positives - negatives >= 2 && text.length < 300) {
        signals.push('lexicon_positive');
        return { class: 'positive', confidence: 'low', signals, evidence: firstSnippet(text) };
    }
    if (negatives - positives >= 2 && text.length < 300) {
        signals.push('lexicon_negative');
        return { class: 'soft_no', confidence: 'low', signals, evidence: firstSnippet(text) };
    }
    // Lone question with no objection lexicon — treat as objection (low confidence)
    if (hasQuestionMark && text.length < 400) {
        signals.push('lone_question');
        return { class: 'objection', confidence: 'low', signals, evidence: firstSnippet(text) };
    }

    return { class: 'unclassified', confidence: 'low', signals };
}

// ────────────────────────────────────────────────────────────────────
// Backfill helper
// ────────────────────────────────────────────────────────────────────

/**
 * Re-classify a batch of inbound EmailMessages. Used by the one-shot backfill
 * script + by future operators who tweak the lexicons and want to rerun. The
 * caller passes the rows; this function returns `(id, classification)` pairs
 * for the caller to write back. Keeps DB I/O out of the pure logic.
 */
export function classifyBatch(
    rows: Array<{ id: string; subject: string; body_text: string | null; body_html: string }>,
): Array<{ id: string; classification: ReplyClassification }> {
    return rows.map(r => ({
        id: r.id,
        classification: classifyReply({
            subject: r.subject,
            body_text: r.body_text,
            body_html: r.body_html,
        }),
    }));
}
