/**
 * User Controller
 *
 * Handles user-related operations like fetching current user info.
 */

import { Request, Response } from 'express';
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
