import { Request, Response } from 'express';
import { verifySlackSignature } from '../utils/slackUtils';
import { logger } from '../services/observabilityService';
import { prisma } from '../index';
import axios from 'axios';
import crypto from 'crypto';

// Token Encryption Helper
function encryptToken(text: string): string {
    const algorithm = 'aes-256-gcm';
    const iv = crypto.randomBytes(16);
    // Use SLACK_SIGNING_SECRET or fall back to generic APP secret for encryption key
    // Ensure key is exactly 32 bytes 
    let key = (process.env.SLACK_SIGNING_SECRET || process.env.JWT_SECRET || 'fallback-secret-for-dev-only--').padEnd(32, '0').substring(0, 32);

    const cipher = crypto.createCipheriv(algorithm, Buffer.from(key), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptToken(encryptedData: string): string {
    const algorithm = 'aes-256-gcm';
    let key = (process.env.SLACK_SIGNING_SECRET || process.env.JWT_SECRET || 'fallback-secret-for-dev-only--').padEnd(32, '0').substring(0, 32);

    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

// ============================================================================
// OAUTH CALLBACK ENDPOINT (/slack/oauth/callback)
// ============================================================================
export const handleOAuthCallback = async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const state = req.query.state as string; // This holds the orgId
    const error = req.query.error as string;

    if (error) {
        logger.warn(`[Slack] OAuth flow cancelled or failed: ${error}`);
        return res.redirect(`${process.env.FRONTEND_URL}/dashboard/settings?slack_error=${error}`);
    }

    if (!code || !state) {
        return res.status(400).send('Missing code or state parameter');
    }

    try {
        // Exchange code for token
        const tokenResponse = await axios.post('https://slack.com/api/oauth.v2.access', null, {
            params: {
                client_id: process.env.SLACK_CLIENT_ID,
                client_secret: process.env.SLACK_CLIENT_SECRET,
                code
            }
        });

        const data = tokenResponse.data;

        if (!data.ok) {
            logger.error('[Slack] OAuth exchange failed:', data.error);
            return res.redirect(`${process.env.FRONTEND_URL}/dashboard/settings?slack_error=${data.error}`);
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
                bot_token_encrypted: encryptToken(botToken),
                installed_by_user_id: superkabeUserId !== 'system' ? superkabeUserId : orgId // fallback if user not present
            }
        });

        logger.info(`[Slack] Integration successfully installed for Org ${orgId} to Workspace ${teamId}`);
        res.redirect(`${process.env.FRONTEND_URL}/dashboard/settings?slack_success=true`);

    } catch (err) {
        logger.error('[Slack] Unexpected error during OAuth callback', err as Error);
        res.redirect(`${process.env.FRONTEND_URL}/dashboard/settings?slack_error=internal_server_error`);
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
    const rawBody = (req as any).rawBody;
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
    const rawBody = (req as any).rawBody;
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

        const token = decryptToken(integration.bot_token_encrypted);

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

        // Filter for channels where the bot is actually a member, per architectural review
        const availableChannels = response.data.channels
            .filter((c: any) => c.is_member)
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

        const token = decryptToken(integration.bot_token_encrypted);

        // Immediate Validation against Slack
        // We verify the bot can actually post to this channel before saving it.
        const testRes = await axios.post('https://slack.com/api/chat.postMessage', {
            channel: channel_id,
            text: "✅ Superkabe alerts successfully configured for this channel."
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (!testRes.data.ok) {
            logger.warn(`[Slack] Channel validation failed for Org ${orgId}. Slack error: ${testRes.data.error}`);
            return res.status(400).json({ success: false, error: testRes.data.error, message: 'Could not post to the selected channel. Ensure the Superkabe bot is invited to it.' });
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
