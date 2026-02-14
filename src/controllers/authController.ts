import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';

// JWT_SECRET is validated at startup in index.ts — crashes if missing in production.
// In development, a dev-only fallback is used.
function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('FATAL: JWT_SECRET is not set in production');
        }
        logger.warn('JWT_SECRET not set — using dev-only fallback. NEVER use this in production.');
        return 'drason_dev_only_secret_DO_NOT_USE_IN_PROD';
    }
    return secret;
}

const JWT_SECRET = getJwtSecret();
const TOKEN_EXPIRY = '3d'; // 3-day token lifetime
const COOKIE_MAX_AGE = 3 * 24 * 60 * 60 * 1000; // 3 days in ms

/**
 * Set auth token as httpOnly server-side cookie + return in body for backward compat.
 */
function setTokenCookie(res: Response, token: string): void {
    res.cookie('token', token, {
        httpOnly: true,           // Not accessible via document.cookie — XSS safe
        secure: process.env.NODE_ENV === 'production', // HTTPS only in production
        sameSite: 'lax',          // CSRF protection
        path: '/',
        maxAge: COOKIE_MAX_AGE,
    });
}

/**
 * Generate a JWT for a user.
 */
function generateToken(user: { id: string; email: string; role: string; organization_id: string }): string {
    return jwt.sign(
        {
            userId: user.id,
            email: user.email,
            role: user.role,
            orgId: user.organization_id,
        },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY }
    );
}

export const login = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }

        const user = await prisma.user.findUnique({
            where: { email },
            include: { organization: true }
        });

        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const token = generateToken(user);

        // Update last login
        await prisma.user.update({
            where: { id: user.id },
            data: { last_login_at: new Date() }
        });

        logger.info('User logged in', { userId: user.id, email: user.email });

        // Set httpOnly cookie server-side
        setTokenCookie(res, token);

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                organization: {
                    id: user.organization.id,
                    name: user.organization.name,
                    slug: user.organization.slug
                }
            }
        });
    } catch (error: any) {
        logger.error('Login error', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

export const register = async (req: Request, res: Response) => {
    try {
        const { name, email, password, organizationName } = req.body;

        if (!email || !password || !organizationName) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ success: false, error: 'Email already registered' });
        }

        // Slugify org name
        const slug = organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-');

        // Check slug uniqueness
        const existingOrg = await prisma.organization.findUnique({ where: { slug } });
        if (existingOrg) {
            return res.status(400).json({ success: false, error: 'Organization name/slug already taken' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Transaction to create Org + User
        const result = await prisma.$transaction(async (tx) => {
            const org = await tx.organization.create({
                data: {
                    name: organizationName,
                    slug,
                    system_mode: 'observe'
                }
            });

            const user = await tx.user.create({
                data: {
                    email,
                    password_hash: passwordHash,
                    name,
                    role: 'admin', // First user is admin
                    organization_id: org.id
                }
            });

            return { org, user };
        });

        const token = generateToken({ ...result.user, organization_id: result.org.id });

        logger.info('User registered', { userId: result.user.id, email: result.user.email });

        // Set httpOnly cookie server-side
        setTokenCookie(res, token);

        res.status(201).json({
            token,
            user: {
                id: result.user.id,
                email: result.user.email,
                name: result.user.name,
                role: result.user.role,
                organization: {
                    id: result.org.id,
                    name: result.org.name,
                    slug: result.org.slug
                }
            }
        });

    } catch (error: any) {
        logger.error('Registration error', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

/**
 * Refresh token — issues a new JWT if the current one is still valid.
 * Called periodically by the frontend to extend the session.
 * Requires a valid (non-expired) JWT in the cookie or Authorization header.
 */
export const refreshToken = async (req: Request, res: Response) => {
    try {
        // Extract token from cookie or header
        let token: string | undefined;

        if (req.cookies?.token) {
            token = req.cookies.token;
        } else {
            const authHeader = req.headers.authorization;
            if (authHeader?.startsWith('Bearer ')) {
                token = authHeader.substring(7);
            }
        }

        if (!token) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }

        // Verify current token
        let decoded: any;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (err: any) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ success: false, error: 'Token expired. Please log in again.' });
            }
            return res.status(401).json({ success: false, error: 'Invalid token' });
        }

        // Look up user to ensure they still exist and are active
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            include: { organization: true }
        });

        if (!user) {
            return res.status(401).json({ success: false, error: 'User no longer exists' });
        }

        // Issue fresh token
        const newToken = generateToken(user);

        // Set new httpOnly cookie
        setTokenCookie(res, newToken);

        logger.info('Token refreshed', { userId: user.id });

        res.json({
            token: newToken,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                organization: {
                    id: user.organization.id,
                    name: user.organization.name,
                    slug: user.organization.slug
                }
            }
        });
    } catch (error: any) {
        logger.error('Token refresh error', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

/**
 * Logout — clears the auth cookie.
 */
export const logout = async (_req: Request, res: Response) => {
    res.clearCookie('token', { path: '/' });
    res.json({ success: true, data: { message: 'Logged out successfully' } });
};
