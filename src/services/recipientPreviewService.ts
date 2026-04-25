/**
 * Recipient preview service
 *
 * Simulates how a cold email will look to the recipient across mainstream
 * clients. Three concerns:
 *
 *   1. INBOX LIST — sender name, subject line, preview text, all truncated
 *      to each client's actual width. The first thing the recipient sees.
 *   2. OPENED VIEW — HTML normalized to each client's quirks (Gmail strips
 *      <style> blocks, Outlook re-renders via Word, Apple Mail keeps most).
 *   3. AI SUMMARY — what Gmail's "Summarize" / Apple Intelligence / Superhuman
 *      produce when they auto-summarize the message. By 2026 a meaningful
 *      share of mobile readers see the summary BEFORE the email itself.
 *
 * This is approximate, not pixel-truth. Litmus charges for actual rendering.
 * What we deliver is: "looks like the client" + "AI summary the recipient
 * would likely see" — enough to surprise senders into rewriting their copy.
 */

import OpenAI from 'openai';

// ─── Client catalog ──────────────────────────────────────────────────────────
//
// Per-client measured constants. Calibrated against public client docs +
// observed defaults; can be overridden later from real-device screenshots.

export type ClientKey =
    | 'gmail_mobile'
    | 'gmail_desktop'
    | 'apple_mail_ios'
    | 'apple_mail_macos'
    | 'outlook_mobile'
    | 'outlook_desktop'
    | 'superhuman';

export interface ClientProfile {
    key: ClientKey;
    label: string;
    /** rough max chars rendered in inbox-list subject; ellipsis after */
    inboxSubjectChars: number;
    /** rough max chars rendered in inbox-list preview line; ellipsis after */
    inboxPreviewChars: number;
    /** rough max chars rendered in inbox-list sender column */
    inboxSenderChars: number;
    /** does the client expose an AI summary feature? (Gmail Summarize, Apple Intelligence, Superhuman) */
    hasAiSummary: boolean;
    /** style hint for the AI summary prompt */
    aiSummaryStyle?: 'gmail' | 'apple' | 'superhuman';
    /** does the client strip <style> blocks (Gmail-style) */
    stripsStyleBlock: boolean;
    /** does the client honor inline styles (always true in practice) */
    honorsInlineStyle: boolean;
    /** dark-mode behavior */
    darkMode: 'force_invert' | 'partial_invert' | 'none' | 'system_respect';
    /** does the client display Mail Privacy Protection (Apple Mail iOS) */
    pixelPreloaded: boolean;
}

export const CLIENT_PROFILES: Record<ClientKey, ClientProfile> = {
    gmail_mobile: {
        key: 'gmail_mobile',
        label: 'Gmail · Mobile',
        inboxSubjectChars: 36,
        inboxPreviewChars: 38,
        inboxSenderChars: 24,
        hasAiSummary: true,
        aiSummaryStyle: 'gmail',
        stripsStyleBlock: true,
        honorsInlineStyle: true,
        darkMode: 'force_invert',
        pixelPreloaded: false,
    },
    gmail_desktop: {
        key: 'gmail_desktop',
        label: 'Gmail · Desktop',
        inboxSubjectChars: 70,
        inboxPreviewChars: 90,
        inboxSenderChars: 30,
        hasAiSummary: true,
        aiSummaryStyle: 'gmail',
        stripsStyleBlock: true,
        honorsInlineStyle: true,
        darkMode: 'system_respect',
        pixelPreloaded: false,
    },
    apple_mail_ios: {
        key: 'apple_mail_ios',
        label: 'Apple Mail · iOS',
        inboxSubjectChars: 30,
        inboxPreviewChars: 60,
        inboxSenderChars: 28,
        hasAiSummary: true,
        aiSummaryStyle: 'apple',
        stripsStyleBlock: false,
        honorsInlineStyle: true,
        darkMode: 'partial_invert',
        pixelPreloaded: true,
    },
    apple_mail_macos: {
        // Apple Mail on macOS — three-pane layout with sidebar + message list
        // + reading pane. Wider than iOS since the list pane can show two
        // lines of preview text under the subject. Mail Privacy Protection
        // applies on macOS too when enabled in Settings.
        key: 'apple_mail_macos',
        label: 'Apple Mail · macOS',
        inboxSubjectChars: 36,
        inboxPreviewChars: 80,
        inboxSenderChars: 24,
        hasAiSummary: true,
        aiSummaryStyle: 'apple',
        stripsStyleBlock: false,
        honorsInlineStyle: true,
        darkMode: 'partial_invert',
        pixelPreloaded: true,
    },
    outlook_mobile: {
        key: 'outlook_mobile',
        label: 'Outlook · Mobile',
        inboxSubjectChars: 32,
        inboxPreviewChars: 40,
        inboxSenderChars: 26,
        hasAiSummary: false,
        stripsStyleBlock: false,
        honorsInlineStyle: true,
        darkMode: 'force_invert',
        pixelPreloaded: false,
    },
    outlook_desktop: {
        key: 'outlook_desktop',
        label: 'Outlook · Desktop',
        inboxSubjectChars: 60,
        inboxPreviewChars: 90,
        inboxSenderChars: 30,
        hasAiSummary: false,
        stripsStyleBlock: false,
        honorsInlineStyle: true,
        darkMode: 'system_respect',
        pixelPreloaded: false,
    },
    superhuman: {
        key: 'superhuman',
        label: 'Superhuman',
        inboxSubjectChars: 80,
        inboxPreviewChars: 100,
        inboxSenderChars: 30,
        hasAiSummary: true,
        aiSummaryStyle: 'superhuman',
        stripsStyleBlock: true,
        honorsInlineStyle: true,
        darkMode: 'system_respect',
        pixelPreloaded: false,
    },
};

