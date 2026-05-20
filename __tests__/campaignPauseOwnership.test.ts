/**
 * dashboardController pauseCampaign / resumeCampaign ownership-check tests.
 *
 * Super Protect audit ROUND 3 R3-SP1 (CRITICAL): the endpoints accepted
 * `campaignId` from the body and forwarded it to campaignHealthService,
 * which executed prisma.campaign.findUnique({id}) + .update({id}) WITHOUT
 * an organization_id filter. Any authenticated user could pause or resume
 * any campaign in any org just by knowing its UUID. Direct sibling of the
 * original SP1 cross-tenant attack in monitoringController.triggerEvent.
 *
 * Contract frozen here:
 *   - campaignId belonging to a different org -> 404 + audit row, no
 *     service call (defence-in-depth: even if the service is reached,
 *     the service-layer findFirst({id, organization_id}) refuses too)
 *   - campaignId not found at all -> same 404 shape (no information leak)
 *   - campaignId belonging to the caller's org -> service called +
 *     CAMPAIGN_MANUALLY_PAUSED / CAMPAIGN_MANUALLY_RESUMED audit row
 *
 * The handlers are mocked end-to-end via a fake prisma + a stub
 * campaignHealthService. We exercise the ownership predicate, not the
 * downstream pause logic.
 */

import type { Request, Response } from 'express';

const findFirstMock = jest.fn();
const pauseServiceMock = jest.fn();
const resumeServiceMock = jest.fn();
const recordSecurityEventMock = jest.fn();

jest.mock('../src/prisma', () => ({
    prisma: {
        campaign: {
            findFirst: (...args: unknown[]) => findFirstMock(...args),
        },
    },
}));
jest.mock('../src/services/campaignHealthService', () => ({
    pauseCampaign: (...args: unknown[]) => pauseServiceMock(...args),
    resumeCampaign: (...args: unknown[]) => resumeServiceMock(...args),
}));
jest.mock('../src/services/securityAuditLog', () => ({
    recordSecurityEvent: (...args: unknown[]) => recordSecurityEventMock(...args),
    EVENT_TYPES: {
        CROSS_TENANT_CAMPAIGN_ACCESS_DENIED: 'campaign.cross_tenant_access_denied',
        CAMPAIGN_MANUALLY_PAUSED: 'campaign.manually_paused',
        CAMPAIGN_MANUALLY_RESUMED: 'campaign.manually_resumed',
    },
}));
jest.mock('../src/services/routingService', () => ({}));
jest.mock('../src/services/leadHealthService', () => ({}));
jest.mock('../src/services/entityStateService', () => ({}));
jest.mock('../src/utils/responseCache', () => ({ cached: (fn: any) => fn }));

// Late-import so the mocks above apply.
import { pauseCampaign, resumeCampaign } from '../src/controllers/dashboardController';

function mockReqRes(orgId: string, body: any) {
    const req = {
        body,
        orgContext: { organizationId: orgId, userId: 'user-1' },
        headers: {},
        ip: '127.0.0.1',
        socket: {},
    } as unknown as Request;
    const status = jest.fn(() => res);
    const json = jest.fn();
    const res = { status, json } as unknown as Response;
    return { req, res, status, json };
}

beforeEach(() => {
    findFirstMock.mockReset();
    pauseServiceMock.mockReset();
    resumeServiceMock.mockReset();
    recordSecurityEventMock.mockReset();
    pauseServiceMock.mockResolvedValue(undefined);
    resumeServiceMock.mockResolvedValue(undefined);
});

