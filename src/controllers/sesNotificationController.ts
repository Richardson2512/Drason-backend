/**
 * SES SNS notification webhook.
 *
 * AWS SES publishes Delivery / Bounce / Complaint / Reject notifications
 * to an SNS topic; SNS POSTs the JSON envelope to this endpoint.
 *
 * The endpoint handles three SNS message types:
 *   - SubscriptionConfirmation: AWS sends this once when the SNS topic
 *     is first subscribed. We auto-confirm by GETting SubscribeURL.
 *   - Notification: the actual SES event payload (wrapped twice - once
 *     by SNS, once by SES).
 *   - UnsubscribeConfirmation: logged, no action.
 *
 * Auto-pause thresholds - AWS publishes these as the levels at which
 * SES itself starts throttling. We trip a few hundred basis points
 * earlier so we never let one of our IPs degrade the whole AWS account:
 *
 *   bounce_rate > 4%      → auto_paused_bounce       (AWS limit: 5%)
 *   complaint_rate > 0.08% → auto_paused_complaint   (AWS limit: 0.1%)
 *
 * The 24h aggregates on DedicatedIp drive the decision; the raw event
 * goes into DedicatedIpEvent for forensics + monthly reputation reports.
 */

import { Request, Response } from 'express';
import axios from 'axios';
import MessageValidator from 'sns-validator';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { recordSecurityEvent, EVENT_TYPES } from '../services/securityAuditLog';

const BOUNCE_PAUSE_THRESHOLD = 0.04;     // 4%
const COMPLAINT_PAUSE_THRESHOLD = 0.0008; // 0.08%
const MIN_VOLUME_FOR_PAUSE = 100;         // don't pause on 1 bounce out of 5 sends

// SNS message signature validator. The default host pattern only accepts
// SigningCertURLs on `sns.<region>.amazonaws.com[.cn]` - an attacker
// cannot point us at a cert they control. validate() also checks the
// RSA signature over the canonical message string, so forged envelopes
// (fake bounces to auto-pause a paid IP) are rejected here.
const snsValidator = new MessageValidator();

function validateSnsSignature(envelope: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
        snsValidator.validate(envelope, (err) => (err ? reject(err) : resolve()));
    });
}

// Defense-in-depth on the SubscriptionConfirmation handshake: even though
// the signature is validated first, only ever fetch a SubscribeURL whose
// host is an AWS SNS endpoint. Without this, a validly-signed message
// with a crafted SubscribeURL could still drive an SSRF.
function isAwsSnsUrl(raw: string): boolean {
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    return u.protocol === 'https:' && /^sns\.[a-z0-9-]{3,}\.amazonaws\.com(\.cn)?$/i.test(u.hostname);
}

// Optional pinning - when SES_SNS_TOPIC_ARN is set, reject any envelope
// whose TopicArn doesn't match, so a different (but validly-signed) AWS
// SNS topic can't feed us events.
const EXPECTED_TOPIC_ARN = process.env.SES_SNS_TOPIC_ARN || null;

interface SnsEnvelope {
    Type?: string;
    Message?: string;
    SubscribeURL?: string;
    TopicArn?: string;
    MessageId?: string;
}

interface SesNotification {
    notificationType?: string; // 'Bounce' | 'Complaint' | 'Delivery'
    eventType?: string;        // alternate field on configuration-set events
    mail?: {
        messageId?: string;
        sourceIp?: string;
        sendingAccountId?: string;
        commonHeaders?: { from?: string[]; to?: string[]; subject?: string };
        tags?: Record<string, string[]>;
    };
    bounce?: {
        bounceType?: string;
        bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }>;
    };
    complaint?: {
        complainedRecipients?: Array<{ emailAddress?: string }>;
        complaintFeedbackType?: string;
    };
    delivery?: {
        recipients?: string[];
    };
}

