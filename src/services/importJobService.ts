/**
 * Import Job Service
 *
 * Manages the one-time-import lifecycle for migrating customers off competing
 * platforms (Smartlead today; Instantly + EmailBison later). Holds the
 * customer-supplied admin API key encrypted at rest, with a strict TTL:
 *
 *   - Initial paste sets `import_key_expires_at = now + 72h` (hard ceiling).
 *   - Import completion shrinks it to `min(expires_at, now + 24h)`.
 *   - Customer can `discardKeyNow()` at any time for an immediate wipe.
 *   - `importKeyTtlWorker` sweeps every 15 minutes and nulls expired keys.
 *
 * The plaintext key never leaves this module's `getDecryptedImportKey()` —
 * callers receive the decrypted string only when they're about to make an
 * outbound API call.
 */

import { prisma } from '../index';
import { encrypt, decrypt } from '../utils/encryption';
import { logger } from './observabilityService';

const HARD_CEILING_HOURS  = 72;  // Max time we ever hold the key (from paste)
const POST_COMPLETION_HOURS = 24; // Hold time after a successful/failed import

const SUPPORTED_PLATFORMS = ['smartlead', 'instantly', 'emailbison'] as const;
export type ImportPlatform = typeof SUPPORTED_PLATFORMS[number];

export interface ImportKeyStatus {
    connected: boolean;
    platform: ImportPlatform | null;
    expiresAt: Date | null;
    minutesRemaining: number | null;
}

const hoursFromNow = (h: number): Date => new Date(Date.now() + h * 60 * 60 * 1000);

const writeAudit = async (
    orgId: string,
    action: string,
    details: Record<string, unknown> = {},
): Promise<void> => {
    try {
        await prisma.auditLog.create({
            data: {
                organization_id: orgId,
                entity: 'import_key',
                trigger: 'system',
                action,
                details: JSON.stringify(details),
            },
        });
    } catch (err) {
        // Audit failure must not block the security-critical operation.
        logger.error('[IMPORT-JOB] AuditLog write failed', err as Error, { orgId, action });
    }
};

/**
 * Store an admin API key for a one-time import. Sets the 72h hard ceiling.
 * Called when the customer pastes their key in step 1 of the wizard.
 */
export const setImportKey = async (
    orgId: string,
    platform: ImportPlatform,
    plaintextKey: string,
): Promise<{ expiresAt: Date }> => {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
        throw new Error(`Unsupported import platform: ${platform}`);
    }
    if (!plaintextKey || plaintextKey.trim().length < 8) {
        throw new Error('Invalid API key — too short');
    }

    const expiresAt = hoursFromNow(HARD_CEILING_HOURS);
    const encrypted = encrypt(plaintextKey.trim());

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            import_source_platform: platform,
            import_source_key_encrypted: encrypted,
            import_key_expires_at: expiresAt,
        },
    });

    await writeAudit(orgId, 'stored', {
        platform,
        expiresAt: expiresAt.toISOString(),
        ttlHours: HARD_CEILING_HOURS,
    });

    logger.info('[IMPORT-JOB] Key stored', { orgId, platform, expiresAt });
    return { expiresAt };
};

/**
 * Decrypt and return the stored key for outbound API calls. Returns null
 * if no key is held or if it has expired (sweep worker will null it on its
 * next tick — this read-time check is the belt to that suspenders).
 */
export const getDecryptedImportKey = async (
    orgId: string,
): Promise<{ platform: ImportPlatform; key: string } | null> => {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            import_source_platform: true,
            import_source_key_encrypted: true,
            import_key_expires_at: true,
        },
    });
    if (!org?.import_source_key_encrypted || !org.import_source_platform) return null;
    if (org.import_key_expires_at && org.import_key_expires_at.getTime() < Date.now()) {
        return null;
    }
    return {
        platform: org.import_source_platform as ImportPlatform,
        key: decrypt(org.import_source_key_encrypted),
    };
};

/**
 * Tighten the TTL after the import job reaches a terminal state. Shortens
 * the expiry to `min(current, now + 24h)`. Customers get a 24h retry window
 * if they spot an issue, but the key isn't held for the full 72h ceiling.
 */
export const shrinkTtlAfterCompletion = async (orgId: string): Promise<void> => {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { import_key_expires_at: true },
    });
    if (!org?.import_key_expires_at) return;

    const candidate = hoursFromNow(POST_COMPLETION_HOURS);
    if (candidate.getTime() >= org.import_key_expires_at.getTime()) return;

    await prisma.organization.update({
        where: { id: orgId },
        data: { import_key_expires_at: candidate },
    });
    await writeAudit(orgId, 'ttl_shortened_after_completion', {
        newExpiresAt: candidate.toISOString(),
        ttlHours: POST_COMPLETION_HOURS,
    });
};

/**
 * Customer-triggered immediate wipe. Clears all three columns and audits.
 */
