/**
 * Account-deletion-scheduled email - sent when a user (or admin) starts
 * the GDPR Article 17 right-to-erasure flow. Hard-deletes happen 30 days
 * after the request; this email confirms the request and surfaces the
 * cancellation token so the user can abort if they change their mind.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface AccountDeletionScheduledEmailParams {
    requesterName: string | null;
    organizationName: string | null;
    /** Date the hard-delete will run. */
    executesAt: Date;
    /** One-time cancellation token shown in the dashboard + this email. */
    cancellationToken: string;
    /** URL the user can hit to cancel before grace period elapses. */
    cancelUrl: string;
}

export function accountDeletionScheduledEmail(params: AccountDeletionScheduledEmailParams): RenderedEmail {
    const greeting = params.requesterName ? `Hi ${escapeText(params.requesterName)},` : 'Hi there,';
    const subject = 'Your Superkabe account deletion is scheduled';
    const days = Math.max(1, Math.round((params.executesAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    const preheader = `${params.organizationName ?? 'Your account'} will be permanently deleted on ${params.executesAt.toUTCString()}. Cancel anytime before then.`;

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Compliance · GDPR Art. 17',
        heading: 'Account deletion scheduled',
        intro: `${greeting} We received a request to delete ${params.organizationName ? `<strong>${escapeHtml(params.organizationName)}</strong>` : 'your account'}. The hard-delete is scheduled for <strong>${params.executesAt.toUTCString()}</strong> - ${days} day${days === 1 ? '' : 's'} from today.`,
        facts: [
            { label: 'Executes at', value: params.executesAt.toUTCString() },
            { label: 'Cancellation token', value: params.cancellationToken, mono: true },
        ],
        body:
            `Until then, your account is read-only - campaigns are paused, ` +
            `mailboxes will not send, and integrations stop syncing. We keep ` +
            `your data intact during this grace period in case you change ` +
            `your mind.` +
            `<br/><br/>` +
            `<strong style="color:#111827;">After the grace period</strong>, all ` +
            `personal data - leads, mailboxes, sequence content, audit history ` +
            `- is irreversibly removed within 24 hours. Anonymized aggregate ` +
            `metrics may be retained per our Privacy Policy.` +
            `<br/><br/>` +
            `If you didn't request this deletion, contact ` +
            `<a href="mailto:security@superkabe.com" style="color:#1C4532;text-decoration:underline;">security@superkabe.com</a> ` +
            `immediately.`,
        ctaLabel: 'Cancel deletion',
        ctaUrl: params.cancelUrl,
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
function escapeText(s: string): string { return s.replace(/[<>]/g, ''); }
