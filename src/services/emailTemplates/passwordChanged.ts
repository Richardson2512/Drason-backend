/**
 * Password changed email — sent immediately after a successful
 * /api/user/change-password OR /api/auth/reset-password. Lets the user
 * know their password was changed and gives them an emergency contact
 * if it wasn't them.
 *
 * This is a SECURITY ALERT, not the password-reset link itself. Both
 * change-password and reset-password fire it.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface PasswordChangedEmailParams {
    name: string | null;
    /** When the password was changed. Defaults to now. */
    changedAt?: Date;
    /** "Chrome on macOS · 1.2.3.4" — boosts trust. */
    requesterContext?: string | null;
    /** Source of the change — affects copy slightly. */
    source: 'self_service' | 'reset_link';
    /** /forgot-password URL in case the user wasn't the one who changed it. */
    forgotPasswordUrl: string;
}

export function passwordChangedEmail(params: PasswordChangedEmailParams): RenderedEmail {
    const greeting = params.name ? `Hi ${escapeText(params.name)},` : 'Hi there,';
    const subject = 'Your Superkabe password was changed';
    const changedAt = params.changedAt ?? new Date();
    const preheader = `Your password was changed on ${changedAt.toUTCString()}. If this wasn't you, secure your account immediately.`;

    const sourceLine = params.source === 'reset_link'
        ? 'Your password was just reset using a password-reset link.'
        : 'Your password was just changed from your account settings.';

    const facts = [
        { label: 'Changed at', value: changedAt.toUTCString() },
    ];
    if (params.requesterContext) {
        facts.push({ label: 'Changed from', value: params.requesterContext });
    }

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Account security',
        heading: 'Your password was changed',
        intro: `${greeting} ${sourceLine} All previously signed-in sessions have been signed out — you'll need to sign in again with your new password.`,
        facts,
        body:
            `<strong style="color:#111827;">If this was you</strong>, no further action is needed. You can keep using Superkabe normally.` +
            `<br/><br/>` +
            `<strong style="color:#111827;">If this wasn't you</strong>, someone has access to your password. Reset it right now using the link below, then contact <a href="mailto:security@superkabe.com" style="color:#1C4532;text-decoration:underline;">security@superkabe.com</a> so we can investigate.`,
        ctaLabel: 'Reset password',
        ctaUrl: params.forgotPasswordUrl,
    };

    return {
        subject,
        html: renderEmailTemplate(tplParams),
        text: renderEmailPlainText(tplParams),
        preheader,
    };
}

function escapeText(s: string): string { return s.replace(/[<>]/g, ''); }
