import { handleEmailBisonWebhook } from '../src/controllers/emailbisonWebhookController';
import { getOrgId } from '../src/middleware/orgContext';
import { enqueueEvent } from '../src/services/eventQueue';
import { EventType } from '../src/types';
import { Request, Response } from 'express';

// Mock external dependencies
jest.mock('../src/middleware/orgContext', () => ({
    getOrgId: jest.fn().mockReturnValue('org-123')
}));
jest.mock('../src/services/eventQueue', () => ({
    enqueueEvent: jest.fn().mockResolvedValue(true)
}));
jest.mock('../src/services/observabilityService', () => ({
    logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

describe('EmailBison Webhook Controller', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should parse an array of EmailBison events, prefix IDs, and enqueue them into BullMQ', async () => {
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
                        event: 'email_opened', // Test alternative key
                        data: {
                            email_account_id: '99',
                            campaign_id: '55'
                        }
                    },
                    {
                        id: 'evt_3',
                        type: 'untracked_event_blabla'
                    }
                ]
            }
        };

        const res = {
            json: jest.fn()
        };

        await handleEmailBisonWebhook(req as any, res as any);

        expect(res.json).toHaveBeenCalledWith({ success: true, processed: 3 });

        // Should have enqueued exactly 2 events (skipped the untracked one)
        expect(enqueueEvent).toHaveBeenCalledTimes(2);

        // Verify the bounced event mapping and ID prefixing
        expect(enqueueEvent).toHaveBeenNthCalledWith(1, {
            eventId: 'evt_1',
            eventType: EventType.HARD_BOUNCE,
            entityType: 'mailbox',
            entityId: 'eb-99',
            organizationId: 'org-123',
            campaignId: 'eb-55',
            recipientEmail: 'bounce@test.com',
            smtpResponse: '550 User unknown'
        });

        // Verify the opened event falling back to data.* keys
        expect(enqueueEvent).toHaveBeenNthCalledWith(2, {
            eventId: 'evt_2',
            eventType: 'EmailOpened',
            entityType: 'mailbox',
            entityId: 'eb-99',
            organizationId: 'org-123',
            campaignId: 'eb-55',
            recipientEmail: undefined,
            smtpResponse: undefined
        });
    });
});
