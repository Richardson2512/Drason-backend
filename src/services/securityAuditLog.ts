/**
 * Security audit log writer - the ONE place OAuth/MCP security events are
 * recorded to the durable SecurityAuditLog table (API/MCP audit G6).
 *
 * Before this, the only record of client registrations, token mints,
 * revocations and auth-code-reuse detections was logger.info / logger.warn,
 * which roll over. The security audit needs to outlive operational logs.
 *
 * Design contract:
 *   - Writes are BEST-EFFORT: the function logs and swallows errors, NEVER
 *     throws back to the caller. A DB hiccup must not brick the OAuth flow it
 *     instruments.
 *   - Event vocabulary lives in EVENT_TYPES so a typo at a call site is a
 *     TypeScript error, not a silent miscategorisation.
 *   - Metadata never carries raw tokens, raw payloads, or PII beyond what is
 *     already in the request log (client_id, scope strings, token id prefix).
 */

import type { Request } from 'express';
import { prisma } from '../index';
import { logger } from './observabilityService';

export const EVENT_TYPES = {
    OAUTH_CLIENT_REGISTERED: 'oauth.client.registered',
    OAUTH_CLIENT_REGISTRATION_REJECTED: 'oauth.client.registration_rejected',
    OAUTH_TOKEN_MINTED: 'oauth.token.minted',
    OAUTH_TOKEN_REVOKED: 'oauth.token.revoked',
    OAUTH_CODE_REUSE_DETECTED: 'oauth.code.reuse_detected',
} as const;
export type SecurityEventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

export type ActorKind = 'oauth_client' | 'user' | 'api_key' | 'system';

export interface RecordSecurityEventOpts {
    organizationId?: string | null;
    actorKind: ActorKind;
    actorId?: string | null;
    eventType: SecurityEventType;
    target?: string | null;
    metadata?: Record<string, unknown>;
    /** When called from an Express handler, pass `req` to capture IP + UA. */
    req?: Request;
}

/**
 * Write one row to SecurityAuditLog. Best-effort - errors are logged but never
 * thrown back. Callers need not await for correctness (only for test ordering).
 */
export async function recordSecurityEvent(opts: RecordSecurityEventOpts): Promise<void> {
    try {
        const ip = opts.req ? extractIp(opts.req) : undefined;
        const userAgent = opts.req ? extractUserAgent(opts.req) : undefined;

        await prisma.securityAuditLog.create({
            data: {
                organization_id: opts.organizationId ?? null,
                actor_kind: opts.actorKind,
                actor_id: opts.actorId ?? null,
                event_type: opts.eventType,
                target: opts.target ?? null,
                metadata: (opts.metadata ?? null) as any,
                ip: ip ?? null,
                user_agent: userAgent ?? null,
            },
        });
    } catch (err) {
        // Best-effort: log loudly but never throw. The flow this instruments
        // must complete even when the audit table is momentarily unavailable.
        logger.error('[SECURITY_AUDIT] Failed to write event (non-fatal)',
            err instanceof Error ? err : new Error(String(err)));
    }
}

function extractIp(req: Request): string | undefined {
    const ip = req.ip || (req.socket as any)?.remoteAddress || undefined;
    return ip ? String(ip).slice(0, 64) : undefined;
}

function extractUserAgent(req: Request): string | undefined {
    const ua = req.headers['user-agent'];
    if (!ua) return undefined;
    return String(ua).slice(0, 512);
}
