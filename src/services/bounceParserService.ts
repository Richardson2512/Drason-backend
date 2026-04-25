/**
 * Bounce (NDR) Parser Service
 *
 * Detects Delivery Status Notifications (DSN / NDR bounces) inside incoming emails
 * fetched by the IMAP / Gmail / Graph reply workers. When detected, creates a
 * BounceEvent via monitoringService.recordBounce so the same Protection pipeline
 * that handles sync SMTP bounces also handles async NDRs.
 *
 * Why this matters: when you send via SMTP and the server accepts the message,
 * you get a "250 OK" synchronously — but the actual delivery failure can arrive
 * hours later as a bounce notification email to the sender. Those land in the
 * inbox and the reply worker picks them up.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import * as monitoringService from './monitoringService';

interface IncomingEmail {
    from: string;
    fromName?: string;
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    messageId: string;
    inReplyTo?: string;
    references?: string;
    receivedAt: Date;
    hasAttachments: boolean;
}

const NDR_SENDER_PATTERNS = [
    /^mailer-daemon@/i,
    /^postmaster@/i,
    /^mail-daemon@/i,
    /^bounce[s]?@/i,
    /^noreply-bounce@/i,
    /^daemon@/i,
];

const NDR_SUBJECT_PATTERNS = [
    /undeliverable/i,
    /delivery.*(failed|failure|status|notification|problem)/i,
    /returned.*mail/i,
    /mail.*delivery.*failure/i,
    /failure notice/i,
    /non[- ]?delivery/i,
    /could not be delivered/i,
    /delivery has failed/i,
    /^bounce[d]?:/i,
];

/**
 * Is this email a bounce notification (DSN / NDR)?
 */
export function isBounceNotification(email: IncomingEmail): boolean {
    const senderMatch = NDR_SENDER_PATTERNS.some(p => p.test(email.from));
    if (senderMatch) return true;

    const subjectMatch = NDR_SUBJECT_PATTERNS.some(p => p.test(email.subject));
    if (subjectMatch) return true;

    // Check body for DSN markers (multipart/report often gets flattened to text by our fetchers)
    const body = `${email.bodyText || ''} ${email.bodyHtml || ''}`.toLowerCase();
    if (
        (body.includes('status: 5.') || body.includes('status: 4.')) &&
        (body.includes('final-recipient:') || body.includes('action: failed') || body.includes('diagnostic-code:'))
    ) {
        return true;
    }

    return false;
}

/**
 * Extract the original recipient email from an NDR body.
 * DSN standard: "Final-Recipient: rfc822; user@domain.com"
 * Falls back to heuristics on provider-specific bounce texts.
 */
function extractFailedRecipient(email: IncomingEmail): string | null {
    const body = `${email.bodyText || ''}\n${email.bodyHtml || ''}`;

    // Standard DSN field
    const finalRecipient = body.match(/Final-Recipient:\s*rfc822;\s*([^\s<>\n]+)/i);
    if (finalRecipient?.[1]) return finalRecipient[1].trim().toLowerCase();

    const originalRecipient = body.match(/Original-Recipient:\s*rfc822;\s*([^\s<>\n]+)/i);
    if (originalRecipient?.[1]) return originalRecipient[1].trim().toLowerCase();

    // Gmail/Outlook-style: "The following address(es) failed: user@domain.com"
    const failedBlock = body.match(/following (?:address|recipients?).*?:\s*([^\s<>\n]+@[^\s<>\n]+)/is);
    if (failedBlock?.[1]) return failedBlock[1].trim().toLowerCase();

    // Generic: find an email in angle brackets near the word "failed" or "bounce"
    const nearFailed = body.match(/<([^@<>\s]+@[^@<>\s]+)>[\s\S]{0,200}(failed|could not|did not reach|undeliverable)/i);
    if (nearFailed?.[1]) return nearFailed[1].trim().toLowerCase();

    return null;
}

/**
 * Extract SMTP diagnostic code / reason from NDR body.
 */
