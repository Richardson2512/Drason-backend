/**
 * Sequence threading-header tests.
 *
 * Production-readiness fix: before this, sendQueueService dispatched every
 * follow-up step of a sequence without RFC 5322 threading headers (In-Reply-To
 * / References), so the recipient's email client (Gmail, Outlook, Apple Mail)
 * treated each step as a new conversation instead of a reply chain. The send
 * adapters already supported the headers - the dispatcher just never set them.
 *
 * Two-part fix:
 *   1. buildThreadingHeaders looks up the most recent outbound EmailMessage in
 *      the (org, account, contact, campaign) thread and returns the
 *      In-Reply-To / References pair for the NEXT send.
 *   2. The EmailMessage row written after each send now stores message_id,
 *      in_reply_to, and references so the NEXT step's lookup can chain off it.
 *
 * Contract frozen here (buildThreadingHeaders is the load-bearing piece):
 *   - Step 1 -> {null, null} (first-touch, no parent)
 *   - Step 2+ with no prior thread -> {null, null} (degrade gracefully)
 *   - Step 2+ with prior outbound, no prior references -> in_reply_to and
 *     references both === prev.message_id
 *   - Step N>2 with full chain -> in_reply_to === prev.message_id;
 *     references === `${prev.references} ${prev.message_id}`
 *   - DB hiccup on lookup -> {null, null} (never blocks the send)
 */

const threadFindFirstMock = jest.fn();
const messageFindFirstMock = jest.fn();

// Prod imports prisma from ../index (no standalone prisma module), matching
// the established prod test convention (see emailbisonWebhook.test.ts).
jest.mock('../src/index', () => ({
    prisma: {
        emailThread: {
            findFirst: (...args: unknown[]) => threadFindFirstMock(...args),
        },
        emailMessage: {
            findFirst: (...args: unknown[]) => messageFindFirstMock(...args),
        },
    },
}));
jest.mock('../src/services/observabilityService', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    maskEmail: (e: string) => e.replace(/(.{2}).*(@.*)/, '$1***$2'),
}));
// Stub the rest of sendQueueService's import graph so the unit under test
// (buildThreadingHeaders) loads without pulling real transports / queues.
jest.mock('../src/services/emailSendAdapters', () => ({}));
jest.mock('../src/services/trackingService', () => ({}));
jest.mock('../src/services/polarClient', () => ({}));
jest.mock('../src/utils/redis', () => ({}));
jest.mock('../src/services/mailboxProvisioningService', () => ({}));
jest.mock('../src/services/healingService', () => ({}));
jest.mock('../src/services/bounceProcessingService', () => ({}));
jest.mock('../src/services/executionGateService', () => ({}));
jest.mock('../src/services/inactivityService', () => ({}));
jest.mock('../src/services/auditLogService', () => ({}));
jest.mock('../src/services/SlackAlertService', () => ({ SlackAlertService: {} }));
jest.mock('../src/services/webhookEventBus', () => ({}));
jest.mock('../src/utils/spintax', () => ({}));
jest.mock('bullmq', () => ({
    Queue: jest.fn(),
    Worker: jest.fn(),
    Job: jest.fn(),
}));

import { buildThreadingHeaders } from '../src/services/sendQueueService';

beforeEach(() => {
    threadFindFirstMock.mockReset();
    messageFindFirstMock.mockReset();
});

const baseParams = {
    organizationId: 'org-1',
    accountId: 'acct-1',
    contactEmail: 'recipient@example.com',
    campaignId: 'camp-1',
};

