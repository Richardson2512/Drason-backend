import { Request, Response } from 'express';
import { verifySlackSignature } from '../utils/slackUtils';
import { logger } from '../services/observabilityService';
import { prisma } from '../index';
import axios from 'axios';

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
    const { text, response_url, user_id, channel_id } = req.body;

    // 2. Respond immediately (must be within 3 seconds)
    res.status(200).json({
        response_type: 'ephemeral',
        text: 'Processing your request...'
    });

    // 3. Process the command asynchronously
    processSlackCommand(text?.trim() || '', response_url).catch(err => {
        logger.error('[Slack] Error processing command async', err);
    });
};

// ============================================================================
// ASYNC COMMAND PROCESSING
// ============================================================================
async function processSlackCommand(text: string, responseUrl: string) {
    if (!text) {
        await sendSlackResponse(responseUrl, 'Please provide a command. Supported commands: `status <domain>`, `mailbox <email>`, `org`');
        return;
    }

    const args = text.split(/\s+/);
    const command = args[0].toLowerCase();
    const target = args[1];

    try {
        if (command === 'status' && target) {
            await handleDomainStatus(target, responseUrl);
        } else if (command === 'mailbox' && target) {
            await handleMailboxStatus(target, responseUrl);
        } else if (command === 'org') {
            await handleOrgStatus(responseUrl);
        } else {
            await sendSlackResponse(responseUrl, `Unknown command: \`${command}\`. Supported commands: \n• \`status <domain>\`\n• \`mailbox <email>\`\n• \`org\``);
        }
    } catch (error) {
        logger.error(`[Slack] Error executing command ${command}`, error as Error);
        await sendSlackResponse(responseUrl, 'An internal error occurred while processing your request.');
    }
}

// ----------------------------------------------------------------------------
// HANDLERS FOR SPECIFIC COMMANDS (Phase 1)
// ----------------------------------------------------------------------------

async function handleDomainStatus(domainName: string, responseUrl: string) {
    const domain = await prisma.domain.findFirst({
        where: { domain: domainName }
    });

    if (!domain) {
        await sendSlackResponse(responseUrl, `Domain \`${domainName}\` not found in Superkabe.`);
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

async function handleMailboxStatus(email: string, responseUrl: string) {
    const mailbox = await prisma.mailbox.findFirst({
        where: { email }
    });

    if (!mailbox) {
        await sendSlackResponse(responseUrl, `Mailbox \`${email}\` not found in Superkabe.`);
        return;
    }

    const domain = await prisma.domain.findUnique({ where: { id: mailbox.domain_id } });
    const statusEmoji = mailbox.status === 'active' ? '🟢' : mailbox.status === 'paused' ? '⏸️' : '🔴';

    const text = `*Mailbox Status: ${email}*\nStatus: ${statusEmoji} ${mailbox.status.toUpperCase()}\nDomain: ${domain?.domain || 'Unknown'}\nBounces in current window: ${mailbox.window_bounce_count}\nAdded: ${mailbox.created_at.toISOString().split('T')[0]}`;

    await sendSlackResponse(responseUrl, text);
}

async function handleOrgStatus(responseUrl: string) {
    // For Phase 1, just returning global stats since we don't map Slack users to specific Orgs yet.
    // In production we would map `team_id` from Slack to `Organization` in DB.

    // Count all domains and mailboxes
    const domainsCount = await prisma.domain.count();
    const activeDomains = await prisma.domain.count({ where: { status: 'active' } });

    const mailboxesCount = await prisma.mailbox.count();
    const activeMailboxes = await prisma.mailbox.count({ where: { status: 'active' } });

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
