/**
 * API Key Controller
 *
 * Manage API keys for external integrations and MCP server access.
 * Keys are hashed with SHA-256 before storage — the raw key is only shown once at creation.
 */

import crypto from 'crypto';
import { Request, Response } from 'express';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import { getOrgId } from '../middleware/orgContext';

// All available scopes
export const AVAILABLE_SCOPES = [
    'leads:read',
    'leads:write',
    'campaigns:read',
    'campaigns:write',
    'validation:read',
    'validation:trigger',
    'mailboxes:read',
    'domains:read',
    'replies:read',
    'replies:send',
    'reports:read',
    'account:read',
] as const;

/**
 * Generate a new API key with `sk_live_` prefix.
 */
function generateApiKey(): { raw: string; hash: string; prefix: string } {
    const randomBytes = crypto.randomBytes(32).toString('hex');
    const raw = `sk_live_${randomBytes}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const prefix = `sk_live_${randomBytes.slice(0, 8)}...`;
    return { raw, hash, prefix };
}

/**
 * POST /api/api-keys
 * Create a new API key.
 */
export const createApiKey = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { name, scopes, expires_in_days } = req.body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }

        // Validate scopes
        const requestedScopes: string[] = scopes || [...AVAILABLE_SCOPES];
        const invalidScopes = requestedScopes.filter((s: string) => !(AVAILABLE_SCOPES as readonly string[]).includes(s));
        if (invalidScopes.length > 0) {
            return res.status(400).json({ success: false, error: `Invalid scopes: ${invalidScopes.join(', ')}` });
        }

        // Limit to 10 active keys per org
        const activeCount = await prisma.apiKey.count({
            where: { organization_id: orgId, revoked_at: null }
        });
        if (activeCount >= 10) {
            return res.status(400).json({ success: false, error: 'Maximum 10 active API keys per organization' });
        }

        const { raw, hash, prefix } = generateApiKey();

        const expiresAt = expires_in_days
            ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000)
            : null;

        const apiKey = await prisma.apiKey.create({
            data: {
                key_hash: hash,
                key_prefix: prefix,
                name: name.trim(),
                scopes: requestedScopes,
                organization_id: orgId,
                expires_at: expiresAt,
            }
        });

        logger.info(`[API_KEY] Created key "${name}" for org ${orgId}`, { keyId: apiKey.id, scopes: requestedScopes });

        // Return the raw key ONCE — it cannot be retrieved after this
        return res.status(201).json({
            success: true,
            key: {
                id: apiKey.id,
                raw_key: raw,
                prefix: prefix,
                name: apiKey.name,
                scopes: apiKey.scopes,
                expires_at: apiKey.expires_at,
                created_at: apiKey.created_at,
            },
            warning: 'Save this key now. It will not be shown again.'
        });
    } catch (error) {
        logger.error('[API_KEY] Failed to create key', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create API key' });
    }
};

/**
 * GET /api/api-keys
 * List all API keys for the organization (without hashes).
 */
export const listApiKeys = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);

        const keys = await prisma.apiKey.findMany({
            where: { organization_id: orgId },
            select: {
                id: true,
                key_prefix: true,
                name: true,
                scopes: true,
                last_used_at: true,
                expires_at: true,
                created_at: true,
                revoked_at: true,
            },
            orderBy: { created_at: 'desc' }
        });

        return res.json({ success: true, keys });
    } catch (error) {
        logger.error('[API_KEY] Failed to list keys', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list API keys' });
    }
};

/**
 * DELETE /api/api-keys/:id
 * Revoke an API key (soft delete).
 */
export const revokeApiKey = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = req.params.id as string;

        const key = await prisma.apiKey.findFirst({
            where: { id, organization_id: orgId }
        });

        if (!key) {
            return res.status(404).json({ success: false, error: 'API key not found' });
        }

        if (key.revoked_at) {
            return res.status(400).json({ success: false, error: 'Key is already revoked' });
        }

        await prisma.apiKey.update({
            where: { id },
            data: { revoked_at: new Date() }
        });

        logger.info(`[API_KEY] Revoked key "${key.name}" for org ${orgId}`, { keyId: id });

        return res.json({ success: true, message: 'API key revoked' });
    } catch (error) {
        logger.error('[API_KEY] Failed to revoke key', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to revoke API key' });
    }
};

/**
 * GET /api/api-keys/scopes
 * Return all available scopes for reference.
 */
export const getAvailableScopes = async (_req: Request, res: Response): Promise<Response> => {
    return res.json({ success: true, scopes: AVAILABLE_SCOPES });
};