describe('buildThreadingHeaders', () => {
    it('step 1 -> no headers (first-touch, no parent to reference)', async () => {
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 1 });
        expect(result).toEqual({ inReplyTo: null, references: null });
        expect(threadFindFirstMock).not.toHaveBeenCalled();
        expect(messageFindFirstMock).not.toHaveBeenCalled();
    });

    it('step 2+ with no prior thread -> degrades to no headers (graceful)', async () => {
        threadFindFirstMock.mockResolvedValueOnce(null);
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        expect(result).toEqual({ inReplyTo: null, references: null });
        expect(threadFindFirstMock).toHaveBeenCalledTimes(1);
        expect(messageFindFirstMock).not.toHaveBeenCalled();
    });

    it('step 2+ with thread but no prior outbound -> graceful no-headers', async () => {
        threadFindFirstMock.mockResolvedValueOnce({ id: 'thread-1' });
        messageFindFirstMock.mockResolvedValueOnce(null);
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        expect(result).toEqual({ inReplyTo: null, references: null });
    });

    it('step 2 with prior step-1 outbound -> chains in_reply_to and references both to step1', async () => {
        threadFindFirstMock.mockResolvedValueOnce({ id: 'thread-1' });
        messageFindFirstMock.mockResolvedValueOnce({
            message_id: '<step1-uuid@superkabe.com>',
            references: null,
        });
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        expect(result.inReplyTo).toBe('<step1-uuid@superkabe.com>');
        expect(result.references).toBe('<step1-uuid@superkabe.com>');
    });

    it('step 3 with prior step-2 outbound carrying chain -> accumulates ancestors', async () => {
        threadFindFirstMock.mockResolvedValueOnce({ id: 'thread-1' });
        messageFindFirstMock.mockResolvedValueOnce({
            message_id: '<step2-uuid@superkabe.com>',
            references: '<step1-uuid@superkabe.com>',
        });
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 3 });
        expect(result.inReplyTo).toBe('<step2-uuid@superkabe.com>');
        expect(result.references).toBe('<step1-uuid@superkabe.com> <step2-uuid@superkabe.com>');
    });

    it('step 5 with deep chain -> still accumulates correctly', async () => {
        threadFindFirstMock.mockResolvedValueOnce({ id: 'thread-1' });
        messageFindFirstMock.mockResolvedValueOnce({
            message_id: '<step4@superkabe.com>',
            references: '<step1@superkabe.com> <step2@superkabe.com> <step3@superkabe.com>',
        });
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 5 });
        expect(result.inReplyTo).toBe('<step4@superkabe.com>');
        expect(result.references).toBe('<step1@superkabe.com> <step2@superkabe.com> <step3@superkabe.com> <step4@superkabe.com>');
    });

    it('contact_email is normalized to lowercase for the thread lookup', async () => {
        threadFindFirstMock.mockResolvedValueOnce(null);
        await buildThreadingHeaders({ ...baseParams, contactEmail: 'Recipient@EXAMPLE.com', stepNumber: 2 });
        const call = threadFindFirstMock.mock.calls[0][0];
        expect(call.where.contact_email).toBe('recipient@example.com');
    });

    it('lookup-throws -> degrades to no headers (never blocks the send)', async () => {
        threadFindFirstMock.mockRejectedValueOnce(new Error('db down'));
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        expect(result).toEqual({ inReplyTo: null, references: null });
    });

    it('thread query is correctly scoped to (org, account, contact, campaign)', async () => {
        threadFindFirstMock.mockResolvedValueOnce(null);
        await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        const call = threadFindFirstMock.mock.calls[0][0];
        expect(call.where).toEqual({
            organization_id: 'org-1',
            account_id: 'acct-1',
            contact_email: 'recipient@example.com',
            campaign_id: 'camp-1',
        });
    });

    it('message query filters by direction=outbound and orders by sent_at desc', async () => {
        threadFindFirstMock.mockResolvedValueOnce({ id: 'thread-1' });
        messageFindFirstMock.mockResolvedValueOnce(null);
        await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        const call = messageFindFirstMock.mock.calls[0][0];
        expect(call.where.thread_id).toBe('thread-1');
        expect(call.where.direction).toBe('outbound');
        expect(call.where.message_id).toEqual({ not: null });
        expect(call.orderBy).toEqual({ sent_at: 'desc' });
    });
});
