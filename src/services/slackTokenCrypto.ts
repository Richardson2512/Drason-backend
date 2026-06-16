/**
 * Legacy Slack bot-token decryption - read-only backward compatibility.
 *
 * Slack bot tokens used to be encrypted with a bespoke AES-256-GCM routine
 * whose key was `SLACK_SIGNING_SECRET || JWT_SECRET || <hardcoded dev string>`
 * padded to 32 bytes, producing a 3-part `iv:authTag:encrypted` blob. That was
 * replaced by the canonical utils/encryption helper (scrypt key from
 * ENCRYPTION_KEY, random salt, 4-part blob).
 *
 * This module is the SINGLE source of truth for decrypting tokens written by
 * the old routine, so slackController and SlackAlertService share one
 * implementation instead of duplicating it. Decryption only - there is no
 * legacy encrypt; all new writes go through utils/encryption. Callers try the
 * canonical decrypt first and fall back to this on failure; once a connection
 * is re-saved it is stored canonically and never reaches this path again.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function legacyKey(): Buffer {
    const raw = (process.env.SLACK_SIGNING_SECRET || process.env.JWT_SECRET || 'fallback-secret-for-dev-only--')
        .padEnd(32, '0')
        .substring(0, 32);
    return Buffer.from(raw);
}

/**
 * Decrypt a legacy 3-part Slack token blob (iv:authTag:encrypted, hex).
 * Throws if the input is not a valid legacy blob or the key/tag don't match.
 */
export function legacyDecryptSlackToken(encryptedData: string): string {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
        throw new Error('Not a legacy Slack token blob');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, legacyKey(), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
