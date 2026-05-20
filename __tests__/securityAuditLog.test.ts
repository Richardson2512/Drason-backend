/**
 * Security audit log writer tests.
 *
 * The contract this freezes (API/MCP audit G6 root-cause fix):
 *   - Writes are best-effort: a DB hiccup must NEVER throw back to
 *     the OAuth/MCP flow that called the writer. This is the load-
 *     bearing property - a regression where the writer starts
 *     bubbling errors would brick the entire OAuth surface.
 *   - The EVENT_TYPES vocabulary is the authoritative list. Adding
 *     a new event type requires updating it (which this test will
 *     remind you of by failing the import).
 */

import { recordSecurityEvent, EVENT_TYPES } from '../src/services/securityAuditLog';

jest.mock('../src/prisma', () => ({
    prisma: {
        securityAuditLog: {
            create: jest.fn(),
        },
    },
}));

const { prisma } = require('../src/prisma');

describe('recordSecurityEvent', () => {
    beforeEach(() => {
        (prisma.securityAuditLog.create as jest.Mock).mockReset();
    });

    it('writes a row with the supplied fields', async () => {
        (prisma.securityAuditLog.create as jest.Mock).mockResolvedValue({});
        await recordSecurityEvent({
            organizationId: 'org_1',
            actorKind: 'oauth_client',
            actorId: 'mcp_client_abc',
            eventType: EVENT_TYPES.OAUTH_TOKEN_MINTED,
            target: 'token_prefix',
            metadata: { scope: 'leads:read' },
        });
        expect(prisma.securityAuditLog.create).toHaveBeenCalledTimes(1);
        const call = (prisma.securityAuditLog.create as jest.Mock).mock.calls[0][0];
        expect(call.data.organization_id).toBe('org_1');
        expect(call.data.actor_kind).toBe('oauth_client');
        expect(call.data.event_type).toBe('oauth.token.minted');
        expect(call.data.target).toBe('token_prefix');
        expect(call.data.metadata).toEqual({ scope: 'leads:read' });
    });

    it('does NOT throw when the DB write fails - best-effort contract', async () => {
        (prisma.securityAuditLog.create as jest.Mock).mockRejectedValue(new Error('db down'));
        await expect(recordSecurityEvent({
            actorKind: 'system',
            eventType: EVENT_TYPES.OAUTH_CLIENT_REGISTRATION_REJECTED,
        })).resolves.toBeUndefined();
    });

    it('accepts a missing organizationId for pre-auth events (DCR /register)', async () => {
        (prisma.securityAuditLog.create as jest.Mock).mockResolvedValue({});
        await recordSecurityEvent({
            actorKind: 'system',
            eventType: EVENT_TYPES.OAUTH_CLIENT_REGISTRATION_REJECTED,
        });
        const call = (prisma.securityAuditLog.create as jest.Mock).mock.calls[0][0];
        expect(call.data.organization_id).toBeNull();
    });

    it('EVENT_TYPES vocabulary covers every audited touchpoint across OAuth/MCP + Notifications + Super Protect', () => {
        // If this list changes, every call site needs an audit. Reviewer
        // gate - do not relax this without intent. Currently spans the
        // OAuth/MCP subsystem (API/MCP audit G6), the Notifications
        // subsystem (Notifications audit N6), and the Super Protect
        // subsystem (audit SP2/SP3/SP4/SP1).
        expect(Object.values(EVENT_TYPES).sort()).toEqual([
            'dedicated_ip.auto_paused',
            'email.delivery.failed',
            'mailbox.cross_tenant_access_denied',
            'mailbox.paused_by_assessment',
            'mcp.tool.failed',
            'mcp.tool.invoked',
            'oauth.client.registered',
            'oauth.client.registration_rejected',
            'oauth.code.reuse_detected',
            'oauth.consent.approved',
            'oauth.consent.denied',
            'oauth.token.minted',
            'oauth.token.refreshed',
            'oauth.token.revoked',
            'slack.integration.auth_error',
            'slack.integration.revoked',
            'suppression.mode_changed',
            'webhook.delivery.ssrf_blocked',
            'webhook.endpoint.auto_disabled',
        ]);
    });
});
