/**
 * Scaled Mail mailbox-import provider.
 *
 * Wraps scaledMailService in the shared MailboxImportProvider interface.
 *
 * Scaled Mail uses a three-tier walk (org → purchased-domains → mailboxes
 * per domain) instead of Zapmail's flat /export endpoint, so listMailboxes
 * here orchestrates more API calls. The throttle inside the service caps
 * at 4 req/sec to stay under Scaled Mail's documented 5/sec ceiling.
 *
 * The mailbox response schema is undocumented publicly - see the comment
 * block at the top of scaledMailService.ts for how field-name aliases
 * are handled. If a real customer's listing returns 0 mailboxes despite
 * having domains with provisioned mailboxes, check the [SCALEDMAIL] debug
 * log line for the actual key set.
 */

import { listAllMailboxes, validateScaledMailKey } from '../scaledMailService';
import { logger } from '../observabilityService';
import type { MailboxImportProvider, RemoteMailboxCredential } from './types';

export const scaledMailProvider: MailboxImportProvider = {
    key: 'scaled_mail',
    displayName: 'Scaled Mail',
    isImplemented: true,

    async validateApiKey(apiKey: string): Promise<boolean> {
        try {
            await validateScaledMailKey(apiKey);
            return true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // validateScaledMailKey throws our standard friendly message
            // on 401/403 - treat that as "key invalid" so the caller can
            // show a clean error instead of a 500. Genuine transport
            // failures (rate-limit, DNS, timeout) re-throw.
            if (msg.toLowerCase().includes('rejected the api key')) return false;
            throw err;
        }
    },

    async listMailboxes(apiKey: string): Promise<RemoteMailboxCredential[]> {
        const { mailboxes, errors } = await listAllMailboxes(apiKey);
        if (errors.length > 0) {
            // Per-org / per-domain failures don't kill the whole listing.
            // Customer sees mailboxes from whichever scope succeeded.
            logger.warn('[SCALEDMAIL_PROVIDER] Partial listing failure', { errors });
        }

        return mailboxes.map(m => ({
            remoteId: m.id,
            email: m.email,
            displayName: m.displayName,
            provider: m.provider,
            domain: m.domain,
            appPassword: m.appPassword,
            // Scaled Mail's spec doesn't expose TOTP secrets or recovery
            // emails (no fields present in the documented surface). If
            // they show up in the wild, surface them here later.
            totpSecret: null,
            recoveryEmail: null,
            remoteStatus: m.status ?? null,
            isWarmedUp: m.isWarmedUp,
        }));
    },
};
