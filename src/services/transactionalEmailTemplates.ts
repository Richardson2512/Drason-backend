/**
 * Transactional Email Templates
 *
 * Single shared shell for every system-generated email Superkabe sends:
 *   - Webhook auto-disable alerts
 *   - (future) Trial expiry, password reset, weekly reports, etc.
 *
 * DESIGN BRIEF — "Vercel-style restraint, Superkabe brand"
 *   • Vercel patterns we mirror:
 *       - single column, max-width 600px
 *       - generous whitespace between sections
 *       - bulletproof nested-table layout (Outlook 2007–2019)
 *       - inline styles only (no <style> blocks; many clients strip them)
 *       - hidden preheader text shown as inbox preview
 *       - "fact card" key-value table for technical detail
 *       - bulletproof CTA button (VML for Outlook fallback)
 *       - small grey footer with sign-off + company tag
 *   • Superkabe color tokens (from frontend/src/app/globals.css `.light-theme`):
 *       - canvas (page background)     #F7F2EB  (cream, dashboard backdrop)
 *       - card (content surface)       #FFFFFF  (white, like premium-card)
 *       - border (faint hairline)      #D1CBC5  (dashboard card border)
 *       - border-strong                #1F2937  (heading underline accent)
 *       - text-primary                 #111827  (gray-900)
 *       - text-secondary               #4B5563  (gray-600)
 *       - text-muted                   #6B7280  (gray-500)
 *       - text-faint                   #9CA3AF  (gray-400)
 *       - brand                        #1C4532  (deep green)
 *       - cream-accent                 #F5F1EA  (hover / fact-card stripe)
 *
 * Mail-client compatibility notes (the painful learnings baked in):
 *   - No CSS variables, no flex/grid → tables
 *   - All styles inline; no class selectors
 *   - <style> in <head> is acceptable for the dark-mode @media query
 *     (Gmail desktop respects it, Apple Mail honors `prefers-color-scheme`)
 *   - Outlook needs MSO conditional VML for rounded button shape
 *   - Preheader trick: invisible <span> after <body> with the preview text
 */

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface EmailFact {
    label: string;
    /** Plain text or pre-escaped HTML. Caller is responsible for safety. */
    value: string;
    /** Render value as monospace (URLs, IDs, code). Default false. */
    mono?: boolean;
}

export interface RenderEmailParams {
    /** Inbox preview text (hidden in the body). Keep ≤ 90 chars. */
    preheader: string;
    /** Single H1 inside the card. */
    heading: string;
    /** Optional smaller H2 / kicker above the heading. */
    eyebrow?: string;
    /** Lead paragraph — first thing the reader sees. May contain inline HTML. */
    intro?: string;
    /** Optional fact rows — rendered as a striped key/value table. */
    facts?: EmailFact[];
    /** Body paragraphs after the facts. May contain inline HTML. */
    body?: string;
    /** CTA button. Both fields required to render. */
    ctaLabel?: string;
    ctaUrl?: string;
    /** Optional secondary text-link below the CTA (e.g. "View delivery log"). */
    secondaryLinkLabel?: string;
    secondaryLinkUrl?: string;
    /** Final sign-off line. Defaults to "— The Superkabe team". */
    signOff?: string;
    /** Company tagline / footer line. Defaults to brand boilerplate. */
    footerNote?: string;
}

// ────────────────────────────────────────────────────────────────────
// Color tokens — single source of truth, mirrors light-theme CSS
// ────────────────────────────────────────────────────────────────────

const C = {
    canvas: '#F7F2EB',
    card: '#FFFFFF',
    border: '#D1CBC5',
    borderSoft: '#E8E3DC',
    factStripe: '#F5F1EA',
    textPrimary: '#111827',
    textSecondary: '#4B5563',
    textMuted: '#6B7280',
    textFaint: '#9CA3AF',
    brand: '#1C4532',
    brandHover: '#13321F',
    monoBg: '#F3F4F6',
};

// ────────────────────────────────────────────────────────────────────
// Public — render the full email
// ────────────────────────────────────────────────────────────────────

