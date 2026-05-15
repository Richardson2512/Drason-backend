/**
 * SES sender - outbound transport for Super Sender dedicated IPs.
 *
 * The mailbox's stored credentials (SMTP host/port/user/pass for relay
 * providers like Zapmail / Mission Inbox / Scaledmail) are NOT used here.
 * Instead, we send through AWS SES with a `ConfigurationSet` that pins
 * the route to the workspace's dedicated IP pool (`ses_pool_name`).
 *
 * MIME composition reuses nodemailer's MailComposer to keep the wire
 * format identical to sendViaSMTP - recipients see a byte-for-byte
 * indistinguishable message regardless of which transport produced it.
 *
 * STUB FALLBACK: Mirrors sesProvisioningService - when AWS creds aren't
 * configured the sender returns a synthetic success with a fake message
 * id. Lets dev/staging exercise the routing path without wiring AWS.
 */

import MailComposer from 'nodemailer/lib/mail-composer';
import { logger } from './observabilityService';
import type { SendResult } from './emailSendAdapters';

export interface SesSendInput {
    poolName: string;
    fromEmail: string;
    fromName?: string | null;
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    /** Custom message-level headers (List-Unsubscribe, etc.). nodemailer
     *  passes these through to the assembled MIME. */
    headers?: Record<string, string>;
}

function isSesConfigured(): boolean {
    return Boolean(
        process.env.AWS_ACCESS_KEY_ID &&
        process.env.AWS_SECRET_ACCESS_KEY &&
        process.env.AWS_REGION &&
        process.env.SES_CONFIGURATION_SET,
    );
}

async function loadClient(): Promise<{
    sendRaw: (rawMime: Buffer, configSet: string, fromEmail: string) => Promise<string>;
}> {
    // Same indirect-import trick used in sesProvisioningService - keeps TS
    // from trying to resolve @aws-sdk/client-sesv2 in dev/staging where
    // the package isn't installed.
    const dynamicImport: (m: string) => Promise<any> = (m) =>
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        new Function('m', 'return import(m)')(m);
    const sdk: any = await dynamicImport('@aws-sdk/client-sesv2');

    const client = new sdk.SESv2Client({
        region: process.env.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
    });

    return {
        async sendRaw(rawMime: Buffer, configSet: string, fromEmail: string): Promise<string> {
            // SendEmailCommand with `Raw.Data` lets us pass the full MIME
            // built by nodemailer - preserving signed DKIM headers if the
            // mailbox's domain key was already applied upstream.
            const cmd = new sdk.SendEmailCommand({
                ConfigurationSetName: configSet,
                FromEmailAddress: fromEmail,
                Content: { Raw: { Data: rawMime } },
            });
            const res = await client.send(cmd);
            // SES returns MessageId as base64-encoded string of the form
            // "0103019....@us-east-1.amazonses.com".
            return res.MessageId || '';
        },
    };
}

async function buildMime(input: SesSendInput): Promise<Buffer> {
    const composer = new MailComposer({
        from: input.fromName ? `${input.fromName} <${input.fromEmail}>` : input.fromEmail,
        to: input.to,
        subject: input.subject,
        html: input.bodyHtml,
        text: input.bodyText,
        headers: input.headers,
    });
    return new Promise((resolve, reject) => {
        composer.compile().build((err, msg) => {
            if (err) reject(err);
            else resolve(msg);
        });
    });
}

export async function sendViaSes(input: SesSendInput): Promise<SendResult> {
    try {
        const mime = await buildMime(input);

        if (!isSesConfigured()) {
            // Stub mode - no real send. Generate a deterministic-ish id so
            // the logs show "we'd have routed this through SES with pool X".
            const stubId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            logger.info('[SES_SEND] Stub mode - would have sent via SES', {
                poolName: input.poolName,
                to: input.to,
                stubId,
                bytes: mime.length,
            });
            return { success: true, messageId: `<${stubId}@stub.amazonses.com>` };
        }

        const client = await loadClient();
        const configSet = process.env.SES_CONFIGURATION_SET!;
        const messageId = await client.sendRaw(mime, configSet, input.fromEmail);
        logger.info('[SES_SEND] Sent', {
            poolName: input.poolName,
            to: input.to,
            messageId,
        });
        return { success: true, messageId };
    } catch (err: unknown) {
        const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
        logger.error('[SES_SEND] Failed',
            err instanceof Error ? err : new Error(String(err)),
            { poolName: input.poolName, to: input.to });
        return {
            success: false,
            error: e?.message || 'SES send failed',
            smtpCode: e?.$metadata?.httpStatusCode != null ? String(e.$metadata.httpStatusCode) : undefined,
            smtpResponse: (e?.message || '').slice(0, 1024),
        };
    }
}
