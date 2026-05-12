/**
 * Reply intelligence — second-pass enrichment over rule-based replyClassifier.
 *
 * Two enrichment paths share this service:
 *
 *   1. AI re-classification (Gemini Flash). Only runs when the rule-based
 *      classifier returned `unclassified` OR `low` confidence. Saves cost
 *      on the 90%+ of replies where the rule pass is already decisive.
 *      Returns a class + confidence + short reasoning string.
 *
 *   2. Out-of-office date extraction. Runs only when the rule-based class
 *      is `auto`. Tries a fast regex pass first; falls back to Gemini for
 *      the awkward formats ("back the second week of June", "out till
 *      Mon"). Date is returned in ISO; the worker stamps it on
 *      CampaignLead.ooo_until so the dispatcher honors it.
 *
 * Both paths gracefully degrade when GEMINI_API_KEY is unset — the regex
 * OOO parser still runs, AI re-classification becomes a no-op. No code
 * change required to flip between modes.
 */

import { safeGeminiCompletion, isGeminiConfigured } from './geminiClient';
import { logger } from './observabilityService';
import type { ReplyClassification, ReplyQualityClass } from './replyClassifierService';

const VALID_CLASSES: ReplyQualityClass[] = [
    'positive', 'qualified', 'objection', 'referral',
    'soft_no', 'hard_no', 'angry', 'auto', 'unclassified',
];

// ────────────────────────────────────────────────────────────────────
// AI re-classification — Gemini Flash second-pass
// ────────────────────────────────────────────────────────────────────

export interface AiReclassifyInput {
    subject: string;
    body: string; // plain text preferred, but accepts HTML too
    /** The rule-based classifier's verdict, passed in for prompt context.
     *  We don't *trust* it — we re-classify from scratch — but giving
     *  the model the rule output lets it disagree with reasoning. */
    ruleClass: ReplyQualityClass;
    ruleConfidence: 'high' | 'medium' | 'low';
}

export interface AiReclassifyResult {
    class: ReplyQualityClass;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
    /** True when Gemini was actually consulted (vs stub / unconfigured). */
    invoked: boolean;
}

/** Whether the rule pass needs an AI second look. We're stingy here:
 *  every Gemini call costs money, so we only escalate when the rule
 *  output is genuinely ambiguous. */
export function shouldAiReclassify(rule: ReplyClassification): boolean {
    if (!isGeminiConfigured()) return false;
    if (rule.class === 'unclassified') return true;
    if (rule.confidence === 'low') return true;
    return false;
}

const RECLASSIFY_PROMPT_TEMPLATE = (input: AiReclassifyInput) => `You are a cold-email reply classifier. Read the reply below and pick exactly one class from this list:

  positive      — clearly interested, wants to talk or learn more
  qualified     — open but with a condition (timing, role, etc.)
  objection     — concrete reason it's not a fit (uses competitor, has internal team)
  referral      — pointing the sender to someone else
  soft_no       — polite decline, no fire ("not right now", "I'll pass")
  hard_no       — explicit, sometimes hostile no ("stop emailing", "unsubscribe")
  angry         — hostile, frustrated, complaining
  auto          — autoresponder / out-of-office / vacation / delivery notification
  unclassified  — none of the above; genuinely cannot tell

Also report confidence:
  high   — clear signal, unambiguous wording
  medium — leaning one way but some uncertainty
  low    — ambiguous, could plausibly be two classes

Rule-based classifier guessed: ${input.ruleClass} (${input.ruleConfidence} confidence).
You are the second-pass review — disagree freely if the evidence supports it.

Subject: ${(input.subject || '').slice(0, 200)}

Reply body:
${(input.body || '').slice(0, 3000)}

Respond in this exact JSON shape, nothing else:
{"class":"<one of the classes>","confidence":"high|medium|low","reasoning":"<≤200 char explanation>"}`;

