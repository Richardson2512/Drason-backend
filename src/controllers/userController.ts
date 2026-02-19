/**
 * User Controller
 *
 * Handles user-related operations like fetching current user info.
 */

import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';

/**
 * Get current user information.
 * GET /api/user/me
 */
export const getCurrentUser = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;

        if (!userId) {
            res.status(401).json({ error: 'User not authenticated' });
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
                created_at: true
            }
        });

        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        res.json({
            success: true,
            data: user
        });
    } catch (error) {
        logger.error('[USER] Failed to get current user', error as Error);
        res.status(500).json({ error: 'Failed to retrieve user information' });
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
            res.status(401).json({ error: 'User not authenticated' });
            return;
        }

        const { name } = req.body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            res.status(400).json({ error: 'Name is required and must be a non-empty string' });
            return;
        }

        if (name.trim().length > 100) {
            res.status(400).json({ error: 'Name must be 100 characters or less' });
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
        res.status(500).json({ error: 'Failed to update profile' });
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
            res.status(401).json({ error: 'User not authenticated' });
            return;
        }

        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            res.status(400).json({ error: 'Current password and new password are required' });
            return;
        }

        if (newPassword.length < 8) {
            res.status(400).json({ error: 'New password must be at least 8 characters' });
            return;
        }

        // Fetch user with password hash
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, password_hash: true }
        });

        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        // Verify current password
        const isValid = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isValid) {
            res.status(403).json({ error: 'Current password is incorrect' });
            return;
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const newHash = await bcrypt.hash(newPassword, salt);

        await prisma.user.update({
            where: { id: userId },
            data: { password_hash: newHash }
        });

        logger.info('[USER] Password changed', { userId });
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        logger.error('[USER] Failed to change password', error as Error);
        res.status(500).json({ error: 'Failed to change password' });
    }
};
