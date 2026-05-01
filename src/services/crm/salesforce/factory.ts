import type { CrmClient, CrmClientFactory, CrmOAuthTokens, CrmProvider } from '../types';
import { SalesforceCrmClient } from './client';

export const salesforceFactory: CrmClientFactory = {
    provider: 'salesforce' as CrmProvider,
    create(opts: {
        accessToken: string;
        refreshToken?: string | null;
        instanceUrl?: string | null;
        onTokensRefreshed?: (tokens: CrmOAuthTokens) => Promise<void>;
    }): CrmClient {
        return new SalesforceCrmClient({
            accessToken: opts.accessToken,
            refreshToken: opts.refreshToken ?? null,
            instanceUrl: opts.instanceUrl ?? null,
            onTokensRefreshed: opts.onTokensRefreshed,
        });
    },
};
