/**
 * SecurityAuditLog writer contract (G6). The load-bearing properties: it
 * persists the event with the right shape, and it is BEST-EFFORT - a DB write
 * failure is swallowed (logged, never thrown) so it can never brick the OAuth
 * flow it instruments.
 */

jest.mock('../src/index', () => ({ prisma: { securityAuditLog: { create: jest.fn() } } }));
jest.mock('../src/services/observabilityService', () => ({ logger: { error: jest.fn() } }));

import { prisma } from '../src/index';
import { recordSecurityEvent, EVENT_TYPES } from '../src/services/securityAuditLog';

const create = (prisma as any).securityAuditLog.create as jest.Mock;

describe('recordSecurityEvent', () => {
    beforeEach(() => create.mockReset().mockResolvedValue({}));

    it('writes a row with the given fields', async () => {
        await recordSecurityEvent({
            organizationId: 'org-1',
            actorKind: 'oauth_client',
            actorId: 'client-1',
            eventType: EVENT_TYPES.OAUTH_TOKEN_MINTED,
            target: 'client-1',
            metadata: { scope: 'mcp' },
        });
        expect(create).toHaveBeenCalledTimes(1);
        const data = create.mock.calls[0][0].data;
        expect(data.organization_id).toBe('org-1');
        expect(data.actor_kind).toBe('oauth_client');
        expect(data.event_type).toBe('oauth.token.minted');
        expect(data.metadata).toEqual({ scope: 'mcp' });
    });

    it('never throws when the DB write fails (best-effort)', async () => {
        create.mockRejectedValue(new Error('db down'));
        await expect(
            recordSecurityEvent({ actorKind: 'system', eventType: EVENT_TYPES.OAUTH_CODE_REUSE_DETECTED }),
        ).resolves.toBeUndefined();
    });

    it('captures ip and a truncated user-agent from req when provided', async () => {
        const req: any = { ip: '1.2.3.4', headers: { 'user-agent': 'x'.repeat(1000) }, socket: {} };
        await recordSecurityEvent({
            actorKind: 'user',
            eventType: EVENT_TYPES.OAUTH_CLIENT_REGISTERED,
            req,
        });
        const data = create.mock.calls[0][0].data;
        expect(data.ip).toBe('1.2.3.4');
        expect(data.user_agent.length).toBe(512); // truncated from 1000
    });

    it('defaults optional fields to null', async () => {
        await recordSecurityEvent({ actorKind: 'system', eventType: EVENT_TYPES.OAUTH_TOKEN_REVOKED });
        const data = create.mock.calls[0][0].data;
        expect(data.organization_id).toBeNull();
        expect(data.actor_id).toBeNull();
        expect(data.target).toBeNull();
        expect(data.ip).toBeNull();
    });
});