export const handleSesNotification = async (req: Request, res: Response): Promise<Response> => {
    const envelope = (req.body || {}) as SnsEnvelope;

    // 0. AUTHENTICITY GATE. This endpoint is public (no app auth) so the
    // ONLY thing standing between the internet and "auto-pause a paid
    // customer's IP" is the AWS SNS signature. Reject anything that
    // doesn't carry a valid AWS signature before touching the DB.
    if (!envelope.Type) {
        return res.status(400).send('missing Type');
    }
    try {
        await validateSnsSignature(envelope as unknown as Record<string, unknown>);
    } catch (err) {
        logger.warn('[SES_SNS] signature validation failed - rejecting', {
            type: envelope.Type,
            topicArn: envelope.TopicArn,
            err: err instanceof Error ? err.message : String(err),
        });
        return res.status(403).send('invalid signature');
    }

    if (EXPECTED_TOPIC_ARN && envelope.TopicArn !== EXPECTED_TOPIC_ARN) {
        logger.warn('[SES_SNS] TopicArn not in allowlist - rejecting', {
            got: envelope.TopicArn,
        });
        return res.status(403).send('unexpected topic');
    }

    // 1. SNS handshake - auto-confirm subscriptions. AWS will not deliver
    // events until SubscribeURL is fetched once. Signature is already
    // verified above; the host check is belt-and-suspenders against SSRF.
    if (envelope.Type === 'SubscriptionConfirmation' && envelope.SubscribeURL) {
        if (!isAwsSnsUrl(envelope.SubscribeURL)) {
            logger.warn('[SES_SNS] SubscribeURL is not an AWS SNS host - refusing to fetch', {
                topicArn: envelope.TopicArn,
            });
            return res.status(403).send('bad subscribe url');
        }
        try {
            await axios.get(envelope.SubscribeURL, { timeout: 5000 });
            logger.info('[SES_SNS] subscription confirmed', { topicArn: envelope.TopicArn });
        } catch (err) {
            logger.warn('[SES_SNS] subscription confirm failed', {
                topicArn: envelope.TopicArn,
                err: err instanceof Error ? err.message : String(err),
            });
        }
        return res.status(200).send('ok');
    }

    if (envelope.Type === 'UnsubscribeConfirmation') {
        logger.info('[SES_SNS] unsubscribe confirmation', { topicArn: envelope.TopicArn });
        return res.status(200).send('ok');
    }

    // 2. Notification path. SES wraps the event payload as a string in the
    // SNS Message field, so we parse it once.
    if (envelope.Type !== 'Notification' || !envelope.Message) {
        return res.status(200).send('ignored');
    }

    let event: SesNotification;
    try {
        event = JSON.parse(envelope.Message);
    } catch (err) {
        logger.warn('[SES_SNS] failed to parse Message JSON', {
            err: err instanceof Error ? err.message : String(err),
        });
        return res.status(200).send('parse-failed');
    }

    const kind = inferKind(event);
    if (!kind) {
        logger.info('[SES_SNS] unknown notification kind, skipping', {
            notificationType: event.notificationType,
            eventType: event.eventType,
        });
        return res.status(200).send('skipped');
    }

    // 3. Resolve the DedicatedIp via the source IP that SES routed the
    // send through. SES populates `mail.sourceIp` on every notification.
    // Fallback: configuration set tags if we ever switch to per-IP-per-set.
    const sourceIp = event.mail?.sourceIp;
    if (!sourceIp) {
        logger.info('[SES_SNS] event missing sourceIp, recording orphan event', { kind });
        return res.status(200).send('orphan');
    }
    const ip = await prisma.dedicatedIp.findFirst({
        where: { ses_ip_address: sourceIp },
    });
    if (!ip) {
        logger.info('[SES_SNS] sourceIp does not match any tracked DedicatedIp', { sourceIp, kind });
        return res.status(200).send('unknown-ip');
    }

    // 4. Record forensic row (one per recipient on multi-recipient events).
    const recipients = collectRecipients(event, kind);
    const diagnostic = collectDiagnostic(event, kind);
    const eventsToCreate = (recipients.length > 0 ? recipients : [null]).map(rcp => ({
        dedicated_ip_id: ip.id,
        kind,
        recipient: rcp ?? null,
        ses_message_id: event.mail?.messageId ?? null,
        diagnostic,
        payload: event as never,
    }));
    if (eventsToCreate.length > 0) {
        await prisma.dedicatedIpEvent.createMany({ data: eventsToCreate });
    }

    // 5. Update 24h aggregates atomically. We use raw increments instead
    // of a recompute-from-events query because DedicatedIpEvent grows
    // unbounded and a SUM(...) per send isn't viable.
    const incrementField =
        kind === 'delivery' ? 'delivered_count_24h' :
        kind === 'complaint' ? 'complaint_count_24h' :
        (kind === 'bounce_permanent' || kind === 'bounce_transient') ? 'bounce_count_24h' :
        null;
    if (incrementField) {
        const incBy = Math.max(1, recipients.length);
        await prisma.dedicatedIp.update({
            where: { id: ip.id },
            data: { [incrementField]: { increment: incBy } },
        });
    }

    // 6. Pause check. Read the freshly-incremented row.
    if (kind !== 'delivery' && !ip.paused_reason) {
        const fresh = await prisma.dedicatedIp.findUnique({
            where: { id: ip.id },
            select: {
                id: true,
                bounce_count_24h: true,
                complaint_count_24h: true,
                delivered_count_24h: true,
                paused_reason: true,
            },
        });
        if (fresh && !fresh.paused_reason) {
            const total = fresh.bounce_count_24h + fresh.complaint_count_24h + fresh.delivered_count_24h;
            if (total >= MIN_VOLUME_FOR_PAUSE) {
                const bounceRate = fresh.bounce_count_24h / total;
                const complaintRate = fresh.complaint_count_24h / total;
                let pauseReason: string | null = null;
                if (complaintRate > COMPLAINT_PAUSE_THRESHOLD) pauseReason = 'auto_paused_complaint';
                else if (bounceRate > BOUNCE_PAUSE_THRESHOLD) pauseReason = 'auto_paused_bounce';
                if (pauseReason) {
                    const updateResult = await prisma.dedicatedIp.updateMany({
                        // Conditional-on-no-prior-pause to avoid clobbering a manual pause.
                        where: { id: ip.id, paused_reason: null },
                        data: { paused_reason: pauseReason, paused_at: new Date() },
                    });
                    logger.warn('[SES_SNS] DedicatedIp auto-paused', {
                        ipId: ip.id,
                        reason: pauseReason,
                        bounceRate,
                        complaintRate,
                        total,
                    });
                    // Super Protect audit SP2: pause of a paid IP is a
                    // consequential event the audit table needs to
                    // record. Only fire when the conditional update
                    // actually flipped the row (count === 1).
                    if (updateResult.count > 0) {
                        void recordSecurityEvent({
                            organizationId: ip.organization_id ?? null,
                            actorKind: 'system',
                            eventType: EVENT_TYPES.DEDICATED_IP_AUTO_PAUSED,
                            target: ip.id,
                            metadata: {
                                reason: pauseReason,
                                bounce_rate: Number(bounceRate.toFixed(6)),
                                complaint_rate: Number(complaintRate.toFixed(6)),
                                window_total: total,
                                ses_ip_address: ip.ses_ip_address ?? null,
                            },
                        });
                    }
                }
            }
        }
    }

    return res.status(200).send('ok');
};

