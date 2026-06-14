/**
 * Provider registry - maps a CrmProvider string to its CrmClientFactory.
 *
 * Workers (activity push, contact import) look up the right factory here
 * by connection.provider, so neither workers nor controllers need to
 * import HubSpot or Salesforce code directly. Each provider module
 * registers itself at server startup via `registerProvider`.
 */

import type { CrmClientFactory, CrmProvider } from './types';
import { logger } from '../observabilityService';

const factories = new Map<CrmProvider, CrmClientFactory>();

export function registerProvider(factory: CrmClientFactory): void {
    if (factories.has(factory.provider)) {
        logger.warn(`[CRM_REGISTRY] provider ${factory.provider} already registered - overwriting`);
    }
    factories.set(factory.provider, factory);
    logger.info(`[CRM_REGISTRY] registered provider ${factory.provider}`);
}

export function getFactory(provider: CrmProvider): CrmClientFactory | null {
    return factories.get(provider) ?? null;
}

export function listRegisteredProviders(): CrmProvider[] {
    return Array.from(factories.keys());
}
