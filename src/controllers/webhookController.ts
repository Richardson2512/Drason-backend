/**
 * Webhook Controller — customer-facing CRUD for outbound webhook endpoints.
 *
 *   GET    /api/webhooks                  — list endpoints (excludes internal=true)
 *   POST   /api/webhooks                  — create endpoint (tier-gated)
 *   GET    /api/webhooks/events           — list valid event types for the UI
 *   GET    /api/webhooks/:id              — get one
 *   PATCH  /api/webhooks/:id              — update name/url/events/active
 *   DELETE /api/webhooks/:id              — delete
 *   POST   /api/webhooks/:id/rotate       — generate a new secret
 *   POST   /api/webhooks/:id/reactivate   — clear auto-disabled state
 *   POST   /api/webhooks/:id/test         — send a synthetic event to the endpoint
 *
 *   GET    /api/webhooks/:id/deliveries              — recent delivery log
 *   POST   /api/webhooks/:id/deliveries/:deliveryId/replay
 *
 * Internal endpoints (Slack-shim, etc.) are HIDDEN from this surface — the
 * SQL filters them out with `internal: false`. They cannot be created,
 * updated, or deleted via this controller.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getOrgId } from '../middleware/orgContext';
import {
    WEBHOOK_EVENTS,
    isValidEventType,
    dispatchEvent,
    replayDelivery,
    type WebhookEventType,
} from '../services/webhookService';
import { generateEndpointSecret } from '../utils/webhookOutboundSigning';

// ────────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────────

const URL_REGEX = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function validateUrl(url: unknown): { ok: true; url: string } | { ok: false; error: string } {
    if (typeof url !== 'string') return { ok: false, error: 'url must be a string' };
    const trimmed = url.trim();
    if (!URL_REGEX.test(trimmed)) return { ok: false, error: 'url must be a valid http(s) URL' };
    if (process.env.NODE_ENV === 'production' && trimmed.startsWith('http://')) {
        return { ok: false, error: 'http:// URLs are blocked in production — use https://' };
    }
    return { ok: true, url: trimmed };
}

function validateEvents(events: unknown): { ok: true; events: string[] } | { ok: false; error: string } {
    if (events === undefined || events === null) return { ok: true, events: [] };
    if (!Array.isArray(events)) return { ok: false, error: 'events must be an array' };
    const out: string[] = [];
    for (const e of events) {
        if (typeof e !== 'string' || !isValidEventType(e)) {
            return { ok: false, error: `unknown event type: ${e}` };
        }
        out.push(e);
    }
    return { ok: true, events: out };
}

function validateProvider(provider: unknown): { ok: true; provider: 'generic' | 'slack' | 'discord' } | { ok: false; error: string } {
    if (provider === undefined || provider === null) return { ok: true, provider: 'generic' };
    if (provider === 'generic' || provider === 'slack' || provider === 'discord') {
        return { ok: true, provider };
    }
    return { ok: false, error: 'provider must be one of: generic, slack, discord' };
}

// Strip the secret unless explicitly requested (only on create + rotate responses).
function publicShape(endpoint: any, includeSecret = false) {
    return {
        id: endpoint.id,
        name: endpoint.name,
        url: endpoint.url,
        events: endpoint.events,
        active: endpoint.active,
        provider: endpoint.provider,
        failure_count: endpoint.failure_count,
        disabled_at: endpoint.disabled_at,
        disabled_reason: endpoint.disabled_reason,
        last_delivery_at: endpoint.last_delivery_at,
        created_at: endpoint.created_at,
        updated_at: endpoint.updated_at,
        ...(includeSecret ? { secret: endpoint.secret } : {}),
    };
}

// ────────────────────────────────────────────────────────────────────
// GET /api/webhooks/events
// ────────────────────────────────────────────────────────────────────

export const listEvents = async (_req: Request, res: Response): Promise<Response> => {
    return res.json({
        success: true,
        data: { events: WEBHOOK_EVENTS },
    });
};

// ────────────────────────────────────────────────────────────────────
// GET /api/webhooks
// ────────────────────────────────────────────────────────────────────

export const listEndpoints = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const endpoints = await prisma.webhookEndpoint.findMany({
            where: { organization_id: orgId, internal: false },
            orderBy: { created_at: 'desc' },
        });
        return res.json({
            success: true,
            data: {
                endpoints: endpoints.map(e => publicShape(e)),
                limits: {
                    used: endpoints.length,
                    max: null,    // unmetered — every tier gets unlimited webhook endpoints
                },
            },
        });
    } catch (error) {
        logger.error('[WEBHOOKS] list failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list webhooks' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/webhooks   (tier-gated)
// ────────────────────────────────────────────────────────────────────

export const createEndpoint = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const { name, url, events, provider } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 120) {
        return res.status(400).json({ success: false, error: 'name is required (1–120 chars)' });
    }
    const urlV = validateUrl(url);
    if (!urlV.ok) return res.status(400).json({ success: false, error: urlV.error });
    const eventsV = validateEvents(events);
    if (!eventsV.ok) return res.status(400).json({ success: false, error: eventsV.error });
    const providerV = validateProvider(provider);
    if (!providerV.ok) return res.status(400).json({ success: false, error: providerV.error });

    try {
        // Subscription-status gate only — endpoint count is unmetered.
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { subscription_status: true },
        });
        if (!org) return res.status(404).json({ success: false, error: 'Organization not found' });
        if (['expired', 'past_due', 'canceled'].includes(org.subscription_status)) {
            return res.status(403).json({ success: false, error: 'Subscription required', upgrade_required: true });
        }

        const endpoint = await prisma.webhookEndpoint.create({
            data: {
                organization_id: orgId,
                name: name.trim(),
                url: urlV.url,
                secret: generateEndpointSecret(),
                events: eventsV.events,
                provider: providerV.provider,
                active: true,
                internal: false,
            },
        });

        logger.info(`[WEBHOOKS] Endpoint created: ${endpoint.id} (org=${orgId})`);
        // Secret is shown ONCE on creation — UI must surface it before navigating away.
        return res.status(201).json({ success: true, data: publicShape(endpoint, /* includeSecret */ true) });
    } catch (error) {
        logger.error('[WEBHOOKS] create failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create webhook' });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/webhooks/:id
