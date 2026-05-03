/**
 * Lead-source provider registry — analogous to services/crm/registry.ts.
 * Each provider's factory.ts registers itself at server boot if env
 * vars are set. Workers + controllers look up the right factory here
 * by `connection.provider`.
 */

import type { LeadSourceClientFactory, LeadSourceProvider } from './types';
import { logger } from '../observabilityService';

const factories = new Map<LeadSourceProvider, LeadSourceClientFactory>();

export function registerLeadSourceProvider(factory: LeadSourceClientFactory): void {
    if (factories.has(factory.provider)) {
        logger.warn(`[LEAD_SOURCE_REGISTRY] provider ${factory.provider} already registered — overwriting`);
    }
    factories.set(factory.provider, factory);
    logger.info(`[LEAD_SOURCE_REGISTRY] registered provider ${factory.provider}`);
}

export function getLeadSourceFactory(provider: LeadSourceProvider): LeadSourceClientFactory | null {
    return factories.get(provider) ?? null;
}

export function listRegisteredLeadSources(): LeadSourceProvider[] {
    return Array.from(factories.keys());
}
