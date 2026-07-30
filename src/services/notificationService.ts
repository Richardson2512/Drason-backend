/**
 * Notification Service
 * 
 * Handles CRUD operations for user notifications.
 */

import { prisma } from '../index';

interface CreateNotificationParams {
    type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'SYSTEM';
    title: string;
    message: string;
    userId?: string;
}

/**
 * Create a new notification.
 */
export const createNotification = async (orgId: string, params: CreateNotificationParams) => {
    return await prisma.notification.create({
        data: {
            organization_id: orgId,
            type: params.type,
            title: params.title,
            message: params.message,
            user_id: params.userId,
            is_read: false
        }
    });
};

/**
 * Create a notification only if an unread one with the same title does not
 * already exist for this org inside `windowHours`.
 *
 * For recurring watchdog conditions the underlying state does not change
 * between worker cycles, so an unguarded create() writes one row every cycle
 * forever. Use this for anything a worker can re-detect on every pass.
 */
export const createNotificationIfAbsent = async (
    orgId: string,
    params: CreateNotificationParams,
    windowHours: number = 24
) => {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const existing = await prisma.notification.findFirst({
        where: {
            organization_id: orgId,
            title: params.title,
            is_read: false,
            created_at: { gte: since }
        },
        select: { id: true }
    });

    if (existing) return null;

    return await createNotification(orgId, params);
};

/**
 * Get notifications with pagination.
 */
export const getNotifications = async (orgId: string, page: number = 1, limit: number = 20, filter?: 'all' | 'unread') => {
    const skip = (page - 1) * limit;

    const where: any = {
        organization_id: orgId
    };

    if (filter === 'unread') {
        where.is_read = false;
    }

    const [data, total] = await Promise.all([
        prisma.notification.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: limit,
            skip
        }),
        prisma.notification.count({ where })
    ]);

    return {
        data,
        meta: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        }
    };
};

/**
 * Get count of unread notifications.
 */
export const getUnreadCount = async (orgId: string) => {
    return await prisma.notification.count({
        where: {
            organization_id: orgId,
            is_read: false
        }
    });
};

/**
 * Mark notification as read.
 */
export const markAsRead = async (orgId: string, notificationId: string) => {
    return await prisma.notification.updateMany({
        where: {
            id: notificationId,
            organization_id: orgId
        },
        data: {
            is_read: true
        }
    });
};

/**
 * Mark all as read.
 */
export const markAllAsRead = async (orgId: string) => {
    return await prisma.notification.updateMany({
        where: {
            organization_id: orgId,
            is_read: false
        },
        data: {
            is_read: true
        }
    });
};
