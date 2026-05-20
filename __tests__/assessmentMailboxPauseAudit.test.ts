/**
 * infrastructureAssessmentService.enforceMailboxPause audit-emission tests.
 *
 * Super Protect audit ROUND-2 R2-SP1: the first-pass SP4 fix added the
 * operational AuditLog row but left EVENT_TYPES.MAILBOX_PAUSED_BY_ASSESSMENT
 * unused - a pattern divergence vs the three sibling Super Protect events
 * (cross-tenant access, dedicated-ip auto-pause, suppression-mode flip)
 * which all write to SecurityAuditLog via recordSecurityEvent.
 *
 * Contract frozen here:
 *   - enforceMailboxPause writes BOTH audit surfaces:
 *       1. auditLogService.logAction (operational - entity timeline UI)
 *       2. recordSecurityEvent with MAILBOX_PAUSED_BY_ASSESSMENT (forensic)
 *   - The recordSecurityEvent metadata carries reason, mailbox_email,
 *     and the resilience-score before/after so operators investigating
 *     the pause have the full context without a second query.
 *   - Audit emission is fire-and-forget; a DB hiccup on either audit
 *     surface MUST NOT block the assessment flow.
 *
 * This test is the regression gate: if a future refactor drops the
 * recordSecurityEvent call, the constant goes back to being dead code
 * and the pattern divergence reappears. The assertion fires before that
 * lands on staging.
 */

import { Prisma } from '@prisma/client';

const mailboxUpdateMock = jest.fn();
const campaignFindManyMock = jest.fn();
const eventStoreMock = jest.fn();
const auditLogActionMock = jest.fn();
const slackAlertMock = jest.fn();
const rotateMock = jest.fn();
const recordSecurityEventMock = jest.fn();

jest.mock('../src/prisma', () => ({
    prisma: {
        mailbox: {
            update: (...args: unknown[]) => mailboxUpdateMock(...args),
        },
        campaign: {
            findMany: (...args: unknown[]) => campaignFindManyMock(...args),
        },
    },
    Prisma: { JsonNull: Symbol.for('Prisma.JsonNull') },
}));
jest.mock('../src/services/eventService', () => ({
    storeEvent: (...args: unknown[]) => eventStoreMock(...args),
}));
jest.mock('../src/services/auditLogService', () => ({
    logAction: (...args: unknown[]) => auditLogActionMock(...args),
}));
jest.mock('../src/services/SlackAlertService', () => ({
    SlackAlertService: { sendAlert: (...args: unknown[]) => slackAlertMock(...args) },
}));
jest.mock('../src/services/rotationService', () => ({
    rotateForPausedMailbox: (...args: unknown[]) => rotateMock(...args),
}));
jest.mock('../src/services/notificationService', () => ({}));
jest.mock('../src/services/entityStateService', () => ({}));
jest.mock('../src/services/campaignHealthService', () => ({}));
jest.mock('../src/services/dnsblService', () => ({}));
jest.mock('../src/services/observabilityService', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
jest.mock('../src/services/securityAuditLog', () => ({
    recordSecurityEvent: (...args: unknown[]) => recordSecurityEventMock(...args),
    EVENT_TYPES: {
        MAILBOX_PAUSED_BY_ASSESSMENT: 'mailbox.paused_by_assessment',
    },
}));

// Late-import so the mocks above apply.
import { enforceMailboxPause } from '../src/services/infrastructureAssessmentService';

beforeEach(() => {
    mailboxUpdateMock.mockReset();
    campaignFindManyMock.mockReset();
    eventStoreMock.mockReset();
    auditLogActionMock.mockReset();
    slackAlertMock.mockReset();
    rotateMock.mockReset();
    recordSecurityEventMock.mockReset();

    mailboxUpdateMock.mockResolvedValue({});
    campaignFindManyMock.mockResolvedValue([]);
    eventStoreMock.mockResolvedValue(undefined);
    auditLogActionMock.mockResolvedValue(undefined);
    slackAlertMock.mockResolvedValue(undefined);
    rotateMock.mockResolvedValue({ ok: true });
});

describe('enforceMailboxPause audit emission (R2-SP1)', () => {
    const mailbox = { id: 'mb-1', email: 'sender@yourdomain.com', resilience_score: 70 };

    it('writes a SecurityAuditLog row with MAILBOX_PAUSED_BY_ASSESSMENT', async () => {
        await enforceMailboxPause('org-1', mailbox, 'high_bounce_rate');

        // Both audit surfaces fire - we keep the operational AuditLog
        // for the entity timeline UI AND the SecurityAuditLog for the
        // forensic-grade trail.
        expect(auditLogActionMock).toHaveBeenCalledTimes(1);
        expect(recordSecurityEventMock).toHaveBeenCalledTimes(1);

        const auditCall = recordSecurityEventMock.mock.calls[0][0];
        expect(auditCall.organizationId).toBe('org-1');
        expect(auditCall.actorKind).toBe('system');
        expect(auditCall.eventType).toBe('mailbox.paused_by_assessment');
        expect(auditCall.target).toBe('mb-1');
        // Metadata MUST include the operator-investigation context.
        expect(auditCall.metadata.reason).toBe('high_bounce_rate');
        expect(auditCall.metadata.mailbox_email).toBe('sender@yourdomain.com');
        expect(auditCall.metadata.resilience_score_before).toBe(70);
        // -15 per the existing service logic. If the formula changes,
        // this test surfaces the change.
        expect(auditCall.metadata.resilience_score_after).toBe(55);
    });

    it('emits audit even when the operational AuditLog write fails', async () => {
        // The operational AuditLog is wrapped in try/catch; a failure
        // there must NOT prevent the SecurityAuditLog emission. The
        // two surfaces are independent.
        auditLogActionMock.mockRejectedValueOnce(new Error('audit table down'));

        await enforceMailboxPause('org-1', mailbox, 'dns_failure');

        expect(recordSecurityEventMock).toHaveBeenCalledTimes(1);
        expect(recordSecurityEventMock.mock.calls[0][0].eventType).toBe('mailbox.paused_by_assessment');
    });

    it('clamps the resilience score floor to 0 in the audit metadata', async () => {
        const stillTroubled = { id: 'mb-2', email: 'tired@yourdomain.com', resilience_score: 10 };
        await enforceMailboxPause('org-1', stillTroubled, 'fatigue');
        const meta = recordSecurityEventMock.mock.calls[0][0].metadata;
        // 10 - 15 would be -5; service clamps to 0.
        expect(meta.resilience_score_after).toBe(0);
    });

    it('handles null resilience_score by treating it as 50 (matches service default)', async () => {
        const fresh = { id: 'mb-3', email: 'new@yourdomain.com', resilience_score: null };
        await enforceMailboxPause('org-1', fresh, 'initial_assessment');
        const meta = recordSecurityEventMock.mock.calls[0][0].metadata;
        expect(meta.resilience_score_before).toBe(50);
        expect(meta.resilience_score_after).toBe(35);
    });
});
