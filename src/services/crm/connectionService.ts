/**
 * CRM connection persistence — the only thing in Phase 1 that touches
 * the database for CRM concerns. Owns:
 *
 *   - Token encryption / decryption on the way to and from Postgres
 *   - Connection lifecycle (upsert on connect, mark expired on refresh
 *     failure, soft-disconnect on user revoke)
 *   - Active-connection lookup for the activity-push subscriber
 *   - Sync-history / push-queue summary reads for the dashboard
 *
 * Phase 2 / Phase 3 wire in the actual provider clients but keep the
 * persistence layer here; nothing about HubSpot or Salesforce specifics
 * leaks into this file.
 */

import { prisma } from '../../index';
import { encrypt, decrypt } from '../../utils/encryption';
import { logger } from '../observabilityService';
import type {
    CrmConnectionStatus,
    CrmOAuthTokens,
    CrmProvider,
} from './types';

export interface ConnectionUpsertInput {
    organizationId: string;
    provider: CrmProvider;
    tokens: CrmOAuthTokens;
    externalAccountId?: string | null;
    externalAccountName?: string | null;
    instanceUrl?: string | null;
    connectedByUserId?: string | null;
}

export interface DecryptedConnection {
    id: string;
    organizationId: string;
    provider: CrmProvider;
    accessToken: string;          // decrypted
    refreshToken: string | null;  // decrypted, may be null
    tokenExpiresAt: Date | null;
    scopes: string[];
    externalAccountId: string | null;
    externalAccountName: string | null;
    instanceUrl: string | null;
    status: CrmConnectionStatus;
    lastError: string | null;
    connectedAt: Date;
    lastSyncAt: Date | null;
    disconnectedAt: Date | null;
}

function toScopesArray(s: string | null | undefined): string[] {
    if (!s) return [];
    return s.split(/\s+/).filter(Boolean);
}

function decryptConnection(row: any): DecryptedConnection {
    return {
        id: row.id,
        organizationId: row.organization_id,
        provider: row.provider as CrmProvider,
        accessToken: decrypt(row.access_token),
        refreshToken: row.refresh_token ? decrypt(row.refresh_token) : null,
        tokenExpiresAt: row.token_expires_at,
        scopes: toScopesArray(row.scopes),
        externalAccountId: row.external_account_id,
        externalAccountName: row.external_account_name,
        instanceUrl: row.instance_url,
        status: row.status as CrmConnectionStatus,
        lastError: row.last_error,
        connectedAt: row.connected_at,
        lastSyncAt: row.last_sync_at,
        disconnectedAt: row.disconnected_at,
    };
}

/**
 * Insert or update the (org, provider) connection. Called from the
 * OAuth callback handler in Phase 2/3. Existing rows for the same
 * (org, provider) pair are updated in place — there's never more than
 * one active connection per provider per org.
 */
export async function upsertConnection(input: ConnectionUpsertInput): Promise<DecryptedConnection> {
    const data = {
        organization_id: input.organizationId,
        provider: input.provider,
        access_token: encrypt(input.tokens.access_token),
        refresh_token: input.tokens.refresh_token ? encrypt(input.tokens.refresh_token) : null,
        token_expires_at: input.tokens.expires_at ?? null,
        scopes: input.tokens.scopes ? input.tokens.scopes.join(' ') : null,
        external_account_id: input.externalAccountId ?? null,
        external_account_name: input.externalAccountName ?? null,
        instance_url: input.instanceUrl ?? null,
        status: 'active' as CrmConnectionStatus,
        last_error: null,
        disconnected_at: null,
        connected_by_user_id: input.connectedByUserId ?? null,
    };

    const row = await prisma.crmConnection.upsert({
        where: {
            organization_id_provider: {
                organization_id: input.organizationId,
                provider: input.provider,
            },
        },
        create: { ...data, connected_at: new Date() },
        update: { ...data, connected_at: new Date() },
    });

    logger.info('[CRM] connection upserted', {
        orgId: input.organizationId,
        provider: input.provider,
        connectionId: row.id,
    });

    return decryptConnection(row);
}

/** Look up a single connection by ID (with auth-side ownership check). */
export async function getConnection(id: string, organizationId: string): Promise<DecryptedConnection | null> {
    const row = await prisma.crmConnection.findFirst({
        where: { id, organization_id: organizationId },
    });
    return row ? decryptConnection(row) : null;
}

