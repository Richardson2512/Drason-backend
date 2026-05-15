/**
 * Lead-source connection persistence layer. Owns:
 *
 *   - API-key encryption / decryption
 *   - Connection lifecycle (upsert on connect, mark expired on
 *     validation failure, soft-disconnect on revoke)
 *   - Active-connection lookup for workers
 *   - Job-history reads for the dashboard
 *
 * Provider-blind - nothing about Apollo/ZoomInfo specifics leaks here.
 */

import { prisma } from '../../prisma';
import { encrypt, decrypt } from '../../utils/encryption';
import { logger } from '../observabilityService';
import type {
    LeadSourceConnectionStatus,
    LeadSourceProvider,
} from './types';

export interface DecryptedLeadSourceConnection {
    id: string;
    organizationId: string;
    provider: LeadSourceProvider;
    apiKey: string; // decrypted
    status: LeadSourceConnectionStatus;
    externalAccountName: string | null;
    externalAccountId: string | null;
    lastValidatedAt: Date | null;
    lastUsedAt: Date | null;
    lastError: string | null;
    connectedAt: Date;
    disconnectedAt: Date | null;
}

function decryptConnection(row: any): DecryptedLeadSourceConnection {
    return {
        id: row.id,
        organizationId: row.organization_id,
        provider: row.provider as LeadSourceProvider,
        apiKey: decrypt(row.api_key_encrypted),
        status: row.status as LeadSourceConnectionStatus,
        externalAccountName: row.external_account_name,
        externalAccountId: row.external_account_id,
        lastValidatedAt: row.last_validated_at,
        lastUsedAt: row.last_used_at,
        lastError: row.last_error,
        connectedAt: row.connected_at,
        disconnectedAt: row.disconnected_at,
    };
}

export interface UpsertLeadSourceInput {
    organizationId: string;
    provider: LeadSourceProvider;
    apiKey: string;
    externalAccountId?: string | null;
    externalAccountName?: string | null;
    connectedByUserId?: string | null;
}

export async function upsertLeadSourceConnection(
    input: UpsertLeadSourceInput,
): Promise<DecryptedLeadSourceConnection> {
    const data = {
        organization_id: input.organizationId,
        provider: input.provider,
        api_key_encrypted: encrypt(input.apiKey),
        status: 'active' as LeadSourceConnectionStatus,
        external_account_id: input.externalAccountId ?? null,
        external_account_name: input.externalAccountName ?? null,
        last_validated_at: new Date(),
        last_error: null,
        disconnected_at: null,
        connected_by_user_id: input.connectedByUserId ?? null,
    };

    const row = await prisma.leadSourceConnection.upsert({
        where: {
            organization_id_provider: {
                organization_id: input.organizationId,
                provider: input.provider,
            },
        },
        create: { ...data, connected_at: new Date() },
        update: { ...data, connected_at: new Date() },
    });

    logger.info('[LEAD_SOURCE] connection upserted', {
        orgId: input.organizationId,
        provider: input.provider,
        connectionId: row.id,
    });

    return decryptConnection(row);
}

export async function getLeadSourceConnection(
    id: string,
    organizationId: string,
): Promise<DecryptedLeadSourceConnection | null> {
    const row = await prisma.leadSourceConnection.findFirst({
        where: { id, organization_id: organizationId },
    });
    return row ? decryptConnection(row) : null;
}

export async function getLeadSourceConnectionByProvider(
    organizationId: string,
    provider: LeadSourceProvider,
): Promise<DecryptedLeadSourceConnection | null> {
    const row = await prisma.leadSourceConnection.findUnique({
        where: { organization_id_provider: { organization_id: organizationId, provider } },
    });
    return row && row.status === 'active' && !row.disconnected_at ? decryptConnection(row) : null;
}

export async function listLeadSourceConnectionsForOrg(
    organizationId: string,
): Promise<DecryptedLeadSourceConnection[]> {
    const rows = await prisma.leadSourceConnection.findMany({
        where: { organization_id: organizationId },
        orderBy: { connected_at: 'desc' },
    });
    return rows.map(decryptConnection);
}

export async function markLeadSourceConnectionFailed(
    connectionId: string,
    status: 'error' | 'expired',
    error: string,
): Promise<void> {
    await prisma.leadSourceConnection.update({
        where: { id: connectionId },
        data: { status, last_error: error.slice(0, 500) },
    });
    logger.warn('[LEAD_SOURCE] connection marked failed', { connectionId, status, error: error.slice(0, 200) });
}

export async function disconnectLeadSource(
    connectionId: string,
    organizationId: string,
): Promise<void> {
    const row = await prisma.leadSourceConnection.findFirst({
        where: { id: connectionId, organization_id: organizationId },
    });
    if (!row) return;

    await prisma.leadSourceConnection.update({
        where: { id: connectionId },
        data: {
            status: 'disconnected',
            disconnected_at: new Date(),
            // Wipe the encrypted API key so a leaked DB dump can't replay it.
            api_key_encrypted: encrypt(''),
        },
    });

    // Cancel pending imports for this connection.
    await prisma.leadSourceImportJob.updateMany({
        where: {
            lead_source_connection_id: connectionId,
            state: { in: ['pending', 'running'] },
        },
        data: { state: 'cancelled', error_message: 'Connection disconnected' },
    });

    logger.info('[LEAD_SOURCE] connection disconnected', { connectionId, orgId: organizationId });
}

/** Recent import jobs for the dashboard sync-history table. */
export async function listRecentImportJobs(connectionId: string, limit = 25) {
    return prisma.leadSourceImportJob.findMany({
        where: { lead_source_connection_id: connectionId },
        orderBy: { created_at: 'desc' },
        take: limit,
    });
}
