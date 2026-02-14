/**
 * Settings Controller
 * 
 * Manages organization-specific settings like API keys.
 * Settings are now scoped to organizations for multi-tenancy.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';

/**
 * Get all settings for the organization.
 * Masks secret values (shows only first/last 4 chars).
 */
export const getSettings = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        const settings = await prisma.organizationSetting.findMany({
            where: { organization_id: orgId }
        });

        // Mask secret values
        const maskedSettings = settings.map(s => ({
            key: s.key,
            value: s.is_secret ? maskSecret(s.value) : s.value,
            is_secret: s.is_secret
        }));

        res.json({ success: true, data: maskedSettings });
    } catch (error) {
        logger.error('[SETTINGS] getSettings error:', error as Error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
};

/**
 * Update settings for the organization.
 * Accepts an object of key-value pairs.
 */
export const updateSettings = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const settingsToUpdate = req.body;

        if (!settingsToUpdate || typeof settingsToUpdate !== 'object') {
            return res.status(400).json({ error: 'Request body must be an object of settings' });
        }

        // Determine which keys are secrets
        const secretKeys = ['SMARTLEAD_API_KEY', 'INSTANTLY_API_KEY'];

        // Upsert each setting
        const updates = Object.entries(settingsToUpdate).map(([key, value]) => {
            if (typeof value !== 'string') return null;

            return prisma.organizationSetting.upsert({
                where: {
                    organization_id_key: {
                        organization_id: orgId,
                        key
                    }
                },
                update: { value },
                create: {
                    organization_id: orgId,
                    key,
                    value,
                    is_secret: secretKeys.includes(key)
                }
            });
        }).filter(Boolean);

        await prisma.$transaction(updates as any);

        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
        logger.error('[SETTINGS] updateSettings error:', error as Error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
};

/**
 * Get a single setting value (unmasked, for internal use).
 */
export const getSetting = async (orgId: string, key: string): Promise<string | null> => {
    const setting = await prisma.organizationSetting.findUnique({
        where: {
            organization_id_key: {
                organization_id: orgId,
                key
            }
        }
    });
    return setting?.value || null;
};

/**
 * Get Clay webhook URL for the organization.
 */
export const getClayWebhookUrl = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const baseUrl = process.env.BASE_URL || process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3001}`;

        res.json({
            success: true,
            data: {
                webhookUrl: `${baseUrl}/api/ingest/clay`,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Organization-ID': orgId
                },
                note: 'Include the X-Organization-ID header in Clay webhook configuration'
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate webhook URL' });
    }
};

/**
 * Mask a secret value for display.
 */
function maskSecret(value: string): string {
    if (!value || value.length < 8) return '****';
    return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}
