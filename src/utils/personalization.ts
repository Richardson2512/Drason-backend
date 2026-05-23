/**
 * Personalization renderer - resolves merge tags, conditional blocks, and
 * fallback filters in a sequence-step template against one lead's token map.
 *
 * This is the SINGLE SOURCE OF TRUTH for how `{{...}}` constructs render at
 * send time. sendQueueService builds the token map from the lead row and
 * calls renderPersonalization(); nothing else may re-implement substitution.
 *
 * Position in the send pipeline (see spintax.ts):
 *   1. pickVariant     - choose the step variant for this lead
 *   2. renderPersonalization  - resolve {{first_name}}, {{#if ...}}, fallbacks  ← here
 *   3. resolveSpintax  - expand {Hi|Hey} → one option
 *   4. applyTracking   - wrap URLs with HMAC tracking tokens
 *
 * Personalization MUST run before spintax so spintax placed inside a
 * conditional branch or a custom token is expanded after the branch is
 * chosen, and so a chosen branch can itself contain spintax.
 *
 * ── Supported syntax (Smartlead-compatible, paste-in friendly) ──
 *
 * Simple merge tag:
 *   {{first_name}}                         → token value, or "" when missing
 *
 * Fallback filter (graceful default for a missing/empty field):
 *   {{first_name | fallback: "there"}}     → value if present, else "there"
 *   {{company|fallback:Acme}}              → quotes optional, spacing flexible
 *
 * Conditional block (truthiness - field present and non-empty):
 *   {{#if first_name}}Hey {{first_name}},{{else}}Hey there,{{/if}}
 *
 * Conditional block with a comparison operator (operator may be quoted, as
 * Smartlead writes it, or bare):
 *   {{#if position '==' "founder"}}As the founder...{{/if}}
 *   {{#if google_review 'gte' 4}}Congrats on the rating...{{/if}}
 *   {{#if number_of_reviews '<' 15}}Noticed you've got...{{/if}}
 *
 * Operators: ==  !=  >  <  >=  <=  and the Smartlead word forms gte / lte.
 *   - ==, != compare case-insensitively after trimming.
 *   - >, <, >=, <=, gte, lte compare numerically when both sides parse as
 *     finite numbers, otherwise fall back to a lexical string comparison.
 *
 * {{else}} is optional. Blocks may be nested to any depth.
 *
 * ── Safety contract ──
 * renderPersonalization NEVER throws. A structurally malformed template
 * (e.g. an unclosed {{#if}}) degrades to a best-effort render that strips
 * control tags and substitutes the remaining merge/fallback tags, so a bad
 * template can never crash a send worker. validatePersonalization() is the
 * preflight that rejects such templates at save time, before they can send.
 */

const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 50;

export type ComparisonOperator = '==' | '!=' | '>' | '<' | '>=' | '<=';

// ── Flat token stream ────────────────────────────────────────────────

type Tok =
    | { t: 'text'; v: string }
    | { t: 'var'; name: string }
    | { t: 'fallback'; name: string; def: string }
    | { t: 'if'; field: string; op: ComparisonOperator | null; value: string; bad: boolean }
    | { t: 'else' }
    | { t: 'endif' };

// Body templates are authored in a rich-text (HTML) editor, which encodes
// `<` `>` `&` as entities. A condition like {{#if reviews '<' 15}} therefore
// arrives as {{#if reviews '&lt;' 15}}. Decode the small set of entities the
// editor produces so comparison operators and quoted values work identically
// in HTML bodies and plain-text subjects. Applied only to the inside of a
// {{...}} expression (operator / value / fallback default), never to the
// surrounding body, so intentional literal entities elsewhere are untouched.
function decodeBasicEntities(s: string): string {
    return s
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
        .replace(/&amp;/gi, '&');
}

function unquote(s: string): string {
    const v = s.trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        return v.slice(1, v.length - 1);
    }
    return v;
}

function normalizeOperator(raw: string): ComparisonOperator | null {
    switch (raw.toLowerCase()) {
        case '==': return '==';
        case '!=': return '!=';
        case '>': return '>';
        case '<': return '<';
        case '>=': return '>=';
        case '<=': return '<=';
        case 'gte': return '>=';
        case 'lte': return '<=';
        default: return null;
    }
}

