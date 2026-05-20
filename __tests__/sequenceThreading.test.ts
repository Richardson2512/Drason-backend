/**
 * Sequence threading-header tests.
 *
 * Production-readiness round-1 R1 fix: before this commit, sendQueueService
 * dispatched every follow-up step of a sequence without RFC 5322 threading
 * headers (In-Reply-To / References), so the recipient's email client
 * (Gmail, Outlook, Apple Mail) treated each step as a new conversation
 * instead of a reply chain. The SMTP adapter (emailSendAdapters.sendViaSMTP)
 * already supported the headers - the dispatcher just never set them.
 *
 * Two-part fix:
 *   1. buildThreadingHeaders helper looks up the most recent outbound
 *      EmailMessage in the (org, account, contact, campaign) thread and
 *      returns the In-Reply-To / References pair for the NEXT send.
 *   2. The EmailMessage row written after each send now stores message_id,
 *      in_reply_to, and references so the NEXT step's lookup can chain
 *      off it.
 *
 * Contract frozen here (buildThreadingHeaders is the load-bearing piece):
 *   - Step 1 -> {null, null} (first-touch, no parent)
 *   - Step 2+ with no prior thread -> {null, null} (degrade gracefully)
 *   - Step 2+ with prior outbound, no prior references -> in_reply_to and
 *     references both === prev.message_id
 *   - Step N>2 with full chain -> in_reply_to === prev.message_id;
 *     references === `${prev.references} ${prev.message_id}` (accumulating
 *     ancestor chain per RFC 5322)
 *   - DB hiccup on lookup -> {null, null} (never blocks the send)
 *
 * The regression these tests guard against: a refactor that drops the
 * helper call site at sendQueueService:1365 or removes the message_id /
 * in_reply_to / references fields from the EmailMessage.create at
 * sendQueueService:1589 - either would silently re-introduce the
 * thread-breaking bug. The dispatcher path isn't covered here directly;
 * tests focus on the contract this helper freezes.
 */

const threadFindFirstMock = jest.fn();
const messageFindFirstMock = jest.fn();

jest.mock('../src/prisma', () => ({
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
jest.mock('../src/services/emailSendAdapters', () => ({}));
jest.mock('../src/services/trackingService', () => ({}));
jest.mock('../src/services/polarClient', () => ({}));
jest.mock('../src/utils/redis', () => ({}));
jest.mock('../src/services/mailboxProvisioningService', () => ({}));
jest.mock('../src/services/healingService', () => ({}));
jest.mock('../src/services/bounceProcessingService', () => ({}));
jest.mock('../src/services/executionGateService', () => ({}));
jest.mock('../src/services/campaignHealthService', () => ({}));
jest.mock('../src/services/inactivityService', () => ({}));
jest.mock('../src/services/auditLogService', () => ({}));
jest.mock('../src/services/SlackAlertService', () => ({ SlackAlertService: {} }));
jest.mock('../src/services/webhookEventBus', () => ({}));
jest.mock('../src/utils/spintax', () => ({}));
jest.mock('../src/services/sequencer/stepResolver', () => ({
    resolveDeliverableStep: jest.fn(),
    classifyStepOwner: jest.fn(),
}));
jest.mock('../src/services/sequencer/leadProgression', () => ({
    computeProgression: jest.fn(),
    writeProgression: jest.fn(),
    completeLead: jest.fn(),
    progressionWhere: jest.fn(),
    progressionWriteData: jest.fn(),
}));
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
        // No DB lookup performed for step 1 - the helper short-circuits.
        expect(threadFindFirstMock).not.toHaveBeenCalled();
        expect(messageFindFirstMock).not.toHaveBeenCalled();
    });

    it('step 2+ with no prior thread -> degrades to no headers (graceful)', async () => {
        threadFindFirstMock.mockResolvedValueOnce(null);
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        expect(result).toEqual({ inReplyTo: null, references: null });
        expect(threadFindFirstMock).toHaveBeenCalledTimes(1);
        // No message lookup if thread is absent.
        expect(messageFindFirstMock).not.toHaveBeenCalled();
    });

    it('step 2+ with thread but no prior outbound -> graceful no-headers', async () => {
        threadFindFirstMock.mockResolvedValueOnce({ id: 'thread-1' });
        messageFindFirstMock.mockResolvedValueOnce(null);
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        expect(result).toEqual({ inReplyTo: null, references: null });
    });

    it('step 2 with prior step-1 outbound -> chains in_reply_to and references both to step1', async () => {
        // Step 1 was sent earlier with no in_reply_to / references (first-touch).
        // Step 2's headers should both point to step 1's message_id.
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
        // Step 2 has message_id=step2, references=step1 (because step 2's
        // references when written was prev.message_id of step 1, prev.refs was null).
        // Step 3's headers should be:
        //   in_reply_to = step2
        //   references  = "step1 step2"
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
        // Real-world deep chain: step 4 has references covering steps 1+2+3.
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
        // Threading is case-insensitive in RFC 5322 - the existing
        // sendQueueService Unibox flow stores contact_email lowercased,
        // so the lookup must lowercase too or it would miss the row.
        threadFindFirstMock.mockResolvedValueOnce(null);
        await buildThreadingHeaders({ ...baseParams, contactEmail: 'Recipient@EXAMPLE.com', stepNumber: 2 });
        const call = threadFindFirstMock.mock.calls[0][0];
        expect(call.where.contact_email).toBe('recipient@example.com');
    });

    it('lookup-throws -> degrades to no headers (never blocks the send)', async () => {
        // A DB hiccup during the threading lookup must NOT block the send.
        // The user has paid for the warmed mailbox; "couldn't read the
        // previous Message-ID" is not a reason to drop the email.
        threadFindFirstMock.mockRejectedValueOnce(new Error('db down'));
        const result = await buildThreadingHeaders({ ...baseParams, stepNumber: 2 });
        expect(result).toEqual({ inReplyTo: null, references: null });
    });

    it('thread query is correctly scoped to (org, account, contact, campaign)', async () => {
        // The lookup key MUST match the EmailThread create's key inside the
        // Unibox post-send flow at sendQueueService:1551. If those drift,
        // we look up the wrong thread and either miss the chain or
        // (worse) chain off a different lead's history.
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
        // Only outbound messages enter the threading chain. Inbound replies
        // are NOT referenced as parents - step N is a follow-up to step
        // N-1's outbound, not a reply to the recipient.
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
