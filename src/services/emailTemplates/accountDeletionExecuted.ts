/**
 * Account-deletion-executed email - final confirmation, sent right after
 * the hard-delete worker erases all PII. This is the LAST email this
 * recipient will ever get from Superkabe; the User row (and inbox in our
 * system) is gone by the time they read it.
 *
 * Why we still send it: GDPR Art. 12(3) requires confirmation that
 * erasure was carried out, and CCPA § 1798.105 expects a notice of
 * deletion. The recipient inbox is on their email provider, not ours,
 * so the send is fine even after our records are deleted.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface AccountDeletionExecutedEmailParams {
    requesterName: string | null;
    organizationName: string | null;
    /** When the hard-delete completed. */
    executedAt: Date;
}

export function accountDeletionExecutedEmail(params: AccountDeletionExecutedEmailParams): RenderedEmail {
    const greeting = params.requesterName ? `Hi ${escapeText(params.requesterName)},` : 'Hi there,';
    const subject = 'Your Superkabe account has been deleted';
    const preheader = `As requested, ${params.organizationName ?? 'your account'} and all personal data have been permanently deleted from Superkabe.`;

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Compliance · GDPR Art. 17',
        heading: 'Account deletion complete',
        intro: `${greeting} As requested, ${params.organizationName ? `<strong>${escapeHtml(params.organizationName)}</strong>` : 'your account'} and all associated personal data have been permanently deleted from Superkabe.`,
        facts: [
            { label: 'Executed at', value: params.executedAt.toUTCString() },
        ],
        body:
            `What was removed: every user, lead, mailbox, campaign, sequence, ` +
            `audit log, validation result, and consent record under this ` +
            `organization. Send-event PII (recipient addresses) was scrubbed; ` +
            `aggregate counters were retained as anonymized metrics per our ` +
            `Privacy Policy.` +
            `<br/><br/>` +
            `If you ever want to come back, you can sign up again at ` +
            `<a href="https://www.superkabe.com" style="color:#1C4532;text-decoration:underline;">superkabe.com</a> ` +
            `- it'll be a fresh start. Thanks for trying Superkabe.` +
            `<br/><br/>` +
            `Questions about this confirmation? Reach the privacy team at ` +
            `<a href="mailto:privacy@superkabe.com" style="color:#1C4532;text-decoration:underline;">privacy@superkabe.com</a>.`,
        signOff: '- The Superkabe team',
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
