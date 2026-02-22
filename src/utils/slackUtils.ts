import crypto from 'crypto';

/**
 * Verifies a webhook or command request from Slack using the signing secret.
 */
export function verifySlackSignature(
    signature: string | string[] | undefined,
    timestamp: string | string[] | undefined,
    rawBody: string | Buffer | undefined,
    signingSecret: string
): boolean {
    if (!signature || !timestamp || !rawBody || !signingSecret) {
        return false;
    }

    // Prevent replay attacks (e.g. older than 5 minutes)
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);
    if (parseInt(timestamp as string, 10) < fiveMinutesAgo) {
        return false;
    }

    const sigBasestring = `v0:${timestamp}:${rawBody}`;
    const mySignature = 'v0=' + crypto
        .createHmac('sha256', signingSecret)
        .update(sigBasestring, 'utf8')
        .digest('hex');

    const expectedSig = Buffer.from(signature as string, 'utf8');
    const actualSig = Buffer.from(mySignature, 'utf8');

    if (expectedSig.length !== actualSig.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedSig, actualSig);
}