// ────────────────────────────────────────────────────────────────────

export const getEndpoint = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const endpoint = await prisma.webhookEndpoint.findFirst({
            where: { id: String(req.params.id), organization_id: orgId, internal: false },
        });
        if (!endpoint) return res.status(404).json({ success: false, error: 'Webhook not found' });
        return res.json({ success: true, data: publicShape(endpoint) });
    } catch (error) {
        logger.error('[WEBHOOKS] get failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to load webhook' });
    }
};

// ────────────────────────────────────────────────────────────────────
// PATCH /api/webhooks/:id
// ────────────────────────────────────────────────────────────────────

export const updateEndpoint = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const existing = await prisma.webhookEndpoint.findFirst({
            where: { id: String(req.params.id), organization_id: orgId, internal: false },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Webhook not found' });

        const data: any = {};
        const { name, url, events, active, provider } = req.body || {};

        if (name !== undefined) {
            if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) {
                return res.status(400).json({ success: false, error: 'name must be a non-empty string ≤120 chars' });
            }
            data.name = name.trim();
        }
        if (url !== undefined) {
            const v = validateUrl(url);
            if (!v.ok) return res.status(400).json({ success: false, error: v.error });
            data.url = v.url;
        }
        if (events !== undefined) {
            const v = validateEvents(events);
            if (!v.ok) return res.status(400).json({ success: false, error: v.error });
            data.events = v.events;
        }
        if (active !== undefined) {
            if (typeof active !== 'boolean') return res.status(400).json({ success: false, error: 'active must be boolean' });
            data.active = active;
        }
        if (provider !== undefined) {
            const v = validateProvider(provider);
            if (!v.ok) return res.status(400).json({ success: false, error: v.error });
            data.provider = v.provider;
        }

        const updated = await prisma.webhookEndpoint.update({
            where: { id: existing.id },
            data,
        });
        return res.json({ success: true, data: publicShape(updated) });
    } catch (error) {
        logger.error('[WEBHOOKS] update failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update webhook' });
    }
};

// ────────────────────────────────────────────────────────────────────
// DELETE /api/webhooks/:id
// ────────────────────────────────────────────────────────────────────

