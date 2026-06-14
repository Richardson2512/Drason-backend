/**
 * Zapmail mailbox-import provider.
 *
 * Wraps the existing zapmailService in the shared MailboxImportProvider
 * interface so the controller can dispatch to any reseller uniformly.
 *
 * Confirmed via Zapmail's official API docs (https://docs.zapmail.ai):
 *   - GET /v2/users - validates the API key
 *   - GET /v2/mailboxes/list - paginated mailbox list with credentials
 *     in fields: { email, password, appPassword, secret, recoveryEmail }
 *
 * `appPassword` is the Gmail/Outlook app password used for SMTP/IMAP.
 * Some mailboxes may have appPassword=null when still in CREATING_PASSWORD
 * state - those are surfaced as "not ready" and skipped on bulk import.
 */

import { listAllMailboxes, validateZapmailKey } from '../zapmailService';
import { logger } from '../observabilityService';
import type { MailboxImportProvider, RemoteMailboxCredential } from './types';

export const zapmailProvider: MailboxImportProvider = {
    key: 'zapmail',
    displayName: 'Zapmail',
    isImplemented: true,

    async validateApiKey(apiKey: string): Promise<boolean> {
        try {
            await validateZapmailKey(apiKey);
            return true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // validateZapmailKey throws a typed error for 401/403 - we treat
            // any rejection as "key invalid" rather than a transport error.
            // Genuine network/timeout issues will look different in the
            // message (rate limit, DNS, etc.) and re-throw.
            if (msg.toLowerCase().includes('rejected the api key')) return false;
            throw err;
        }
    },

    async listMailboxes(apiKey: string): Promise<RemoteMailboxCredential[]> {
        const { mailboxes, errors } = await listAllMailboxes(apiKey);
        if (errors.length > 0) {
            // Per-provider errors don't kill the whole listing - log and
            // continue. The customer sees mailboxes from whichever side
            // succeeded.
            logger.warn('[ZAPMAIL_PROVIDER] Partial listing failure', { errors });
        }

        return mailboxes.map(m => ({
            remoteId: m.id,
            email: m.email,
            displayName: m.displayName,
            provider: m.provider,
            domain: m.domain,
            appPassword: m.appPassword ?? null,
            totpSecret: m.secret ?? null,
            recoveryEmail: m.recoveryEmail ?? null,
            remoteStatus: m.status ?? null,
            isWarmedUp: m.isWarmedUp,
        }));
    },
};
