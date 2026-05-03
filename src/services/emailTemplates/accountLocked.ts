/**
 * Account locked email — sent when consecutive failed logins trip the
 * lockout threshold. Tells the user they're locked, when access will
 * auto-restore, and how to reset their password if they're stuck.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface AccountLockedEmailParams {
    name: string | null;
    /** Absolute time the lockout auto-clears. */
    lockedUntil: Date;
    /** Number of consecutive failed attempts that triggered the lockout. */
    failedAttempts: number;
    /** Browser/OS · IP summary if extractable from the request that tripped it. */
    requesterContext?: string | null;
    /** Direct link to /forgot-password so the user can recover without waiting. */
    forgotPasswordUrl: string;
}

export function accountLockedEmail(params: AccountLockedEmailParams): RenderedEmail {
    const greeting = params.name ? `Hi ${escapeText(params.name)},` : 'Hi there,';
    const subject = 'Your Superkabe account was temporarily locked';
    const minutes = Math.max(1, Math.round((params.lockedUntil.getTime() - Date.now()) / 60000));
    const preheader = `Locked after ${params.failedAttempts} failed sign-in attempts. Auto-unlocks in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password to recover now.`;

    const facts = [
        { label: 'Failed attempts', value: String(params.failedAttempts) },
        { label: 'Auto-unlocks at', value: params.lockedUntil.toUTCString() },
    ];
    if (params.requesterContext) {
        facts.unshift({ label: 'Last attempt from', value: params.requesterContext });
    }

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Account security',
        heading: 'Your account is temporarily locked',
        intro: `${greeting} We locked your Superkabe account after ${params.failedAttempts} consecutive failed sign-in attempts. This is automatic protection against brute-force attacks — your password and account data are unchanged.`,
        facts,
        body:
            `<strong style="color:#111827;">If this was you</strong>, wait until the auto-unlock time above, or reset your password right now to skip the wait.` +
            `<br/><br/>` +
            `<strong style="color:#111827;">If this wasn't you</strong>, someone is trying to access your account. Reset your password immediately and contact <a href="mailto:security@superkabe.com" style="color:#1C4532;text-decoration:underline;">security@superkabe.com</a>.`,
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
