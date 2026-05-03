/**
 * Mailbox-Import Provider Registry.
 *
 * Single source of truth mapping provider keys to their implementations.
 * Controllers dispatch via getProvider(key); the frontend lists providers
 * via getAllProviders() so a new reseller is registered here exactly once
 * and surfaces everywhere.
 */

import type { MailboxImportProvider, MailboxImportProviderKey } from './types';
import { zapmailProvider } from './zapmail';
import { premiumInboxesProvider } from './premiumInboxes';
import { missionInboxProvider } from './missionInbox';
import { scaledMailProvider } from './scaledMail';

const PROVIDERS: Record<MailboxImportProviderKey, MailboxImportProvider> = {
    zapmail: zapmailProvider,
    premium_inboxes: premiumInboxesProvider,
    mission_inbox: missionInboxProvider,
    scaled_mail: scaledMailProvider,
};

/** Look up a provider by its stable key. Returns null for unknown keys. */
export function getProvider(key: string): MailboxImportProvider | null {
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, key)) return null;
    return PROVIDERS[key as MailboxImportProviderKey];
}

/** All providers in registration order. Used by the listing endpoint
 *  that powers the frontend's "Connect from..." menu. */
export function getAllProviders(): MailboxImportProvider[] {
    return Object.values(PROVIDERS);
}
