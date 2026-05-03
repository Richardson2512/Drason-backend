/**
 * Operational alert emails — fired from healing / state-machine / send-
 * pipeline code when an entity transitions to a degraded state.
 *
 * Coalescing: callers should pass a 15-minute bucket idempotency key to
 * the dispatcher (see `coalesceBucket()` below). Resend dedupes on the
 * key for 24h, so multiple rapid-fire pauses inside a 15-min window
 * collapse to ONE email — the first one. Subsequent pauses are silently
 * suppressed (in-app notifications, audit log, and Slack alerts still
 * fire for each).
 *
 * Tradeoff: only the first entity is named in the email. Operators
 * should treat any operational email as a "go check the dashboard"
 * signal, not a complete inventory.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

/** 15-minute window — matches the operational coalescing policy. */
export const COALESCE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Returns a bucket integer for the current time. Combine with org id and
 * event kind for a coalescing idempotency key:
 *   `mailbox-paused:${orgId}:${coalesceBucket()}`
 */
export function coalesceBucket(now: Date = new Date()): number {
    return Math.floor(now.getTime() / COALESCE_WINDOW_MS);
}

// ─── 1. Mailbox auto-paused ─────────────────────────────────────────────

export interface MailboxPausedEmailParams {
    organizationName: string;
    mailboxEmail: string;
    domainName: string;
    reason: string;
    pausedAt: Date;
    /** Direct link to the mailbox in the dashboard. */
    mailboxUrl: string;
}

