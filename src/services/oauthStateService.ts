/**
 * OAuth `state` nonce service - DB-backed, single-use, TTL-bound.
 *
 * Replaces the per-flow ad-hoc state handling that the OAuth audit flagged
 * as CSRF-vulnerable in three places:
 *   - Postmaster (state was just the orgId - guessable)
 *   - Sequencer Gmail (state was structurally validated only)
 *   - User-login (state was in-memory Map - lost on restart, broken under
 *     horizontal scale)
 *
 * Security properties:
 *   - 256-bit cryptographic nonce, hex-encoded.
 *   - One row per /authorize click; deleted on first read (replay-protected).
 *   - `purpose` discriminator prevents code-from-flow-A being redeemed in
 *     flow-B even if an attacker captures both states.
 *   - Expired rows are deleted on every consume() call (lazy cleanup) so
 *     the table stays small without needing a worker.
 *
 * TTL is short by design: the user has to complete Google's consent screen
 * within this window. Anything longer is unnecessary and widens the
 * replay window.
 */

import crypto from 'crypto';
import { prisma } from '../index';
import { logger } from './observabilityService';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type OAuthPurpose =
    | 'postmaster_oauth'
    | 'sequencer_google_oauth'
    | 'user_login_oauth';

interface CreateArgs {
    purpose: OAuthPurpose;
    organizationId?: string | null;
    metadata?: Record<string, any>;
    ttlMs?: number;
}

interface ConsumeResult {
    organizationId: string | null;
    metadata: Record<string, any>;
}

/**
 * Mint a new state nonce. Returns the opaque hex string to send to Google.
 * Caller must persist nothing else - the row carries all context.
 */
export async function createState(args: CreateArgs): Promise<string> {
    const state = crypto.randomBytes(32).toString('hex');
    const ttl = args.ttlMs ?? DEFAULT_TTL_MS;
    await prisma.oAuthState.create({
        data: {
            state,
            purpose: args.purpose,
            organization_id: args.organizationId ?? null,
            metadata: (args.metadata ?? {}) as any,
            expires_at: new Date(Date.now() + ttl),
        },
    });
    return state;
}

/**
 * Consume a state nonce. Returns the original organizationId/metadata if the
 * nonce exists, hasn't expired, and was minted for the expected purpose.
 * Returns null on any failure - caller MUST treat that as a CSRF rejection.
 *
 * Single-use: the row is deleted before this returns, regardless of outcome.
 * Lazy sweep: also drops any other expired rows so the table stays small.
 */
export async function consumeState(
    state: string,
    expectedPurpose: OAuthPurpose,
): Promise<ConsumeResult | null> {
    if (!state || typeof state !== 'string') return null;
    // Reject anything that doesn't smell like our 64-char hex nonce - short-
    // circuits before hitting the DB on obviously-malformed inputs.
    if (!/^[a-f0-9]{64}$/i.test(state)) return null;

    try {
        // Lazy cleanup of expired rows - cheap, indexed.
        await prisma.oAuthState.deleteMany({
            where: { expires_at: { lt: new Date() } },
        });

        const row = await prisma.oAuthState.findUnique({ where: { state } });
        if (!row) return null;

        // Always delete first, even on validation failure, so a wrong-purpose
        // attempt can't be retried with the right purpose later.
        await prisma.oAuthState.delete({ where: { state } }).catch(() => undefined);

        if (row.expires_at.getTime() < Date.now()) {
            logger.warn('[OAUTH_STATE] expired state presented', { purpose: expectedPurpose });
            return null;
        }
        if (row.purpose !== expectedPurpose) {
            logger.warn('[OAUTH_STATE] purpose mismatch', {
                expected: expectedPurpose,
                actual: row.purpose,
            });
            return null;
        }
        return {
            organizationId: row.organization_id,
            metadata: (row.metadata as Record<string, any>) ?? {},
        };
    } catch (err) {
        logger.error('[OAUTH_STATE] consumeState failed', err instanceof Error ? err : new Error(String(err)));
        return null;
    }
}