export const deleteEndpoint = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const result = await prisma.webhookEndpoint.deleteMany({
            where: { id: String(req.params.id), organization_id: orgId, internal: false },
        });
        if (result.count === 0) return res.status(404).json({ success: false, error: 'Webhook not found' });
        return res.json({ success: true });
    } catch (error) {
        logger.error('[WEBHOOKS] delete failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to delete webhook' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/webhooks/:id/rotate
// ────────────────────────────────────────────────────────────────────

export const rotateSecret = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const existing = await prisma.webhookEndpoint.findFirst({
            where: { id: String(req.params.id), organization_id: orgId, internal: false },
            select: { id: true },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Webhook not found' });

        const updated = await prisma.webhookEndpoint.update({
            where: { id: existing.id },
            data: { secret: generateEndpointSecret() },
        });
        // New secret returned ONCE.
        return res.json({ success: true, data: publicShape(updated, true) });
    } catch (error) {
        logger.error('[WEBHOOKS] rotate failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to rotate secret' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/webhooks/:id/reactivate — clear auto-disabled state
// ────────────────────────────────────────────────────────────────────

export const reactivateEndpoint = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const existing = await prisma.webhookEndpoint.findFirst({
            where: { id: String(req.params.id), organization_id: orgId, internal: false },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Webhook not found' });

        const updated = await prisma.webhookEndpoint.update({
            where: { id: existing.id },
            data: {
                active: true,
                disabled_at: null,
                disabled_reason: null,
                failure_count: 0,
            },
        });
        return res.json({ success: true, data: publicShape(updated) });
    } catch (error) {
        logger.error('[WEBHOOKS] reactivate failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to reactivate webhook' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/webhooks/:id/test — fire a synthetic event to verify wiring
// ────────────────────────────────────────────────────────────────────

export const testEndpoint = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const endpoint = await prisma.webhookEndpoint.findFirst({
            where: { id: String(req.params.id), organization_id: orgId, internal: false },
        });
        if (!endpoint) return res.status(404).json({ success: false, error: 'Webhook not found' });
        if (!endpoint.active || endpoint.disabled_at) {
            return res.status(400).json({ success: false, error: 'Endpoint is inactive — reactivate before testing' });
        }

        // Use the user's chosen event allowlist or default to a benign event.
        const eventType: WebhookEventType =
            (endpoint.events.length > 0 ? endpoint.events[0] : 'lead.created') as WebhookEventType;

        const result = await dispatchEvent(orgId, eventType, {
            test: true,
            note: 'Synthetic test event from Superkabe webhook UI',
            endpoint_id: endpoint.id,
        });

        return res.json({
            success: true,
            data: {
                test_event_type: eventType,
                deliveries_created: result.created,
                delivery_ids: result.deliveryIds,
            },
        });
    } catch (error) {
        logger.error('[WEBHOOKS] test failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Test event failed' });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/webhooks/:id/deliveries
// ────────────────────────────────────────────────────────────────────

export const listDeliveries = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));
    const status = req.query.status as string | undefined;

    try {
        const endpoint = await prisma.webhookEndpoint.findFirst({
            where: { id: String(req.params.id), organization_id: orgId, internal: false },
            select: { id: true },
        });
        if (!endpoint) return res.status(404).json({ success: false, error: 'Webhook not found' });

        const where: any = { endpoint_id: endpoint.id };
        if (status && ['pending', 'success', 'failed', 'dead_letter'].includes(status)) {
            where.status = status;
        }

        const deliveries = await prisma.webhookDelivery.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: limit,
            select: {
                id: true,
                event_type: true,
                event_id: true,
                status: true,
                attempt_count: true,
                next_attempt_at: true,
                response_code: true,
                duration_ms: true,
                last_error: true,
                delivered_at: true,
                created_at: true,
            },
        });
        return res.json({ success: true, data: deliveries });
    } catch (error) {
        logger.error('[WEBHOOKS] listDeliveries failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list deliveries' });
    }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/webhooks/:id/deliveries/:deliveryId — full payload + body
// ────────────────────────────────────────────────────────────────────

export const getDelivery = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const delivery = await prisma.webhookDelivery.findFirst({
            where: {
                id: String(req.params.deliveryId),
                endpoint: {
                    id: String(req.params.id),
                    organization_id: orgId,
                    internal: false,
                },
            },
        });
        if (!delivery) return res.status(404).json({ success: false, error: 'Delivery not found' });
        return res.json({ success: true, data: delivery });
    } catch (error) {
        logger.error('[WEBHOOKS] getDelivery failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to load delivery' });
    }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/webhooks/:id/deliveries/:deliveryId/replay
// ────────────────────────────────────────────────────────────────────

export const replay = async (req: Request, res: Response): Promise<Response> => {
    const orgId = getOrgId(req);
    try {
        const delivery = await prisma.webhookDelivery.findFirst({
            where: {
                id: String(req.params.deliveryId),
                endpoint: {
                    id: String(req.params.id),
                    organization_id: orgId,
                    internal: false,
                },
            },
            select: { id: true },
        });
        if (!delivery) return res.status(404).json({ success: false, error: 'Delivery not found' });

        await replayDelivery(delivery.id);
        return res.json({ success: true });
    } catch (error) {
        logger.error('[WEBHOOKS] replay failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to replay delivery' });
    }
};