export function mailboxPausedEmail(p: MailboxPausedEmailParams): RenderedEmail {
    const subject = `Mailbox paused — ${p.mailboxEmail}`;
    const preheader = `${p.mailboxEmail} was auto-paused: ${p.reason.slice(0, 80)}`;
    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Operational alert',
        heading: 'A mailbox was auto-paused',
        intro: `Superkabe paused <strong>${escapeHtml(p.mailboxEmail)}</strong> on <strong>${escapeHtml(p.domainName)}</strong> to prevent further damage. Sending from this mailbox is suspended until it recovers or you manually resume.`,
        facts: [
            { label: 'Mailbox', value: p.mailboxEmail },
            { label: 'Domain', value: p.domainName },
            { label: 'Reason', value: p.reason },
            { label: 'Paused at', value: p.pausedAt.toUTCString() },
        ],
        body: `Other mailboxes may have hit the same threshold inside the last 15 minutes — open the dashboard for the full picture. The recovery pipeline will graduate this mailbox automatically once bounce rates settle.`,
        ctaLabel: 'Inspect mailbox',
        ctaUrl: p.mailboxUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 2. Mailbox entered quarantine ──────────────────────────────────────

export interface MailboxQuarantineEmailParams {
    organizationName: string;
    mailboxEmail: string;
    domainName: string;
    relapseCount: number;
    resilienceScore: number;
    healingUrl: string;
}

export function mailboxQuarantineEmail(p: MailboxQuarantineEmailParams): RenderedEmail {
    const subject = `Mailbox in quarantine — ${p.mailboxEmail}`;
    const preheader = `${p.mailboxEmail} entered the recovery pipeline. It will warm back up automatically; no action needed unless relapses continue.`;
    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Healing pipeline',
        heading: 'Mailbox entered quarantine',
        intro: `<strong>${escapeHtml(p.mailboxEmail)}</strong> on <strong>${escapeHtml(p.domainName)}</strong> has entered the quarantine phase of the recovery pipeline after repeated bounces or reputation hits.`,
        facts: [
            { label: 'Mailbox', value: p.mailboxEmail },
            { label: 'Relapses', value: String(p.relapseCount) },
            { label: 'Resilience score', value: `${p.resilienceScore} / 100` },
        ],
        body: `Quarantine is automatic — sending stays paused while we monitor for clean signal. Once the threshold of consecutive clean sends is reached, the mailbox graduates to "restricted send" and then back to "warm recovery" before resuming full sending. You don't need to do anything yet; we'll email again if manual intervention becomes required.`,
        ctaLabel: 'Open recovery pipeline',
        ctaUrl: p.healingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 3. Mailbox recovered (graduated to healthy) ────────────────────────

export interface MailboxRecoveredEmailParams {
    organizationName: string;
    mailboxEmail: string;
    domainName: string;
    /** When the mailbox graduated. */
    recoveredAt: Date;
    /** Total time from first pause to graduation. */
    durationLabel: string;
    mailboxUrl: string;
}

export function mailboxRecoveredEmail(p: MailboxRecoveredEmailParams): RenderedEmail {
    const subject = `Mailbox healed — ${p.mailboxEmail}`;
    const preheader = `${p.mailboxEmail} graduated from the recovery pipeline and is sending normally again.`;
    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Healing pipeline · Good news',
        heading: 'A mailbox is back to healthy',
        intro: `Good news — <strong>${escapeHtml(p.mailboxEmail)}</strong> on <strong>${escapeHtml(p.domainName)}</strong> graduated from the recovery pipeline and is sending normally again.`,
        facts: [
            { label: 'Mailbox', value: p.mailboxEmail },
            { label: 'Recovery time', value: p.durationLabel },
            { label: 'Recovered at', value: p.recoveredAt.toUTCString() },
        ],
        body: `Active campaigns assigned to this mailbox will pick up where they left off on the next dispatch cycle.`,
        ctaLabel: 'Open mailbox',
        ctaUrl: p.mailboxUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 4. Domain auto-paused ──────────────────────────────────────────────

export interface DomainPausedEmailParams {
    organizationName: string;
    domainName: string;
    reason: string;
    pausedAt: Date;
    domainUrl: string;
}

export function domainPausedEmail(p: DomainPausedEmailParams): RenderedEmail {
    const subject = `Domain paused — ${p.domainName}`;
    const preheader = `${p.domainName} was auto-paused: ${p.reason.slice(0, 80)}`;
    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Operational alert',
        heading: 'A domain was auto-paused',
        intro: `<strong>${escapeHtml(p.domainName)}</strong> was paused by Superkabe to prevent further damage to its reputation. Every mailbox under this domain is suspended until the domain recovers or you manually resume.`,
        facts: [
            { label: 'Domain', value: p.domainName },
            { label: 'Reason', value: p.reason },
            { label: 'Paused at', value: p.pausedAt.toUTCString() },
        ],
        body: `Domain pauses are typically triggered by aggregate bounce rate or DNSBL listings across the domain's mailboxes. Open the dashboard to inspect DNS health, child mailbox state, and the audit trail.`,
        ctaLabel: 'Inspect domain',
        ctaUrl: p.domainUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 5. Manual intervention required ────────────────────────────────────

export interface ManualInterventionEmailParams {
    organizationName: string;
    entityType: 'mailbox' | 'domain';
    entityLabel: string;
    relapseCount: number;
    reason: string;
    healingUrl: string;
}

export function manualInterventionEmail(p: ManualInterventionEmailParams): RenderedEmail {
    const subject = `Manual review needed — ${p.entityLabel}`;
    const preheader = `Automated healing has been blocked for ${p.entityLabel} after ${p.relapseCount} relapses. Manual review required.`;
    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Healing pipeline · Action required',
        heading: 'Manual intervention required',
        intro: `Automated healing for the ${p.entityType} <strong>${escapeHtml(p.entityLabel)}</strong> has been suspended after <strong>${p.relapseCount} relapses</strong>. Continued auto-graduation would risk longer-term reputation damage, so we're handing it back to you.`,
        facts: [
            { label: 'Entity', value: `${p.entityType} · ${p.entityLabel}` },
            { label: 'Relapses', value: String(p.relapseCount) },
            { label: 'Last reason', value: p.reason },
        ],
        body: `Open the recovery pipeline and choose: clear the intervention flag (which lets healing resume), permanently retire the entity, or wait until you understand the root cause. Common root causes: a corrupted DNS record, a third-party warm-up tool sending unmonitored, or simply a lead list with too many invalid addresses.`,
        ctaLabel: 'Open recovery pipeline',
        ctaUrl: p.healingUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 6. Campaign auto-paused ────────────────────────────────────────────

export interface CampaignPausedEmailParams {
    organizationName: string;
    campaignName: string;
    reason: string;
    pausedAt: Date;
    sentSoFar: number;
    bounceRate: number;          // 0–1
    campaignUrl: string;
}

export function campaignPausedEmail(p: CampaignPausedEmailParams): RenderedEmail {
    const subject = `Campaign paused — ${p.campaignName}`;
    const preheader = `Campaign "${p.campaignName}" was paused: ${p.reason.slice(0, 80)}`;
    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Operational alert',
        heading: 'A campaign was auto-paused',
        intro: `Superkabe paused <strong>${escapeHtml(p.campaignName)}</strong> to prevent further damage. Sending is suspended until you resolve the underlying issue and resume the campaign.`,
        facts: [
            { label: 'Campaign', value: p.campaignName },
            { label: 'Reason', value: p.reason },
            { label: 'Sent so far', value: String(p.sentSoFar) },
            { label: 'Bounce rate', value: `${(p.bounceRate * 100).toFixed(2)}%` },
            { label: 'Paused at', value: p.pausedAt.toUTCString() },
        ],
        body: `Inspect the campaign for the specific trigger — usually a bounce-rate threshold or a paused mailbox/domain in the assigned set. Resume manually once you've addressed the root cause.`,
        ctaLabel: 'Open campaign',
        ctaUrl: p.campaignUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 7. Mailbox OAuth disconnected ──────────────────────────────────────

export interface MailboxOAuthDisconnectedEmailParams {
    organizationName: string;
    mailboxEmail: string;
    provider: 'google' | 'microsoft' | 'smtp' | string;
    /** Raw provider error for the support trail. */
    providerError?: string | null;
    detectedAt: Date;
    reconnectUrl: string;
}

export function mailboxOAuthDisconnectedEmail(p: MailboxOAuthDisconnectedEmailParams): RenderedEmail {
    const subject = `Reconnect needed — ${p.mailboxEmail}`;
    const preheader = `${p.mailboxEmail} lost its ${labelProvider(p.provider)} connection. Sending is paused until you reconnect.`;
    const facts: { label: string; value: string }[] = [
        { label: 'Mailbox', value: p.mailboxEmail },
        { label: 'Provider', value: labelProvider(p.provider) },
        { label: 'Detected at', value: p.detectedAt.toUTCString() },
    ];
    if (p.providerError) facts.push({ label: 'Error', value: p.providerError });

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Integration · Action required',
        heading: 'Reconnect a disconnected mailbox',
        intro: `Superkabe lost its connection to <strong>${escapeHtml(p.mailboxEmail)}</strong> (${escapeHtml(labelProvider(p.provider))}). Sending from this mailbox is paused until you re-authorize the connection.`,
        facts,
        body: `Common causes: an admin revoked the OAuth grant, the user changed their password, the OAuth refresh token expired due to inactivity, or the provider rotated their security policy. Reconnecting takes ~30 seconds and resumes any campaigns assigned to this mailbox automatically.`,
        ctaLabel: 'Reconnect mailbox',
        ctaUrl: p.reconnectUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── helpers ────────────────────────────────────────────────────────────

function wrap(subject: string, tpl: RenderEmailParams, preheader: string): RenderedEmail {
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
function labelProvider(p: string): string {
    if (p === 'google') return 'Google Workspace';
    if (p === 'microsoft') return 'Microsoft 365';
    if (p === 'smtp') return 'SMTP';
    return p;
}