export const discardKeyNow = async (orgId: string, userId?: string): Promise<void> => {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { import_source_platform: true, import_source_key_encrypted: true },
    });
    if (!org?.import_source_key_encrypted) return; // Nothing to wipe.

    await prisma.organization.update({
        where: { id: orgId },
        data: {
            import_source_platform: null,
            import_source_key_encrypted: null,
            import_key_expires_at: null,
        },
    });
    await writeAudit(orgId, 'discarded_by_user', {
        platform: org.import_source_platform,
        userId: userId || null,
    });
    logger.info('[IMPORT-JOB] Key discarded by user', { orgId });
};

/**
 * Sweep operation — used by importKeyTtlWorker. Returns the number of orgs
 * whose keys were nulled.
 */
export const sweepExpiredKeys = async (): Promise<number> => {
    const expired = await prisma.organization.findMany({
        where: {
            import_source_key_encrypted: { not: null },
            import_key_expires_at: { lt: new Date() },
        },
        select: { id: true, import_source_platform: true, import_key_expires_at: true },
    });

    for (const org of expired) {
        await prisma.organization.update({
            where: { id: org.id },
            data: {
                import_source_platform: null,
                import_source_key_encrypted: null,
                import_key_expires_at: null,
            },
        });
        await writeAudit(org.id, 'discarded_by_ttl', {
            platform: org.import_source_platform,
            originalExpiry: org.import_key_expires_at?.toISOString() || null,
        });
    }

    if (expired.length > 0) {
        logger.info(`[IMPORT-JOB] TTL sweep wiped ${expired.length} expired key(s)`);
    }
    return expired.length;
};

/**
 * Read-only status for the wizard UI.
 */
export const getKeyStatus = async (orgId: string): Promise<ImportKeyStatus> => {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            import_source_platform: true,
            import_source_key_encrypted: true,
            import_key_expires_at: true,
        },
    });
    if (!org?.import_source_key_encrypted) {
        return { connected: false, platform: null, expiresAt: null, minutesRemaining: null };
    }
    const minutesRemaining = org.import_key_expires_at
        ? Math.max(0, Math.floor((org.import_key_expires_at.getTime() - Date.now()) / 60000))
        : null;
    return {
        connected: true,
        platform: (org.import_source_platform as ImportPlatform) || null,
        expiresAt: org.import_key_expires_at,
        minutesRemaining,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// ImportJob lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export type ImportJobStatus =
    | 'pending'
    | 'running'
    | 'paused_source'
    | 'complete'
    | 'failed'
    | 'cancelled';

export interface ImportJobStats {
    campaignsFound?: number;
    sequencesImported?: number;
    variantsImported?: number;
    leadsImported?: number;
    leadsSkippedInFlight?: number;
    mailboxesFound?: number;
    [key: string]: unknown;
}

export const createImportJob = async (
    orgId: string,
    platform: ImportPlatform,
    config?: {
        mode?: 'conservative' | 'aggressive';
        includeRecentContacts?: boolean;
    },
): Promise<{ id: string }> => {
    const mode = config?.mode === 'aggressive' ? 'aggressive' : 'conservative';
    const includeRecent = !!config?.includeRecentContacts && mode === 'aggressive';

    const job = await prisma.importJob.create({
        data: {
            organization_id: orgId,
            platform,
            status: 'pending',
            mode,
            include_recent_contacts: includeRecent,
        },
        select: { id: true },
    });
    await writeAudit(orgId, 'job_created', {
        jobId: job.id,
        platform,
        mode,
        includeRecentContacts: includeRecent,
    });
    return job;
};

export const updateImportJob = async (
    jobId: string,
    patch: {
        status?: ImportJobStatus;
        statsPatch?: ImportJobStats;
        error?: string | null;
        markStarted?: boolean;
        markCompleted?: boolean;
    },
): Promise<void> => {
    const data: Record<string, unknown> = {};
    if (patch.status) data.status = patch.status;
    if (patch.error !== undefined) data.error = patch.error;
    if (patch.markStarted) data.started_at = new Date();
    if (patch.markCompleted) data.completed_at = new Date();

    if (patch.statsPatch) {
        const current = await prisma.importJob.findUnique({
            where: { id: jobId },
            select: { stats: true },
        });
        const merged = { ...(current?.stats as object || {}), ...patch.statsPatch };
        data.stats = merged;
    }

    await prisma.importJob.update({ where: { id: jobId }, data });
};

export const getLatestImportJob = async (
    orgId: string,
): Promise<{
    id: string;
    platform: string;
    status: string;
    stats: unknown;
    error: string | null;
    started_at: Date | null;
    completed_at: Date | null;
    created_at: Date;
} | null> => {
    return prisma.importJob.findFirst({
        where: { organization_id: orgId },
        orderBy: { created_at: 'desc' },
        select: {
            id: true,
            platform: true,
            status: true,
            stats: true,
            error: true,
            started_at: true,
            completed_at: true,
            created_at: true,
        },
    });
};
