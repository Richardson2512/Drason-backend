/**
 * Workspace invite email - sent when an agency owner creates a client login
 * for one of their workspaces. The email body contains the workspace slug
 * and email so the client has everything they need to sign in even if the
 * magic link is misplaced or expires.
 *
 * Co-branded by default: subject + body call out the agency name as the
 * outbound partner, with "Powered by Superkabe" framing. Full white-label
 * (custom-domain mailing, no Superkabe branding) is a v2 concern.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface WorkspaceInviteEmailParams {
    /** Display name for the recipient (optional - falls back to "there"). */
    recipientName: string | null;
    /** Recipient email - surfaced in the body as a fact so the client knows
     *  exactly which address the workspace login is bound to. */
    recipientEmail: string;
    /** The agency's display name shown in the subject + intro. */
    agencyName: string;
    /** Workspace name as the agency wrote it (e.g. "Acme - Q2 outbound"). */
    workspaceName: string;
    /** URL-safe workspace identifier the client types at /login. */
    workspaceSlug: string;
    /** The magic-link URL - points at /set-password?token=…&workspace=…&email=… */
    magicLinkUrl: string;
    /** TTL label surfaced in the body. Default "7 days". */
    ttlLabel?: string;
}

export function workspaceInviteEmail(params: WorkspaceInviteEmailParams): RenderedEmail {
    const ttl = params.ttlLabel ?? '7 days';
    const greeting = params.recipientName ? `Hi ${escapeText(params.recipientName)},` : 'Hi there,';
    const subject = `${params.agencyName} invited you to a workspace on Superkabe`;
    const preheader = `Set your password and access your workspace. Link expires in ${ttl}.`;

    const facts = [
        { label: 'Workspace', value: params.workspaceSlug },
        { label: 'Email', value: params.recipientEmail },
    ];

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: `${params.agencyName} · powered by Superkabe`,
        heading: `You've been invited to ${escapeHtml(params.workspaceName)}`,
        intro: `${greeting} <strong>${escapeHtml(params.agencyName)}</strong> invited you as a client on their Superkabe workspace. Set your password using the button below - the link expires in <strong>${escapeHtml(ttl)}</strong>.`,
        facts,
        ctaLabel: 'Set my password',
        ctaUrl: params.magicLinkUrl,
        body: `<p style="margin:0 0 12px 0;color:#374151;">After setting your password, you can sign in any time at <a href="https://app.superkabe.com/login" style="color:#1C4532;text-decoration:underline;">https://app.superkabe.com/login</a> using:</p>
<p style="margin:0 0 16px 0;color:#374151;">
  <strong>Workspace:</strong> ${escapeHtml(params.workspaceSlug)}<br />
  <strong>Email:</strong> ${escapeHtml(params.recipientEmail)}
</p>
<p style="margin:0;color:#6B7280;font-size:13px;"><strong style="color:#111827;">Didn't expect this?</strong> If you weren't expecting an invite from ${escapeHtml(params.agencyName)}, you can safely ignore this email. The link will expire automatically.</p>`,
    };

    return {
        subject,
        html: renderEmailTemplate(tplParams),
        text: renderEmailPlainText(tplParams),
        preheader,
    };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function escapeText(s: string): string {
    return s.replace(/[<>]/g, '');
}