describe('pauseCampaign ownership gate (R3-SP1)', () => {
    it('returns 404 when the campaignId belongs to a DIFFERENT org', async () => {
        // The findFirst with the dual predicate {id, organization_id: orgA}
        // returns null when the campaign actually belongs to orgB.
        findFirstMock.mockResolvedValueOnce(null);

        const { req, res, status, json } = mockReqRes('orgA', {
            campaignId: 'orgB-campaign-uuid',
            reason: 'malicious',
        });
        await pauseCampaign(req, res);

        expect(status).toHaveBeenCalledWith(404);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
        expect(pauseServiceMock).not.toHaveBeenCalled();
        // Cross-tenant attempt durably recorded.
        expect(recordSecurityEventMock).toHaveBeenCalledTimes(1);
        const auditCall = recordSecurityEventMock.mock.calls[0][0];
        expect(auditCall.eventType).toBe('campaign.cross_tenant_access_denied');
        expect(auditCall.target).toBe('orgB-campaign-uuid');
        expect(auditCall.organizationId).toBe('orgA');
        expect(auditCall.metadata.action).toBe('pause');
    });

    it('returns 404 when the campaignId does not exist anywhere', async () => {
        findFirstMock.mockResolvedValueOnce(null);
        const { req, res, status } = mockReqRes('orgA', {
            campaignId: 'nonexistent-uuid',
            reason: 'X',
        });
        await pauseCampaign(req, res);
        expect(status).toHaveBeenCalledWith(404);
        expect(pauseServiceMock).not.toHaveBeenCalled();
    });

    it('forwards to pauseCampaign service when ownership checks pass + emits MANUAL pause audit', async () => {
        findFirstMock.mockResolvedValueOnce({ id: 'camp-1' });
        const { req, res, json } = mockReqRes('orgA', {
            campaignId: 'camp-1',
            reason: 'high bounce rate',
        });
        await pauseCampaign(req, res);

        expect(pauseServiceMock).toHaveBeenCalledWith('orgA', 'camp-1', 'high bounce rate');
        expect(recordSecurityEventMock).toHaveBeenCalledTimes(1);
        const auditCall = recordSecurityEventMock.mock.calls[0][0];
        expect(auditCall.eventType).toBe('campaign.manually_paused');
        expect(auditCall.target).toBe('camp-1');
        expect(auditCall.metadata.reason).toBe('high bounce rate');
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('rejects missing campaignId with 400 (no DB lookup, no audit)', async () => {
        const { req, res, status } = mockReqRes('orgA', { reason: 'X' });
        await pauseCampaign(req, res);
        expect(status).toHaveBeenCalledWith(400);
        expect(findFirstMock).not.toHaveBeenCalled();
        expect(recordSecurityEventMock).not.toHaveBeenCalled();
    });

    it('defaults reason to "Manual pause" when omitted', async () => {
        findFirstMock.mockResolvedValueOnce({ id: 'camp-1' });
        const { req, res } = mockReqRes('orgA', { campaignId: 'camp-1' });
        await pauseCampaign(req, res);
        expect(pauseServiceMock).toHaveBeenCalledWith('orgA', 'camp-1', 'Manual pause');
    });
});

describe('resumeCampaign ownership gate (R3-SP1)', () => {
    it('returns 404 when the campaignId belongs to a DIFFERENT org', async () => {
        findFirstMock.mockResolvedValueOnce(null);
        const { req, res, status } = mockReqRes('orgA', {
            campaignId: 'orgB-campaign-uuid',
        });
        await resumeCampaign(req, res);

        expect(status).toHaveBeenCalledWith(404);
        expect(resumeServiceMock).not.toHaveBeenCalled();
        const auditCall = recordSecurityEventMock.mock.calls[0][0];
        expect(auditCall.eventType).toBe('campaign.cross_tenant_access_denied');
        expect(auditCall.metadata.action).toBe('resume');
    });

    it('forwards to resumeCampaign service when ownership checks pass + emits MANUAL resume audit', async () => {
        findFirstMock.mockResolvedValueOnce({ id: 'camp-2' });
        const { req, res, json } = mockReqRes('orgA', { campaignId: 'camp-2' });
        await resumeCampaign(req, res);

        expect(resumeServiceMock).toHaveBeenCalledWith('orgA', 'camp-2');
        const auditCall = recordSecurityEventMock.mock.calls[0][0];
        expect(auditCall.eventType).toBe('campaign.manually_resumed');
        expect(auditCall.target).toBe('camp-2');
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('rejects missing campaignId with 400', async () => {
        const { req, res, status } = mockReqRes('orgA', {});
        await resumeCampaign(req, res);
        expect(status).toHaveBeenCalledWith(400);
        expect(findFirstMock).not.toHaveBeenCalled();
    });
});
