/**
 * Premium Inboxes mailbox-import provider.
 *
 * STUB — Premium Inboxes does not publish API documentation publicly.
 * The customer-facing flow they support today is "request a CSV export"
 * via their dashboard, which delivers email + app password tuples.
 *
 * To complete this implementation, do ONE of:
 *
 *   (A) If Premium Inboxes exposes a REST API, fill in:
 *       - validateApiKey: hit their auth endpoint
 *       - listMailboxes: fetch + map their mailbox response into
 *         RemoteMailboxCredential[]. Their fields likely map cleanly:
 *           email → email
 *           appPassword/smtpPassword → appPassword
 *           workspace/domain → domain
 *
 *   (B) If they only offer CSV export, build a separate "Paste CSV"
 *       flow on the frontend that posts the parsed credential bundle
 *       to a generic /bulk-import endpoint. That bypasses this provider
 *       entirely; remove the stub or mark isImplemented=false.
 *
 * Until either path is wired, isImplemented=false makes the controller
 * return 501 Not Implemented for any write op against this provider.
 * Listing the provider in the registry is still useful: the frontend
 * can render the "Coming soon" entry without faking it.
 */

import type { MailboxImportProvider, RemoteMailboxCredential } from './types';

export const premiumInboxesProvider: MailboxImportProvider = {
    key: 'premium_inboxes',
    displayName: 'Premium Inboxes',
    isImplemented: false,

    async validateApiKey(_apiKey: string): Promise<boolean> {
        throw new Error(
            'Premium Inboxes integration is not yet implemented. ' +
            'Contact Premium Inboxes support to confirm their API surface, ' +
            'then complete this provider.',
        );
    },

    async listMailboxes(_apiKey: string): Promise<RemoteMailboxCredential[]> {
        throw new Error('Premium Inboxes integration is not yet implemented.');
    },
};