/** All connections for an org (active and disconnected) — for the dashboard. */
export async function listConnectionsForOrg(organizationId: string): Promise<DecryptedConnection[]> {
    const rows = await prisma.crmConnection.findMany({
        where: { organization_id: organizationId },
        orderBy: { connected_at: 'desc' },
    });
    return rows.map(decryptConnection);
}

/**
 * Active connections only — used by the activity-push subscriber on
 * the hot path. `status='active'` AND `disconnected_at IS NULL`. Returns
 * a minimal shape (no decrypted tokens) since the subscriber only
 * needs the connection ID + provider.
 */
export async function listActiveConnectionIdsForOrg(organizationId: string): Promise<Array<{
    id: string;
    provider: CrmProvider;
}>> {
    const rows = await prisma.crmConnection.findMany({
        where: {
            organization_id: organizationId,
            status: 'active',
            disconnected_at: null,
        },
        select: { id: true, provider: true },
    });
    return rows.map(r => ({ id: r.id, provider: r.provider as CrmProvider }));
}

/**
 * Persist a refreshed token bundle. Called by clients that detect a 401
 * and successfully refresh against the provider — keeps Postgres in sync
 * with the live token state so the next request doesn't re-refresh.
 */
export async function updateRefreshedTokens(
    connectionId: string,
    tokens: CrmOAuthTokens,
): Promise<void> {
    await prisma.crmConnection.update({
        where: { id: connectionId },
        data: {
            access_token: encrypt(tokens.access_token),
            refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined,
            token_expires_at: tokens.expires_at ?? null,
            status: 'active',
            last_error: null,
        },
    });
}

/**
 * Mark a connection as expired/error. Called when refresh fails or the
 * provider returns a permanent 401. The dashboard surfaces a "Reconnect"
 * action; the activity-push worker stops queuing for this connection.
 */
export async function markConnectionFailed(
    connectionId: string,
    status: 'error' | 'expired',
    error: string,
): Promise<void> {
    await prisma.crmConnection.update({
        where: { id: connectionId },
        data: { status, last_error: error.slice(0, 500) },
    });
    logger.warn('[CRM] connection marked failed', { connectionId, status, error });
}

/**
 * User-initiated disconnect. Soft-delete pattern: keep the row for
 * audit, blank the tokens, set disconnected_at. Cascade-deletes
 * field mappings, contact links, and pending push items via the FK.
 */
export async function disconnect(connectionId: string, organizationId: string): Promise<void> {
    const row = await prisma.crmConnection.findFirst({
        where: { id: connectionId, organization_id: organizationId },
    });
    if (!row) return;

    await prisma.crmConnection.update({
        where: { id: connectionId },
        data: {
            status: 'disconnected',
            disconnected_at: new Date(),
            // Wipe encrypted token blobs so a leaked DB dump can't be replayed.
            access_token: encrypt(''),
            refresh_token: null,
            token_expires_at: null,
        },
    });

    // Cancel pending activity pushes for this connection (no point pushing
    // to a CRM we no longer have credentials for).
    await prisma.crmActivityPushItem.updateMany({
        where: { crm_connection_id: connectionId, state: 'pending' },
        data: { state: 'skipped', last_error: 'Connection disconnected' },
    });

    logger.info('[CRM] connection disconnected', { connectionId, orgId: organizationId });
}

/**
 * Activity-push counts for the dashboard. Cheap aggregate — backs
 * the connection-card status pills.
 */
export async function getActivityPushSummary(connectionId: string): Promise<{
    pending: number;
    pushed: number;
    failed: number;
    skipped: number;
}> {
    const counts = await prisma.crmActivityPushItem.groupBy({
        by: ['state'],
        where: { crm_connection_id: connectionId },
        _count: { _all: true },
    });
    const out = { pending: 0, pushed: 0, failed: 0, skipped: 0 };
    for (const c of counts) {
        if (c.state in out) (out as any)[c.state] = c._count._all;
    }
    return out;
}

/**
 * Recent sync jobs for the dashboard sync-history table.
 */
export async function listRecentSyncJobs(connectionId: string, limit = 25) {
    return prisma.crmSyncJob.findMany({
        where: { crm_connection_id: connectionId },
        orderBy: { created_at: 'desc' },
        take: limit,
    });
}
