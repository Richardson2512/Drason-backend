/**
 * Mission Inbox mailbox-import provider.
 *
 * STUB — Mission Inbox does not publish API documentation publicly.
 * Implementation pattern matches Zapmail when their docs are obtained.
 *
 * Expected fields in their mailbox response:
 *   - id, email, domain, appPassword (or smtp_password), totpSecret
 *
 * See ./premiumInboxes.ts for the full pattern; replicate here once
 * you have Mission Inbox's API spec.
 */

import type { MailboxImportProvider, RemoteMailboxCredential } from './types';

export const missionInboxProvider: MailboxImportProvider = {
    key: 'mission_inbox',
    displayName: 'Mission Inbox',
    isImplemented: false,

    async validateApiKey(_apiKey: string): Promise<boolean> {
        throw new Error(
            'Mission Inbox integration is not yet implemented. ' +
            'Contact Mission Inbox support for their API spec.',
        );
    },

    async listMailboxes(_apiKey: string): Promise<RemoteMailboxCredential[]> {
        throw new Error('Mission Inbox integration is not yet implemented.');
    },
};
