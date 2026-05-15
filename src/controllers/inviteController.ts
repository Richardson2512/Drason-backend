/**
 * Workspace invite controller.
 *
 * Three endpoints power the magic-link client-login flow:
 *
 *   1. POST /api/agency/workspaces/:id/invites  (auth-gated, agency-owner only)
 *      Creates a WorkspaceInvite + sends the email.
 *
 *   2. GET  /api/auth/invite?token=…             (public)
 *      Validates an invite token. Returns { email, workspaceName, workspaceSlug }
 *      so the /set-password page can show useful context.
 *
 *   3. POST /api/auth/invite/complete             (public)
 *      Body: { token, password }. Creates the User row, the WorkspaceMembership
 *      row, marks the invite consumed.
 *
 * Token security:
 *   - Raw token is 32 random bytes hex-encoded (64 chars). Only sent in the
 *     email body and the client URL - never persisted raw on the server.
 *   - DB stores SHA-256(token). DB compromise alone doesn't yield a usable
 *     token.
 *   - 7-day TTL enforced at lookup time.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';
import { dispatchEmail } from '../services/emailTemplates/dispatcher';
import { workspaceInviteEmail } from '../services/emailTemplates/workspaceInvite';
import { recordConsent, extractClientIp, extractUserAgent } from '../services/consentService';
import { TOS_VERSION, PRIVACY_VERSION, TOS_PATH, PRIVACY_PATH } from '../constants/legalDocVersions';
import { CAPABILITY_KEYS } from '../middleware/requireCapability';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Capability whitelist - single source of truth lives in requireCapability.ts.
 *  /user/me also returns this list to the frontend so the invite modal's
 *  checkbox UI can't drift either. */
const VALID_CAPABILITIES: ReadonlySet<string> = new Set(CAPABILITY_KEYS);

function generateRawToken(): string {
    return crypto.randomBytes(32).toString('hex');
}

function hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Thrown inside the consume txn when another request consumed the invite first. */
class InviteRaceError extends Error {
    constructor() { super('INVITE_RACE'); }
}

/**
 * POST /api/agency/workspaces/:id/invites
 * Body: { email: string, displayName?: string, capabilities: string[] }
 *
 * Agency-owner only. Creates a WorkspaceInvite row and sends the magic-link
 * email. If a previous pending invite exists for the same (workspace, email),
 * we revoke it (consume) before creating the new one - this is the natural
 * behavior of "Resend invite" in the UI.
 */
export const createWorkspaceInvite = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.orgContext?.userId;
        if (!userId) {
            res.status(401).json({ success: false, error: 'Not authenticated' });
            return;
        }
        const me = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, account_id: true, is_agency_owner: true },
        });
        if (!me) {
            res.status(401).json({ success: false, error: 'User not found' });
            return;
        }
        if (!me.is_agency_owner) {
            res.status(403).json({ success: false, error: 'Only agency owners can create client invites' });
            return;
        }

        const workspaceId = String(req.params.id);
        const workspace = await prisma.organization.findUnique({
            where: { id: workspaceId },
            select: { id: true, name: true, slug: true, account_id: true },
        });
        if (!workspace || workspace.account_id !== me.account_id) {
            res.status(404).json({ success: false, error: 'Workspace not found' });
            return;
        }

        const body = req.body as { email?: unknown; displayName?: unknown; capabilities?: unknown };
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim() || null : null;
        const capsInput = Array.isArray(body.capabilities) ? body.capabilities : [];
        const capabilities = capsInput
            .filter((c): c is string => typeof c === 'string' && VALID_CAPABILITIES.has(c));

        if (!email || !email.includes('@')) {
            res.status(400).json({ success: false, error: 'Valid email is required' });
            return;
        }

        // Block creating an invite for an email already actively a member of
        // this workspace - prevents accidental capability overrides without
        // an explicit "edit" path.
        const existingMember = await prisma.workspaceMembership.findFirst({
            where: { organization_id: workspaceId, user: { email } },
            include: { user: { select: { email: true, scoped_organization_id: true } } },
        });
        if (existingMember && existingMember.status !== 'pending_invite') {
            res.status(409).json({ success: false, error: 'A login already exists for that email on this workspace' });
            return;
        }

        // Revoke any unconsumed prior invites for this email+workspace.
        await prisma.workspaceInvite.updateMany({
            where: { organization_id: workspaceId, email, consumed_at: null },
            data: { consumed_at: new Date() },
        });

        // Generate token, store hash.
        const rawToken = generateRawToken();
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

        const invite = await prisma.workspaceInvite.create({
            data: {
                organization_id: workspaceId,
                email,
                display_name: displayName,
                capabilities,
                token_hash: tokenHash,
                expires_at: expiresAt,
                created_by_user_id: userId,
                last_send_status: 'pending',
                last_send_attempted_at: new Date(),
            },
        });

        // Build the magic-link URL - pre-populates the /set-password page.
        const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3000';
        const magicLinkUrl = `${frontendBase}/set-password?token=${rawToken}` +
            `&workspace=${encodeURIComponent(workspace.slug)}&email=${encodeURIComponent(email)}`;

        // Resolve agency display name.
        const account = me.account_id
            ? await prisma.account.findUnique({
                where: { id: me.account_id },
                select: { agency_display_name: true, name: true },
            })
            : null;
        const agencyName = account?.agency_display_name || account?.name || 'Your agency';

        // Send the email and record the outcome on the invite row so the
        // agency UI can show "delivered" vs "failed → resend" instead of
        // silently never reaching the client.
        dispatchEmail({
            rendered: workspaceInviteEmail({
                recipientName: displayName,
                recipientEmail: email,
                agencyName,
                workspaceName: workspace.name,
                workspaceSlug: workspace.slug,
                magicLinkUrl,
            }),
            audience: { kind: 'email', email },
            category: 'account_security',
            eventKind: 'workspace_invite',
            idempotencyKey: `workspace-invite:${invite.id}`,
        }).then(() => prisma.workspaceInvite.update({
            where: { id: invite.id },
            data: { last_send_status: 'sent', last_send_attempted_at: new Date() },
        })).catch((sendErr) => {
            logger.warn('[INVITE] Email dispatch failed', { inviteId: invite.id, err: String(sendErr) });
            return prisma.workspaceInvite.update({
                where: { id: invite.id },
                data: {
                    last_send_status: 'failed',
                    last_send_attempted_at: new Date(),
                    last_send_error: String(sendErr).slice(0, 500),
                },
            }).catch(() => undefined);
        });

        logger.info(`[INVITE] Created for ${email} on workspace ${workspace.slug} by ${userId}`);

        res.status(201).json({
            success: true,
            data: {
                id: invite.id,
                email,
                displayName,
                capabilities,
                status: 'pending_invite',
                createdAt: invite.created_at.toISOString(),
                expiresAt: expiresAt.toISOString(),
                // Surface the magic link for dev/staging convenience. The
                // production frontend should NOT display this in the UI; the
                // agency just sees "Invite sent."
                magicLinkUrl,
            },
        });
    } catch (e: any) {
        logger.error('[INVITE] createWorkspaceInvite failed', e);
        res.status(500).json({ success: false, error: 'Failed to create invite' });
    }
};

