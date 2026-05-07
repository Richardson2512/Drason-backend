/**
 * Internal new-signup alert — fires to the Superkabe team every time a new
 * user finishes registration. NOT user-facing. Used to track signup volume
 * in real time without polling the dashboard / DB.
 *
 * Wire-up sites:
 *   - authController.register (email/password)
 *   - googleAuthController.handleGoogleCallback (Workspace auto-org branch)
 *   - googleAuthController.completeGoogleOnboarding (Gmail flow)
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface InternalNewSignupAlertParams {
    /** New user's email — primary identifier in the alert. */
    userEmail: string;
    /** Display name from registration. May be null/empty. */
    userName: string | null;
    /** Organization name created or joined. */
    organizationName: string | null;
    /** Which signup flow fired this — useful for spotting trends. */
    signupSource: 'email_password' | 'google_workspace' | 'google_gmail';
    /** Plan selected at signup, if any (e.g. "starter", "pro"). */
    plan?: string | null;
    /** Best-effort client IP for fraud / dupe spotting. */
    ipAddress?: string | null;
    /** Best-effort user-agent string. */
    userAgent?: string | null;
}

const SOURCE_LABEL: Record<InternalNewSignupAlertParams['signupSource'], string> = {
    email_password: 'Email + password',
    google_workspace: 'Google Workspace (auto-org)',
    google_gmail: 'Personal Gmail (onboarded)',
};

export function internalNewSignupAlert(params: InternalNewSignupAlertParams): RenderedEmail {
    const subject = `New signup — ${params.userEmail}`;
    const preheader = `${params.userName || params.userEmail} just signed up via ${SOURCE_LABEL[params.signupSource]}.`;

    const rows: Array<[string, string]> = [
        ['Email', params.userEmail],
        ['Name', params.userName || '—'],
        ['Organization', params.organizationName || '—'],
        ['Source', SOURCE_LABEL[params.signupSource]],
    ];
    if (params.plan) rows.push(['Plan', params.plan]);
    if (params.ipAddress) rows.push(['IP', params.ipAddress]);
    if (params.userAgent) rows.push(['User-Agent', truncate(params.userAgent, 120)]);
    rows.push(['Time', new Date().toISOString()]);

    const tableRows = rows.map(
        ([k, v]) =>
            `<tr>` +
            `<td style="padding:6px 12px 6px 0;color:#6E6E78;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>` +
            `<td style="padding:6px 0;color:#111827;font-size:14px;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;">${escapeHtml(v)}</td>` +
            `</tr>`,
    ).join('');

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Internal · New signup',
        heading: `${params.userEmail}`,
        intro: `A new user just registered on Superkabe via <strong>${escapeHtml(SOURCE_LABEL[params.signupSource])}</strong>.`,
        body: `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:8px;">${tableRows}</table>`,
        ctaLabel: 'Open admin dashboard',
        ctaUrl: `${process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000'}/admin`,
    };

    return {
        subject,
        html: renderEmailTemplate(tplParams),
        text: renderEmailPlainText(tplParams),
        preheader,
    };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}
