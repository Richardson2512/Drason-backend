/**
 * User Controller
 *
 * Handles user-related operations like fetching current user info.
 */

import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { dispatchEmail } from '../services/emailTemplates/dispatcher';
import { passwordChangedEmail } from '../services/emailTemplates/passwordChanged';
import { summariseRequester, buildFrontendUrl } from '../services/emailTemplates/requesterContext';
import { resolveCapabilities, CAPABILITY_KEYS } from '../middleware/requireCapability';
import { clearTokenCookie } from '../services/tokenService';

/**
 * Get current user information.
 * GET /api/user/me
 */
export const getCurrentUser = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;

        if (!userId) {
            res.status(401).json({ success: false, error: 'User not authenticated' });
            return;
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
                organization_id: true,
                last_login_at: true,
                created_at: true,
                is_agency_owner: true,
                scoped_organization_id: true,
                account_id: true,
                // Surface the org's slug so the dashboard can render the
                // per-org MCP URL (`/mcp/<slug>`) without an extra round-trip.
                organization: {
                    select: { id: true, name: true, slug: true },
                },
            }
        });

        if (!user) {
            res.status(404).json({ success: false, error: 'User not found' });
            return;
        }

        // Capability list for the frontend so it can hide write controls the
        // user can't actually use. Source of truth still lives on the backend
        // — every gated route checks via requireCapability — but a clean UI
        // beats a button that 403s on click.
        //
        // capabilityKeys is the canonical list of every capability the
        // backend recognizes. The frontend's invite-creation modal reads
        // this so adding a new capability is a one-side change (backend
        // adds it to CAPABILITY_KEYS; frontend renders it automatically).
        const capabilities = await resolveCapabilities(userId, user.organization_id);

        res.json({
            success: true,
            data: { ...user, capabilities, capabilityKeys: CAPABILITY_KEYS },
        });
    } catch (error) {
        logger.error('[USER] Failed to get current user', error as Error);
        res.status(500).json({ success: false, error: 'Failed to retrieve user information' });
    }
};

/**
 * Update current user's profile (name).
 * PATCH /api/user/me
 */
export const updateCurrentUser = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;

        if (!userId) {
            res.status(401).json({ success: false, error: 'User not authenticated' });
            return;
        }

        const { name } = req.body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            res.status(400).json({ success: false, error: 'Name is required and must be a non-empty string' });
            return;
        }

        if (name.trim().length > 100) {
            res.status(400).json({ success: false, error: 'Name must be 100 characters or less' });
            return;
        }

        const user = await prisma.user.update({
            where: { id: userId },
            data: { name: name.trim() },
            select: {
                id: true,
                email: true,
                name: true,
                role: true,
            }
        });

        logger.info('[USER] Profile updated', { userId });
        res.json({ success: true, data: user });
    } catch (error) {
        logger.error('[USER] Failed to update profile', error as Error);
        res.status(500).json({ success: false, error: 'Failed to update profile' });
    }
};

/**
 * Change current user's password.
 * POST /api/user/change-password
 */
export const changePassword = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;

        if (!userId) {
            res.status(401).json({ success: false, error: 'User not authenticated' });
            return;
        }

        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            res.status(400).json({ success: false, error: 'Current password and new password are required' });
            return;
        }

        if (newPassword.length < 8) {
            res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
            return;
        }

        // Fetch user with password hash
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, password_hash: true }
        });

        if (!user) {
            res.status(404).json({ success: false, error: 'User not found' });
            return;
        }

        // OAuth-only users cannot change password
        if (!user.password_hash) {
            res.status(403).json({ success: false, error: 'OAuth users cannot change password' });
            return;
        }

        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isValid) {
            res.status(403).json({ success: false, error: 'Current password is incorrect' });
            return;
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(newPassword, salt);

        const changedAt = new Date();
        await prisma.user.update({
            where: { id: userId },
            data: {
                password_hash: newHash,
                password_changed_at: changedAt
            }
        });

        // Clear the current session cookie — force re-login
        clearTokenCookie(res);

        // Security notification — fire-and-forget. Confirms the change and
        // gives the user a fast recovery path if it wasn't them.
        const userRecord = await prisma.user.findUnique({
            where: { id: userId },
            select: { name: true, email: true },
        });
        if (userRecord) {
            void dispatchEmail({
                rendered: passwordChangedEmail({
                    name: userRecord.name,
                    changedAt,
                    requesterContext: summariseRequester(req),
                    source: 'self_service',
                    forgotPasswordUrl: buildFrontendUrl('/forgot-password'),
                }),
                audience: { kind: 'email', email: userRecord.email },
                category: 'account_security',
                eventKind: 'password_changed',
                idempotencyKey: `pwchanged:${userId}:${changedAt.getTime()}`,
            });
        }

        logger.info('[USER] Password changed — all prior sessions invalidated', { userId });
        res.json({ success: true, message: 'Password changed successfully. Please log in again.' });
    } catch (error) {
        logger.error('[USER] Failed to change password', error as Error);
        res.status(500).json({ success: false, error: 'Failed to change password' });
    }
};
