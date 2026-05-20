/**
 * Slack bot-token encryption helper - the ONE place every Slack-token
 * write/read in the backend goes for AES-256-GCM at rest.
 *
 * Pre-fix (Notifications audit N2, HIGH): both `controllers/slackController.ts`
 * and `services/SlackAlertService.ts` reimplemented AES-GCM locally with:
 *   - a literal `'fallback-secret-for-dev-only--'` string when env was
 *     unset (anyone who knew the fallback could decrypt prod tokens);
 *   - `padEnd('0').substring(0, 32)` as the "KDF" - if the env secret
 *     was 24 chars (Slack signing secrets are 32 hex chars by spec but
 *     env vars get truncated / typo'd), 8 bytes of the AES key were
 *     deterministic zero bytes.
 * Same class of bug as API/MCP G3 (parallel JWT_SECRET resolvers) -
 * collapse to the existing platform-wide AES-256-GCM module.
 *
 * Post-fix:
 *   - `encryptSlackToken(plain)`  → writes v2 format via utils/encryption.ts
 *     (scrypt KDF, per-operation random salt, requires ENCRYPTION_KEY).
 *   - `decryptSlackToken(enc)`    → tries v2 first; on failure, tries the
 *     LEGACY `padEnd` format so rows written before this fix still decrypt.
 *     Legacy success is logged loud so ops can run a one-time re-encrypt
 *     pass; the row is NOT silently re-encrypted here because that would
 *     require write access from every reader, including read-only paths.
 *
 * A small `reencryptIfLegacy(orgId, enc)` helper IS provided for the
 * write paths (OAuth callback, alert dispatch) so legacy rows
 * opportunistically migrate to v2 the next time they're decrypted by
 * a caller that already owns a write transaction.
 */

import crypto from 'crypto';
import { encrypt, decrypt } from './encryption';
import { logger } from '../services/observabilityService';
import { prisma } from '../prisma';

/** Encrypt a Slack bot token for storage. v2 format, single source of truth. */
export function encryptSlackToken(plaintext: string): string {
    return encrypt(plaintext);
}

/**
 * Decrypt a Slack bot token. Returns the plaintext AND a flag telling
 * the caller whether the row is still in the legacy format so it can
 * trigger a re-encrypt-in-place.
 */
export function decryptSlackToken(encrypted: string): { plaintext: string; legacy: boolean } {
    // Try v2 (utils/encryption.ts) first. v1/v2 of that module both
    // throw on authTag mismatch, which is exactly what we want here -
    // a legacy-format blob will fail authTag check because the key is
    // different.
    try {
        const plain = decrypt(encrypted);
        return { plaintext: plain, legacy: false };
    } catch (v2Err) {
        // Fall through to the legacy path.
        try {
            const plain = decryptLegacySlackToken(encrypted);
            logger.warn('[SLACK_TOKEN] Decrypted a legacy-format token - schedule re-encrypt', {
                err_v2: v2Err instanceof Error ? v2Err.message : String(v2Err),
            });
            return { plaintext: plain, legacy: true };
        } catch (legacyErr) {
            throw new Error(
                `Slack token decryption failed in both v2 and legacy paths: ${legacyErr instanceof Error ? legacyErr.message : String(legacyErr)}`
            );
        }
    }
}

/**
 * Legacy decrypt - mirrors the broken implementation that lived in
 * slackController + SlackAlertService before this fix, EXACTLY so that
 * rows written by the old code can still be read. New rows never use
 * this path. Kept until ops confirms zero legacy rows remain (a one-
 * time sweep over SlackIntegration can re-encrypt all current rows in
 * a single transaction; until then this stays as the fallback).
 */
function decryptLegacySlackToken(encryptedData: string): string {
    const algorithm = 'aes-256-gcm';
    // No literal-string fallback here - if env is unset in production
    // we'd rather fail loudly than silently use a known string. dev
    // still gets a non-prod fallback to match the legacy behaviour the
    // existing rows were encrypted with.
    let envSecret = process.env.SLACK_SIGNING_SECRET || process.env.JWT_SECRET;
    if (!envSecret) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('legacy Slack-token decrypt requires SLACK_SIGNING_SECRET or JWT_SECRET');
        }
        envSecret = 'drason_dev_only_secret_DO_NOT_USE_IN_PROD';
    }
    const key = envSecret.padEnd(32, '0').substring(0, 32);

    const parts = encryptedData.split(':');
    if (parts.length !== 3) throw new Error('legacy Slack-token: expected iv:authTag:enc');

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(parts[2], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * Opportunistic legacy-to-v2 migration. Called by paths that already
 * own a write to SlackIntegration (OAuth callback, alert dispatch).
 * Best-effort - errors are logged and swallowed so a transient DB
 * issue can't break the OAuth or alert flow that depends on this.
 */
export async function reencryptSlackTokenIfLegacy(
    organizationId: string,
    decryptResult: { plaintext: string; legacy: boolean }
): Promise<void> {
    if (!decryptResult.legacy) return;
    try {
        const fresh = encryptSlackToken(decryptResult.plaintext);
        await prisma.slackIntegration.update({
            where: { organization_id: organizationId },
            data: { bot_token_encrypted: fresh },
        });
        logger.info('[SLACK_TOKEN] Re-encrypted legacy token to v2', { organizationId });
    } catch (err) {
        logger.warn('[SLACK_TOKEN] Best-effort re-encrypt failed (non-fatal)', {
            organizationId,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}