/**
 * GET /api/auth/invite?token=…
 * Public - no auth. Validates a magic-link token. Used by /set-password to
 * decide which form to render (valid / expired / unknown).
 */
export const validateInviteToken = async (req: Request, res: Response): Promise<void> => {
    try {
        const token = typeof req.query.token === 'string' ? req.query.token : '';
        if (!token) {
            res.status(400).json({ success: false, error: 'Token is required' });
            return;
        }

        const invite = await prisma.workspaceInvite.findUnique({
            where: { token_hash: hashToken(token) },
            include: {
                organization: { select: { name: true, slug: true } },
            },
        });
        if (!invite) {
            res.status(404).json({ success: false, error: 'Invalid or already-used invite' });
            return;
        }
        if (invite.consumed_at) {
            res.status(410).json({ success: false, error: 'This invite has already been used' });
            return;
        }
        if (invite.expires_at < new Date()) {
            res.status(410).json({
                success: false,
                error: 'This invite has expired',
                data: { expiresAt: invite.expires_at.toISOString() },
            });
            return;
        }

        res.json({
            success: true,
            data: {
                email: invite.email,
                displayName: invite.display_name,
                workspaceName: invite.organization.name,
                workspaceSlug: invite.organization.slug,
                expiresAt: invite.expires_at.toISOString(),
            },
        });
    } catch (e: any) {
        logger.error('[INVITE] validateInviteToken failed', e);
        res.status(500).json({ success: false, error: 'Failed to validate invite' });
    }
};

/**
 * POST /api/auth/invite/complete
 * Body: { token: string, password: string }
 *
 * Public - no auth. Consumes the invite token: creates the User row scoped
 * to the workspace, creates the WorkspaceMembership with the capabilities
 * the agency picked, marks the invite consumed. After success the client
 * redirects to /login and signs in via the client login flow.
 */
