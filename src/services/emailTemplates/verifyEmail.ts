/**
 * Email-verification message - sent immediately after an email/password
 * signup. The recipient must click the link before they can log into the
 * dashboard. Mirrors the password-reset email's single-CTA shape; the link
 * carries the raw verification token (we store only its SHA-256 hash).
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface VerifyEmailParams {
    name: string | null;
    /** Fully-qualified verify URL with the raw token in the query string. */
    verifyUrl: string;
    /** Hours until the link expires, for the body copy. */
    expiresInHours: number;
}

export function verifyEmailTemplate(params: VerifyEmailParams): RenderedEmail {
    const greeting = params.name ? `Hi ${escapeText(params.name)},` : 'Hi there,';
    const subject = 'Verify your email to activate your Superkabe account';
    const preheader = 'Confirm your email address to finish setting up your Superkabe account.';

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Verify your email',
        heading: 'Confirm your email address',
        intro: `${greeting} Thanks for signing up for Superkabe. Confirm this email address to activate your account and open your dashboard.`,
        body:
            `Click the button below to verify your email. ` +
            `This link expires in <strong>${params.expiresInHours} hours</strong>.` +
            `<br/><br/>` +
            `If you did not create a Superkabe account, you can safely ignore this email - no account is activated until the link is used.`,
        ctaLabel: 'Verify email address',
        ctaUrl: params.verifyUrl,
    };

    return {
        subject,
        html: renderEmailTemplate(tplParams),
        text: renderEmailPlainText(tplParams),
        preheader,
    };
}

function escapeText(s: string): string { return s.replace(/[<>]/g, ''); }
