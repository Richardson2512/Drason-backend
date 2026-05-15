/**
 * Email-verification email - sent on password signup. The user has NO
 * session until they click this link (the link both verifies the address
 * and logs them in), so this is the first and only message a new
 * unverified account receives. Built on the same canonical
 * transactionalEmailTemplates renderer as passwordReset for one design
 * language.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface EmailVerificationEmailParams {
    name: string | null;
    /** Full https URL the user clicks to land on /verify-email. */
    verifyUrl: string;
    /** Link TTL surfaced in body. Default "24 hours". */
    ttlLabel?: string;
}

export function emailVerificationEmail(params: EmailVerificationEmailParams): RenderedEmail {
    const ttl = params.ttlLabel ?? '24 hours';
    const greeting = params.name ? `Hi ${escapeText(params.name)},` : 'Hi there,';
    const subject = 'Verify your email to activate your Superkabe account';
    const preheader = `Confirm your email to finish creating your Superkabe account. This link expires in ${ttl}.`;

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Account security',
        heading: 'Verify your email',
        intro: `${greeting} Thanks for signing up for Superkabe. Confirm this is your email address to activate your account - you'll be signed in automatically. The link expires in <strong>${escapeHtml(ttl)}</strong>.`,
        ctaLabel: 'Verify email & sign in',
        ctaUrl: params.verifyUrl,
        body: `<strong style="color:#111827;">Didn't sign up?</strong> You can safely ignore this email - no account will be activated and nothing further will be sent. If you have questions, contact <a href="mailto:security@superkabe.com" style="color:#1C4532;text-decoration:underline;">security@superkabe.com</a>.`,
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
