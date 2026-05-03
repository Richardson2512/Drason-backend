/**
 * Welcome email — sent once, immediately after a user finishes signup
 * (email/password or Google-OAuth-onboarded). Sets expectations for the
 * trial, points at the three highest-leverage onboarding actions.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface WelcomeEmailParams {
    name: string | null;
    organizationName: string | null;
    /** Days remaining in trial. Null for paid signups. */
    trialDaysRemaining?: number | null;
    /** Dashboard root URL, used for the primary CTA. */
    dashboardUrl: string;
}

export function welcomeEmail(params: WelcomeEmailParams): RenderedEmail {
    const greeting = params.name ? `Hi ${escapeText(params.name)},` : 'Hi there,';
    const subject = 'Welcome to Superkabe';
    const trialLine = params.trialDaysRemaining
        ? `Your <strong>${params.trialDaysRemaining}-day trial</strong> is active — explore everything without limits before deciding.`
        : 'Your account is ready to go.';
    const preheader = `${params.name ? `${params.name}, ` : ''}your Superkabe account is ready. Connect a mailbox, import leads, launch a campaign — all under deliverability protection.`;

    const tplParams: RenderEmailParams = {
        preheader,
        eyebrow: 'Welcome',
        heading: 'Your Superkabe account is live',
        intro: `${greeting} Welcome to Superkabe${params.organizationName ? ` — glad to have ${escapeHtml(params.organizationName)} on board` : ''}. ${trialLine}`,
        body:
            `Three things to get you to the first reply fast:` +
            `<br/><br/>` +
            `<strong style="color:#111827;">1. Connect a sending mailbox</strong> — Google, Microsoft, or SMTP. ` +
            `Every send runs through the execution gate, so we'll catch problems before they hurt your domain.` +
            `<br/><br/>` +
            `<strong style="color:#111827;">2. Import or add your leads</strong> — CSV, Apollo, HubSpot, or one-by-one. ` +
            `We validate every email at intake and route invalid addresses out before they bounce.` +
            `<br/><br/>` +
            `<strong style="color:#111827;">3. Launch your first campaign</strong> — write a sequence, pick the leads, hit go. ` +
            `Open / click / reply tracking and per-mailbox health monitoring are on by default.`,
        ctaLabel: 'Open dashboard',
        ctaUrl: params.dashboardUrl,
        secondaryLinkLabel: 'Read the quickstart guide →',
        secondaryLinkUrl: 'https://www.superkabe.com/docs',
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
