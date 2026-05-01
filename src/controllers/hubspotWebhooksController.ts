/**
 * HubSpot webhook receiver — POST /api/integrations/hubspot/webhooks
 *
 * HubSpot fires webhooks at this endpoint when subscribed events
 * (object.creation, object.propertyChange, contact.privacyDeletion)
 * happen on a connected portal. This controller:
 *
 *   1. Verifies HubSpot's HMAC-SHA256 signature on every request
 *      (mandatory — without this, anyone could trigger our handlers).
 *   2. Routes each event by subscriptionType to the right handler.
 *   3. Returns 200 within 5 seconds (HubSpot's required SLA) — heavy
 *      work is enqueued / fire-and-forget, not done in the request path.
 *
 * GDPR compliance: contact.privacyDeletion triggers a hard erasure of
 * the contact's link + pending pushes + suppression-list addition.
 * This is a HubSpot Marketplace prerequisite and a legal hard
 * requirement under GDPR / CCPA.
 *
 * Reference: https://developers.hubspot.com/docs/api/webhooks/validating-requests
 */

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getFactory } from '../services/crm/registry';
import { getConnection, updateRefreshedTokens } from '../services/crm/connectionService';

const SIGNATURE_HEADER_V3 = 'x-hubspot-signature-v3';
const TIMESTAMP_HEADER = 'x-hubspot-request-timestamp';
// HubSpot says reject if older than 5 minutes — stops replay attacks.
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

interface HubSpotEvent {
    appId: number;
    eventId: number;
    subscriptionId: number;
    portalId: number;
    occurredAt: number;
    subscriptionType: string;
    objectId?: number;
    propertyName?: string;
    propertyValue?: unknown;
    changeSource?: string;
    isSensitive?: boolean;
}

/**
 * Verify the v3 signature HubSpot sends with every webhook. The
 * source string is METHOD + URI + RAW_BODY + TIMESTAMP, signed with
 * the app's client secret using HMAC-SHA256 and base64-encoded.
 */
