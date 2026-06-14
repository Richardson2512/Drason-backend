/**
 * Data export confirmation - sent right after a GDPR Art. 15 / CCPA
 * "right-to-know" export is generated. The export itself is delivered
 * via the original HTTP response (synchronous JSON download); this
 * email is the security-audit trail saying "your data was exported on
 * X from <browser/IP>". If it wasn't them, they can act fast.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface DataExportReadyEmailParams {
    name: string | null;
    organizationName: string | null;
    exportedAt: Date;
    requesterContext?: string | null;
    /** Counts included in the export for human verification. */
    counts: {
        mailboxes: number;
        leads: number;
        campaigns: number;
        emailsSent: number;
        emailsValidated: number;
    };
    dataRightsUrl: string;
}

export function dataExportReadyEmail(p: DataExportReadyEmailParams): RenderedEmail {
    const greeting = p.name ? `Hi ${escapeText(p.name)},` : 'Hi there,';
    const subject = 'Your Superkabe data export is ready';
    const preheader = `Your GDPR data export ran on ${p.exportedAt.toUTCString()}. If this wasn't you, secure your account immediately.`;

    const facts: { label: string; value: string }[] = [
        { label: 'Exported at', value: p.exportedAt.toUTCString() },
        { label: 'Mailboxes', value: String(p.counts.mailboxes) },
        { label: 'Leads', value: String(p.counts.leads) },
        { label: 'Campaigns', value: String(p.counts.campaigns) },
        { label: 'Emails sent (last 30d)', value: String(p.counts.emailsSent) },
        { label: 'Emails validated (last 30d)', value: String(p.counts.emailsValidated) },
    ];
    if (p.requesterContext) facts.unshift({ label: 'Request from', value: p.requesterContext });

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Compliance · GDPR Art. 15',
        heading: 'Your data export was generated',
        intro: `${greeting} As requested, ${p.organizationName ? `<strong>${escapeHtml(p.organizationName)}</strong>` : 'your account'} data was exported and delivered to your browser as a JSON file. Below is a confirmation summary for your records.`,
        facts,
        body: `<strong style="color:#111827;">If this wasn't you</strong>, your account may be compromised. Reset your password immediately and contact <a href="mailto:security@superkabe.com" style="color:#1C4532;text-decoration:underline;">security@superkabe.com</a>. Data exports include your contacts, campaign metadata, and consent history - even though they exclude credentials and OAuth tokens, that's still sensitive information.`,
        ctaLabel: 'Review data rights',
        ctaUrl: p.dataRightsUrl,
    };
    return {
        subject,
        html: renderEmailTemplate(tpl),
        text: renderEmailPlainText(tpl),
        preheader,
    };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeText(s: string): string { return s.replace(/[<>]/g, ''); }
