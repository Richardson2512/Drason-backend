import { Request, Response } from 'express';
import { verifySlackSignature } from '../utils/slackUtils';
import { logger } from '../services/observabilityService';
import { prisma } from '../prisma';
import axios from 'axios';
import { getPublicBackendUrl } from '../utils/publicBackendUrl';
// Slack bot-token at-rest encryption is now consolidated in
// utils/slackTokenEncryption.ts (Notifications audit N2 root-cause fix).
// The old local AES-256-GCM with a padEnd "KDF" + hardcoded fallback
// string is gone; legacy rows still decrypt via the v2-then-legacy
// fallback inside the helper.
import { encryptSlackToken, decryptSlackToken, reencryptSlackTokenIfLegacy } from '../utils/slackTokenEncryption';

interface RequestWithRawBody extends Request {
    rawBody?: string;
}

// ============================================================================
// OAUTH INSTALL INITIATION (/api/slack/install)
// ============================================================================
export const initiateInstall = async (req: Request, res: Response) => {
    const orgId = req.orgContext?.organizationId;
    const userId = req.orgContext?.userId;

    if (!orgId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
        logger.error('[Slack] SLACK_CLIENT_ID is not configured');
        return res.redirect(`${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/settings?slack_error=slack_not_configured`);
    }

    const redirectUri = `${getPublicBackendUrl()}/slack/oauth/callback`;

    // Encode orgId:userId into state (matches what handleOAuthCallback expects)
    const state = userId ? `${orgId}:${userId}` : orgId;

    const scopes = [
        'chat:write',
        'commands',
        'app_mentions:read',
        'channels:read',
        'groups:read',
    ].join(',');

    const params = new URLSearchParams({
        client_id: clientId,
        scope: scopes,
        state,
        redirect_uri: redirectUri,
    });

    const authorizeUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
    logger.info(`[Slack] Initiating OAuth install for Org ${orgId}`);
    res.redirect(authorizeUrl);
};

// ============================================================================
// OAUTH CALLBACK ENDPOINT (/slack/oauth/callback)
// ============================================================================
export const handleOAuthCallback = async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string; // This holds the orgId
    const error = req.query.error as string;

    if (error) {
        logger.warn(`[Slack] OAuth flow cancelled or failed: ${error}`);
        return res.redirect(`${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/settings?slack_error=${error}`);
    }

    if (!code || !state) {
        return res.status(400).send('Missing code or state parameter');
    }

    try {
        const redirectUri = `${getPublicBackendUrl()}/slack/oauth/callback`;

        // Exchange code for token. redirect_uri must match the one sent at
        // install initiation, otherwise Slack returns `bad_redirect_uri`.
        const tokenResponse = await axios.post('https://slack.com/api/oauth.v2.access', null, {
            params: {
                client_id: process.env.SLACK_CLIENT_ID,
                client_secret: process.env.SLACK_CLIENT_SECRET,
                code,
                ...(redirectUri ? { redirect_uri: redirectUri } : {})
            }
        });

        const data = tokenResponse.data;

        if (!data.ok) {
            logger.error('[Slack] OAuth exchange failed:', data.error);
            return res.redirect(`${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/settings?slack_error=${data.error}`);
        }

        const teamId = data.team.id;
        const botToken = data.access_token;
        const authedUserId = data.authed_user.id; // Using Slack's user ID as the installer reference for now, but really this should be a Superkabe user ID

        // We temporarily encode the user ID and org ID into the state parameter
        let orgId = state;
        let superkabeUserId = 'system';

        if (state.includes(':')) {
            const parts = state.split(':');
            orgId = parts[0];
            superkabeUserId = parts[1];
        }

        // Verify Org exists
        const org = await prisma.organization.findUnique({
            where: { id: orgId }
        });

        if (!org) {
            return res.status(404).send('Invalid state: Organization not found');
        }

        // Upsert the integration 
        // Note: Using a transaction or carefully handling conflicts to guarantee 1:1 mapping

        // Remove any existing integration for this org first (to enforce 1 slack bot per org)
        await prisma.slackIntegration.deleteMany({
            where: { organization_id: orgId }
        });

        // Remove any existing integration mapping to this slack workspace
        await prisma.slackIntegration.deleteMany({
            where: { slack_team_id: teamId }
        });

        await prisma.slackIntegration.create({
            data: {
                organization_id: orgId,
                slack_team_id: teamId,
                bot_token_encrypted: encryptSlackToken(botToken),
                installed_by_user_id: superkabeUserId !== 'system' ? superkabeUserId : orgId // fallback if user not present
            }
        });

        logger.info(`[Slack] Integration successfully installed for Org ${orgId} to Workspace ${teamId}`);
        res.redirect(`${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/settings?slack_success=true`);

    } catch (err) {
        logger.error('[Slack] Unexpected error during OAuth callback', err as Error);
        res.redirect(`${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/settings?slack_error=internal_server_error`);
    }
};