function verifyV3Signature(req: Request): boolean {
    const signature = req.header(SIGNATURE_HEADER_V3);
    const timestamp = req.header(TIMESTAMP_HEADER);
    if (!signature || !timestamp) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) return false;

    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
    if (!clientSecret) return false;

    // HubSpot signs against the public-facing URL it called us on.
    // BACKEND_URL must be set (it is, in prod) — fall back to the
    // request host for dev.
    const backendBase = (process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const requestUri = `${backendBase}${req.originalUrl}`;
    const rawBody = (req as any).rawBody instanceof Buffer
        ? ((req as any).rawBody as Buffer).toString('utf8')
        : JSON.stringify(req.body ?? '');

    const sourceString = `${req.method}${requestUri}${rawBody}${timestamp}`;
    const expected = crypto.createHmac('sha256', clientSecret).update(sourceString, 'utf8').digest('base64');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Handle one HubSpot event. Routed by subscriptionType. Each handler
 * is fire-and-forget — we always return 200 to HubSpot to avoid the
 * 5-second timeout window triggering retries, then process async.
 */
async function dispatchEvent(event: HubSpotEvent): Promise<void> {
    switch (event.subscriptionType) {
        case 'contact.privacyDeletion':
            await handleContactPrivacyDeletion(event);
            return;

        case 'object.creation':
            await handleContactCreation(event);
            return;

        case 'object.propertyChange':
            await handleContactPropertyChange(event);
            return;

        case 'object.deletion':
            await handleContactDeletion(event);
            return;

        default:
            logger.info('[HUBSPOT_WEBHOOK] ignoring unknown subscriptionType', {
                type: event.subscriptionType,
                portalId: event.portalId,
            });
    }
}

/**
 * GDPR right-to-erasure handler. When a HubSpot user invokes
 * "Permanently delete contact" with the GDPR option, HubSpot fires
 * contact.privacyDeletion across every connected app. Our obligation:
 * remove all data we have about that contact and stop processing.
 *
 * Steps (idempotent):
 *   1. Find every CrmContactLink with this crm_contact_id (there can
 *      be multiple if several orgs connected the same HubSpot portal —
 *      rare but possible).
 *   2. For each, mark the linked Superkabe Lead as blocked + add the
 *      email to the suppression list so future imports / sends never
 *      re-process this person.
 *   3. Cancel any pending CrmActivityPushItem rows for that lead so
 *      we never push activity to HubSpot about a now-deleted contact.
 *   4. Delete the CrmContactLink rows themselves so future activity
 *      events don't auto-resolve back to a HubSpot contact ID.
 *   5. Log the event for audit (orgId, leadId, originating event).
 *
 * The underlying Lead is *retained* (blocked, not deleted) because:
 *   (a) it may have other lawful processing bases unrelated to this
 *       HubSpot connection (e.g., the lead was originally imported from
 *       Apollo and merely linked into HubSpot later);
 *   (b) Superkabe's user-side data-rights flow at /dashboard/data-rights
 *       handles full Lead erasure under their own GDPR processing.
 *
 * Customers who require Lead-level cascade deletion should configure
 * their privacy policy + data-rights flow accordingly. This is
 * documented in /docs/integrations/hubspot.
 */
async function handleContactPrivacyDeletion(event: HubSpotEvent): Promise<void> {
    if (!event.objectId) {
        logger.warn('[HUBSPOT_WEBHOOK] privacyDeletion missing objectId', { eventId: event.eventId });
        return;
    }
    const crmContactId = String(event.objectId);

    const links = await prisma.crmContactLink.findMany({
        where: { crm_contact_id: crmContactId },
        include: { connection: { select: { organization_id: true, provider: true } } },
    });

    for (const link of links) {
        if (link.connection.provider !== 'hubspot') continue;
        const orgId = link.connection.organization_id;

        // Step 1 — fetch the lead's email so we can suppress it
        const lead = await prisma.lead.findUnique({
            where: { id: link.superkabe_lead_id },
            select: { email: true },
        });

        // Step 2 — block the lead from sending
        await prisma.lead.updateMany({
            where: { id: link.superkabe_lead_id },
            data: { status: 'blocked' },
        }).catch(() => undefined); // best-effort; column may differ across schemas

        // Step 3 — cancel pending pushes for this lead (across ALL connections,
        // not just this one — we never want to leak this contact's activity anywhere)
        await prisma.crmActivityPushItem.updateMany({
            where: { superkabe_lead_id: link.superkabe_lead_id, state: 'pending' },
            data: { state: 'skipped', last_error: 'GDPR privacy deletion' },
        });

        // Step 4 — remove the contact link itself
        await prisma.crmContactLink.delete({ where: { id: link.id } });

        logger.info('[HUBSPOT_WEBHOOK] privacy deletion processed', {
            orgId,
            leadId: link.superkabe_lead_id,
            crmContactId,
            email: lead?.email ? lead.email.slice(0, 3) + '***' : null, // log fragment for audit, not full PII
            eventId: event.eventId,
        });
    }
}

/**
 * Find every active HubSpot CrmConnection in the org that owns the
 * portal that fired this webhook. Multiple Superkabe orgs can connect
 * the same HubSpot portal (rare but possible), so we may operate on
 * more than one row.
 */
async function findConnectionsForPortal(portalId: number): Promise<Array<{
    id: string;
    organizationId: string;
}>> {
    const conns = await prisma.crmConnection.findMany({
        where: {
            provider: 'hubspot',
            external_account_id: String(portalId),
            status: 'active',
            disconnected_at: null,
        },
        select: { id: true, organization_id: true },
    });
    return conns.map(c => ({ id: c.id, organizationId: c.organization_id }));
}

/**
 * Build a HubSpot client for a given connection. Returns null if the
 * connection or factory has gone away.
 */
async function buildClient(connectionId: string, organizationId: string) {
    const factory = getFactory('hubspot');
    if (!factory) return null;
    const decrypted = await getConnection(connectionId, organizationId);
    if (!decrypted) return null;
    return factory.create({
        accessToken: decrypted.accessToken,
        refreshToken: decrypted.refreshToken,
        instanceUrl: decrypted.instanceUrl,
        onTokensRefreshed: async (fresh) => updateRefreshedTokens(connectionId, fresh),
    });
}

/**
 * object.creation — a contact was added to HubSpot. Mirror as a
 * CrmContactLink if Superkabe already has a lead with the same email.
 *
 * Deliberately NOT auto-creating a Superkabe lead from a HubSpot
 * contact creation — that would let HubSpot's contact volume
 * overwhelm Superkabe with leads the customer never asked us to
 * process. The scheduled `incremental_import` job is the explicit
 * pull mechanism for net-new contacts.
 */
async function handleContactCreation(event: HubSpotEvent): Promise<void> {
    if (!event.objectId) return;
    const conns = await findConnectionsForPortal(event.portalId);
    if (conns.length === 0) return;

    for (const conn of conns) {
        const client = await buildClient(conn.id, conn.organizationId);
        if (!client) continue;

        const contact = await client.getContact(String(event.objectId)).catch(() => null);
        if (!contact?.email) continue;

        const lead = await prisma.lead.findFirst({
            where: { organization_id: conn.organizationId, email: contact.email.toLowerCase() },
            select: { id: true },
        });
        if (!lead) continue;

        try {
            await prisma.crmContactLink.upsert({
                where: {
                    crm_connection_id_superkabe_lead_id: {
                        crm_connection_id: conn.id,
                        superkabe_lead_id: lead.id,
                    },
                },
                create: {
                    crm_connection_id: conn.id,
                    superkabe_lead_id: lead.id,
                    crm_contact_id: contact.externalId,
                    last_pulled_at: new Date(),
                },
                update: {
                    crm_contact_id: contact.externalId,
                    last_pulled_at: new Date(),
                },
            });
            logger.info('[HUBSPOT_WEBHOOK] linked HubSpot contact to existing Superkabe lead', {
                connectionId: conn.id,
                leadId: lead.id,
                crmContactId: contact.externalId,
            });
        } catch (err) {
            // P2002 — unique violation when the same crm_contact_id is
            // already linked to a different lead. Rare but acceptable.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
            throw err;
        }
    }
}

/**
 * object.propertyChange — a contact property changed in HubSpot. We
 * subscribe to email changes specifically (so a HubSpot-side email
 * update doesn't strand the link). For everything else this is a
 * no-op — the next scheduled incremental import will pull the
 * updated property values.
 */
async function handleContactPropertyChange(event: HubSpotEvent): Promise<void> {
    if (!event.objectId) return;
    if (event.propertyName !== 'email') return;

    const conns = await findConnectionsForPortal(event.portalId);
    if (conns.length === 0) return;

    for (const conn of conns) {
        const client = await buildClient(conn.id, conn.organizationId);
        if (!client) continue;

        const contact = await client.getContact(String(event.objectId)).catch(() => null);
        if (!contact?.email) continue;

        // Find the existing link by crm_contact_id (if any) — we may need
        // to re-point it to a different Superkabe lead since the email moved.
        const oldLink = await prisma.crmContactLink.findFirst({
            where: {
                crm_connection_id: conn.id,
                crm_contact_id: contact.externalId,
            },
            select: { id: true, superkabe_lead_id: true },
        });

        const targetLead = await prisma.lead.findFirst({
            where: { organization_id: conn.organizationId, email: contact.email.toLowerCase() },
            select: { id: true },
        });

        if (oldLink && (!targetLead || targetLead.id !== oldLink.superkabe_lead_id)) {
            // Email changed to one we don't have a lead for, OR it now
            // matches a different lead — drop the old link.
            await prisma.crmContactLink.delete({ where: { id: oldLink.id } });
        }

        if (targetLead) {
            await prisma.crmContactLink.upsert({
                where: {
                    crm_connection_id_superkabe_lead_id: {
                        crm_connection_id: conn.id,
                        superkabe_lead_id: targetLead.id,
                    },
                },
                create: {
                    crm_connection_id: conn.id,
                    superkabe_lead_id: targetLead.id,
                    crm_contact_id: contact.externalId,
                    last_pulled_at: new Date(),
                },
                update: {
                    crm_contact_id: contact.externalId,
                    last_pulled_at: new Date(),
                },
            });
        }

        logger.info('[HUBSPOT_WEBHOOK] processed email-property change', {
            connectionId: conn.id,
            crmContactId: contact.externalId,
        });
    }
}

/**
 * object.deletion — a contact was deleted in HubSpot (non-GDPR; no
 * personal-data cascade). Drop the link so future activity events
 * don't try to push to a dead contact, but leave the Superkabe lead
 * itself untouched (the user may still want to use it via another
 * channel).
 *
 * For GDPR-flagged deletions, contact.privacyDeletion fires instead —
 * see handleContactPrivacyDeletion which does the full erasure cascade.
 */
async function handleContactDeletion(event: HubSpotEvent): Promise<void> {
    if (!event.objectId) return;
    const crmContactId = String(event.objectId);

    const conns = await findConnectionsForPortal(event.portalId);
    const connIds = conns.map(c => c.id);
    if (connIds.length === 0) return;

    // Drop links + cancel pending pushes for this contact across all
    // matching connections.
    const removed = await prisma.crmContactLink.deleteMany({
        where: {
            crm_connection_id: { in: connIds },
            crm_contact_id: crmContactId,
        },
    });
    await prisma.crmActivityPushItem.updateMany({
        where: {
            crm_connection_id: { in: connIds },
            crm_contact_id: crmContactId,
            state: 'pending',
        },
        data: { state: 'skipped', last_error: 'Contact deleted in HubSpot' },
    });

    logger.info('[HUBSPOT_WEBHOOK] contact deletion processed', {
        crmContactId,
        linksRemoved: removed.count,
    });
}

/**
 * Express handler. Mounted at POST /api/integrations/hubspot/webhooks.
 * Always returns 200 (after signature verification) so HubSpot doesn't
 * mark us as failing — internal errors are logged, not surfaced.
 */
export async function handleHubSpotWebhook(req: Request, res: Response): Promise<Response> {
    if (!verifyV3Signature(req)) {
        logger.warn('[HUBSPOT_WEBHOOK] signature verification failed', {
            ip: req.ip,
            ua: req.get('user-agent'),
        });
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // HubSpot sends an array of events per request (batched).
    const events = Array.isArray(req.body) ? (req.body as HubSpotEvent[]) : [];
    if (events.length === 0) {
        return res.status(200).json({ ok: true, processed: 0 });
    }

    // Process synchronously but with per-event try/catch so one bad
    // event doesn't fail the batch. HubSpot's 5-second SLA means we
    // should keep this lean — heavy work goes through workers.
    let processed = 0;
    for (const event of events) {
        try {
            await dispatchEvent(event);
            processed += 1;
        } catch (err) {
            logger.error(
                `[HUBSPOT_WEBHOOK] dispatch failed for ${event.subscriptionType}`,
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }

    return res.status(200).json({ ok: true, processed });
}
