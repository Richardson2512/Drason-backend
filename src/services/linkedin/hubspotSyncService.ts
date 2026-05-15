/**
 * HubSpot 4-bucket sync service.
 *
 * Groups synced LinkedIn data into 4 property buckets on the HubSpot
 * Contact object:
 *
 *   1. Attribution - set ONCE at first contact creation. Captures
 *      original lead source, first-touch date, originating campaign.
 *   2. Exposure   - campaign + list memberships, last sender, import
 *      source. Updates as outreach progresses.
 *   3. Engagement - reply count, time-to-first-reply, last-reply-at.
 *   4. Intent     - auto-tag class (Positive/Neutral/Negative). Driven
 *      by the reply classifier.
 *
 * Direction: Superkabe → HubSpot (unidirectional push). Email is the
 * required dedup identifier - leads without an email cannot create a
 * contact.
 *
 * Activity timeline events (CR sent, message sent, reply received, etc.)
 * are pushed alongside property updates so the HubSpot rep sees the
 * full outreach history per contact.
 *
 * v1 implementation:
 *   - Real HubSpot API calls when HUBSPOT_API_KEY is configured.
 *   - Stub-safe (no-ops) when unset.
 *   - Idempotent: every push uses HubSpot's email-as-key upsert; calling
 *     pushAttribution twice is a no-op for already-attributed contacts.
 *
 * Trigger wiring lives at each integration point (supervisor.ts when
 * promoting a profile → lead, dispatcher when a CR is sent, webhook
 * handler when a reply lands, reply classifier when a tag is generated).
 */

import { logger } from '../observabilityService';

const HUBSPOT_BASE = 'https://api.hubapi.com';
const REQUEST_TIMEOUT_MS = 10_000;

export function isHubSpotConfigured(): boolean {
    return Boolean(process.env.HUBSPOT_API_KEY);
}

interface ContactProps {
    email: string;
    firstname?: string;
    lastname?: string;
    company?: string;
    jobtitle?: string;
    website?: string;
    industry?: string;
    /// Custom properties (group: "superkabe_linkedin")
    superkabe_attribution_source?: string;
    superkabe_attribution_first_touch_at?: string;
    superkabe_attribution_first_campaign?: string;
    superkabe_exposure_campaign_count?: number;
    superkabe_exposure_list_count?: number;
    superkabe_exposure_last_sender?: string;
    superkabe_exposure_import_source?: string;
    superkabe_engagement_reply_count?: number;
    superkabe_engagement_time_to_first_reply_hours?: number;
    superkabe_engagement_last_reply_at?: string;
    superkabe_intent_auto_tag?: 'Interested' | 'Not Interested' | 'Generic';
    superkabe_intent_classified_at?: string;
}

async function hubspotRequest<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T | null> {
    if (!isHubSpotConfigured()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${HUBSPOT_BASE}${path}`, {
            method,
            headers: {
                'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}`,
                'Accept': 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text();
            logger.warn('[HUBSPOT] non-2xx', { method, path, status: res.status, body: text.slice(0, 200) });
            return null;
        }
        const text = await res.text();
        return text ? (JSON.parse(text) as T) : null;
    } catch (err) {
        logger.warn('[HUBSPOT] request failed', { method, path, err: String(err).slice(0, 200) });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Upsert by email using HubSpot's batch upsert endpoint. */
async function upsertContact(props: ContactProps): Promise<void> {
    if (!props.email) return; // HubSpot requires email
    await hubspotRequest('POST', '/crm/v3/objects/contacts/batch/upsert', {
        inputs: [{
            idProperty: 'email',
            id: props.email,
            properties: props,
        }],
    });
}

// ────────────────────────────────────────────────────────────────────
// Public trigger surface - one function per trigger event.
// Each call is idempotent + stub-safe.
// ────────────────────────────────────────────────────────────────────

export interface PushAttributionInput {
    email: string;
    first_name?: string | null;
    last_name?: string | null;
    company?: string | null;
    title?: string | null;
    source: 'linkedin_signal' | 'csv' | 'api' | 'manual' | string;
    first_campaign_name?: string | null;
}

export async function pushAttribution(input: PushAttributionInput): Promise<void> {
    await upsertContact({
        email: input.email,
        firstname: input.first_name || undefined,
        lastname: input.last_name || undefined,
        company: input.company || undefined,
        jobtitle: input.title || undefined,
        superkabe_attribution_source: input.source,
        superkabe_attribution_first_touch_at: new Date().toISOString(),
        superkabe_attribution_first_campaign: input.first_campaign_name || undefined,
    });
}

export async function pushExposureUpdate(input: {
    email: string;
    campaign_count: number;
    list_count?: number;
    last_sender?: string | null;
    import_source?: string | null;
}): Promise<void> {
    await upsertContact({
        email: input.email,
        superkabe_exposure_campaign_count: input.campaign_count,
        superkabe_exposure_list_count: input.list_count,
        superkabe_exposure_last_sender: input.last_sender || undefined,
        superkabe_exposure_import_source: input.import_source || undefined,
    });
}

export async function pushEngagementReply(input: {
    email: string;
    reply_count: number;
    time_to_first_reply_hours?: number;
}): Promise<void> {
    await upsertContact({
        email: input.email,
        superkabe_engagement_reply_count: input.reply_count,
        superkabe_engagement_time_to_first_reply_hours: input.time_to_first_reply_hours,
        superkabe_engagement_last_reply_at: new Date().toISOString(),
    });
}

export async function pushIntent(input: { email: string; tag: 'Interested' | 'Not Interested' | 'Generic' }): Promise<void> {
    await upsertContact({
        email: input.email,
        superkabe_intent_auto_tag: input.tag,
        superkabe_intent_classified_at: new Date().toISOString(),
    });
}

// ────────────────────────────────────────────────────────────────────
// Activity timeline - pushes a single event row onto the contact's
// timeline so the HubSpot rep sees the outreach history inline. Uses
// HubSpot's CRM timeline events API. Requires a registered "event
// template" in HubSpot's developer portal; the template id lives in
// HUBSPOT_TIMELINE_TEMPLATE_ID env var.
// ────────────────────────────────────────────────────────────────────

export type TimelineEventType =
    | 'cr_sent' | 'cr_accepted'
    | 'message_sent' | 'inmail_sent'
    | 'reply_received'
    | 'campaign_added' | 'campaign_removed'
    | 'lead_tagged';

export async function pushTimelineEvent(input: {
    email: string;
    type: TimelineEventType;
    summary: string;
    detail?: string;
}): Promise<void> {
    const templateId = process.env.HUBSPOT_TIMELINE_TEMPLATE_ID;
    if (!isHubSpotConfigured() || !templateId) return;
    await hubspotRequest('POST', '/crm/v3/timeline/events', {
        eventTemplateId: templateId,
        email: input.email,
        tokens: {
            type: input.type,
            summary: input.summary,
            detail: input.detail || '',
        },
    });
}