const COND_RE = /^([\w.]+)(?:\s+(['"]?)(==|!=|>=|<=|>|<|gte|lte)\2\s+(.+))?$/;

function classifyTag(inner: string): Tok {
    const t = inner.trim();

    if (/^#if\b/i.test(t)) {
        const condStr = decodeBasicEntities(t.replace(/^#if\s*/i, '').trim());
        const m = condStr.match(COND_RE);
        if (!m) {
            // Unparseable condition - keep the leading word as the field so a
            // truthiness check still degrades sensibly; flag for validation.
            return { t: 'if', field: condStr.split(/\s+/)[0] || '', op: null, value: '', bad: true };
        }
        const field = m[1];
        const op = m[3] ? normalizeOperator(m[3]) : null;
        const value = m[4] !== undefined ? unquote(m[4]) : '';
        // op token present but unrecognized => bad; truthiness form (no op) is fine.
        const bad = m[3] !== undefined && op === null;
        return { t: 'if', field, op, value, bad };
    }
    if (/^else$/i.test(t)) return { t: 'else' };
    if (/^(\/if|endif)$/i.test(t)) return { t: 'endif' };

    if (t.includes('|')) {
        const pipe = t.indexOf('|');
        const name = t.slice(0, pipe).trim();
        const filter = t.slice(pipe + 1).trim();
        const fm = filter.match(/^fallback\s*:\s*([\s\S]+)$/i);
        if (fm) return { t: 'fallback', name, def: unquote(decodeBasicEntities(fm[1])) };
        // Unknown filter - degrade to a plain token on the left-hand name.
        return { t: 'var', name };
    }

    return { t: 'var', name: t };
}

function tokenize(template: string): Tok[] {
    const toks: Tok[] = [];
    let last = 0;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(template))) {
        if (m.index > last) toks.push({ t: 'text', v: template.slice(last, m.index) });
        toks.push(classifyTag(m[1]));
        last = m.index + m[0].length;
    }
    if (last < template.length) toks.push({ t: 'text', v: template.slice(last) });
    return toks;
}

// ── AST ──────────────────────────────────────────────────────────────

type AstNode =
    | { t: 'text'; v: string }
    | { t: 'var'; name: string }
    | { t: 'fallback'; name: string; def: string }
    | { t: 'if'; field: string; op: ComparisonOperator | null; value: string; cons: AstNode[]; alt: AstNode[] };

interface ParseResult {
    ast: AstNode[];
    issues: PersonalizationIssue[];
}

interface Frame {
    node: { t: 'if'; field: string; op: ComparisonOperator | null; value: string; cons: AstNode[]; alt: AstNode[] };
    inElse: boolean;
}

function parse(template: string): ParseResult {
    const toks = tokenize(template);
    const issues: PersonalizationIssue[] = [];
    const root: AstNode[] = [];
    const stack: Frame[] = [];

    const target = (): AstNode[] => {
        if (stack.length === 0) return root;
        const top = stack[stack.length - 1];
        return top.inElse ? top.node.alt : top.node.cons;
    };

    for (const tok of toks) {
        switch (tok.t) {
            case 'text':
                target().push({ t: 'text', v: tok.v });
                break;
            case 'var':
                target().push({ t: 'var', name: tok.name });
                break;
            case 'fallback':
                target().push({ t: 'fallback', name: tok.name, def: tok.def });
                break;
            case 'if': {
                if (tok.bad) {
                    issues.push({ code: 'bad_condition', message: `Could not parse condition in {{#if ${tok.field}}}. Use {{#if field}} or {{#if field '==' "value"}}.` });
                }
                const node = { t: 'if' as const, field: tok.field, op: tok.op, value: tok.value, cons: [], alt: [] };
                target().push(node);
                stack.push({ node, inElse: false });
                break;
            }
            case 'else': {
                const top = stack[stack.length - 1];
                if (!top) {
                    issues.push({ code: 'unexpected_else', message: '{{else}} without a matching {{#if}}.' });
                } else if (top.inElse) {
                    issues.push({ code: 'unexpected_else', message: 'Duplicate {{else}} in one {{#if}} block.' });
                } else {
                    top.inElse = true;
                }
                break;
            }
            case 'endif': {
                if (stack.length === 0) {
                    issues.push({ code: 'unexpected_close', message: '{{/if}} without a matching {{#if}}.' });
                } else {
                    stack.pop();
                }
                break;
            }
        }
    }

    while (stack.length > 0) {
        issues.push({ code: 'unclosed_if', message: 'A {{#if}} block was never closed with {{/if}}.' });
        stack.pop();
    }

    return { ast: root, issues };
}

// ── Evaluation ───────────────────────────────────────────────────────

function lookup(tokens: Record<string, string>, name: string): string {
    return tokens[name.toLowerCase()] ?? '';
}

export function evaluateCondition(
    field: string,
    op: ComparisonOperator | null,
    value: string,
    tokens: Record<string, string>,
): boolean {
    const raw = lookup(tokens, field);
    if (!op) return raw.trim() !== '';

    if (op === '==' || op === '!=') {
        const eq = raw.trim().toLowerCase() === value.trim().toLowerCase();
        return op === '==' ? eq : !eq;
    }

    const a = Number(raw);
    const b = Number(value);
    const numeric = raw.trim() !== '' && value.trim() !== '' && Number.isFinite(a) && Number.isFinite(b);
    let cmp: number;
    if (numeric) {
        cmp = a < b ? -1 : a > b ? 1 : 0;
    } else {
        cmp = raw.trim().localeCompare(value.trim());
    }
    switch (op) {
        case '>': return cmp > 0;
        case '<': return cmp < 0;
        case '>=': return cmp >= 0;
        case '<=': return cmp <= 0;
    }
}

function renderNodes(nodes: AstNode[], tokens: Record<string, string>, depth: number): string {
    if (depth > MAX_DEPTH) return '';
    let out = '';
    for (const node of nodes) {
        switch (node.t) {
            case 'text':
                out += node.v;
                break;
            case 'var':
                out += lookup(tokens, node.name);
                break;
            case 'fallback': {
                const v = lookup(tokens, node.name);
                out += v.trim() !== '' ? v : node.def;
                break;
            }
            case 'if':
                out += evaluateCondition(node.field, node.op, node.value, tokens)
                    ? renderNodes(node.cons, tokens, depth + 1)
                    : renderNodes(node.alt, tokens, depth + 1);
                break;
        }
    }
    return out;
}

/**
 * Best-effort render for structurally malformed templates: strip control
 * tags and substitute the remaining merge / fallback tags. Used only when
 * parse() reports issues, so a bad template degrades instead of crashing.
 */
function degradedRender(template: string, tokens: Record<string, string>): string {
    let out = '';
    let last = 0;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(template))) {
        out += template.slice(last, m.index);
        const tok = classifyTag(m[1]);
        if (tok.t === 'var') out += lookup(tokens, tok.name);
        else if (tok.t === 'fallback') {
            const v = lookup(tokens, tok.name);
            out += v.trim() !== '' ? v : tok.def;
        }
        // if / else / endif control tags are dropped.
        last = m.index + m[0].length;
    }
    out += template.slice(last);
    return out;
}

/**
 * Render a template against a lead's token map. Never throws.
 *
 * @param template  raw step subject / preheader / body_html
 * @param tokens    map of lowercased token name → string value
 */
export function renderPersonalization(template: string, tokens: Record<string, string>): string {
    if (!template) return template ?? '';
    if (!template.includes('{{')) return template;

    const { ast, issues } = parse(template);
    if (issues.length > 0) {
        return degradedRender(template, tokens);
    }
    return renderNodes(ast, tokens, 0);
}

// ── Validation (save-time preflight) ─────────────────────────────────

export interface PersonalizationIssue {
    code: 'unclosed_if' | 'unexpected_close' | 'unexpected_else' | 'bad_condition';
    message: string;
}

/**
 * Lint a single template. Returns structural issues without throwing -
 * `issues.length === 0` means the template is safe to render exactly.
 */
export function validatePersonalization(template: string): PersonalizationIssue[] {
    if (!template || !template.includes('{{')) return [];
    return parse(template).issues;
}

/**
 * Validate the personalization syntax across a set of sequence steps
 * (subject / preheader / body_html, plus per-step A/B variants). Returns a
 * flat, human-readable list of "Step N (field): message" strings so a
 * controller can reject the save with an actionable 400. Empty array = OK.
 *
 * This is the shared guard called by every persistence path that can feed
 * the send pipeline (saved sequence templates and campaign steps), so the
 * validation rule lives in exactly one place.
 */
export interface StepTemplateLike {
    step_number?: number;
    subject?: string | null;
    preheader?: string | null;
    body_html?: string | null;
    variants?: Array<{ subject?: string | null; body_html?: string | null; bodyHtml?: string | null } | null> | null;
}

export function validateStepTemplates(steps: StepTemplateLike[] | undefined | null): string[] {
    if (!Array.isArray(steps)) return [];
    const errors: string[] = [];
    steps.forEach((step, i) => {
        const label = `Step ${step?.step_number ?? i + 1}`;
        const check = (field: string, value: string | null | undefined) => {
            for (const issue of validatePersonalization(value || '')) {
                errors.push(`${label} (${field}): ${issue.message}`);
            }
        };
        check('subject', step?.subject);
        check('preheader', step?.preheader);
        check('body', step?.body_html);
        if (Array.isArray(step?.variants)) {
            step!.variants!.forEach((v, vi) => {
                if (!v) return;
                check(`variant ${vi + 1} subject`, v.subject);
                check(`variant ${vi + 1} body`, v.body_html ?? v.bodyHtml);
            });
        }
    });
    return errors;
}
