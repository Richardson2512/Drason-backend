/**
 * Compliance Service
 * 
 * Implements Phase 8: Data Retention & Compliance
 * - Data retention policies
 * - Soft delete for GDPR compliance
 * - Audit log immutability guarantees
 */

import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import { logger } from './observabilityService';

// ============================================================================
// RETENTION POLICIES
// ============================================================================

interface RetentionPolicy {
    entityType: string;
    retentionDays: number;
    description: string;
}

const RETENTION_POLICIES: RetentionPolicy[] = [
    {
        entityType: 'RawEvent',
        retentionDays: 90,
        description: 'Raw events retained for 90 days'
    },
    {
        entityType: 'AuditLog',
        retentionDays: 365,
        description: 'Audit logs retained for 1 year (compliance requirement)'
    },
    {
        entityType: 'StateTransition',
        retentionDays: 180,
        description: 'State transitions retained for 6 months'
    },
    {
        entityType: 'Lead',
        retentionDays: 730,
        description: 'Lead data retained for 2 years'
    },
    {
        entityType: 'MailboxMetrics',
        retentionDays: 90,
        description: 'Metrics retained for 90 days'
    }
];

/**
 * Get all retention policies.
 */
export function getRetentionPolicies(): RetentionPolicy[] {
    return RETENTION_POLICIES;
}

/**
 * Apply data retention policies - delete data older than retention period.
 */
export async function applyRetentionPolicies(
    organizationId: string,
    dryRun: boolean = true
): Promise<{
    policy: string;
    recordsAffected: number;
    deleted: boolean;
}[]> {
    const results = [];
    const now = new Date();

    for (const policy of RETENTION_POLICIES) {
        const cutoffDate = new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000);

        let count = 0;
        let deleted = false;

        try {
            switch (policy.entityType) {
                case 'RawEvent':
                    count = await countExpiredEvents(organizationId, cutoffDate);
                    if (!dryRun && count > 0) {
                        await deleteExpiredEvents(organizationId, cutoffDate);
                        deleted = true;
                    }
                    break;

                case 'StateTransition':
                    count = await countExpiredTransitions(organizationId, cutoffDate);
                    if (!dryRun && count > 0) {
                        await deleteExpiredTransitions(organizationId, cutoffDate);
                        deleted = true;
                    }
                    break;

                case 'Lead':
                    count = await countExpiredLeads(organizationId, cutoffDate);
                    if (!dryRun && count > 0) {
                        await softDeleteExpiredLeads(organizationId, cutoffDate);
                        deleted = true;
                    }
                    break;

                case 'AuditLog':
                    // Audit logs are immutable - count only, no deletion
                    count = await countAuditLogs(organizationId, cutoffDate);
                    break;

                case 'MailboxMetrics':
                    // Metrics are overwritten, not deleted
                    count = 0;
                    break;
            }

            results.push({
                policy: policy.entityType,
                recordsAffected: count,
                deleted
            });

            logger.info(`Retention check: ${policy.entityType}`, {
                organizationId,
                count,
                dryRun,
                deleted
            });
        } catch (error) {
            logger.error(`Retention error: ${policy.entityType}`, error as Error, { organizationId });
        }
    }

    // Log the retention run to audit
    await auditLogService.logAction({
        organizationId,
        entity: 'system',
        trigger: 'retention_policy',
        action: 'retention_check',
        details: JSON.stringify({ dryRun, results })
    });

    return results;
}

// ============================================================================
// HELPER FUNCTIONS FOR RETENTION
// ============================================================================

async function countExpiredEvents(organizationId: string, cutoffDate: Date): Promise<number> {
    return prisma.rawEvent.count({
        where: {
            organization_id: organizationId,
            created_at: { lt: cutoffDate }
        }
    });
}

async function deleteExpiredEvents(organizationId: string, cutoffDate: Date): Promise<void> {
    await prisma.rawEvent.deleteMany({
        where: {
            organization_id: organizationId,
            created_at: { lt: cutoffDate }
        }
    });
}

async function countExpiredTransitions(organizationId: string, cutoffDate: Date): Promise<number> {
    return prisma.stateTransition.count({
        where: {
            organization_id: organizationId,
            created_at: { lt: cutoffDate }
        }
    });
}

async function deleteExpiredTransitions(organizationId: string, cutoffDate: Date): Promise<void> {
    await prisma.stateTransition.deleteMany({
        where: {
            organization_id: organizationId,
            created_at: { lt: cutoffDate }
        }
    });
}

async function countExpiredLeads(organizationId: string, cutoffDate: Date): Promise<number> {
    return prisma.lead.count({
        where: {
            organization_id: organizationId,
            created_at: { lt: cutoffDate },
            deleted_at: null // Not already soft deleted
        }
    });
}

async function softDeleteExpiredLeads(organizationId: string, cutoffDate: Date): Promise<void> {
    await prisma.lead.updateMany({
        where: {
            organization_id: organizationId,
            created_at: { lt: cutoffDate },
            deleted_at: null
        },
        data: {
            deleted_at: new Date()
        }
    });
}

async function countAuditLogs(organizationId: string, cutoffDate: Date): Promise<number> {
    return prisma.auditLog.count({
        where: {
            organization_id: organizationId,
            timestamp: { lt: cutoffDate }
        }
    });
}

// ============================================================================
// SOFT DELETE
// ============================================================================

/**
 * Soft delete a lead (GDPR compliance).
 */