function extractBounceReason(email: IncomingEmail): string {
    const body = `${email.bodyText || ''}\n${email.bodyHtml || ''}`;

    // Prefer Diagnostic-Code header
    const diag = body.match(/Diagnostic-Code:\s*(?:smtp;\s*)?([^\n]+)/i);
    if (diag?.[1]) return diag[1].trim().slice(0, 255);

    // Status field
    const status = body.match(/Status:\s*([0-9.]+)\s*([^\n]*)/i);
    if (status) return `${status[1]} ${status[2]}`.trim().slice(0, 255);

    return email.subject.slice(0, 255);
}

/**
 * Determine if the bounce reason indicates a hard or soft bounce.
 * 5.x.x = permanent (hard), 4.x.x = transient (soft).
 */
function isHardBounce(reason: string): boolean {
    // Explicit 5.x.x DSN status
    if (/5\.\d+\.\d+/.test(reason)) return true;
    if (/4\.\d+\.\d+/.test(reason)) return false;

    // Keyword-based fallback
    const hardKeywords = /no such user|user unknown|does not exist|mailbox unavailable|address rejected|invalid recipient|user disabled|account disabled|550 |551 |553 /i;
    if (hardKeywords.test(reason)) return true;

    const softKeywords = /mailbox full|quota|rate limit|try again|throttl|deferred|temporary/i;
    if (softKeywords.test(reason)) return false;

    // Default to hard if we can't tell — safer to err on the side of protecting reputation
    return true;
}

/**
 * Process a potential bounce notification. Returns true if it was processed as a bounce
 * (caller should NOT also process it as a reply), false otherwise.
 */
export async function tryProcessBounce(
    accountId: string,
    organizationId: string,
    email: IncomingEmail
): Promise<boolean> {
    if (!isBounceNotification(email)) return false;

    const failedRecipient = extractFailedRecipient(email);
    if (!failedRecipient) {
        logger.warn('[BOUNCE-PARSER] NDR detected but could not extract failed recipient', {
            subject: email.subject.slice(0, 80),
            from: email.from,
        });
        return true; // Still consume it — don't treat as a reply
    }

    const reason = extractBounceReason(email);
    const hard = isHardBounce(reason);

    // Match to a campaign — find the most recent SendEvent for this account × recipient
    const recentSend = await prisma.sendEvent.findFirst({
        where: {
            organization_id: organizationId,
            mailbox_id: accountId,
            recipient_email: failedRecipient,
        },
        orderBy: { sent_at: 'desc' },
        select: { campaign_id: true, sent_at: true },
    });

    const campaignId = recentSend?.campaign_id || '';

    if (hard) {
        // Full Protection pipeline — creates BounceEvent, checks thresholds, auto-pauses if needed
        try {
            await monitoringService.recordBounce(
                accountId,
                campaignId,
                reason,
                failedRecipient,
            );
            logger.info(`[BOUNCE-PARSER] Hard bounce NDR → Protection pipeline: ${failedRecipient} (${reason.slice(0, 60)})`);
        } catch (err: any) {
            logger.error(`[BOUNCE-PARSER] recordBounce failed for ${accountId}`, err);
        }

        // Update the CampaignLead status so the send queue stops retrying
        await prisma.campaignLead.updateMany({
            where: { campaign_id: campaignId, email: failedRecipient },
            data: { status: 'bounced', bounced_at: new Date(), next_send_at: null },
        }).catch(() => {});
    } else {
        // Soft bounce — record but don't trigger pause pipeline
        await prisma.bounceEvent.create({
            data: {
                organization_id: organizationId,
                mailbox_id: accountId,
                campaign_id: campaignId || null,
                bounce_type: 'soft_bounce',
                bounce_reason: reason,
                email_address: failedRecipient,
                sent_at: recentSend?.sent_at || null,
            },
        }).catch(() => {});
        logger.info(`[BOUNCE-PARSER] Soft bounce NDR: ${failedRecipient} (${reason.slice(0, 60)})`);
    }

    return true;
}
