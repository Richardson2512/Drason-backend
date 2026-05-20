/**
 * Notification Service
 * 
 * Handles CRUD operations for user notifications.
 */

import { prisma } from '../prisma';

interface CreateNotificationParams {
    type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'SYSTEM';
    title: string;
    message: string;
    userId?: string;
    /** Deep-link the notification UI navigates to when the user clicks
     *  the row. Must pass `validateNotificationActionUrl` - relative
     *  Superkabe paths only, no javascript:/data:/etc. */
    actionUrl?: string;
    entityType?: string;
    entityId?: string;
}

/**
 * Validate a Notification.action_url before persisting.
 *
 * Notifications audit N7 (defense-in-depth): the schema has a free-form
 * `action_url String?` column and the dashboard renders it inside an
 * <a href> element. Today every writer in the codebase passes a
 * hardcoded internal path (`/dashboard/...`) - safe. But the moment a
 * future writer wires this to user-controlled data, a stored XSS
 * (`javascript:fetch('/api/me')...`) opens up. Lock the contract NOW
 * at the writer so a future regression is a function-call error, not
 * a security incident.
 *
 * Accepts:
 *   - Relative paths starting with a single slash (`/dashboard/...`)
 *   - Absolute https URLs on a small allowlist (FRONTEND_URL host)
 * Rejects:
 *   - protocol-relative (`//evil.example`)
 *   - non-http(s) schemes
 *   - anything else
 */
export function validateNotificationActionUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
    if (raw === undefined || raw === null || raw === '') return { ok: true, url: '' };
    if (typeof raw !== 'string') return { ok: false, error: 'action_url must be a string' };
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: true, url: '' };
    if (trimmed.length > 512) return { ok: false, error: 'action_url is too long (max 512)' };

    // Relative path - must start with single slash, not double (which
    // would be protocol-relative and could be redirected off-site).
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        return { ok: true, url: trimmed };
    }

    // Absolute URL - parse and allowlist by host.
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return { ok: false, error: 'action_url must be a relative path (/dashboard/...) or an absolute https URL' };
    }
    if (parsed.protocol !== 'https:') {
        return { ok: false, error: `action_url scheme "${parsed.protocol.replace(/:$/, '')}" is not allowed; use a relative path or https` };
    }
    const allowed = new Set<string>();
    try {
        if (process.env.FRONTEND_URL) allowed.add(new URL(process.env.FRONTEND_URL).hostname);
    } catch { /* ignore */ }
    if (!allowed.has(parsed.hostname)) {
        return { ok: false, error: `action_url host "${parsed.hostname}" is not on the platform allowlist` };
    }
    return { ok: true, url: parsed.toString() };
}

/**
 * Create a new notification.
 *
 * This is the SHOULD-USE entry point for writing Notification rows -
 * it routes the action_url through `validateNotificationActionUrl`.
 * Direct `prisma.notification.create(...)` callers are accepted today
 * (one exists in replyActionService) but should migrate here so the
 * action_url contract has a single enforcement point.
 */
export const createNotification = async (orgId: string, params: CreateNotificationParams) => {
    const urlCheck = validateNotificationActionUrl(params.actionUrl);
    if (!urlCheck.ok) {
        throw new Error(`[notificationService] invalid action_url: ${urlCheck.error}`);
    }
    return await prisma.notification.create({
        data: {
            organization_id: orgId,
            type: params.type,
            title: params.title,
            message: params.message,
            user_id: params.userId,
            action_url: urlCheck.url || null,
            entity_type: params.entityType,
            entity_id: params.entityId,
            is_read: false
        }
    });
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