export function renderEmailTemplate(p: RenderEmailParams): string {
    const sign = p.signOff || '— The Superkabe team';
    const footer = p.footerNote || 'Sent by Superkabe · AI-powered cold email with deliverability protection';

    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${escapeHtml(p.heading)}</title>
  <style>
    /* Mobile tweaks — Gmail / Apple Mail respect <style> blocks. */
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; }
      .px-32 { padding-left: 24px !important; padding-right: 24px !important; }
      h1.heading { font-size: 22px !important; line-height: 30px !important; }
    }
    /* Anchor reset for Apple Mail blue links on monospace value */
    a.mono-link { color: ${C.brand} !important; text-decoration: none; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${C.canvas};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${C.textPrimary};-webkit-font-smoothing:antialiased;">

  <!-- Preheader: hidden in the body, shown as inbox preview text. -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.canvas};opacity:0;">
    ${escapeHtml(p.preheader)}
  </div>
  <!-- Whitespace hack to push real content out of the preview snippet. -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    ${'&nbsp;&zwnj;'.repeat(50)}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.canvas};">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- Header: wordmark only, no card frame. Vercel-style. -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="container" width="600" style="max-width:600px;width:100%;">
          <tr>
            <td style="padding:0 0 24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:20px;font-weight:700;letter-spacing:-0.01em;color:${C.brand};">
              Superkabe
            </td>
          </tr>
        </table>

        <!-- Card -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="container" width="600" style="max-width:600px;width:100%;background-color:${C.card};border:1px solid ${C.border};border-radius:12px;">
          <tr>
            <td class="px-32" style="padding:32px 32px 24px 32px;">
              ${p.eyebrow ? `
              <div style="font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.textMuted};margin:0 0 8px 0;">
                ${escapeHtml(p.eyebrow)}
              </div>` : ''}

              <h1 class="heading" style="margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.02em;color:${C.textPrimary};">
                ${escapeHtml(p.heading)}
              </h1>

              ${p.intro ? `
              <p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${C.textSecondary};">
                ${p.intro}
              </p>` : ''}

              ${p.facts && p.facts.length > 0 ? renderFacts(p.facts) : ''}

              ${p.body ? `
              <p style="margin:24px 0 0 0;font-size:14px;line-height:22px;color:${C.textSecondary};">
                ${p.body}
              </p>` : ''}

              ${p.ctaLabel && p.ctaUrl ? renderButton(p.ctaLabel, p.ctaUrl) : ''}

              ${p.secondaryLinkLabel && p.secondaryLinkUrl ? `
              <p style="margin:12px 0 0 0;font-size:13px;line-height:20px;color:${C.textMuted};">
                <a href="${escapeAttr(p.secondaryLinkUrl)}" style="color:${C.brand};text-decoration:underline;">${escapeHtml(p.secondaryLinkLabel)}</a>
              </p>` : ''}
            </td>
          </tr>

          <!-- Sign-off divider -->
          <tr>
            <td class="px-32" style="padding:0 32px 32px 32px;">
              <div style="border-top:1px solid ${C.borderSoft};margin:0 0 20px 0;"></div>
              <p style="margin:0;font-size:14px;line-height:22px;color:${C.textSecondary};">
                ${escapeHtml(sign)}
              </p>
            </td>
          </tr>
        </table>

        <!-- Footer (outside card) -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="container" width="600" style="max-width:600px;width:100%;">
          <tr>
            <td style="padding:24px 0 0 0;text-align:center;font-size:12px;line-height:18px;color:${C.textFaint};">
              ${escapeHtml(footer)}
              <br />
              <a href="https://www.superkabe.com" style="color:${C.textFaint};text-decoration:underline;">superkabe.com</a>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ────────────────────────────────────────────────────────────────────
// Facts table — Vercel's "key:value" detail block, dashboard colors
// ────────────────────────────────────────────────────────────────────

function renderFacts(facts: EmailFact[]): string {
    const rows = facts.map((f, i) => {
        const stripe = i % 2 === 1;
        const valueStyle = f.mono
            ? `font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;font-size:12.5px;color:${C.textPrimary};word-break:break-all;`
            : `font-size:13px;color:${C.textPrimary};`;
        return `
          <tr>
            <td style="padding:10px 14px;background-color:${stripe ? C.factStripe : C.card};border-bottom:1px solid ${C.borderSoft};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${C.textMuted};white-space:nowrap;vertical-align:top;width:35%;">
              ${escapeHtml(f.label)}
            </td>
            <td style="padding:10px 14px;background-color:${stripe ? C.factStripe : C.card};border-bottom:1px solid ${C.borderSoft};${valueStyle}vertical-align:top;">
              ${escapeHtml(f.value)}
            </td>
          </tr>`;
    }).join('');

    return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${C.border};border-radius:8px;overflow:hidden;margin:0 0 8px 0;">
        ${rows}
      </table>`;
}

// ────────────────────────────────────────────────────────────────────
// CTA button — bulletproof for Outlook (VML fallback)
// ────────────────────────────────────────────────────────────────────

function renderButton(label: string, url: string): string {
    const safeUrl = escapeAttr(url);
    const safeLabel = escapeHtml(label);
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0 0;">
        <tr>
          <td style="border-radius:8px;background-color:${C.brand};">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeUrl}" style="height:44px;v-text-anchor:middle;width:200px;" arcsize="18%" stroke="f" fillcolor="${C.brand}">
              <w:anchorlock/>
              <center style="color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;">${safeLabel}</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-->
            <a href="${safeUrl}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
              ${safeLabel}
            </a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>`;
}

// ────────────────────────────────────────────────────────────────────
// HTML escaping
// ────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function escapeAttr(s: string): string {
    return escapeHtml(s);
}

// ────────────────────────────────────────────────────────────────────
// Plain-text companion — Resend auto-derives if not provided, but a
// hand-written version reads better and avoids the "this email is best
// viewed in HTML" tax. Caller can pass through SendTransactionalEmail.text.
// ────────────────────────────────────────────────────────────────────

export function renderEmailPlainText(p: RenderEmailParams): string {
    const lines: string[] = [];
    if (p.eyebrow) lines.push(p.eyebrow.toUpperCase(), '');
    lines.push(p.heading, '');
    if (p.intro) lines.push(stripTags(p.intro), '');
    if (p.facts && p.facts.length > 0) {
        for (const f of p.facts) lines.push(`${f.label}: ${f.value}`);
        lines.push('');
    }
    if (p.body) lines.push(stripTags(p.body), '');
    if (p.ctaLabel && p.ctaUrl) lines.push(`${p.ctaLabel}: ${p.ctaUrl}`, '');
    if (p.secondaryLinkLabel && p.secondaryLinkUrl) lines.push(`${p.secondaryLinkLabel}: ${p.secondaryLinkUrl}`, '');
    lines.push(p.signOff || '— The Superkabe team', '');
    lines.push(p.footerNote || 'Sent by Superkabe · AI-powered cold email with deliverability protection');
    lines.push('https://www.superkabe.com');
    return lines.join('\n');
}

function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
