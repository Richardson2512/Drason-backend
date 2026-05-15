/**
 * Outreach connection persistence - owns:
 *   - Token encryption / decryption (AES-256-GCM via utils/encryption)
 *   - Upsert on connect, refresh-token write-back, soft-disconnect
 *   - Active connection lookup for the worker
 */

import { prisma } from '../../prisma';
import { encrypt, decrypt } from '../../utils/encryption';
import { logger } from '../observabilityService';

export interface DecryptedOutreachConnection {
    id: string;
    organizationId: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: Date;
    scopes: string | null;
    outreachUserId: string | null;
    outreachUserEmail: string | null;
    outreachOrgName: string | null;
    status: string;
    lastValidatedAt: Date | null;
    lastUsedAt: Date | null;
    lastError: string | null;
    connectedAt: Date;
    disconnectedAt: Date | null;
}

function decryptRow(row: any): DecryptedOutreachConnection {
    return {
        id: row.id,
        organizationId: row.organization_id,
        accessToken: decrypt(row.access_token),
        refreshToken: decrypt(row.refresh_token),
        tokenExpiresAt: row.token_expires_at,
        scopes: row.scopes,
        outreachUserId: row.outreach_user_id,
        outreachUserEmail: row.outreach_user_email,
        outreachOrgName: row.outreach_org_name,
        status: row.status,
        lastValidatedAt: row.last_validated_at,
        lastUsedAt: row.last_used_at,
        lastError: row.last_error,
        connectedAt: row.connected_at,
        disconnectedAt: row.disconnected_at,
    };
}

export interface UpsertOutreachInput {
    organizationId: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: Date;
    scopes?: string[];
    outreachUserId?: string | null;
    outreachUserEmail?: string | null;
    outreachOrgName?: string | null;
    connectedByUserId?: string | null;
}

export async function upsertOutreachConnection(
    input: UpsertOutreachInput,
): Promise<DecryptedOutreachConnection> {
    const data = {
        organization_id: input.organizationId,
        access_token: encrypt(input.accessToken),
        refresh_token: encrypt(input.refreshToken),
        token_expires_at: input.tokenExpiresAt,
        scopes: input.scopes?.join(' ') ?? null,
        outreach_user_id: input.outreachUserId ?? null,
        outreach_user_email: input.outreachUserEmail ?? null,
        outreach_org_name: input.outreachOrgName ?? null,
        status: 'active',
        last_validated_at: new Date(),
        last_error: null,
        disconnected_at: null,
        connected_by_user_id: input.connectedByUserId ?? null,
    };

    const row = await prisma.outreachConnection.upsert({
        where: { organization_id: input.organizationId },
        create: { ...data, connected_at: new Date() },
        update: { ...data, connected_at: new Date() },
    });

    logger.info('[OUTREACH] connection upserted', {
        orgId: input.organizationId,
        connectionId: row.id,
        outreachUserId: input.outreachUserId,
    });

    return decryptRow(row);
}

export async function getOutreachConnection(
    id: string,
    organizationId: string,
): Promise<DecryptedOutreachConnection | null> {
    const row = await prisma.outreachConnection.findFirst({
        where: { id, organization_id: organizationId },
    });
    return row ? decryptRow(row) : null;
}

export async function getActiveOutreachConnection(
    organizationId: string,
): Promise<DecryptedOutreachConnection | null> {
    const row = await prisma.outreachConnection.findUnique({
        where: { organization_id: organizationId },
    });
    if (!row || row.status !== 'active' || row.disconnected_at) return null;
    return decryptRow(row);
}

export async function updateRefreshedTokens(
    connectionId: string,
    fresh: { accessToken: string; refreshToken: string; tokenExpiresAt: Date },
): Promise<void> {
    await prisma.outreachConnection.update({
        where: { id: connectionId },
        data: {
            access_token: encrypt(fresh.accessToken),
            refresh_token: encrypt(fresh.refreshToken),
            token_expires_at: fresh.tokenExpiresAt,
            last_used_at: new Date(),
            status: 'active',
            last_error: null,
        },
    });
}

export async function markOutreachConnectionFailed(
    connectionId: string,
    status: 'error' | 'expired',
    error: string,
): Promise<void> {
    await prisma.outreachConnection.update({
        where: { id: connectionId },
        data: { status, last_error: error.slice(0, 500) },
    });
    logger.warn('[OUTREACH] connection marked failed', { connectionId, status, error: error.slice(0, 200) });
}

export async function disconnectOutreach(
    connectionId: string,
    organizationId: string,
): Promise<void> {
    const row = await prisma.outreachConnection.findFirst({
        where: { id: connectionId, organization_id: organizationId },
    });
    if (!row) return;

    await prisma.outreachConnection.update({
        where: { id: connectionId },
        data: {
            status: 'disconnected',
            disconnected_at: new Date(),
            // Wipe encrypted tokens so a leaked DB dump can't replay them.
            access_token: encrypt(''),
            refresh_token: encrypt(''),
        },
    });

    await prisma.outreachExportJob.updateMany({
        where: {
            outreach_connection_id: connectionId,
            state: { in: ['pending', 'running'] },
        },
        data: { state: 'cancelled', error_message: 'Connection disconnected' },
    });

    logger.info('[OUTREACH] connection disconnected', { connectionId, orgId: organizationId });
}

export async function listRecentExportJobs(connectionId: string, limit = 25) {
    return prisma.outreachExportJob.findMany({
        where: { outreach_connection_id: connectionId },
        orderBy: { created_at: 'desc' },
        take: limit,
    });
}
