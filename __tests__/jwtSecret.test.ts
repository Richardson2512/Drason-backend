/**
 * JWT secret resolver tests - the contract every JWT issuer/verifier
 * in the backend relies on. A regression here is a security regression
 * (G3 root cause: a misconfigured production instance silently signing
 * with a well-known dev string).
 *
 * Tests target the pure resolver function (not the module-load value)
 * so dotenv's re-population of process.env on jest.resetModules can't
 * mask the behaviour we're checking.
 */

import { resolveJwtSecret, DEV_FALLBACK_SECRET } from '../src/utils/jwtSecret';

describe('resolveJwtSecret', () => {
    it('returns the supplied secret when set (any NODE_ENV)', () => {
        expect(resolveJwtSecret({ JWT_SECRET: 'real-prod-secret', NODE_ENV: 'production' } as any))
            .toBe('real-prod-secret');
        expect(resolveJwtSecret({ JWT_SECRET: 'dev-set', NODE_ENV: 'development' } as any))
            .toBe('dev-set');
    });

    it('THROWS when JWT_SECRET is missing in production', () => {
        expect(() => resolveJwtSecret({ NODE_ENV: 'production' } as any))
            .toThrow(/JWT_SECRET is not set in production/);
    });

    it('THROWS when JWT_SECRET is an empty string in production (falsy guard)', () => {
        expect(() => resolveJwtSecret({ JWT_SECRET: '', NODE_ENV: 'production' } as any))
            .toThrow(/JWT_SECRET is not set in production/);
    });

    it('falls back to the dev-only constant in non-production', () => {
        expect(resolveJwtSecret({ NODE_ENV: 'development' } as any)).toBe(DEV_FALLBACK_SECRET);
        expect(resolveJwtSecret({ NODE_ENV: 'test' } as any)).toBe(DEV_FALLBACK_SECRET);
    });

    it('the dev fallback is NEVER the hardcoded string the MCP/CRM oauthServices used to leak', () => {
        // The old leak was 'dev-secret-change-me'. Even the dev fallback
        // must not collide with it - if a future caller resolves its own
        // secret independently, this string is the canary.
        expect(DEV_FALLBACK_SECRET).not.toBe('dev-secret-change-me');
    });
});
