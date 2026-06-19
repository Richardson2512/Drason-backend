/**
 * Per-org rate limiter (Redis-backed) behavior contract. The load-bearing
 * properties: it FAILS OPEN (no org / no Redis / Redis error -> pass through,
 * never block legit traffic), and it returns 429 + Retry-After once the org's
 * window budget is exceeded.
 */

jest.mock('../src/utils/redis', () => ({ getRedisClient: jest.fn() }));
jest.mock('../src/services/observabilityService', () => ({ logger: { debug: jest.fn() } }));

import { getRedisClient } from '../src/utils/redis';
import { rateLimitPerOrg } from '../src/middleware/rateLimitPerOrg';

const getRedisMock = getRedisClient as jest.Mock;

function harness(orgId?: string) {
    const req: any = { orgContext: orgId ? { organizationId: orgId } : undefined };
    const res: any = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: null as any,
        setHeader(k: string, v: string) { this.headers[k] = v; },
        status(c: number) { this.statusCode = c; return this; },
        json(b: any) { this.body = b; return this; },
    };
    const next = jest.fn();
    return { req, res, next };
}

const mw = rateLimitPerOrg({ maxPerWindow: 5, windowMs: 60_000, bucketKey: 'test' });

describe('rateLimitPerOrg (fail-open Redis limiter)', () => {
    beforeEach(() => getRedisMock.mockReset());

    it('passes through when there is no org context (nothing to key on)', async () => {
        const { req, res, next } = harness(undefined);
        await mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(getRedisMock).not.toHaveBeenCalled();
    });

    it('fails open when Redis is not configured', async () => {
        getRedisMock.mockReturnValue(null);
        const { req, res, next } = harness('org-1');
        await mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(0);
    });

    it('passes through under the limit', async () => {
        getRedisMock.mockReturnValue({ eval: jest.fn().mockResolvedValue(3) });
        const { req, res, next } = harness('org-1');
        await mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(0);
    });

    it('returns 429 + Retry-After once over the limit', async () => {
        getRedisMock.mockReturnValue({ eval: jest.fn().mockResolvedValue(6) });
        const { req, res, next } = harness('org-1');
        await mw(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(429);
        expect(res.body.success).toBe(false);
        expect(Number(res.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
        expect(res.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    });

    it('fails open when the Redis call throws', async () => {
        getRedisMock.mockReturnValue({ eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
        const { req, res, next } = harness('org-1');
        await mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(0);
    });

    it('allows exactly up to the limit (boundary)', async () => {
        getRedisMock.mockReturnValue({ eval: jest.fn().mockResolvedValue(5) });
        const { req, res, next } = harness('org-1');
        await mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1); // 5 == maxPerWindow, still allowed
    });
});
