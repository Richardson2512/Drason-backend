/**
 * Locks the validation-credit accounting contract after consolidating onto a
 * single ledger (ValidationAttempt). The bug this guards against: two paths
 * counting two different tables (validationBatchLead vs validationAttempt) so
 * a CSV batch could overspend the monthly plan cap the single/by-tag paths
 * enforced. getValidationCreditsUsed is now the ONE query every gate reads.
 *
 * '../src/index' is mocked so importing the service does not boot the server.
 */

jest.mock('../src/index', () => ({
    prisma: { validationAttempt: { count: jest.fn() } },
}));
jest.mock('../src/services/polarClient', () => ({
    TIER_LIMITS: {
        trial: { validationCredits: 10000 },
        starter: { validationCredits: 3000 },
        enterprise: { validationCredits: Infinity },
    },
}));

import { prisma } from '../src/index';
import {
    monthStart,
    getValidationLimit,
    getValidationCreditsUsed,
    getValidationCreditState,
} from '../src/services/validationCreditService';

const countMock = (prisma as any).validationAttempt.count as jest.Mock;

describe('validationCreditService', () => {
    beforeEach(() => countMock.mockReset());

    it('monthStart is the 1st of the month at local midnight', () => {
        const d = monthStart(new Date(2026, 5, 17, 13, 45, 12)); // 2026-06-17 13:45
        expect(d.getDate()).toBe(1);
        expect(d.getMonth()).toBe(5);
        expect(d.getHours()).toBe(0);
        expect(d.getMinutes()).toBe(0);
        expect(d.getSeconds()).toBe(0);
    });

    it('getValidationLimit maps tiers (case-insensitive) and defaults to trial', () => {
        expect(getValidationLimit('starter')).toBe(3000);
        expect(getValidationLimit('STARTER')).toBe(3000);
        expect(getValidationLimit('enterprise')).toBe(Infinity);
        expect(getValidationLimit(null)).toBe(10000);
        expect(getValidationLimit(undefined)).toBe(10000);
        expect(getValidationLimit('does-not-exist')).toBe(10000);
    });

    it('getValidationCreditsUsed counts ValidationAttempt by org + current month', async () => {
        countMock.mockResolvedValue(42);
        const used = await getValidationCreditsUsed('org-1');
        expect(used).toBe(42);
        // The single-ledger query: organization_id + created_at >= monthStart.
        const arg = countMock.mock.calls[0][0];
        expect(arg.where.organization_id).toBe('org-1');
        expect(arg.where.created_at.gte).toBeInstanceOf(Date);
        expect(arg.where.created_at.gte.getDate()).toBe(1);
    });

    it('unlimited tier short-circuits without hitting the ledger', async () => {
        const state = await getValidationCreditState('org-1', 'enterprise');
        expect(state).toEqual({ limit: Infinity, used: 0, remaining: Infinity, unlimited: true });
        expect(countMock).not.toHaveBeenCalled();
    });

    it('limited tier: remaining = limit - used, clamped at 0', async () => {
        countMock.mockResolvedValue(2500);
        expect(await getValidationCreditState('org-1', 'starter')).toEqual({
            limit: 3000, used: 2500, remaining: 500, unlimited: false,
        });

        countMock.mockResolvedValue(5000); // overspent
        const overspent = await getValidationCreditState('org-1', 'starter');
        expect(overspent.remaining).toBe(0);
        expect(overspent.used).toBe(5000);
    });
});
