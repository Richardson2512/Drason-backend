import type { LeadSourceClient, LeadSourceClientFactory, LeadSourceFilter, LeadSourceProvider } from '../types';
import { ApolloLeadSourceClient } from './client';
import { parseApolloUrl } from './urlParser';

export const apolloFactory: LeadSourceClientFactory = {
    provider: 'apollo' as LeadSourceProvider,

    create(opts: { apiKey: string }): LeadSourceClient {
        return new ApolloLeadSourceClient({ apiKey: opts.apiKey });
    },

    parseUrl(url: string): LeadSourceFilter | null {
        return parseApolloUrl(url);
    },
};