// ─── HTML → plain text + preview extraction ──────────────────────────────────

/**
 * Extract preview text for inbox-list rendering. Mirrors what each client does
 * to the body before showing a snippet next to the subject line:
 *   - strip HTML
 *   - collapse whitespace
 *   - drop quoted-reply blocks (anything after "On <date> ... wrote:")
 *   - drop trailing signature blocks (lines starting with "--" or "Sent from")
 */
export function extractPreviewText(bodyHtml: string): string {
    if (!bodyHtml) return '';
    // Strip HTML
    let text = bodyHtml
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    // Drop quoted-reply
    text = text.split(/\nOn .{1,80}wrote:\n/)[0];
    text = text.split(/\n>+\s*/)[0];
    // Drop signature
    text = text.split(/\n--\s*\n/)[0];
    text = text.split(/\nSent from my (iPhone|iPad|Android)/)[0];

    // Collapse whitespace
    return text.replace(/\s+/g, ' ').trim();
}

export function truncate(s: string, max: number): string {
    if (!s) return '';
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// ─── Per-client HTML normalization for the opened view ────────────────────────

/**
 * Apply each client's known HTML quirks to the source body so the rendered
 * preview behaves more like what the recipient actually sees. Best-effort
 * — known to be incomplete; calibrated up over time as we hit edge cases.
 */
export function normalizeHtmlForClient(bodyHtml: string, profile: ClientProfile): string {
    let html = bodyHtml || '';

    // Gmail (and Superhuman) strip <style> blocks. Inline styles survive.
    if (profile.stripsStyleBlock) {
        html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    }

    // Outlook desktop's Word renderer ignores most modern CSS. We don't have
    // a way to perfectly emulate that without a full Word-rules engine, so
    // we strip a known-broken set: flexbox, grid, custom properties, padding
    // shorthand longer than 4 values. Result still won't be Outlook-perfect
    // but reads "more constrained" than the source.
    if (profile.key === 'outlook_desktop') {
        html = html.replace(/display:\s*flex[^;"]*;?/gi, '');
        html = html.replace(/display:\s*grid[^;"]*;?/gi, '');
        html = html.replace(/--[a-z-]+:\s*[^;"]+;?/gi, '');
    }

    return html;
}

// ─── Dark-mode rendering ─────────────────────────────────────────────────────
//
// Each client handles dark mode differently:
//
//   - force_invert    (Gmail Mobile, Outlook Mobile): the client aggressively
//                     inverts colors. Light-on-dark text is left alone, but
//                     dark-on-light text gets flipped, and explicit white
//                     backgrounds are darkened. We approximate with a dark
//                     background + reverse foreground; explicit color: rules
//                     in the source are best-effort respected.
//   - partial_invert  (Outlook Desktop): only flips backgrounds, doesn't
//                     touch foreground text colors → leads to the infamous
//                     "dark gray on dark gray" unreadable email. We render
//                     the dark background but DON'T flip foreground.
//   - system_respect  (Apple Mail iOS, Superhuman): respects the email's own
//                     color choices and only adapts unstyled chrome. Render
//                     with a dark surrounding chrome but the email body
//                     keeps its source colors.
//   - none            (Gmail Desktop): no dark transform at all.
//
// We DO NOT fully simulate every quirk — that requires a real client. We
// produce a "this is roughly what you'd see" view good enough for catching
// "my email is unreadable in dark mode" disasters before they ship.

export interface DarkRenderInfo {
    /** transformed HTML to render inside the dark surface */
    html: string;
    /** background color of the surrounding chrome */
    chromeBg: string;
    /** default foreground color of the surrounding chrome */
    chromeFg: string;
    /** human-readable note about what this client does in dark mode */
    note: string;
}

/**
 * Rough heuristic: does the source HTML have an explicit foreground/background
 * color set (inline)? If yes, the client's dark transform mostly leaves it
 * alone, which is usually the *bad* case (sender forgot to test dark mode).
 */
function hasExplicitColors(html: string): boolean {
    return /style="[^"]*\bcolor\s*:/i.test(html) || /style="[^"]*background[^"]*:/i.test(html);
}

export function renderDarkForClient(bodyHtml: string, profile: ClientProfile): DarkRenderInfo {
    const base = normalizeHtmlForClient(bodyHtml, profile);
    const explicit = hasExplicitColors(base);

    switch (profile.darkMode) {
        case 'force_invert': {
            // Wrap in a dark surface with a forced-light foreground. If the
            // source has explicit colors they may visually fight the invert,
            // which is the realistic outcome.
            const wrapped = `<div style="color:#E5E7EB">${base}</div>`;
            return {
                html: wrapped,
                chromeBg: '#0B0F19',
                chromeFg: '#E5E7EB',
                note: explicit
                    ? 'Force-invert client: explicit colors in your HTML may clash with the inversion.'
                    : 'Force-invert client: text and background flipped to light-on-dark.',
            };
        }
        case 'partial_invert': {
            // Outlook desktop dark mode: backgrounds invert but text colors
            // do not — explicit dark text on default white surface ends up
            // as dark text on dark surface = unreadable.
            return {
                html: base,
                chromeBg: '#1F2937',
                chromeFg: '#9CA3AF',
                note: explicit
                    ? 'Partial-invert client: your explicit text colors were NOT flipped — risk of dark-on-dark text.'
                    : 'Partial-invert client: background darkened, default text colors kept.',
            };
        }
        case 'system_respect': {
            return {
                html: base,
                chromeBg: '#111827',
                chromeFg: '#F3F4F6',
                note: 'System-respecting client: your email keeps its own colors; only the surrounding chrome is dark.',
            };
        }
        case 'none':
        default:
            return {
                html: base,
                chromeBg: '#FFFFFF',
                chromeFg: '#111827',
                note: 'This client does not have a dark mode.',
            };
    }
}

// ─── AI summary prediction ───────────────────────────────────────────────────

let _openai: OpenAI | null = null;
function getClient(): OpenAI {
    if (!_openai) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
        _openai = new OpenAI({ apiKey });
    }
    return _openai;
}

/**
 * Predict the AI summary the recipient's client would generate. Gmail's
 * Summarize, Apple Intelligence's "Summary" line, and Superhuman's
 * Instant-Summary all have distinct voices — concise / helpful / punchy.
 *
 * We approximate by prompting GPT-4o-mini with a style guide for each
 * client. Output is short on purpose because the real clients are short.
 */
export async function predictAiSummary(
    subject: string,
    bodyHtml: string,
    senderName: string,
    style: 'gmail' | 'apple' | 'superhuman',
): Promise<string> {
    const plain = extractPreviewText(bodyHtml);

    const styleInstructions: Record<typeof style, string> = {
        gmail: `You are Gmail's "Summarize" feature. Generate a single declarative sentence (≤18 words) that captures the email's core ask. Use passive observational tone. No greeting, no quotes, no marketing language. Start with the verb or "Sender" or the action. Examples: "Sales rep proposing a 15-minute call to discuss outbound infrastructure." or "Vendor requesting feedback on their pricing tiers."`,
        apple: `You are Apple Intelligence's email summary. Produce ONE concise sentence (≤16 words), respectful tone, third-person. Surface the action being requested. Avoid superlatives. Example: "A request for a meeting to discuss email deliverability tools."`,
        superhuman: `You are Superhuman's Instant Summary. Output a 4-7 word noun phrase capturing the email's core intent. Punchy, action-oriented, all lowercase. Examples: "cold pitch — outbound infra demo", "follow-up on pricing question", "intro w/ shared connection".`,
    };

    const prompt = `Email metadata:
From: ${senderName || 'Unknown sender'}
Subject: ${subject || '(no subject)'}

Email body (plain text):
${plain.slice(0, 2000)}

${styleInstructions[style]}

Output ONLY the summary text. No prefixes, no quotation marks, no explanation.`;

    try {
        const res = await getClient().chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.4,
            max_tokens: 60,
        });
        return (res.choices[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
    } catch {
        // Graceful — better to return a placeholder than fail the whole preview
        return '(summary unavailable)';
    }
}

// ─── Issue detection ─────────────────────────────────────────────────────────

export interface PreviewIssue {
    severity: 'warning' | 'error';
    code:
        | 'subject_too_long'
        | 'subject_empty'
        | 'preview_empty'
        | 'preview_short'
        | 'dark_mode_contrast'
        | 'image_no_alt'
        | 'tracking_pixel_visible'
        | 'links_no_protocol'
        | 'spam_trigger_words';
    message: string;
    affectsClients?: ClientKey[];
}

const SPAM_TRIGGER_WORDS = [
    'free', 'free trial', 'guarantee', 'no obligation', 'risk free', 'click here',
    'act now', 'limited time', 'urgent', 'congratulations', 'winner', 'cash',
    'earn money', 'make $', 'best price', '100% free', 'no cost', 'discount',
];

export function detectIssues(subject: string, bodyHtml: string): PreviewIssue[] {
    const issues: PreviewIssue[] = [];
    const plain = extractPreviewText(bodyHtml).toLowerCase();
    const subj = (subject || '').toLowerCase();

    if (!subject || !subject.trim()) {
        issues.push({ severity: 'error', code: 'subject_empty', message: 'Subject line is empty — most clients will show "(no subject)" which kills open rates.' });
    }
    // Gmail mobile clips at ~36 chars; if longer, the truncated preview omits the value prop
    if (subject && subject.length > 60) {
        issues.push({
            severity: 'warning',
            code: 'subject_too_long',
            message: `Subject is ${subject.length} chars — Gmail mobile cuts off at ~36, Apple Mail iOS at ~30. Front-load the value.`,
            affectsClients: ['gmail_mobile', 'apple_mail_ios', 'outlook_mobile'],
        });
    }

    if (!plain) {
        issues.push({ severity: 'warning', code: 'preview_empty', message: 'No preview text — clients will fall back to header noise. Add a real first sentence.' });
    } else if (plain.length < 30) {
        issues.push({ severity: 'warning', code: 'preview_short', message: `Preview text is only ${plain.length} chars — most of the inbox-row preview will be empty.` });
    }

    // Dark-mode contrast — common breakage: white background, dark text in inline styles
    // Heuristic: any inline style with background:white|#fff|#ffffff combined with explicit dark text
    if (/background:\s*(?:#fff|#ffffff|white)/i.test(bodyHtml || '') && /color:\s*(?:#000|#000000|black|#1\w{2})/i.test(bodyHtml || '')) {
        issues.push({
            severity: 'warning',
            code: 'dark_mode_contrast',
            message: 'Hard-coded white-on-dark or black-on-light styling detected — Gmail Android/iOS will force-invert and may make this unreadable.',
            affectsClients: ['gmail_mobile', 'outlook_mobile'],
        });
    }

    // Images without alt
    const imgsNoAlt = (bodyHtml || '').match(/<img\b(?![^>]*\balt=)[^>]*>/gi);
    if (imgsNoAlt && imgsNoAlt.length > 0) {
        issues.push({
            severity: 'warning',
            code: 'image_no_alt',
            message: `${imgsNoAlt.length} image${imgsNoAlt.length === 1 ? '' : 's'} without alt text — when blocked or in a screen reader, recipient sees nothing.`,
        });
    }

    // Links without protocol
    if (/<a\b[^>]*\bhref=["'](?!https?:|mailto:|tel:|#|\/)([^"']+)["']/i.test(bodyHtml || '')) {
        issues.push({
            severity: 'warning',
            code: 'links_no_protocol',
            message: 'Link href without https:// — many clients silently drop or break these.',
        });
    }

    // Spam-trigger words
    const triggered = SPAM_TRIGGER_WORDS.filter((w) => subj.includes(w) || plain.includes(w));
    if (triggered.length > 0) {
        issues.push({
            severity: 'warning',
            code: 'spam_trigger_words',
            message: `Spam-trigger words detected: ${triggered.slice(0, 5).join(', ')}${triggered.length > 5 ? '…' : ''}. ISP filters score these heavily.`,
        });
    }

    return issues;
}

// ─── Top-level builder ───────────────────────────────────────────────────────

export interface ClientPreview {
    key: ClientKey;
    label: string;
    /** Inbox-list view fields */
    inbox: {
        sender: string;
        subject: string;
        preview: string;
        senderTruncated: boolean;
        subjectTruncated: boolean;
        previewTruncated: boolean;
    };
    /** Opened-view HTML normalized for this client */
    openedHtml: string;
    /** Predicted AI summary (only for clients with hasAiSummary) */
    aiSummary?: string;
    /** Notes on dark-mode behavior */
    darkMode: ClientProfile['darkMode'];
    /** Per-client dark-mode render: HTML transform + chrome colors + note */
    darkRender: DarkRenderInfo;
    /** Will Apple Mail Privacy Protection pre-load tracking pixels? */
    pixelPreloaded: boolean;
}

export interface PreviewRequest {
    subject: string;
    bodyHtml: string;
    senderName: string;
    senderEmail: string;
    clients?: ClientKey[];
    /** include AI summary predictions; opt-in because they cost $ */
    includeAiSummary?: boolean;
}

export interface PreviewResult {
    clients: ClientPreview[];
    issues: PreviewIssue[];
    plainText: string;
}

const DEFAULT_CLIENTS: ClientKey[] = [
    'gmail_mobile',
    'gmail_desktop',
    'apple_mail_ios',
    'outlook_mobile',
    'outlook_desktop',
    'superhuman',
];

export async function buildRecipientPreview(req: PreviewRequest): Promise<PreviewResult> {
    const clientKeys = req.clients?.length ? req.clients : DEFAULT_CLIENTS;
    const senderDisplay = req.senderName || req.senderEmail || 'Unknown sender';
    const subject = req.subject || '';
    const plain = extractPreviewText(req.bodyHtml || '');
    const issues = detectIssues(subject, req.bodyHtml || '');

    // Run AI summary calls in parallel — typical 1–3 clients have hasAiSummary,
    // and we only call when includeAiSummary=true (caller controls cost).
    const summaryPromises: Promise<{ key: ClientKey; summary: string }>[] = [];
    if (req.includeAiSummary) {
        for (const key of clientKeys) {
            const profile = CLIENT_PROFILES[key];
            if (profile.hasAiSummary && profile.aiSummaryStyle) {
                summaryPromises.push(
                    predictAiSummary(subject, req.bodyHtml || '', senderDisplay, profile.aiSummaryStyle)
                        .then((summary) => ({ key, summary })),
                );
            }
        }
    }
    const summaryResults = await Promise.all(summaryPromises);
    const summaryMap = new Map(summaryResults.map((r) => [r.key, r.summary]));

    const clients: ClientPreview[] = clientKeys.map((key) => {
        const profile = CLIENT_PROFILES[key];
        const sender = truncate(senderDisplay, profile.inboxSenderChars);
        const subj = truncate(subject, profile.inboxSubjectChars);
        const prev = truncate(plain, profile.inboxPreviewChars);

        return {
            key,
            label: profile.label,
            inbox: {
                sender,
                subject: subj,
                preview: prev,
                senderTruncated: senderDisplay.length > profile.inboxSenderChars,
                subjectTruncated: subject.length > profile.inboxSubjectChars,
                previewTruncated: plain.length > profile.inboxPreviewChars,
            },
            openedHtml: normalizeHtmlForClient(req.bodyHtml || '', profile),
            aiSummary: summaryMap.get(key),
            darkMode: profile.darkMode,
            darkRender: renderDarkForClient(req.bodyHtml || '', profile),
            pixelPreloaded: profile.pixelPreloaded,
        };
    });

    return {
        clients,
        issues,
        plainText: plain,
    };
}
