/**
 * Spintax resolver — expands {a|b|c} alternatives into a single chosen branch.
 *
 * Each call returns a fresh random expansion, so when invoked per-send, every
 * recipient receives a different lexical variant of the same step template.
 * This breaks the pattern-fingerprinting heuristics ISP spam filters use to
 * detect bulk sequence sends, and sits orthogonal to step variants (which
 * rotate at the sequence-step level).
 *
 * Position in the send pipeline:
 *   1. pickVariant   — chooses one of the step's variants for this lead
 *   2. personalize   — resolves {{first_name}} → "John", etc.
 *   3. resolveSpintax — expands {Hi|Hey} → "Hi" or "Hey"   ← here
 *   4. applyTracking — wraps URLs with HMAC tracking tokens
 *
 * Ordering rationale:
 *  - Personalization MUST run first so any spintax placed inside a token
 *    template ({{custom_variable}}) is already substituted.
 *  - Spintax MUST run before tracking so URLs containing spintax (rare but
 *    possible) are resolved before being signed.
 *
 * Supported syntax:
 *   {a|b|c}                    — pick one of three
 *   {Hi|Hey {there|friend}}    — nested; inner resolves first
 *   {a||c}                     — empty option is allowed (1/3 chance of "")
 *   \{literal\}                — escaped braces pass through (rendered as {literal})
 *
 * Excluded by design:
 *   {{first_name}}             — double-brace tokens are NOT spintax. The regex
 *                                requires a literal `|` inside the braces, so
 *                                {{...}} (no pipe) is never matched.
 */

const MAX_ITERATIONS = 100;
const SPINTAX_RE = /\{([^{}]*\|[^{}]*)\}/;

// Sentinels mask escaped braces during processing. Strings that won't appear
// in legitimate user content.
const ESCAPE_OPEN_SENTINEL = '__SPX_ESC_OPEN__';
const ESCAPE_CLOSE_SENTINEL = '__SPX_ESC_CLOSE__';

export function resolveSpintax(template: string): string {
    if (!template || !template.includes('|')) return template;
    if (!template.includes('{')) return template;

    let work = template.replace(/\\\{/g, ESCAPE_OPEN_SENTINEL).replace(/\\\}/g, ESCAPE_CLOSE_SENTINEL);

    let iterations = 0;
    while (iterations++ < MAX_ITERATIONS) {
        const match = work.match(SPINTAX_RE);
        if (!match) break;
        const [full, inside] = match;
        const options = inside.split('|');
        const chosen = options[Math.floor(Math.random() * options.length)];
        work = work.replace(full, chosen);
    }

    return work
        .replace(new RegExp(ESCAPE_OPEN_SENTINEL, 'g'), '{')
        .replace(new RegExp(ESCAPE_CLOSE_SENTINEL, 'g'), '}');
}

/**
 * Lint helper for editor preview / preflight. Returns structural issues
 * without throwing — `issues.length === 0` means safe to send.
 */
export interface SpintaxIssue {
    code: 'unbalanced' | 'empty_group';
    message: string;
    position: number;
}

export function validateSpintax(template: string): SpintaxIssue[] {
    const issues: SpintaxIssue[] = [];
    if (!template) return issues;

    const stripped = template
        .replace(/\\\{/g, '')
        .replace(/\\\}/g, '')
        .replace(/\{\{[^{}]*\}\}/g, '');

    let depth = 0;
    let lastOpen = -1;
    for (let i = 0; i < stripped.length; i++) {
        if (stripped[i] === '{') { depth++; lastOpen = i; }
        else if (stripped[i] === '}') {
            depth--;
            if (depth < 0) {
                issues.push({ code: 'unbalanced', message: 'Closing brace with no matching opener', position: i });
                depth = 0;
            }
        }
    }
    if (depth > 0) {
        issues.push({ code: 'unbalanced', message: 'Opening brace with no matching closer', position: lastOpen });
    }

    const groupRe = /\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = groupRe.exec(template))) {
        if (m[1] === '') {
            issues.push({ code: 'empty_group', message: 'Empty {} — no choices', position: m.index });
        }
    }

    return issues;
}