export const completeInvite = async (req: Request, res: Response): Promise<void> => {
    try {
        const body = req.body as { token?: unknown; password?: unknown };
        const token = typeof body.token === 'string' ? body.token : '';
        const password = typeof body.password === 'string' ? body.password : '';

        if (!token) {
            res.status(400).json({ success: false, error: 'Token is required' });
            return;
        }
        if (password.length < 12) {
            res.status(400).json({ success: false, error: 'Password must be at least 12 characters' });
            return;
        }
        if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
            res.status(400).json({ success: false, error: 'Password must include uppercase, lowercase, and a number' });
            return;
        }

        const invite = await prisma.workspaceInvite.findUnique({
            where: { token_hash: hashToken(token) },
            include: {
                organization: { select: { id: true, slug: true, name: true } },
            },
        });
        if (!invite) {
            res.status(404).json({ success: false, error: 'Invalid or already-used invite' });
            return;
        }
        if (invite.consumed_at) {
            res.status(410).json({ success: false, error: 'This invite has already been used' });
            return;
        }
        if (invite.expires_at < new Date()) {
            res.status(410).json({ success: false, error: 'This invite has expired' });
            return;
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const orgId = invite.organization.id;

        // Atomic consume + create. Two design points:
        //
        //   1. The invite is consumed via updateMany() with `consumed_at: null`
        //      in the WHERE clause. Two concurrent /invite/complete calls on
        //      the same token will race; exactly one will see count=1, the
        //      other gets count=0 and we abort the txn. Without this CAS the
        //      pre-flight check above is TOCTOU-vulnerable.
        //
        //   2. Email collision is now handled at the DB level by the partial
        //      unique on (scoped_organization_id, email). The same email can
        //      live in many workspaces independently, so no suffix workaround
        //      is needed. If a User row for this (workspace, email) already
        //      exists somehow (e.g. the agency reactivated a stale membership
        //      out-of-band), the unique-violation surfaces as P2002 and we
        //      return a clean 409.
        let createdUser: { id: string; email: string; name: string | null };
        try {
            createdUser = await prisma.$transaction(async (tx) => {
                const consume = await tx.workspaceInvite.updateMany({
                    where: {
                        id: invite.id,
                        consumed_at: null,
                        expires_at: { gt: new Date() },
                    },
                    data: { consumed_at: new Date() },
                });
                if (consume.count === 0) {
                    // Another request consumed it between our pre-flight check
                    // and now. Throwing aborts the txn; we surface 410 below.
                    throw new InviteRaceError();
                }

                const user = await tx.user.create({
                    data: {
                        email: invite.email,
                        name: invite.display_name,
                        password_hash: passwordHash,
                        role: 'viewer',
                        organization_id: orgId,
                        account_id: null, // clients don't belong to the agency's Account directly
                        is_agency_owner: false,
                        scoped_organization_id: orgId, // hard-lock to this workspace
                        // password_changed_at deliberately left NULL on creation -
                        // the auth middleware compares JWT iat to this column and
                        // setting it to "now" creates a sub-second race that
                        // invalidates the very token the client is about to use.
                        // It gets populated when the user changes their password
                        // later via the existing reset / change-password flows.
                    },
                    select: { id: true, email: true, name: true },
                });

                await tx.workspaceMembership.create({
                    data: {
                        organization_id: orgId,
                        user_id: user.id,
                        capabilities: invite.capabilities,
                        status: 'active',
                    },
                });

                return user;
            });
        } catch (txnErr: any) {
            if (txnErr instanceof InviteRaceError) {
                res.status(410).json({ success: false, error: 'This invite has already been used' });
                return;
            }
            // P2002 = unique constraint violation. With the new partial unique
            // on (scoped_organization_id, email), this means a User row for
            // this (workspace, email) already exists.
            if (txnErr?.code === 'P2002') {
                logger.warn('[INVITE] User already exists for (workspace, email)', { workspaceId: orgId, email: invite.email });
                res.status(409).json({ success: false, error: 'A login already exists for that email on this workspace' });
                return;
            }
            throw txnErr;
        }

        const newUser = createdUser;

        // Record consent - accepting the magic-link invite is the implicit
        // consent moment. Without these rows the requireFreshConsent
        // middleware blocks every subsequent request, so this isn't optional.
        {
            const ipAddress = extractClientIp(req);
            const userAgent = extractUserAgent(req);
            try {
                await Promise.all([
                    recordConsent({
                        consentType: 'tos',
                        documentVersion: TOS_VERSION,
                        // Using 'signup' since accepting the magic-link invite
                        // IS the user's first signup. The 'inviteId' metadata
                        // distinguishes this from a normal /signup flow.
                        channel: 'signup',
                        userId: newUser.id,
                        organizationId: orgId,
                        userEmailSnapshot: newUser.email,
                        userNameSnapshot: newUser.name,
                        ipAddress,
                        userAgent,
                        metadata: { documentPath: TOS_PATH, inviteId: invite.id },
                    }),
                    recordConsent({
                        consentType: 'privacy',
                        documentVersion: PRIVACY_VERSION,
                        // Using 'signup' since accepting the magic-link invite
                        // IS the user's first signup. The 'inviteId' metadata
                        // distinguishes this from a normal /signup flow.
                        channel: 'signup',
                        userId: newUser.id,
                        organizationId: orgId,
                        userEmailSnapshot: newUser.email,
                        userNameSnapshot: newUser.name,
                        ipAddress,
                        userAgent,
                        metadata: { documentPath: PRIVACY_PATH, inviteId: invite.id },
                    }),
                ]);
            } catch (consentErr) {
                // Non-fatal; the user can re-accept via the standard prompt.
                logger.warn('[INVITE] Failed to record initial consent', { error: String(consentErr), userId: newUser.id });
            }
        }

        logger.info(`[INVITE] Consumed for ${invite.email} on ${invite.organization.slug}`);

        res.json({
            success: true,
            data: {
                workspaceSlug: invite.organization.slug,
                workspaceName: invite.organization.name,
                email: invite.email,
                redirectTo: '/login',
            },
        });
    } catch (e: any) {
        logger.error('[INVITE] completeInvite failed', e);
        res.status(500).json({ success: false, error: 'Failed to complete invite' });
    }
};