// ============================================================================
// EVENT SUBSCRIPTIONS ENDPOINT (/slack/events)
// ============================================================================
export const handleEvents = async (req: Request, res: Response) => {
    const { type, challenge } = req.body;

    // 1. URL Verification (Required by Slack during setup)
    if (type === 'url_verification') {
        return res.status(200).json({ challenge });
    }

    // 2. Validate Signature
    const rawBody = (req as RequestWithRawBody).rawBody;
    const signature = req.headers['x-slack-signature'] as string;
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const signingSecret = process.env.SLACK_SIGNING_SECRET || '';

    if (!verifySlackSignature(signature, timestamp, rawBody, signingSecret)) {
        logger.warn('[Slack] Invalid signature on event webhook');
        return res.status(401).send('Invalid Signature');
    }

    // Process actual events here (e.g. app_mention, message)
    // 3. Multi-Tenant Lookup
    const teamId = req.body.team_id;
    if (teamId) {
        const integration = await prisma.slackIntegration.findUnique({
            where: { slack_team_id: teamId }
        });

        if (!integration) {
            logger.warn(`[Slack] Received event for unknown team_id: ${teamId}`);
            return res.status(403).send('Unauthorized Workspace');
        }

        const orgId = integration.organization_id;
        logger.info(`[Slack] Processing event for Org ${orgId}`);
        // TODO: Route event based on orgId
    }

    // Always return 200 immediately to Slack
    res.status(200).send();
};

// ============================================================================
// SLASH COMMAND ENDPOINT (/slack/command)
// ============================================================================
export const handleCommand = async (req: Request, res: Response) => {
    // 1. Validate Signature
    const rawBody = (req as RequestWithRawBody).rawBody;
    const signature = req.headers['x-slack-signature'] as string;
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const signingSecret = process.env.SLACK_SIGNING_SECRET || '';

    if (!verifySlackSignature(signature, timestamp, rawBody, signingSecret)) {
        logger.warn('[Slack] Invalid signature on slash command');
        return res.status(401).send('Invalid Signature');
    }

    // Slack sends URL encoded form data
    const { text, response_url, user_id, team_id, channel_id } = req.body;

    // 2. Multi-Tenant Lookup
    const integration = await prisma.slackIntegration.findUnique({
        where: { slack_team_id: team_id }
    });

    if (!integration) {
        logger.warn(`[Slack] Received command for unknown workspace: ${team_id}`);
        return res.status(200).json({
            response_type: 'ephemeral',
            text: 'This Slack workspace is not connected to Superkabe. Please install the app from your Superkabe dashboard.'
        });
    }

    const orgId = integration.organization_id;

    // 3. Respond immediately (must be within 3 seconds)
    res.status(200).json({
        response_type: 'ephemeral',
        text: 'Processing your request...'
    });

    // 4. Process the command asynchronously scoped to this Organization
    processSlackCommand(text?.trim() || '', response_url, orgId).catch(err => {
        logger.error('[Slack] Error processing command async', err);
    });
};

// ============================================================================
// ASYNC COMMAND PROCESSING
// ============================================================================
async function processSlackCommand(text: string, responseUrl: string, orgId: string) {
    if (!text) {
        await sendSlackResponse(responseUrl, 'Please provide a command. Supported commands: `status <domain>`, `mailbox <email>`, `org`');
        return;
    }

    const args = text.split(/\s+/);
    const command = args[0].toLowerCase();
    const target = args[1];

    try {
        if (command === 'status' && target) {
            await handleDomainStatus(target, responseUrl, orgId);
        } else if (command === 'mailbox' && target) {
            await handleMailboxStatus(target, responseUrl, orgId);
        } else if (command === 'org') {
            await handleOrgStatus(responseUrl, orgId);
        } else {
            await sendSlackResponse(responseUrl, `Unknown command: \`${command}\`. Supported commands: \n• \`status <domain>\`\n• \`mailbox <email>\`\n• \`org\``);
        }
    } catch (error) {
        logger.error(`[Slack] Error executing org command`, error as Error);
        await sendSlackResponse(responseUrl, 'An internal error occurred while fetching organization status.');
    }
}

