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
            where: { organization_id: orgId } // This is fine since it's 1-to-1
        });

        // Mask secret values
        const maskedSettings = settings.map(s => ({
            key: s.key,
            value: s.is_secret ? maskSecret(s.value) : s.value,
            is_secret: s.is_secret
        }));

        maskedSettings.push({
            key: 'SLACK_CONNECTED',
            value: slackIntegration ? 'true' : 'false',
            is_secret: false
        } as any);

        if (slackIntegration) {
            maskedSettings.push(
                { key: 'SLACK_ALERTS_CHANNEL', value: slackIntegration.alerts_channel_id || '', is_secret: false } as any,
                { key: 'SLACK_ALERTS_STATUS', value: slackIntegration.alerts_status, is_secret: false } as any,
                { key: 'SLACK_ALERTS_LAST_ERROR', value: slackIntegration.alerts_last_error_message || '', is_secret: false } as any,
                { key: 'SLACK_ALERTS_LAST_ERROR_AT', value: slackIntegration.alerts_last_error_at ? slackIntegration.alerts_last_error_at.toISOString() : '', is_secret: false } as any
            );
        }

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

        // Upsert each setting (encrypt secrets before storing)
        const updates = Object.entries(settingsToUpdate).map(([key, value]) => {
            if (typeof value !== 'string') return null;

            // If the user is removing the Smartlead API key, purge all synced data
            if (key === 'SMARTLEAD_API_KEY' && (value === '' || value.trim() === '')) {
                logger.info(`[SETTINGS] Smartlead API key removed for org ${orgId}. Purging all synced data.`);

                // Fire off asynchronous purge (don't block the request)
                purgeSmartleadData(orgId).catch(err => {
                    logger.error(`[SETTINGS] Failed to purge Smartlead data for org ${orgId}:`, err);
                });
            }

            const isSecret = secretKeys.includes(key);
            // Encrypt secret values before storing
            const storedValue = isSecret ? encrypt(value) : value;

            return prisma.organizationSetting.upsert({
                where: {
                    organization_id_key: {
                        organization_id: orgId,
                        key
                    }
                },
                update: { value: storedValue },
                create: {
                    organization_id: orgId,
                    key,
                    value: storedValue,
                    is_secret: isSecret
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
 * Automatically decrypts encrypted values.
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

    if (!setting?.value) return null;

    // Decrypt if encrypted (secret values)
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

        // Determine base URL - prefer BACKEND_URL for webhook endpoints
        let baseUrl = process.env.BACKEND_URL || process.env.BASE_URL;
        if (!baseUrl) {
            // Fallback: construct from request host
            const protocol = req.protocol;
            const host = req.get('host');
            baseUrl = `${protocol}://${host}`;
        }

        // Fetch organization's webhook secret
        let org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { clay_webhook_secret: true }
        });

        // Auto-generate webhook secret if missing (backfill for existing orgs)
        if (!org?.clay_webhook_secret) {
            const crypto = await import('crypto');
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

/**
 * Purge all Smartlead-synced data when the API key is removed.
 */
async function purgeSmartleadData(orgId: string) {
    try {
        await prisma.$transaction([
            // Lead has a relation to Campaign, so delete Leads first or cascade will handle it, 
            // but explicit deletion is safer for counting. However, Prisma handles relations.
            prisma.lead.deleteMany({ where: { organization_id: orgId } }),

            // Mailboxes belong to Campaigns and Domains
            prisma.mailboxMetrics.deleteMany({ where: { mailbox: { organization_id: orgId } } }),
            prisma.mailbox.deleteMany({ where: { organization_id: orgId } }),

            // Routing rules belong to campaigns
            prisma.routingRule.deleteMany({ where: { organization_id: orgId } }),

            // Delete Campaigns
            prisma.campaign.deleteMany({ where: { organization_id: orgId } }),

            // Delete Domains last
            prisma.domain.deleteMany({ where: { organization_id: orgId } })
        ]);

        logger.info(`[SETTINGS] Successfully purged all Smartlead data for org ${orgId}`);
    } catch (error) {
        logger.error(`[SETTINGS] Error during Smartlead data purge for org ${orgId}:`, error as Error);
        throw error;
    }
}
