/**
 * Audit Log Service
 * 
 * Comprehensive logging of all significant system actions.
 * Section 12 of Audit: Audit logging is mandatory for all state changes.
 * 
 * Logs are:
 * - Immutable (no updates or deletes)
 * - Scoped to organization
 * - Complete with context (trigger, action, details)
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

interface LogActionParams {
    organizationId: string;
    entity: string;
    entityId?: string;
    trigger: string;
    action: string;
    details?: string;
    correlationId?: string;
    userId?: string;
    ipAddress?: string;
}

/**
 * Log a significant action in the system.
 * This is the primary interface for audit logging.
 */
export const logAction = async (params: LogActionParams): Promise<void> => {
    const {
        organizationId,
        entity,
        entityId,
        trigger,
        action,
        details,
        correlationId,
        userId,
        ipAddress
    } = params;

    try {
        await prisma.auditLog.create({
            data: {
                organization_id: organizationId,
                entity,
                entity_id: entityId,
                trigger,
                action,
                details,
                correlation_id: correlationId,
                user_id: userId,
                ip_address: ipAddress
            }
        });

        logger.info(`[AUDIT] ${entity}:${entityId || 'N/A'} | ${trigger} -> ${action}`);
    } catch (error) {
        // Audit logging should never crash the main flow
        logger.error('[AUDIT] Failed to log action:', error as Error);
    }
};

/**
 * Get audit logs for an entity.
 */
export const getLogsForEntity = async (
    organizationId: string,
    entity: string,
    entityId: string,
    limit: number = 100
): Promise<any[]> => {
    return prisma.auditLog.findMany({
        where: {
            organization_id: organizationId,
            entity,
            entity_id: entityId
        },
        orderBy: { timestamp: 'desc' },
        take: limit
    });
};

/**
 * Get all audit logs for an organization with optional filtering.
 */
export const getLogs = async (
    organizationId: string,
    options: {
        entity?: string;
        action?: string;
        limit?: number;
    } = {}
): Promise<any[]> => {
    const { entity, action, limit = 100 } = options;

    return prisma.auditLog.findMany({
        where: {
            organization_id: organizationId,
            ...(entity && { entity }),
            ...(action && { action })
        },
        orderBy: { timestamp: 'desc' },
        take: limit
    });
};
