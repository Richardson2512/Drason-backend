import type { CrmClient, CrmClientFactory, CrmOAuthTokens, CrmProvider } from '../types';
import { HubSpotCrmClient } from './client';

export const hubspotFactory: CrmClientFactory = {
    provider: 'hubspot' as CrmProvider,
    create(opts: {
        accessToken: string;
        refreshToken?: string | null;
        instanceUrl?: string | null;
        onTokensRefreshed?: (tokens: CrmOAuthTokens) => Promise<void>;
    }): CrmClient {
        return new HubSpotCrmClient({
            accessToken: opts.accessToken,
            refreshToken: opts.refreshToken ?? null,
            onTokensRefreshed: opts.onTokensRefreshed,
        });
    },
};
