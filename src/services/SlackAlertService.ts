import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../index';
import { logger } from './observabilityService';
import { SlackAlertsStatus } from '@prisma/client';

export type AlertSeverity = 'info' | 'warning' | 'critical';

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
    info: '#2eb67d',     // Green
    warning: '#ecb22e',  // Yellow
    critical: '#e01e5a'  // Red
};

// Decrypt helper explicitly duplicated here to enforce isolation 
// from web request threads and prevent token leakage.
function decryptTokenIsolated(encryptedData: string): string {
    const algorithm = 'aes-256-gcm';
    const key = (process.env.SLACK_SIGNING_SECRET || process.env.JWT_SECRET || 'fallback-secret-for-dev-only--').padEnd(32, '0').substring(0, 32);

    const parts = encryptedData.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted token format');

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(parts[2], 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/**
 * Proactive Slack Alert Service
 * Runs entirely decoupled from standard API threads. Safe for worker queues.
 */
export class SlackAlertService {

    /**
     * Send a proactive infrastructural alert to a customer's workspace.
     */
    static async sendAlert(params: {
        organizationId: string;
        eventType: string;
        entityId?: string;
        severity: AlertSeverity;
        title: string;
        message: string;
        contextBlocks?: any[];
    }): Promise<void> {

        // 1. Idempotency Check (Deduplication)
        // Creating a hash based on Org + EventType + Entity + Timestamp Bucket (15 min)
        const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
        const hashBase = `${params.organizationId}:${params.eventType}:${params.entityId || 'none'}:${bucket}`;
        const eventHash = crypto.createHash('sha256').update(hashBase).digest('hex');

        try {
            await prisma.slackAlertLog.create({
                data: {
                    organization_id: params.organizationId,
                    event_type: params.eventType,
                    event_hash: eventHash
                }
            });
        } catch (error: any) {
            // Prisma error P2002 means Unique Constraint violation -> it's a duplicate alert
            if (error?.code === 'P2002') {
                logger.info(`[SlackAlertService] Dropping duplicate alert for org ${params.organizationId} (hash: ${eventHash})`);
                return;
            }
            // If it's a different DB issue, we should probably still try to alert, but log the failure
            logger.warn(`[SlackAlertService] Failed to secure idempotency lock: ${error.message}`);
        }

        try {
            // 2. Lookup Integration
            const integration = await prisma.slackIntegration.findUnique({
                where: { organization_id: params.organizationId }
            });

            if (!integration || !integration.alerts_channel_id || integration.alerts_status !== SlackAlertsStatus.active) {
                return; // Silently skip if Slack is not configured or in an error state
            }

            // 3. Decrypt safely strictly in memory scope
            const botToken = decryptTokenIsolated(integration.bot_token_encrypted);

            // 4. Construct Block Kit Payload
            const blocks: any[] = [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*${params.title}*`
                    }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: params.message
                    }
                }
            ];

            if (params.contextBlocks && params.contextBlocks.length > 0) {
                blocks.push({
                    type: 'context',
                    elements: params.contextBlocks
                });
            }

            const payload = {
                channel: integration.alerts_channel_id,
                attachments: [
                    {
                        color: SEVERITY_COLORS[params.severity],
                        blocks: blocks,
                        fallback: params.title // For mobile notifications
                    }
                ]
            };

            // 5. Dispatch with Rate-Limit awareness
            await this.executePostMessageWithBackoff(botToken, payload, params.organizationId);

        } catch (error: any) {
            // 6. Non-blocking error containment
            logger.error(`[SlackAlertService] Core failure sending alert for org ${params.organizationId}`, error);
            // We DO NOT throw the error. Worker isolation is critical.
        }
    }

    private static async executePostMessageWithBackoff(token: string, payload: any, orgId: string, retryCount = 0): Promise<void> {
        try {
            const response = await axios.post('https://slack.com/api/chat.postMessage', payload, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.data.ok) {
                await this.handleSlackErrorMap(orgId, response.data.error, response.headers);
            }

        } catch (error: any) {
            // Handle Axios-level errors and Rate Limits
            if (error.response?.status === 429) {
                // Rate limited by Slack
                const retryAfter = parseInt(error.response.headers['retry-after'] || '2', 10);

                if (retryCount < 3) {
                    logger.warn(`[SlackAlertService] Rate limited by Slack for org ${orgId}. Retrying in ${retryAfter}s`);
                    await new Promise(resolve => setTimeout(resolve, Math.min(retryAfter * 1000, 10000))); // Max 10s backoff
                    return this.executePostMessageWithBackoff(token, payload, orgId, retryCount + 1);
                } else {
                    logger.error(`[SlackAlertService] Exhausted rate limit retries for org ${orgId}`);
                }
            } else {
                // 5xx timeouts, network errors, etc. We just log them. No state freezing.
                logger.error(`[SlackAlertService] Network/Timeout error reaching Slack for org ${orgId}`, error.message);
            }
        }
    }

    private static async handleSlackErrorMap(orgId: string, slackError: string, headers: any): Promise<void> {
        // Critical Structural Errors that require freezing the integration
        let structuralStatus: SlackAlertsStatus | null = null;

        if (slackError === 'invalid_auth' || slackError === 'token_revoked') {
            structuralStatus = SlackAlertsStatus.auth_error;
        } else if (slackError === 'not_in_channel' || slackError === 'channel_not_found' || slackError === 'is_archived') {
            structuralStatus = SlackAlertsStatus.channel_not_found;
        } else if (slackError === 'account_inactive') {
            structuralStatus = SlackAlertsStatus.revoked;
        }

        if (structuralStatus) {
            logger.warn(`[SlackAlertService] Structural error "${slackError}" encountered. Freezing integration for org ${orgId} as ${structuralStatus}`);
            await prisma.slackIntegration.update({
                where: { organization_id: orgId },
                data: {
                    alerts_status: structuralStatus,
                    alerts_last_error_at: new Date(),
                    alerts_last_error_message: `Integration disabled due to Slack error: ${slackError}`
                }
            });
        } else {
            // Other non-structural API errors (e.g. invalid_blocks) we just log
            logger.error(`[SlackAlertService] Slack sent non-structural error response for org ${orgId}: ${slackError}`);
        }
    }
}