// ============================================================================
// APP SETTINGS API (Authenticated)
// ============================================================================
export const getSlackChannels = async (req: Request, res: Response) => {
    const orgId = req.orgContext?.organizationId;
    if (!orgId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    try {
        const integration = await prisma.slackIntegration.findUnique({
            where: { organization_id: orgId }
        });

        if (!integration) {
            return res.status(404).json({ success: false, error: 'Slack not connected' });
        }

        const decoded = decryptSlackToken(integration.bot_token_encrypted);
        const token = decoded.plaintext;
        // Opportunistically re-encrypt legacy rows; failure must not
        // break the channel-list flow.
        void reencryptSlackTokenIfLegacy(orgId, decoded);

        const response = await axios.get('https://slack.com/api/conversations.list', {
            headers: { Authorization: `Bearer ${token}` },
            params: {
                types: 'public_channel,private_channel',
                exclude_archived: true,
                limit: 1000
            }
        });

        if (!response.data.ok) {
            return res.status(400).json({ success: false, error: response.data.error });
        }

        // Do not filter by is_member so users can see all public channels.
        // If they select a channel the bot isn't in, the test postMessage will fail
        // and instruct them to invite the bot.
        const availableChannels = response.data.channels
            .map((c: any) => ({
                id: c.id,
                name: `#${c.name}`
            }));

        res.json({ success: true, data: availableChannels });
    } catch (error: any) {
        logger.error('[Slack] Failed to fetch channels', error);
        res.status(500).json({ success: false, error: 'Failed to fetch Slack channels' });
    }
};

export const saveSlackChannel = async (req: Request, res: Response) => {
    const orgId = req.orgContext?.organizationId;
    const { channel_id } = req.body;

    if (!orgId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!channel_id) return res.status(400).json({ success: false, error: 'channel_id required' });

    try {
        const integration = await prisma.slackIntegration.findUnique({
            where: { organization_id: orgId }
        });

        if (!integration) {
            return res.status(404).json({ success: false, error: 'Slack not connected' });
        }

        const decoded = decryptSlackToken(integration.bot_token_encrypted);
        const token = decoded.plaintext;
        void reencryptSlackTokenIfLegacy(orgId, decoded);

        const postTestMessage = () => axios.post('https://slack.com/api/chat.postMessage', {
            channel: channel_id,
            text: "✅ Superkabe alerts successfully configured for this channel."
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        // Verify the bot can actually post to this channel before saving it.
        let testRes = await postTestMessage();

        // not_in_channel: bot has channels:read but isn't a member yet.
        // Auto-join public channels via conversations.join (requires channels:join scope).
        // Private channels can't be joined - bot must be invited manually.
        if (!testRes.data.ok && testRes.data.error === 'not_in_channel') {
            const joinRes = await axios.post('https://slack.com/api/conversations.join', null, {
                headers: { Authorization: `Bearer ${token}` },
                params: { channel: channel_id }
            });

            if (joinRes.data.ok) {
                testRes = await postTestMessage();
            } else {
                logger.warn(`[Slack] conversations.join failed for Org ${orgId}: ${joinRes.data.error}`);

                const channelName = (joinRes.data.channel?.name) ? `#${joinRes.data.channel.name}` : 'the selected channel';
                let friendly: string;

                if (joinRes.data.error === 'method_not_supported_for_channel_type' || joinRes.data.error === 'is_private') {
                    friendly = `${channelName} is a private channel. Open the channel in Slack and run /invite @superkabe-bot, then save again.`;
                } else if (joinRes.data.error === 'missing_scope') {
                    friendly = `Superkabe is missing the channels:join scope. Add it in your Slack app config and reinstall the integration, or invite the bot manually with /invite @superkabe-bot in the channel.`;
                } else {
                    friendly = `Could not join the channel automatically. Open it in Slack and run /invite @superkabe-bot, then save again.`;
                }

                return res.status(400).json({ success: false, error: friendly });
            }
        }

        if (!testRes.data.ok) {
            logger.warn(`[Slack] Channel validation failed for Org ${orgId}. Slack error: ${testRes.data.error}`);

            const friendly = testRes.data.error === 'channel_not_found'
                ? 'That channel no longer exists. Refresh the page and pick another.'
                : testRes.data.error === 'is_archived'
                    ? 'That channel is archived. Pick a different channel.'
                    : `Could not post to the selected channel (${testRes.data.error}). Invite @superkabe-bot to it and try again.`;

            return res.status(400).json({ success: false, error: friendly });
        }

        // Validation succeeded. Save safely.
        await prisma.slackIntegration.update({
            where: { organization_id: orgId },
            data: {
                alerts_channel_id: channel_id,
                alerts_status: 'active',
                alerts_last_error_at: null,
                alerts_last_error_message: null
            }
        });

        res.json({ success: true });
    } catch (error: any) {
        logger.error('[Slack] Failed to save channel', error);
        res.status(500).json({ success: false, error: 'Failed to configure channel' });
    }
};

// ----------------------------------------------------------------------------
// HANDLERS FOR SPECIFIC COMMANDS (Phase 1)
// ----------------------------------------------------------------------------

async function handleDomainStatus(domainName: string, responseUrl: string, orgId: string) {
    const domain = await prisma.domain.findFirst({
        where: { domain: domainName, organization_id: orgId }
    });

    if (!domain) {
        await sendSlackResponse(responseUrl, `Domain \`${domainName}\` not found in your Superkabe organization.`);
        return;
    }

    const statusEmoji = domain.status === 'active' ? '🟢' : domain.status === 'paused' ? '⏸️' : '🔴';

    // Fetch mailbox stats for this domain
    const mailboxes = await prisma.mailbox.findMany({
        where: { domain_id: domain.id }
    });

    const activeCount = mailboxes.filter(m => m.status === 'active').length;

    const text = `*Domain Status: ${domainName}*\nStatus: ${statusEmoji} ${domain.status.toUpperCase()}\nMailboxes: ${activeCount}/${mailboxes.length} active\nCreated: ${domain.created_at.toISOString().split('T')[0]}`;

    await sendSlackResponse(responseUrl, text);
}

async function handleMailboxStatus(email: string, responseUrl: string, orgId: string) {
    const mailbox = await prisma.mailbox.findFirst({
        where: { email, organization_id: orgId }
    });

    if (!mailbox) {
        await sendSlackResponse(responseUrl, `Mailbox \`${email}\` not found in your Superkabe organization.`);
        return;
    }

    const domain = await prisma.domain.findUnique({ where: { id: mailbox.domain_id } });
    const statusEmoji = mailbox.status === 'active' ? '🟢' : mailbox.status === 'paused' ? '⏸️' : '🔴';

    const text = `*Mailbox Status: ${email}*\nStatus: ${statusEmoji} ${mailbox.status.toUpperCase()}\nDomain: ${domain?.domain || 'Unknown'}\nBounces in current window: ${mailbox.window_bounce_count}\nAdded: ${mailbox.created_at.toISOString().split('T')[0]}`;

    await sendSlackResponse(responseUrl, text);
}

async function handleOrgStatus(responseUrl: string, orgId: string) {
    // Count all domains and mailboxes for this specific org
    const domainsCount = await prisma.domain.count({ where: { organization_id: orgId } });
    const activeDomains = await prisma.domain.count({ where: { status: 'active', organization_id: orgId } });

    const mailboxesCount = await prisma.mailbox.count({ where: { organization_id: orgId } });
    const activeMailboxes = await prisma.mailbox.count({ where: { status: 'active', organization_id: orgId } });

    const text = `*Superkabe Organization Overview*\nTotal Domains: ${domainsCount} (${activeDomains} active)\nTotal Mailboxes: ${mailboxesCount} (${activeMailboxes} active)\nSystem is actively monitoring your infrastructure.`;

    await sendSlackResponse(responseUrl, text);
}

// ----------------------------------------------------------------------------
// SLACK API HELPER
// ----------------------------------------------------------------------------
async function sendSlackResponse(responseUrl: string, text: string) {
    try {
        await axios.post(responseUrl, {
            text,
            response_type: 'in_channel' // or 'ephemeral' to only show to the user
        });
    } catch (err) {
        logger.error('[Slack] Failed to send followup response', err as Error);
    }
}

// ─── Notification preferences + history ─────────────────────────────────────
import { getOrgId as resolveOrgId } from '../middleware/orgContext';
import { SLACK_EVENT_CATALOG, SLACK_EVENT_GROUPS, defaultPreferenceForEvent } from '../services/slackEventCatalog';

/**
 * GET /api/slack/notifications/catalog
 * Static catalog of every event_type the platform can emit, grouped for the
 * preferences UI. Each row also reports the operator's effective preference
 * (enabled + channel override) so the frontend can render with one call.
 */
export const getNotificationCatalog = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = resolveOrgId(req);
        const prefs = await prisma.slackNotificationPreference.findMany({
            where: { organization_id: orgId },
            select: { event_type: true, enabled: true, channel_id_override: true },
        });
        const prefMap = new Map(prefs.map(p => [p.event_type, p]));
        const events = SLACK_EVENT_CATALOG.map(def => {
            const stored = prefMap.get(def.event_type);
            return {
                event_type: def.event_type,
                label: def.label,
                description: def.description,
                group: def.group,
                default_enabled: def.default_enabled,
                enabled: stored ? stored.enabled : def.default_enabled,
                channel_id_override: stored?.channel_id_override ?? null,
            };
        });
        res.json({ success: true, data: { groups: SLACK_EVENT_GROUPS, events } });
    } catch (err: any) {
        logger.error('[Slack] getNotificationCatalog failed', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to load notification catalog' });
    }
};

/**
 * PUT /api/slack/notifications/preferences
 * Body: { preferences: [{ event_type, enabled, channel_id_override? }, ...] }
 * Upserts each provided event_type. Unspecified events keep their existing
 * pref (or the catalog default).
 */
export const updateNotificationPreferences = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = resolveOrgId(req);
        const incoming = Array.isArray(req.body?.preferences) ? req.body.preferences : [];
        for (const p of incoming) {
            const eventType = String(p?.event_type || '').trim();
            if (!eventType) continue;
            await prisma.slackNotificationPreference.upsert({
                where: {
                    organization_id_event_type: {
                        organization_id: orgId,
                        event_type: eventType,
                    },
                },
                create: {
                    organization_id: orgId,
                    event_type: eventType,
                    enabled: typeof p.enabled === 'boolean' ? p.enabled : defaultPreferenceForEvent(eventType),
                    channel_id_override: p.channel_id_override || null,
                },
                update: {
                    enabled: typeof p.enabled === 'boolean' ? p.enabled : defaultPreferenceForEvent(eventType),
                    channel_id_override: p.channel_id_override || null,
                },
            });
        }
        res.json({ success: true });
    } catch (err: any) {
        logger.error('[Slack] updateNotificationPreferences failed', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to save preferences' });
    }
};

/**
 * GET /api/slack/notifications/history?limit=50&offset=0
 * Paginated feed of every alert (sent or suppressed) for this org.
 */
export const getNotificationHistory = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = resolveOrgId(req);
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
        const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

        const [rows, total] = await Promise.all([
            prisma.slackAlertLog.findMany({
                where: { organization_id: orgId },
                orderBy: { sent_at: 'desc' },
                skip: offset,
                take: limit,
                select: {
                    id: true,
                    event_type: true,
                    title: true,
                    message: true,
                    severity: true,
                    entity_id: true,
                    channel_id: true,
                    suppressed_by_pref: true,
                    sent_at: true,
                },
            }),
            prisma.slackAlertLog.count({ where: { organization_id: orgId } }),
        ]);

        // Decorate with the human label from the catalog so the UI doesn't
        // have to keep its own lookup table.
        const decorated = rows.map(r => {
            const def = SLACK_EVENT_CATALOG.find(d => d.event_type === r.event_type);
            return { ...r, label: def?.label ?? r.event_type, group: def?.group ?? null };
        });
        res.json({ success: true, data: decorated, meta: { total, limit, offset } });
    } catch (err: any) {
        logger.error('[Slack] getNotificationHistory failed', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to load notification history' });
    }
};
