/**
 * OAuth authorization-code reuse detection (RFC 6749 section 10.5 / audit G4).
 * A code is single-use; if it is presented twice, the second presentation is a
 * theft signal. The defining behavior: on reuse we REVOKE every access token
 * minted from that code (so a replayer can't keep a live session) and reject
 * the exchange. Fresh codes mint a token tagged with source_auth_code_hash so
 * the revoke can find them. The MCP OAuth HTTP flow is HTTPS-only and can't be
 * booted in dev, so this exercises the provider methods directly with a mocked
 * prisma. (The SDK imports in the provider are `import type`, so nothing from
 * @modelcontextprotocol loads at runtime here.)
 */

jest.mock('../src/index', () => ({
    prisma: {
        oAuthAuthorizationCode: { findUnique: jest.fn(), update: jest.fn() },
        oAuthAccessToken: { create: jest.fn(), updateMany: jest.fn() },
        securityAuditLog: { create: jest.fn().mockResolvedValue({}) },
    },
}));
jest.mock('../src/services/observabilityService', () => ({
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { prisma } from '../src/index';
import { oauthProvider } from '../src/mcp/oauthProvider';

const p: any = prisma;

describe('OAuth auth-code reuse detection (G4)', () => {
    beforeEach(() => {
        p.oAuthAuthorizationCode.findUnique.mockReset();
        p.oAuthAuthorizationCode.update.mockReset().mockResolvedValue({});
        p.oAuthAccessToken.create.mockReset().mockResolvedValue({});
        p.oAuthAccessToken.updateMany.mockReset().mockResolvedValue({ count: 0 });
    });

    it('revokeTokensMintedFromCode revokes only the un-revoked tokens for that code', async () => {
        p.oAuthAccessToken.updateMany.mockResolvedValue({ count: 2 });
        await oauthProvider.revokeTokensMintedFromCode('codehash-1');
        expect(p.oAuthAccessToken.updateMany).toHaveBeenCalledTimes(1);
        const arg = p.oAuthAccessToken.updateMany.mock.calls[0][0];
        expect(arg.where).toEqual({ source_auth_code_hash: 'codehash-1', revoked_at: null });
        expect(arg.data.revoked_at).toBeInstanceOf(Date);
    });

    it('on a REUSED code: revokes minted tokens AND rejects the exchange', async () => {
        p.oAuthAuthorizationCode.findUnique.mockResolvedValue({
            used_at: new Date(),                       // already exchanged -> reuse
            expires_at: new Date(Date.now() + 60_000),
            client_id: 'client-1',
            organization_id: 'org-1',
            user_id: 'user-1',
            scope: 'mcp',
        });

        await expect(
            oauthProvider.exchangeAuthorizationCode({ client_id: 'client-1' } as any, 'plaintext-code'),
        ).rejects.toThrow(/already used/);

        expect(p.oAuthAccessToken.updateMany).toHaveBeenCalledTimes(1); // tokens revoked
        expect(p.oAuthAccessToken.create).not.toHaveBeenCalled();       // nothing minted
    });

    it('a FRESH code mints a token tagged with its source_auth_code_hash', async () => {
        p.oAuthAuthorizationCode.findUnique.mockResolvedValue({
            used_at: null,
            expires_at: new Date(Date.now() + 60_000),
            client_id: 'client-1',
            organization_id: 'org-1',
            user_id: 'user-1',
            scope: 'mcp',
            resource: null,
        });

        await oauthProvider.exchangeAuthorizationCode({ client_id: 'client-1' } as any, 'plaintext-code');

        expect(p.oAuthAccessToken.create).toHaveBeenCalledTimes(1);
        const data = p.oAuthAccessToken.create.mock.calls[0][0].data;
        expect(typeof data.source_auth_code_hash).toBe('string');
        expect(data.source_auth_code_hash.length).toBeGreaterThan(0);
        expect(p.oAuthAccessToken.updateMany).not.toHaveBeenCalled(); // no reuse path
    });
});
