/**
 * Polar reconciler (drift-detection only) contract. It corrects local
 * subscription drift from Polar (B1), but only inside tight, safe rails:
 *   - status is written only when it maps to prod's existing vocab,
 *   - tier is written only when it is a known TIER_LIMITS key,
 *   - any Polar fetch error skips the org (no state change, retry next cycle),
 *   - it NEVER autonomously cancels in Polar.
 */

jest.mock('../src/index', () => ({
    prisma: { organization: { findMany: jest.fn(), update: jest.fn() } },
}));
jest.mock('../src/services/polarClient', () => ({
    getSubscription: jest.fn(),
    TIER_LIMITS: { trial: {}, pro: {}, scale: {} },
}));
jest.mock('../src/services/auditLogService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/observabilityService', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { prisma } from '../src/index';
import * as polarClient from '../src/services/polarClient';
import { runReconcileOnce } from '../src/services/polarReconciler';

const p: any = prisma;
const getSub = (polarClient as any).getSubscription as jest.Mock;

const org = (over: Record<string, unknown> = {}) => ({
    id: 'o1',
    polar_subscription_id: 'sub_1',
    subscription_tier: 'trial',
    subscription_status: 'trialing',
    next_billing_date: null,
    ...over,
});

const driftCall = () => p.organization.update.mock.calls.find(
    (c: any) => c[0].data.subscription_status || c[0].data.subscription_tier || c[0].data.next_billing_date,
);
const stampCall = () => p.organization.update.mock.calls.find((c: any) => c[0].data.polar_reconciled_at);

beforeEach(() => {
    p.organization.findMany.mockReset();
    p.organization.update.mockReset().mockResolvedValue({});
    getSub.mockReset();
});

describe('polarReconciler.runReconcileOnce', () => {
    it('corrects status + tier + period drift from Polar', async () => {
        p.organization.findMany.mockResolvedValue([org()]);
        getSub.mockResolvedValue({ status: 'active', metadata: { tier: 'pro' }, current_period_end: '2026-07-01T00:00:00.000Z' });

        const r = await runReconcileOnce();
        expect(r.reconciled).toBe(1);
        const d = driftCall();
        expect(d[0].data.subscription_status).toBe('active');
        expect(d[0].data.subscription_tier).toBe('pro');
        expect(d[0].data.next_billing_date).toBeInstanceOf(Date);
    });

    it('maps unpaid -> past_due (prod vocab)', async () => {
        p.organization.findMany.mockResolvedValue([org({ subscription_status: 'active' })]);
        getSub.mockResolvedValue({ status: 'unpaid', metadata: {} });
        await runReconcileOnce();
        expect(driftCall()[0].data.subscription_status).toBe('past_due');
    });

    it('leaves status untouched for an unmapped Polar status', async () => {
        p.organization.findMany.mockResolvedValue([org()]);
        getSub.mockResolvedValue({ status: 'incomplete', metadata: {} });
        const r = await runReconcileOnce();
        expect(r.reconciled).toBe(0);
        expect(driftCall()).toBeUndefined();
    });

    it('never writes an unknown tier', async () => {
        p.organization.findMany.mockResolvedValue([org()]);
        getSub.mockResolvedValue({ status: 'trialing', metadata: { tier: 'bogus_tier' } });
        const r = await runReconcileOnce();
        expect(r.reconciled).toBe(0); // status unchanged + tier unknown -> no write
    });

    it('skips an org on Polar fetch error but still stamps reconciled_at', async () => {
        p.organization.findMany.mockResolvedValue([org()]);
        getSub.mockRejectedValue(new Error('Polar 404'));
        const r = await runReconcileOnce();
        expect(r.errors).toBe(1);
        expect(r.reconciled).toBe(0);
        expect(driftCall()).toBeUndefined(); // no state change on error
        expect(stampCall()).toBeDefined();   // but it does defer via the stamp
    });
});
