/**
 * Weekly performance digest - sent every Monday at 09:00 UTC. Aggregates
 * the previous 7 days of activity for an organization.
 *
 * Operator-facing - give them the "did this week go well" answer in one
 * email so they don't have to crawl the dashboard.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

export interface WeeklyDigestEmailParams {
    organizationName: string;
    weekStart: Date;
    weekEnd: Date;
    totals: {
        sent: number;
        opens: number;
        clicks: number;
        replies: number;
        bounces: number;
    };
    /** Week-over-week delta on sends (decimal, e.g. 0.12 for +12%). */
    sendsDeltaPct?: number | null;
    /** Top 3 active campaigns by reply count. */
    topCampaigns?: Array<{ name: string; replies: number; sent: number }>;
    /** Headline operational events: mailboxes paused, recovered, etc. */
    operationalSummary?: {
        mailboxesPaused: number;
        mailboxesRecovered: number;
        domainsPaused: number;
    };
    dashboardUrl: string;
}

export function weeklyDigestEmail(p: WeeklyDigestEmailParams): RenderedEmail {
    const subject = `Your Superkabe weekly digest - ${formatDate(p.weekStart)} to ${formatDate(p.weekEnd)}`;
    const replyRate = p.totals.sent > 0 ? (p.totals.replies / p.totals.sent) * 100 : 0;
    const openRate = p.totals.sent > 0 ? (p.totals.opens / p.totals.sent) * 100 : 0;
    const bounceRate = p.totals.sent > 0 ? (p.totals.bounces / p.totals.sent) * 100 : 0;
    const deltaLabel = p.sendsDeltaPct != null
        ? `${p.sendsDeltaPct > 0 ? '+' : ''}${(p.sendsDeltaPct * 100).toFixed(0)}% vs last week`
        : 'first week of data';
    const preheader = `${p.totals.sent} sent · ${replyRate.toFixed(1)}% reply rate · ${bounceRate.toFixed(1)}% bounces. ${deltaLabel}.`;

    const facts: { label: string; value: string }[] = [
        { label: 'Period', value: `${formatDate(p.weekStart)} – ${formatDate(p.weekEnd)}` },
        { label: 'Emails sent', value: `${p.totals.sent.toLocaleString()} (${deltaLabel})` },
        { label: 'Open rate', value: `${openRate.toFixed(1)}% (${p.totals.opens.toLocaleString()} opens)` },
        { label: 'Reply rate', value: `${replyRate.toFixed(1)}% (${p.totals.replies.toLocaleString()} replies)` },
        { label: 'Click count', value: p.totals.clicks.toLocaleString() },
        { label: 'Bounce rate', value: `${bounceRate.toFixed(2)}% (${p.totals.bounces.toLocaleString()} bounces)` },
    ];
    if (p.operationalSummary) {
        const { mailboxesPaused, mailboxesRecovered, domainsPaused } = p.operationalSummary;
        const opLine = [
            mailboxesPaused > 0 ? `${mailboxesPaused} paused` : null,
            mailboxesRecovered > 0 ? `${mailboxesRecovered} recovered` : null,
            domainsPaused > 0 ? `${domainsPaused} domain pause${domainsPaused === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ') || 'all clear';
        facts.push({ label: 'Health events', value: opLine });
    }

    const topCampaignsBlock = p.topCampaigns && p.topCampaigns.length > 0
        ? `<br/><br/><strong style="color:#111827;">Top campaigns this week</strong><br/>` +
          p.topCampaigns.map((c, i) => {
              const reply = c.sent > 0 ? ((c.replies / c.sent) * 100).toFixed(1) : '0';
              return `${i + 1}. <strong>${escapeHtml(c.name)}</strong> - ${c.replies} repl${c.replies === 1 ? 'y' : 'ies'} (${reply}% rate, ${c.sent} sent)`;
          }).join('<br/>')
        : '';

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Weekly digest',
        heading: 'Your week at a glance',
        intro: `Here's how <strong>${escapeHtml(p.organizationName)}</strong> performed from <strong>${escapeHtml(formatDate(p.weekStart))}</strong> to <strong>${escapeHtml(formatDate(p.weekEnd))}</strong>.`,
        facts,
        body:
            (topCampaignsBlock || '') +
            `<br/><br/>Open the dashboard for hourly breakdowns, lead-level engagement, and the full campaign roster.`,
        ctaLabel: 'Open dashboard',
        ctaUrl: p.dashboardUrl,
    };
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
function formatDate(d: Date): string {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
