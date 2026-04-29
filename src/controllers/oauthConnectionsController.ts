/**
 * OAuth connections controller — surfaces a user-friendly summary of
 * active OAuth grants (DCR-registered MCP clients) for the current org.
 *
 * Used by the dashboard Integrations page to show "Claude — Connected"
 * once the user has completed an OAuth flow from claude.ai. Each row is
 * one (client × user × org) grant; tokens that are revoked or expired
 * are excluded.
 */

import type { Request, Response } from 'express';
import { prisma } from '../index';

export async function listOAuthConnections(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const orgId = req.orgContext.organizationId;
    const now = new Date();

    // Active grants = not revoked, refresh token (if any) still valid.
    // We surface the latest grant per (client_id) to avoid dupes when a
    // user has refreshed tokens multiple times.
    const grants = await prisma.oAuthAccessToken.findMany({
        where: {
            organization_id: orgId,
            revoked_at: null,
            OR: [
                { refresh_expires_at: null, expires_at: { gt: now } },
                { refresh_expires_at: { gt: now } },
            ],
        },
        include: {
            client: {
                select: {
                    client_id: true,
                    client_name: true,
                    client_uri: true,
                    logo_uri: true,
                },
            },
        },
        orderBy: { created_at: 'desc' },
    });

    // Dedupe by client_id, keeping the most recent grant.
    const seen = new Set<string>();
    const summary = [];
    for (const g of grants) {
        if (seen.has(g.client_id)) continue;
        seen.add(g.client_id);
        summary.push({
            client_id: g.client_id,
            client_name: g.client.client_name,
            client_uri: g.client.client_uri,
            logo_uri: g.client.logo_uri,
            scopes: (g.scope || '').split(/\s+/).filter(Boolean),
            granted_at: g.created_at.toISOString(),
            last_used_at: g.last_used_at ? g.last_used_at.toISOString() : null,
            access_token_expires_at: g.expires_at.toISOString(),
            refresh_expires_at: g.refresh_expires_at ? g.refresh_expires_at.toISOString() : null,
        });
    }

    return res.json({ success: true, data: summary });
}

/**
 * Revoke all OAuth grants for a specific client_id (or all clients if
 * none specified) for the current org. Used by the dashboard to let
 * users disconnect Claude (or any DCR-registered client) cleanly.
 */
export async function revokeOAuthConnection(req: Request, res: Response): Promise<Response> {
    if (!req.orgContext) {
        return res.status(401).json({ success: false, error: 'Login required' });
    }

    const orgId = req.orgContext.organizationId;
    const { client_id } = req.body as { client_id?: string };

    const where: any = { organization_id: orgId, revoked_at: null };
    if (client_id) where.client_id = client_id;

    const result = await prisma.oAuthAccessToken.updateMany({
        where,
        data: { revoked_at: new Date() },
    });

    return res.json({ success: true, data: { revoked: result.count } });
}