export async function aiReclassify(input: AiReclassifyInput): Promise<AiReclassifyResult | null> {
    if (!isGeminiConfigured()) return null;

    try {
        const { text } = await safeGeminiCompletion({
            prompt: RECLASSIFY_PROMPT_TEMPLATE(input),
            temperature: 0.1,
            maxTokens: 200,
            jsonMode: true,
            tag: 'reply.reclassify',
        });

        if (!text || text.trim() === '{}') return null;

        const parsed = JSON.parse(text) as { class?: string; confidence?: string; reasoning?: string };
        const cls = (parsed.class || '').toLowerCase().trim();
        if (!VALID_CLASSES.includes(cls as ReplyQualityClass)) {
            logger.warn('[REPLY_AI] Gemini returned unknown class — discarding', { returned: parsed.class });
            return null;
        }
        const conf = (parsed.confidence || '').toLowerCase().trim();
        const confidence: 'high' | 'medium' | 'low' = conf === 'high' || conf === 'medium' || conf === 'low' ? conf : 'low';
        const reasoning = (parsed.reasoning || '').slice(0, 200);

        return {
            class: cls as ReplyQualityClass,
            confidence,
            reasoning,
            invoked: true,
        };
    } catch (err) {
        logger.warn('[REPLY_AI] aiReclassify failed (non-fatal — keeping rule output)', {
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

// ────────────────────────────────────────────────────────────────────
// OOO date extraction
// ────────────────────────────────────────────────────────────────────

/** Strip HTML to plain text for date scanning. Cheap regex pass; we don't
 *  need full DOM parsing here. */
function stripHtml(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Regex-based date extraction. Handles the most common autoresponder
 * formats; falls through to the LLM helper for the awkward stuff.
 *
 * Returns the FIRST plausible return-date >= today + 1 day. Earlier
 * dates (e.g. "I was out from May 1 to May 3" sent on May 5) are
 * ignored — the operator's intent is "when can I send again."
 */
export function extractOooDateRegex(body: string, now: Date = new Date()): Date | null {
    const text = stripHtml(body).toLowerCase();
    const tomorrow = new Date(now);
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const candidates: Date[] = [];

    const monthNames: Record<string, number> = {
        jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
        apr: 3, april: 3, may: 4, jun: 5, june: 5,
        jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
        oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
    };

    // Pattern: "back on May 15", "return on June 1st", "until Aug 22"
    const monthDayRe = /\b(?:back|return(?:ing)?|out|away|away until|until)\s+(?:on\s+|the\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]+(\d{4}))?/gi;
    for (const m of text.matchAll(monthDayRe)) {
        const monthKey = m[1].toLowerCase();
        const month = monthNames[monthKey];
        const day = parseInt(m[2], 10);
        const explicitYear = m[3] ? parseInt(m[3], 10) : null;
        if (month === undefined || isNaN(day) || day < 1 || day > 31) continue;
        const year = explicitYear ?? now.getFullYear();
        let d = new Date(Date.UTC(year, month, day, 0, 0, 0));
        // If the parsed date is in the past for this year, assume next year
        // (e.g. an OOO sent in December referencing "Jan 5" probably means
        // next January).
        if (!explicitYear && d < tomorrow) {
            d = new Date(Date.UTC(year + 1, month, day, 0, 0, 0));
        }
        if (d >= tomorrow) candidates.push(d);
    }

    // Pattern: "back 12/15", "return 12/15/2026", "until 2026-12-15"
    const numericRe = /\b(?:back|return(?:ing)?|away until|until)\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/gi;
    for (const m of text.matchAll(numericRe)) {
        let a = parseInt(m[1], 10);
        let b = parseInt(m[2], 10);
        let y: number;
        if (m[3]) {
            const raw = parseInt(m[3], 10);
            y = raw < 100 ? 2000 + raw : raw;
        } else {
            y = now.getFullYear();
        }
        // Disambiguate US (MM/DD) vs ISO (YYYY-MM-DD) shape based on order.
        // If first number > 12 it must be DD/MM; otherwise default to MM/DD.
        let month: number, day: number;
        if (a > 12 && b <= 12) {
            day = a;
            month = b - 1;
        } else {
            month = a - 1;
            day = b;
        }
        if (month < 0 || month > 11 || day < 1 || day > 31) continue;
        let d = new Date(Date.UTC(y, month, day, 0, 0, 0));
        if (!m[3] && d < tomorrow) {
            d = new Date(Date.UTC(y + 1, month, day, 0, 0, 0));
        }
        if (d >= tomorrow) candidates.push(d);
    }

    // Pattern: "return in 5 days", "back in 2 weeks"
    const relativeRe = /\b(?:back|return(?:ing)?)\s+(?:in\s+)?(\d{1,3})\s+(day|days|week|weeks|business\s+day|business\s+days)\b/gi;
    for (const m of text.matchAll(relativeRe)) {
        const n = parseInt(m[1], 10);
        if (!Number.isFinite(n) || n <= 0 || n > 365) continue;
        const unit = m[2].toLowerCase();
        const multDays = unit.includes('week') ? 7 : 1;
        const d = new Date(now);
        d.setDate(d.getDate() + n * multDays);
        d.setHours(0, 0, 0, 0);
        if (d >= tomorrow) candidates.push(d);
    }

    if (candidates.length === 0) return null;
    // Pick the earliest plausible return-date. Multiple matches are
    // common in long autoresponders that list a delegate + a return
    // date; the earliest is the right choice.
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0];
}

const OOO_PROMPT_TEMPLATE = (subject: string, body: string, today: string) => `You are reading an out-of-office autoresponder. Extract the date the sender returns.

Today: ${today}
Subject: ${subject.slice(0, 200)}
Body: ${body.slice(0, 2000)}

Return ONLY a JSON object:
{"return_date":"<YYYY-MM-DD or null>"}

If no usable return date is mentioned, return null. Always pick the date the sender is BACK and ready to read mail (not when they left). If multiple dates are mentioned, return the latest one the recipient should respect.`;

/**
 * Full OOO date extraction. Regex first; falls through to Gemini Flash
 * for the cases regex couldn't crack.
 */
export async function extractOooDate(input: { subject: string; body: string }, now: Date = new Date()): Promise<Date | null> {
    const fromRegex = extractOooDateRegex(input.body, now);
    if (fromRegex) return fromRegex;
    if (!isGeminiConfigured()) return null;

    try {
        const { text } = await safeGeminiCompletion({
            prompt: OOO_PROMPT_TEMPLATE(input.subject, stripHtml(input.body), now.toISOString().slice(0, 10)),
            temperature: 0.0,
            maxTokens: 80,
            jsonMode: true,
            tag: 'reply.ooo_date',
        });

        if (!text || text.trim() === '{}') return null;

        const parsed = JSON.parse(text) as { return_date?: string | null };
        if (!parsed.return_date) return null;

        const d = new Date(`${parsed.return_date}T00:00:00Z`);
        if (isNaN(d.getTime())) return null;
        const tomorrow = new Date(now);
        tomorrow.setHours(0, 0, 0, 0);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (d < tomorrow) return null;
        return d;
    } catch (err) {
        logger.warn('[REPLY_AI] extractOooDate Gemini fallback failed', {
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
