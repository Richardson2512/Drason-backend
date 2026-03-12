/**
 * Settings Controller
 * 
 * Manages organization-specific settings like API keys.
 * Settings are now scoped to organizations for multi-tenancy.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import { encrypt, decrypt, isEncrypted } from '../utils/encryption';
import axios from 'axios';
import { SourcePlatform } from '@prisma/client';
import { setSyncCancelled, releaseLock } from '../utils/redis';

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
 * Update settings for the organization.
 * Accepts an object of key-value pairs.
 */
export const updateSettings = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const settingsToUpdate = req.body;

        if (!settingsToUpdate || typeof settingsToUpdate !== 'object') {
            return res.status(400).json({ success: false, error: 'Request body must be an object of settings' });
        }

        // Determine which keys are secrets
        const secretKeys = ['SMARTLEAD_API_KEY', 'INSTANTLY_API_KEY', 'EMAILBISON_API_KEY'];

        // Check if any API key is already registered under a different org
        for (const [key, value] of Object.entries(settingsToUpdate)) {
            if (typeof value !== 'string' || !value.trim() || !secretKeys.includes(key)) continue;

            const existingSettings = await prisma.organizationSetting.findMany({
                where: {
                    key,
                    is_secret: true,
                    organization_id: { not: orgId },
                },
                select: { value: true }
            });

            for (const existing of existingSettings) {
                try {
                    const decryptedValue = isEncrypted(existing.value) ? decrypt(existing.value) : existing.value;
                    if (decryptedValue === value) {
                        return res.status(409).json({
                            success: false,
                            error: 'This API key is already registered under another organization. Each API key can only be used by one organization.'
                        });
                    }
                } catch {
                    // Skip entries that fail to decrypt (corrupted data)
                    continue;
                }
            }
        }

        // Check if any API key is changing — purge old platform data before saving
        for (const [key, value] of Object.entries(settingsToUpdate)) {
            if (typeof value !== 'string' || !secretKeys.includes(key)) continue;

            const platformName = key.replace('_API_KEY', '').toLowerCase(); // smartlead, instantly, emailbison
            const existingSetting = await prisma.organizationSetting.findUnique({
                where: { organization_id_key: { organization_id: orgId, key } }
            });

            if (existingSetting?.value) {
                let oldDecrypted: string | null = null;
                try {
                    oldDecrypted = isEncrypted(existingSetting.value) ? decrypt(existingSetting.value) : existingSetting.value;
                } catch { /* corrupted, treat as changed */ }

                const isChanging = oldDecrypted !== value;
                const isRemoving = !value.trim();

                if (isChanging || isRemoving) {
                    logger.info(`[SETTINGS] ${platformName} API key ${isRemoving ? 'removed' : 'changed'} for org ${orgId}. Cancelling any running sync and purging old data.`);

                    // Signal any in-flight sync to abort
                    await setSyncCancelled(orgId, platformName);

                    // Release the sync lock so the cancelled sync doesn't block the new one
                    await releaseLock(`sync:${platformName}:org:${orgId}`);

                    // Small delay to let the running sync hit the cancellation check
                    await new Promise(resolve => setTimeout(resolve, 500));

                    await purgePlatformData(orgId, platformName);
                }
            }
        }

        // Upsert each setting (encrypt secrets before storing)
        const updates = Object.entries(settingsToUpdate).map(([key, value]) => {
            if (typeof value !== 'string') return null;

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
        }).filter((u): u is NonNullable<typeof u> => u !== null);

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

        // Use configured BACKEND_URL — never trust request Host header
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

        // Fetch organization's webhook secret
        let org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { clay_webhook_secret: true }
        });

        // Auto-generate webhook secret if missing (backfill for existing orgs)
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

/**
 * Mask a secret value for display.
 */
function maskSecret(value: string): string {
    if (!value || value.length < 8) return '****';
    return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

/**
 * Purge all synced data for a specific platform when its API key changes or is removed.
 * Filters by source_platform so data from other platforms is preserved.
 * Resets organization entity counts after purge.
 */
async function purgePlatformData(orgId: string, platform: string) {
    try {
        // Map settings key prefix to SourcePlatform enum value
        const platformMap: Record<string, SourcePlatform> = {
            smartlead: SourcePlatform.smartlead,
            instantly: SourcePlatform.instantly,
            emailbison: SourcePlatform.emailbison,
        };
        const platformFilter = platformMap[platform];
        if (!platformFilter) {
            logger.warn(`[SETTINGS] Unknown platform "${platform}", skipping purge`);
            return;
        }

        await prisma.$transaction([
            prisma.lead.deleteMany({ where: { organization_id: orgId, source_platform: platformFilter } }),
            prisma.mailboxMetrics.deleteMany({ where: { mailbox: { organization_id: orgId, source_platform: platformFilter } } }),
            prisma.mailbox.deleteMany({ where: { organization_id: orgId, source_platform: platformFilter } }),
            prisma.routingRule.deleteMany({ where: { organization_id: orgId } }),
            prisma.campaign.deleteMany({ where: { organization_id: orgId, source_platform: platformFilter } }),
            prisma.domain.deleteMany({ where: { organization_id: orgId, source_platform: platformFilter } }),
        ]);

        // Recount remaining entities and update organization counts
        const [domainCount, mailboxCount, leadCount] = await Promise.all([
            prisma.domain.count({ where: { organization_id: orgId } }),
            prisma.mailbox.count({ where: { organization_id: orgId } }),
            prisma.lead.count({ where: { organization_id: orgId } }),
        ]);

        await prisma.organization.update({
            where: { id: orgId },
            data: {
                current_domain_count: domainCount,
                current_mailbox_count: mailboxCount,
                current_lead_count: leadCount,
            }
        });

        logger.info(`[SETTINGS] Successfully purged ${platform} data for org ${orgId}`, {
            remainingDomains: domainCount,
            remainingMailboxes: mailboxCount,
            remainingLeads: leadCount,
        });
    } catch (error) {
        logger.error(`[SETTINGS] Error during ${platform} data purge for org ${orgId}:`, error as Error);
        throw error;
    }
}

/**
 * Disconnect Slack Integration for the organization.
 * POST /api/user/settings/slack/disconnect
 */
export const disconnectSlack = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        // Check if an integration exists
        const existingIntegration = await prisma.slackIntegration.findUnique({
            where: { organization_id: orgId }
        });

        if (!existingIntegration) {
            return res.status(404).json({ success: false, error: 'No active Slack integration found for this organization.' });
        }

        // Revoke the Slack token to cleanly uninstall the bot from the workspace
        try {
            const tokenStr = decrypt(existingIntegration.bot_token_encrypted);
            await axios.post('https://slack.com/api/auth.revoke', null, {
                headers: { Authorization: `Bearer ${tokenStr}` }
            });
            logger.info(`[SETTINGS] Slack token revoked for org ${orgId}`);
        } catch (revokeErr: any) {
            logger.warn(`[SETTINGS] Failed to revoke Slack token during disconnect for org ${orgId}`, { error: revokeErr.message || String(revokeErr) });
        }

        // Delete the slack integration record
        await prisma.slackIntegration.delete({
            where: { organization_id: orgId }
        });

        logger.info(`[SETTINGS] Slack integration disconnected for org ${orgId}`);

        res.json({ success: true, message: 'Slack integration disconnected successfully.' });
    } catch (error) {
        logger.error('[SETTINGS] disconnectSlack error:', error as Error);
        res.status(500).json({ success: false, error: 'Failed to disconnect Slack integration' });
    }
};
