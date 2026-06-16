/**
 * Locks the JWT-secret resolution contract after collapsing ~5 per-file
 * resolvers into one. The security point: in production a missing JWT_SECRET
 * must be FATAL (previously oauthProvider / slackController silently fell back
 * to a hardcoded 'dev-secret-change-me', letting anyone forge OAuth-state /
 * consent JWTs against a misconfigured prod instance).
 */

jest.mock('../src/services/observabilityService', () => ({ logger: { warn: jest.fn() } }));

import { resolveJwtSecret, DEV_FALLBACK_SECRET } from '../src/utils/jwtSecret';

describe('resolveJwtSecret', () => {
    it('returns the configured secret when JWT_SECRET is set', () => {
        expect(resolveJwtSecret({ JWT_SECRET: 'real-secret', NODE_ENV: 'production' } as any)).toBe('real-secret');
    });

    it('is FATAL in production when JWT_SECRET is missing', () => {
        expect(() => resolveJwtSecret({ NODE_ENV: 'production' } as any))
            .toThrow(/JWT_SECRET is not set in production/);
    });

    it('falls back to the dev-only constant in non-production when missing', () => {
        expect(resolveJwtSecret({ NODE_ENV: 'development' } as any)).toBe(DEV_FALLBACK_SECRET);
        expect(resolveJwtSecret({} as any)).toBe(DEV_FALLBACK_SECRET);
    });
});
