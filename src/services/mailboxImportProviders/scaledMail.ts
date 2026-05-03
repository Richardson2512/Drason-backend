/**
 * Scaled Mail mailbox-import provider.
 *
 * STUB — Scaled Mail does not publish API documentation publicly.
 * Implementation pattern matches Zapmail when their docs are obtained.
 */

import type { MailboxImportProvider, RemoteMailboxCredential } from './types';

export const scaledMailProvider: MailboxImportProvider = {
    key: 'scaled_mail',
    displayName: 'Scaled Mail',
    isImplemented: false,

    async validateApiKey(_apiKey: string): Promise<boolean> {
        throw new Error(
            'Scaled Mail integration is not yet implemented. ' +
            'Contact Scaled Mail support for their API spec.',
        );
    },

    async listMailboxes(_apiKey: string): Promise<RemoteMailboxCredential[]> {
        throw new Error('Scaled Mail integration is not yet implemented.');
    },
};
