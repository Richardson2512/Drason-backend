/**
 * monitoringController.triggerEvent ownership-check tests.
 *
 * Super Protect audit SP1 (CRITICAL): the endpoint previously accepted
 * `mailboxId` from the body and forwarded to the recording service
 * without verifying the caller's org owned that mailbox. Any
 * authenticated user could inject fake bounces against another org's
 * mailbox and trigger its auto-pause.
 *
 * Contract frozen here:
 *   - mailboxId belonging to a different org → 404 (no leak about
 *     whether the UUID exists in some other org)
 *   - mailboxId not found at all → 404
 *   - mailboxId belonging to the caller's org → service call fires
 *
 * The handler is mocked end-to-end via a fake prisma + a stub
 * monitoringService - we exercise the ownership predicate, not the
 * downstream bounce-recording logic.
 */

import type { Request, Response } from 'express';

const findFirstMock = jest.fn();
const recordBounceMock = jest.fn();
const recordSentMock = jest.fn();
const recordSecurityEventMock = jest.fn();

jest.mock('../src/prisma', () => ({
    prisma: {
        mailbox: {
            findFirst: (...args: unknown[]) => findFirstMock(...args),
        },
    },
}));
jest.mock('../src/services/monitoringService', () => ({
    recordBounce: (...args: unknown[]) => recordBounceMock(...args),
    recordSent: (...args: unknown[]) => recordSentMock(...args),
}));
jest.mock('../src/services/securityAuditLog', () => ({
    recordSecurityEvent: (...args: unknown[]) => recordSecurityEventMock(...args),
    EVENT_TYPES: {
        CROSS_TENANT_MAILBOX_ACCESS_DENIED: 'mailbox.cross_tenant_access_denied',
    },
}));

// Late-import so the mocks above apply.
import { triggerEvent } from '../src/controllers/monitoringController';

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
    recordBounceMock.mockReset();
    recordSentMock.mockReset();
    recordSecurityEventMock.mockReset();
});

describe('triggerEvent ownership gate (SP1)', () => {
    it('returns 404 when the mailboxId belongs to a DIFFERENT org', async () => {
        // Simulates: an authenticated user from orgA posts the UUID of
        // a mailbox that lives in orgB. The findFirst with the dual
        // predicate {id, organization_id: orgA} returns null.
        findFirstMock.mockResolvedValueOnce(null);

        const { req, res, status, json } = mockReqRes('orgA', {
            eventType: 'bounce',
            mailboxId: 'orgB-mailbox-uuid',
        });
        await triggerEvent(req, res);

        expect(status).toHaveBeenCalledWith(404);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
        expect(recordBounceMock).not.toHaveBeenCalled();
        // The attempt must be durably recorded.
        expect(recordSecurityEventMock).toHaveBeenCalledTimes(1);
        const auditCall = recordSecurityEventMock.mock.calls[0][0];
        expect(auditCall.eventType).toBe('mailbox.cross_tenant_access_denied');
        expect(auditCall.target).toBe('orgB-mailbox-uuid');
        expect(auditCall.organizationId).toBe('orgA');
    });

    it('returns 404 when the mailboxId does not exist anywhere', async () => {
        findFirstMock.mockResolvedValueOnce(null);
        const { req, res, status } = mockReqRes('orgA', {
            eventType: 'bounce',
            mailboxId: 'nonexistent-uuid',
        });
        await triggerEvent(req, res);
        expect(status).toHaveBeenCalledWith(404);
        expect(recordBounceMock).not.toHaveBeenCalled();
    });

    it('forwards to recordBounce when the mailbox belongs to the caller', async () => {
        findFirstMock.mockResolvedValueOnce({ id: 'mb-1' });
        const { req, res, json } = mockReqRes('orgA', {
            eventType: 'bounce',
            mailboxId: 'mb-1',
            campaignId: 'camp-1',
        });
        await triggerEvent(req, res);
        expect(recordBounceMock).toHaveBeenCalledWith('mb-1', 'camp-1');
        expect(recordSecurityEventMock).not.toHaveBeenCalled();
        expect(json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            mailboxId: 'mb-1',
        }));
    });

    it('forwards to recordSent for sent events when ownership checks pass', async () => {
        findFirstMock.mockResolvedValueOnce({ id: 'mb-1' });
        const { req, res } = mockReqRes('orgA', {
            eventType: 'sent',
            mailboxId: 'mb-1',
        });
        await triggerEvent(req, res);
        expect(recordSentMock).toHaveBeenCalledWith('mb-1', '');
    });

    it('rejects unknown event types with 400 (no service call)', async () => {
        findFirstMock.mockResolvedValueOnce({ id: 'mb-1' });
        const { req, res, status } = mockReqRes('orgA', {
            eventType: 'crash',
            mailboxId: 'mb-1',
        });
        await triggerEvent(req, res);
        expect(status).toHaveBeenCalledWith(400);
        expect(recordBounceMock).not.toHaveBeenCalled();
        expect(recordSentMock).not.toHaveBeenCalled();
    });

    it('rejects missing required fields with 400 (no DB lookup)', async () => {
        const { req, res, status } = mockReqRes('orgA', { eventType: 'bounce' });
        await triggerEvent(req, res);
        expect(status).toHaveBeenCalledWith(400);
        expect(findFirstMock).not.toHaveBeenCalled();
    });
});
