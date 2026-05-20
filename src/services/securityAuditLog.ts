/**
 * Security audit log writer - the ONE place every OAuth/MCP/public-API
 * security event is recorded to the durable SecurityAuditLog table.
 *
 * Pre-fix (API/MCP audit G6): there was no durable trail. logger.info /
 * logger.warn calls in oauthProvider, oauthConsentController, and the
 * MCP transport were the only record of consent approvals, token mints,
 * refreshes, revocations, code-reuse detections, and tool invocations.
 * Operational logs roll over; the security audit needs to outlive them.
 *
 * Design contract:
 *   - Writes are best-effort. The function logs and swallows errors; it
 *     NEVER throws back to the caller. A DB hiccup must not brick the
 *     OAuth or MCP flow being instrumented.
 *   - Event vocabulary lives in EVENT_TYPES so a typo at a call site
 *     is a TypeScript error, not a silent miscategorisation.
 *   - Metadata never carries raw tokens, raw payloads, or PII beyond
 *     what is already in the request log (client_id, tool name, scope
 *     strings). Tools that handle sensitive bodies pass `arg_keys`
 *     (the top-level keys) instead of the values.
 */

import type { Request } from 'express';
import { prisma } from '../prisma';
import { logger } from './observabilityService';

export const EVENT_TYPES = {
    OAUTH_CLIENT_REGISTERED: 'oauth.client.registered',
    OAUTH_CLIENT_REGISTRATION_REJECTED: 'oauth.client.registration_rejected',
    OAUTH_CONSENT_APPROVED: 'oauth.consent.approved',
    OAUTH_CONSENT_DENIED: 'oauth.consent.denied',
    OAUTH_TOKEN_MINTED: 'oauth.token.minted',
    OAUTH_TOKEN_REFRESHED: 'oauth.token.refreshed',
    OAUTH_TOKEN_REVOKED: 'oauth.token.revoked',
    OAUTH_CODE_REUSE_DETECTED: 'oauth.code.reuse_detected',
    MCP_TOOL_INVOKED: 'mcp.tool.invoked',
    MCP_TOOL_FAILED: 'mcp.tool.failed',
    // Notifications subsystem (audit N6)
    WEBHOOK_ENDPOINT_AUTO_DISABLED: 'webhook.endpoint.auto_disabled',
    WEBHOOK_DELIVERY_SSRF_BLOCKED: 'webhook.delivery.ssrf_blocked',
    SLACK_INTEGRATION_AUTH_ERROR: 'slack.integration.auth_error',
    SLACK_INTEGRATION_REVOKED: 'slack.integration.revoked',
    EMAIL_DELIVERY_FAILED: 'email.delivery.failed',
    // Super Protect subsystem (audit SP2 + SP3 + SP4)
    DEDICATED_IP_AUTO_PAUSED: 'dedicated_ip.auto_paused',
    SUPPRESSION_MODE_CHANGED: 'suppression.mode_changed',
    MAILBOX_PAUSED_BY_ASSESSMENT: 'mailbox.paused_by_assessment',
    CROSS_TENANT_MAILBOX_ACCESS_DENIED: 'mailbox.cross_tenant_access_denied',
    // Super Protect ROUND 3 - dashboard campaign pause/resume audit
    CROSS_TENANT_CAMPAIGN_ACCESS_DENIED: 'campaign.cross_tenant_access_denied',
    CAMPAIGN_MANUALLY_PAUSED: 'campaign.manually_paused',
    CAMPAIGN_MANUALLY_RESUMED: 'campaign.manually_resumed',
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
    /** When called from an Express handler, pass `req` so the writer can
     *  capture IP + UA without each call site spelling them out. */
    req?: Request;
}

/**
 * Write one row to SecurityAuditLog. Best-effort - errors are logged
 * but never thrown back. Returns void; callers should not await on
 * the result for correctness (only for ordering in tests).
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
        // Best-effort: log loudly but never throw. The OAuth/MCP flow
        // this instruments must complete even when the audit table is
        // momentarily unavailable.
        logger.error('[SECURITY_AUDIT] Failed to write event (non-fatal)',
            err instanceof Error ? err : new Error(String(err)));
    }
}

function extractIp(req: Request): string | undefined {
    // Trust whatever the Express trust-proxy layer resolved; fall back
    // to the raw socket. Truncated to keep abusive UAs from filling
    // the column.
    const ip = req.ip || (req.socket as any)?.remoteAddress || undefined;
    return ip ? String(ip).slice(0, 64) : undefined;
}

function extractUserAgent(req: Request): string | undefined {
    const ua = req.headers['user-agent'];
    if (!ua) return undefined;
    return String(ua).slice(0, 512);
}
