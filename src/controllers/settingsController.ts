/**
 * Settings Controller
 *
 * Manages organization-level settings: secret-encrypted key/value store
 * (OrganizationSetting), Slack integration status, and Clay webhook config.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import { encrypt, decrypt, isEncrypted } from '../utils/encryption';

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

        const slackIntegration = await prisma.slackIntegration.findUnique({
            where: { organization_id: orgId }
        });

        // Mask secret values
        const maskedSettings: { key: string; value: string; is_secret: boolean }[] = settings.map(s => ({
            key: s.key,
            value: s.is_secret ? maskSecret(s.value) : s.value,
            is_secret: s.is_secret
        }));

        maskedSettings.push({
            key: 'SLACK_CONNECTED',
            value: slackIntegration ? 'true' : 'false',
            is_secret: false
        });

        if (slackIntegration) {
            maskedSettings.push(
                { key: 'SLACK_ALERTS_CHANNEL', value: slackIntegration.alerts_channel_id || '', is_secret: false },
                { key: 'SLACK_ALERTS_STATUS', value: slackIntegration.alerts_status, is_secret: false },
                { key: 'SLACK_ALERTS_LAST_ERROR', value: slackIntegration.alerts_last_error_message || '', is_secret: false },
                { key: 'SLACK_ALERTS_LAST_ERROR_AT', value: slackIntegration.alerts_last_error_at ? slackIntegration.alerts_last_error_at.toISOString() : '', is_secret: false }
            );
        }

        res.json({ success: true, data: maskedSettings });
    } catch (error) {
        logger.error('[SETTINGS] getSettings error:', error as Error);
        res.status(500).json({ success: false, error: 'Failed to fetch settings' });
    }
};

/**
 * Update settings for the organization. The validation middleware enforces
 * the allowlist of writable keys (see middleware/validation.ts).
 */
export const updateSettings = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const settingsToUpdate = req.body;

        if (!settingsToUpdate || typeof settingsToUpdate !== 'object') {
            return res.status(400).json({ success: false, error: 'Request body must be an object of settings' });
        }

        const updates = Object.entries(settingsToUpdate)
            .filter(([_, value]) => typeof value === 'string')
            .map(([key, value]) => {
                const isSecret = key.endsWith('_API_KEY') || key.endsWith('_SECRET');
                const storedValue = isSecret ? encrypt(value as string) : (value as string);
                return prisma.organizationSetting.upsert({
                    where: {
                        organization_id_key: { organization_id: orgId, key }
                    },
                    update: { value: storedValue },
                    create: {
                        organization_id: orgId,
                        key,
                        value: storedValue,
                        is_secret: isSecret
                    }
                });
            });

        await prisma.$transaction(updates);
        res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error) {
        logger.error('[SETTINGS] updateSettings error:', error as Error);
        res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
};

/**
 * Get a single setting value (unmasked, for internal use).
 * Automatically decrypts encrypted values.
 */
export const getSetting = async (orgId: string, key: string): Promise<string | null> => {
    const setting = await prisma.organizationSetting.findUnique({
        where: {
            organization_id_key: { organization_id: orgId, key }
        }
    });

    if (!setting?.value) return null;

    if (setting.is_secret && isEncrypted(setting.value)) {
        try {
            return decrypt(setting.value);
        } catch (error: any) {
            logger.error('[SETTINGS] Failed to decrypt setting', error, { key });
            return null;
        }
    }

    return setting.value;
};

/**
 * Get Clay webhook URL and secret for the organization.
 * Auto-generates webhook secret if missing for existing organizations.
 */
export const getClayWebhookUrl = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        let baseUrl = process.env.BACKEND_URL || process.env.BASE_URL;
        if (!baseUrl) {
            return res.status(500).json({
                success: false,
                error: 'Server configuration error: BACKEND_URL is not set. Contact your administrator.'
            });
        }

        if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
            baseUrl = `https://${baseUrl}`;
        }

        let org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { clay_webhook_secret: true }
        });

        if (!org?.clay_webhook_secret) {
            const webhookSecret = crypto.randomBytes(32).toString('hex');

            await prisma.organization.update({
                where: { id: orgId },
                data: { clay_webhook_secret: webhookSecret }
            });

            logger.info('[SETTINGS] Auto-generated webhook secret for existing organization', { orgId });
            org = { clay_webhook_secret: webhookSecret };
        }

        res.json({
            success: true,
            data: {
                webhookUrl: `${baseUrl}/api/ingest/clay`,
                webhookSecret: org.clay_webhook_secret,
                organizationId: orgId,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Organization-ID': orgId,
                    'X-Clay-Signature': '<HMAC-SHA256 signature of request body>'
                },
                note: 'Configure Clay to send X-Organization-ID header and X-Clay-Signature (HMAC-SHA256 using webhookSecret)'
            }
        });
    } catch (error) {
        logger.error('[SETTINGS] getClayWebhookUrl error:', error as Error);
        res.status(500).json({ success: false, error: 'Failed to generate webhook URL' });
    }
};

function maskSecret(value: string): string {
    if (!value || value.length < 8) return '****';
    return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

/**
 * Disconnect the Slack integration for the organization.
 * POST /api/user/settings/slack/disconnect
 */
export const disconnectSlack = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        await prisma.slackIntegration.deleteMany({
            where: { organization_id: orgId }
        });
        logger.info('[SETTINGS] Disconnected Slack integration', { orgId });
        res.json({ success: true, message: 'Slack disconnected' });
    } catch (error) {
        logger.error('[SETTINGS] disconnectSlack error:', error as Error);
        res.status(500).json({ success: false, error: 'Failed to disconnect Slack' });
    }
};
