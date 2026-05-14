/**
 * Unipile Accounts API — typed wrappers around the connected-accounts surface.
 * Hosted-auth flow + lifecycle calls for LinkedIn accounts specifically.
 *
 * See https://developer.unipile.com/reference/accountscontroller_listaccounts
 * and https://www.unipile.com/developer-auth-on-behalf/
 */

import { unipileRequest } from './client';

// ────────────────────────────────────────────────────────────────────
// Shapes — narrow to the fields we actually consume
// ────────────────────────────────────────────────────────────────────

export interface UnipileAccount {
    id: string;
    /** e.g. 'LINKEDIN' (Unipile uses uppercase provider codes) */
    provider: string;
    /** Display name picked at connect time; falls back to the LinkedIn profile name */
    name?: string;
    /** Account status — mirrors the webhook event taxonomy */
    status?: 'OK' | 'CREDENTIALS' | 'ERROR' | 'CONNECTING' | 'SYNC_SUCCESS' | 'DELETED';
    /** LinkedIn-specific account class — 'CLASSIC' | 'PREMIUM' | 'SALES_NAV' | 'RECRUITER' */
    type?: string;
    /** ISO timestamp */
    created_at?: string;
    /** Provider-side member URN if exposed */
    sources?: Array<{ id: string; status: string }>;
}

export interface ListAccountsResponse {
    object: 'AccountList';
    items: UnipileAccount[];
    cursor?: string;
}

export interface HostedAuthLinkRequest {
    /** 'create' for new connection, 'reconnect' to refresh existing creds */
    type: 'create' | 'reconnect';
    /** Restrict the hosted UI to LinkedIn-only when wiring Super LinkedIn */
    providers: 'LINKEDIN'[];
    /** Where Unipile redirects the user on success / failure */
    success_redirect_url: string;
    failure_redirect_url: string;
    /** Opaque string echoed back to our callbacks — we use it to find the org */
    name?: string;
    /** Server-to-server callback (in addition to redirect) */
    notify_url?: string;
    /** Unix-ms expiration of the auth link */
    expiresOn?: number;
    /** For 'reconnect' — the account_id whose session to refresh */
    reconnect_account?: string;
}

export interface HostedAuthLinkResponse {
    object: 'HostedAuthURL';
    url: string;
}

// ────────────────────────────────────────────────────────────────────
// API calls
// ────────────────────────────────────────────────────────────────────

/**
 * List all connected accounts under the workspace's API key.
 * Filter to LinkedIn on the call site — Unipile mixes providers in one list.
 */
export async function listAccounts(): Promise<ListAccountsResponse> {
    return unipileRequest<ListAccountsResponse>({
        method: 'GET',
        path: '/accounts',
        tag: 'unipile.listAccounts',
    });
}

/**
 * Fetch one account by ID.
 */
export async function getAccount(accountId: string): Promise<UnipileAccount> {
    return unipileRequest<UnipileAccount>({
        method: 'GET',
        path: `/accounts/${encodeURIComponent(accountId)}`,
        tag: 'unipile.getAccount',
    });
}

/**
 * Generate a hosted-auth link the end-user opens to connect (or reconnect)
 * their LinkedIn account. Unipile holds the LinkedIn session server-side;
 * we only ever see the resulting `account_id`.
 */
export async function createHostedAuthLink(req: HostedAuthLinkRequest): Promise<HostedAuthLinkResponse> {
    return unipileRequest<HostedAuthLinkResponse>({
        method: 'POST',
        path: '/hosted/accounts/link',
        body: req,
        tag: 'unipile.createHostedAuthLink',
    });
}

/**
 * Disconnect an account — Unipile invalidates the session + stops sync.
 * Idempotent: returns success even if the account is already gone.
 */
export async function deleteAccount(accountId: string): Promise<void> {
    await unipileRequest({
        method: 'DELETE',
        path: `/accounts/${encodeURIComponent(accountId)}`,
        tag: 'unipile.deleteAccount',
    });
}