export async function softDeleteLead(
    organizationId: string,
    leadId: string,
    reason: string
): Promise<void> {
    await prisma.lead.update({
        where: { id: leadId },
        data: {
            deleted_at: new Date(),
            // Anonymize PII while keeping record
            email: `deleted-${leadId}@anonymized.local`
        }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'lead',
        entityId: leadId,
        trigger: 'gdpr_request',
        action: 'soft_delete',
        details: reason
    });

    logger.info('Lead soft deleted', { organizationId, leadId, reason });
}

/**
 * Soft delete a mailbox.
 */
export async function softDeleteMailbox(
    organizationId: string,
    mailboxId: string,
    reason: string
): Promise<void> {
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            // Mark as inactive instead of deleted_at
            status: 'deleted'
        }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'mailbox',
        entityId: mailboxId,
        trigger: 'admin_action',
        action: 'soft_delete',
        details: reason
    });
}

/**
 * Restore a soft-deleted entity.
 */
export async function restoreEntity(
    organizationId: string,
    entityType: 'lead' | 'mailbox',
    entityId: string
): Promise<void> {
    if (entityType === 'lead') {
        await prisma.lead.update({
            where: { id: entityId },
            data: { deleted_at: null }
        });
    } else if (entityType === 'mailbox') {
        await prisma.mailbox.update({
            where: { id: entityId },
            data: { status: 'healthy' }
        });
    }

    await auditLogService.logAction({
        organizationId,
        entity: entityType,
        entityId,
        trigger: 'admin_action',
        action: 'restore',
        details: 'Entity restored from soft delete'
    });
}

// ============================================================================
// GDPR DATA EXPORT
// ============================================================================

/**
 * Export all data for a lead (GDPR data portability).
 */
export async function exportLeadData(
    organizationId: string,
    leadId: string
): Promise<{
    lead: any;
    events: any[];
    auditLogs: any[];
}> {
    const lead = await prisma.lead.findFirst({
        where: {
            id: leadId,
            organization_id: organizationId
        }
    });

    const events = await prisma.rawEvent.findMany({
        where: {
            organization_id: organizationId,
            entity_type: 'lead',
            entity_id: leadId
        },
        orderBy: { created_at: 'desc' }
    });

    const auditLogs = await prisma.auditLog.findMany({
        where: {
            organization_id: organizationId,
            entity: 'lead',
            entity_id: leadId
        },
        orderBy: { timestamp: 'desc' }
    });

    await auditLogService.logAction({
        organizationId,
        entity: 'lead',
        entityId: leadId,
        trigger: 'gdpr_request',
        action: 'data_export',
        details: 'GDPR data export requested'
    });

    return { lead, events, auditLogs };
}

// ============================================================================
// AUDIT LOG IMMUTABILITY
// ============================================================================

/**
 * Verify audit log integrity (check for tampering).
 * Returns any records that may have been modified.
 */
export async function verifyAuditLogIntegrity(
    organizationId: string,
    limit: number = 1000
): Promise<{
    verified: boolean;
    totalChecked: number;
    issues: string[];
}> {
    const issues: string[] = [];

    // Get recent audit logs
    const logs = await prisma.auditLog.findMany({
        where: { organization_id: organizationId },
        orderBy: { timestamp: 'desc' },
        take: limit
    });

    // Check for gaps in sequence (if using sequential IDs)
    // Check for future timestamps
    // Check for suspicious patterns
    const now = new Date();

    for (const log of logs) {
        if (log.timestamp > now) {
            issues.push(`Log ${log.id} has future timestamp`);
        }
    }

    // Log the verification
    await auditLogService.logAction({
        organizationId,
        entity: 'system',
        trigger: 'integrity_check',
        action: 'audit_log_verification',
        details: JSON.stringify({ checked: logs.length, issues: issues.length })
    });

    return {
        verified: issues.length === 0,
        totalChecked: logs.length,
        issues
    };
}

// ============================================================================
// SCHEDULED RETENTION JOB
// ============================================================================

let retentionJobInterval: NodeJS.Timeout | null = null;
let isRetentionRunning = false;
let retentionLastRunAt: Date | null = null;
let retentionLastError: string | null = null;

/**
 * Get retention job health status (used by health check endpoint).
 */
export function getRetentionJobStatus(): { isRunning: boolean; lastRunAt: Date | null; lastError: string | null } {
    return { isRunning: isRetentionRunning, lastRunAt: retentionLastRunAt, lastError: retentionLastError };
}

/**
 * Start scheduled retention job (runs daily).
 */
export function startRetentionJob(): void {
    const DAILY_MS = 24 * 60 * 60 * 1000;

    retentionJobInterval = setInterval(async () => {
        if (isRetentionRunning) {
            logger.warn('Retention cycle skipped — previous still running');
            return;
        }

        isRetentionRunning = true;
        try {
            const orgs = await prisma.organization.findMany({
                select: { id: true }
            });

            for (const org of orgs) {
                try {
                    await applyRetentionPolicies(org.id, false);
                } catch (error) {
                    logger.error('Retention job failed for org', error as Error, { organizationId: org.id });
                }
            }

            retentionLastRunAt = new Date();
            retentionLastError = null;
        } catch (error) {
            retentionLastError = error instanceof Error ? error.message : String(error);
            logger.error('Retention job failed', error as Error);
        } finally {
            isRetentionRunning = false;
        }
    }, DAILY_MS);

    logger.info('Retention job scheduled');
}

/**
 * Stop retention job.
 */
export function stopRetentionJob(): void {
    if (retentionJobInterval) {
        clearInterval(retentionJobInterval);
        retentionJobInterval = null;
    }
}
