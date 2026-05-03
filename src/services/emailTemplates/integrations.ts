/**
 * Integration emails — fired from CRM sync workers and lead-source
 * import workers when external integrations need attention or hit
 * a milestone.
 */

import { renderEmailTemplate, renderEmailPlainText, type RenderEmailParams } from '../transactionalEmailTemplates';
import type { RenderedEmail } from './dispatcher';

// ─── 1. CRM sync failed (HubSpot / Salesforce activity push or contact import) ──

export interface CrmSyncFailedEmailParams {
    organizationName: string;
    /** "HubSpot" | "Salesforce". */
    provider: string;
    /** "contact_import" | "activity_push" | "suppression_sync" — what was failing. */
    operation: string;
    /** Best-effort error string from the provider. */
    errorMessage: string;
    /** Number of consecutive failures (including this one). */
    consecutiveFailures: number;
    /** Last successful sync, when known. */
    lastSuccessAt?: Date | null;
    /** /dashboard/integrations/crm/[id] for the user to inspect / reconnect. */
    integrationUrl: string;
}

export function crmSyncFailedEmail(p: CrmSyncFailedEmailParams): RenderedEmail {
    const subject = `${p.provider} sync failing — action needed`;
    const preheader = `${p.provider} ${p.operation.replace(/_/g, ' ')} has failed ${p.consecutiveFailures}× in a row. Latest error: ${p.errorMessage.slice(0, 80)}`;

    const facts: { label: string; value: string }[] = [
        { label: 'Provider', value: p.provider },
        { label: 'Operation', value: p.operation.replace(/_/g, ' ') },
        { label: 'Consecutive failures', value: String(p.consecutiveFailures) },
        { label: 'Latest error', value: p.errorMessage.slice(0, 240) },
    ];
    if (p.lastSuccessAt) {
        facts.push({ label: 'Last successful sync', value: p.lastSuccessAt.toUTCString() });
    }

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Integration · Action required',
        heading: `${escapeHtml(p.provider)} sync is failing`,
        intro: `Your ${escapeHtml(p.provider)} integration has failed <strong>${p.consecutiveFailures} time${p.consecutiveFailures === 1 ? '' : 's'} in a row</strong>. Common causes: the OAuth grant was revoked, an API key rotated, the user that connected it lost access, or the field mapping references a property that no longer exists.`,
        facts,
        body: `Open the integration in the dashboard to view the full error log, re-authenticate if needed, and resume sync. While the integration is broken, leads / activities won't flow between Superkabe and ${escapeHtml(p.provider)}.`,
        ctaLabel: `Open ${escapeHtml(p.provider)} integration`,
        ctaUrl: p.integrationUrl,
    };
    return wrap(subject, tpl, preheader);
}

// ─── 2. Lead source import completed (Apollo / ZoomInfo / Clay / etc.) ──

export interface ImportCompletedEmailParams {
    organizationName: string;
    /** "Apollo" | "Smartlead" | "Instantly" | "ZoomInfo" — display name. */
    sourceLabel: string;
    totalProcessed: number;
    totalCreated: number;
    totalUpdated: number;
    totalSkipped: number;
    totalFailed: number;
    /** Wall-clock duration the import ran. */
    durationLabel?: string | null;
    /** Optional credits used (Apollo) — surfaced when present. */
    creditsConsumed?: number | null;
    /** /dashboard/sequencer/contacts (or /integrations/lead-sources/[id]). */
    contactsUrl: string;
}

export function importCompletedEmail(p: ImportCompletedEmailParams): RenderedEmail {
    const subject = `${p.sourceLabel} import complete — ${p.totalCreated} new lead${p.totalCreated === 1 ? '' : 's'}`;
    const preheader = `${p.sourceLabel}: ${p.totalCreated} new, ${p.totalUpdated} updated, ${p.totalSkipped} skipped${p.totalFailed > 0 ? `, ${p.totalFailed} failed` : ''}.`;

    const facts: { label: string; value: string }[] = [
        { label: 'Source', value: p.sourceLabel },
        { label: 'New leads', value: String(p.totalCreated) },
        { label: 'Updated', value: String(p.totalUpdated) },
        { label: 'Skipped', value: String(p.totalSkipped) },
    ];
    if (p.totalFailed > 0) facts.push({ label: 'Failed', value: String(p.totalFailed) });
    if (p.durationLabel) facts.push({ label: 'Duration', value: p.durationLabel });
    if (typeof p.creditsConsumed === 'number') {
        facts.push({ label: 'Credits used', value: String(p.creditsConsumed) });
    }

    const tpl: RenderEmailParams = {
        preheader,
        eyebrow: 'Import complete',
        heading: `${escapeHtml(p.sourceLabel)} import finished`,
        intro: `Your ${escapeHtml(p.sourceLabel)} import for <strong>${escapeHtml(p.organizationName)}</strong> finished. <strong>${p.totalCreated} new lead${p.totalCreated === 1 ? '' : 's'}</strong> were added to your contact database${p.totalUpdated > 0 ? `, and ${p.totalUpdated} existing record${p.totalUpdated === 1 ? '' : 's'} were enriched` : ''}.`,
        facts,
        body: p.totalFailed > 0
            ? `${p.totalFailed} record${p.totalFailed === 1 ? '' : 's'} failed validation or were rejected by the health gate. Open contacts to filter by source = ${escapeHtml(p.sourceLabel)} and review.`
            : `Open contacts to assign these leads to a campaign or run them through email validation.`,
        ctaLabel: 'View contacts',
        ctaUrl: p.contactsUrl,
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
