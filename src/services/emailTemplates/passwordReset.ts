/**
 * Password reset email - built on the canonical
 * services/transactionalEmailTemplates.ts renderer so every system email
 * (this, webhook auto-disabled, all the future ones) ships a single design
 * language to the operator.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface PasswordResetEmailParams {
    name: string | null;
    /** Full https URL the user clicks to land on /reset-password. */
    resetUrl: string;
    /** "Chrome on macOS · 1.2.3.4" - boosts trust, helps users spot phishing. Optional. */
    requesterContext?: string | null;
    /** Link TTL surfaced in body. Default "1 hour". */
    ttlLabel?: string;
}

export function passwordResetEmail(params: PasswordResetEmailParams): RenderedEmail {
    const ttl = params.ttlLabel ?? '1 hour';
    const greeting = params.name ? `Hi ${escapeText(params.name)},` : 'Hi there,';
    const subject = 'Reset your Superkabe password';
    const preheader = `Your password reset link expires in ${ttl}. If you didn't request this, you can ignore this email.`;

    const facts = params.requesterContext
        ? [{ label: 'Request from', value: params.requesterContext }]
        : undefined;

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Account security',
        heading: 'Reset your password',
        intro: `${greeting} We received a request to reset your Superkabe password. Use the button below to choose a new one - the link expires in <strong>${escapeHtml(ttl)}</strong>.`,
        facts,
        ctaLabel: 'Reset password',
        ctaUrl: params.resetUrl,
        body: `<strong style="color:#111827;">Didn't request this?</strong> You can safely ignore this email - your password won't change. Superkabe will never ask you to share your password by email or phone. If you suspect unauthorized access, contact <a href="mailto:security@superkabe.com" style="color:#1C4532;text-decoration:underline;">security@superkabe.com</a>.`,
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

function escapeText(s: string): string {
    return s.replace(/[<>]/g, '');
}