function inferKind(event: SesNotification): string | null {
    const t = (event.notificationType || event.eventType || '').toLowerCase();
    if (t === 'delivery') return 'delivery';
    if (t === 'complaint') return 'complaint';
    if (t === 'reject') return 'reject';
    if (t === 'bounce') {
        const bt = (event.bounce?.bounceType || '').toLowerCase();
        return bt === 'transient' ? 'bounce_transient' : 'bounce_permanent';
    }
    return null;
}

function collectRecipients(event: SesNotification, kind: string): string[] {
    if (kind === 'delivery') return event.delivery?.recipients ?? [];
    if (kind === 'complaint') return (event.complaint?.complainedRecipients ?? [])
        .map(r => r.emailAddress).filter((e): e is string => Boolean(e));
    if (kind.startsWith('bounce')) return (event.bounce?.bouncedRecipients ?? [])
        .map(r => r.emailAddress).filter((e): e is string => Boolean(e));
    return [];
}

function collectDiagnostic(event: SesNotification, kind: string): string | null {
    if (kind.startsWith('bounce')) {
        const r = event.bounce?.bouncedRecipients?.[0];
        return r?.diagnosticCode ? r.diagnosticCode.slice(0, 1024) : null;
    }
    if (kind === 'complaint') {
        return event.complaint?.complaintFeedbackType?.slice(0, 256) ?? null;
    }
    return null;
}
