import { handleEmailBisonWebhook } from '../src/controllers/emailbisonWebhookController';
import { enqueueEvent } from '../src/services/eventQueue';
import { storeEvent } from '../src/services/eventService';
import { EventType } from '../src/types';
import { Request, Response } from 'express';

// Mock external dependencies
jest.mock('../src/index', () => ({
    prisma: {
        mailbox: {
            findUnique: jest.fn().mockResolvedValue({ organization_id: 'org-123' }),
        },
        organizationSetting: {
            findUnique: jest.fn().mockResolvedValue(null),
        },
    }
}));
jest.mock('../src/services/eventQueue', () => ({
    enqueueEvent: jest.fn().mockResolvedValue(true)
}));
jest.mock('../src/services/eventService', () => ({
    storeEvent: jest.fn().mockResolvedValue({ eventId: 'stored-evt-1' })
}));
jest.mock('../src/services/observabilityService', () => ({
    logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../src/utils/webhookSignature', () => ({
    validateWebhookSignature: jest.fn().mockReturnValue(true)
}));

describe('EmailBison Webhook Controller', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset storeEvent to return incrementing IDs
        let callCount = 0;
        (storeEvent as jest.Mock).mockImplementation(() => {
            callCount++;
            return Promise.resolve({ eventId: `stored-evt-${callCount}` });
        });
    });

    it('should parse EmailBison events with flat fallback fields, enqueue mapped events, and skip unmapped ones', async () => {
        const req = {
            body: {
                events: [
                    {
                        id: 'evt_1',
                        type: 'email_bounced',
                        email_account_id: '99',
                        campaign_id: '55',
                        recipient_email: 'bounce@test.com',
                        smtp_response: '550 User unknown'
                    },
                    {
                        id: 'evt_2',
                        event: 'email_opened',
                        email_account_id: '99',
                        campaign_id: '55'
                    },
                    {
                        id: 'evt_3',
                        type: 'untracked_event_blabla',
                        email_account_id: '99',
                        campaign_id: '55'
                    }
                ]
            },
            headers: {},
            get: jest.fn(),
        };

        const res = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handleEmailBisonWebhook(req as any, res as any);

        expect(res.json).toHaveBeenCalledWith({ success: true, processed: 3 });

        // storeEvent should have been called for the 2 mapped events
        expect(storeEvent).toHaveBeenCalledTimes(2);

        // enqueueEvent should have been called for the 2 mapped events (bounced + opened)
        expect(enqueueEvent).toHaveBeenCalledTimes(2);

        // Verify the bounced event mapping
        expect(enqueueEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
            eventId: 'stored-evt-1',
            eventType: EventType.HARD_BOUNCE,
            entityType: 'mailbox',
            entityId: 'eb-99',
            organizationId: 'org-123',
            campaignId: 'eb-55',
            recipientEmail: 'bounce@test.com',
            smtpResponse: '550 User unknown',
        }));

        // Verify the opened event
        expect(enqueueEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
            eventId: 'stored-evt-2',
            eventType: 'EmailOpened',
            entityType: 'mailbox',
            entityId: 'eb-99',
            organizationId: 'org-123',
            campaignId: 'eb-55',
        }));
    });

    it('should return error when first event has no sender email ID', async () => {
        const req = {
            body: {
                events: [{ id: 'evt_no_mailbox', type: 'email_sent' }]
            },
            headers: {},
            get: jest.fn(),
        };

        const res = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handleEmailBisonWebhook(req as any, res as any);

        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Missing mailbox identifier' });
        expect(enqueueEvent).not.toHaveBeenCalled();
    });
});
