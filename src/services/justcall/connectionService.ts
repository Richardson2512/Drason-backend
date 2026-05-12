/**
 * JustCall connection persistence — owns:
 *   - Credential encryption / decryption (AES-256-GCM via utils/encryption)
 *   - Upsert on connect, soft-disconnect with credential wipe
 *   - Active-connection lookup for the export worker
 *
 * Mirrors the OutreachConnection service shape so the dashboard's
 * "Connected as ..." UX is the same across both integrations. The only
 * structural difference is the auth model: JustCall stores api_key +
 * api_secret instead of access_token + refresh_token.
 */

import { prisma } from '../../index';
import { encrypt, decrypt } from '../../utils/encryption';
import { logger } from '../observabilityService';

export interface DecryptedJustCallConnection {
    id: string;
    organizationId: string;
    apiKey: string;
    apiSecret: string;
    justCallUserId: string | null;
    justCallUserEmail: string | null;
    justCallAccountName: string | null;
    status: string;
    lastValidatedAt: Date | null;
    lastUsedAt: Date | null;
    lastError: string | null;
    connectedAt: Date;
    disconnectedAt: Date | null;
}

function decryptRow(row: any): DecryptedJustCallConnection {
    return {
        id: row.id,
        organizationId: row.organization_id,
        apiKey: decrypt(row.api_key),
        apiSecret: decrypt(row.api_secret),
        justCallUserId: row.justcall_user_id,
        justCallUserEmail: row.justcall_user_email,
        justCallAccountName: row.justcall_account_name,
        status: row.status,
        lastValidatedAt: row.last_validated_at,
        lastUsedAt: row.last_used_at,
        lastError: row.last_error,
        connectedAt: row.connected_at,
        disconnectedAt: row.disconnected_at,
    };
}

export interface UpsertJustCallInput {
    organizationId: string;
    apiKey: string;
    apiSecret: string;
    justCallUserId?: string | null;
    justCallUserEmail?: string | null;
    justCallAccountName?: string | null;
    connectedByUserId?: string | null;
}

export async function upsertJustCallConnection(
    input: UpsertJustCallInput,
): Promise<DecryptedJustCallConnection> {
    const data = {
        organization_id: input.organizationId,
        api_key: encrypt(input.apiKey),
        api_secret: encrypt(input.apiSecret),
        justcall_user_id: input.justCallUserId ?? null,
        justcall_user_email: input.justCallUserEmail ?? null,
        justcall_account_name: input.justCallAccountName ?? null,
        status: 'active',
        last_validated_at: new Date(),
        last_error: null,
        disconnected_at: null,
        connected_by_user_id: input.connectedByUserId ?? null,
    };

    const row = await prisma.justCallConnection.upsert({
        where: { organization_id: input.organizationId },
        create: { ...data, connected_at: new Date() },
        update: { ...data, connected_at: new Date() },
    });

    logger.info('[JUSTCALL] connection upserted', {
        orgId: input.organizationId,
        connectionId: row.id,
        justCallUserId: input.justCallUserId,
    });

    return decryptRow(row);
}

export async function getJustCallConnection(
    id: string,
    organizationId: string,
): Promise<DecryptedJustCallConnection | null> {
    const row = await prisma.justCallConnection.findFirst({
        where: { id, organization_id: organizationId },
    });
    return row ? decryptRow(row) : null;
}

export async function getActiveJustCallConnection(
    organizationId: string,
): Promise<DecryptedJustCallConnection | null> {
    const row = await prisma.justCallConnection.findUnique({
        where: { organization_id: organizationId },
    });
    if (!row || row.status !== 'active' || row.disconnected_at) return null;
    return decryptRow(row);
}

export async function markJustCallConnectionFailed(
    connectionId: string,
    organizationId: string,
    error: string,
): Promise<void> {
    // Composite filter — `updateMany` instead of `update` so a stale
    // connection_id pulled from another tenant's queue payload can never
    // touch this row. Returns count=0 silently in that case.
    const result = await prisma.justCallConnection.updateMany({
        where: { id: connectionId, organization_id: organizationId },
        data: { status: 'error', last_error: error.slice(0, 500) },
    });
    if (result.count === 0) {
        logger.warn('[JUSTCALL] markJustCallConnectionFailed — no row matched (cross-tenant or deleted)', {
            connectionId, organizationId,
        });
        return;
    }
    logger.warn('[JUSTCALL] connection marked failed', { connectionId, organizationId, error: error.slice(0, 200) });
}

export async function disconnectJustCall(
    connectionId: string,
    organizationId: string,
): Promise<void> {
    const row = await prisma.justCallConnection.findFirst({
        where: { id: connectionId, organization_id: organizationId },
    });
    if (!row) return;

    await prisma.justCallConnection.update({
        where: { id: connectionId },
        data: {
            status: 'disconnected',
            disconnected_at: new Date(),
            // Wipe encrypted credentials so a leaked DB dump can't replay them.
            api_key: encrypt(''),
            api_secret: encrypt(''),
        },
    });

    await prisma.justCallExportJob.updateMany({
        where: {
            justcall_connection_id: connectionId,
            state: { in: ['pending', 'running'] },
        },
        data: { state: 'cancelled', error_message: 'Connection disconnected' },
    });

    logger.info('[JUSTCALL] connection disconnected', { connectionId, orgId: organizationId });
}

export async function listRecentJustCallExportJobs(connectionId: string, limit = 25) {
    return prisma.justCallExportJob.findMany({
        where: { justcall_connection_id: connectionId },
        orderBy: { created_at: 'desc' },
        take: limit,
    });
}
