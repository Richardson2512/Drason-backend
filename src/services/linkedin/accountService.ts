/**
 * LinkedIn account service - domain layer above the raw Unipile API.
 *
 * Responsibilities:
 *   - Persist/refresh LinkedInAccount rows from Unipile's source of truth.
 *   - Generate hosted-auth links for new connections + reconnects.
 *   - Map Unipile status webhook events to our internal state machine.
 *   - Disconnect: cascade-delete the local row when Unipile confirms removal.
 *
 * Capacity counters (invites_today, invites_this_week, ...) are owned by
 * the send workers in a later phase - this service treats them as read-only.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import * as unipileAccounts from '../unipile/accounts';
import type { UnipileAccount } from '../unipile/accounts';
import { enforceCanAddAccount, releaseAddonSlotOnDisconnect } from './accountLimitService';

// ────────────────────────────────────────────────────────────────────
// View shapes - what the frontend consumes (matches the mock data shape
// already wired in the Accounts page, so the swap is purely about source).
// ────────────────────────────────────────────────────────────────────

export interface LinkedInAccountView {
    id: string;
    unipile_account_id: string;
    display_name: string;
    account_type: 'CLASSIC' | 'PREMIUM' | 'SALES_NAV' | 'RECRUITER';
    status: 'OK' | 'CONNECTING' | 'CREDENTIALS' | 'ERROR' | 'SYNC_SUCCESS' | 'DELETED';
    inbox_sync_mode: 'all' | 'sequence_only';
    invites_today: number;
    invites_today_max: number;
    invites_week: number;
    invites_week_max: number;
    msgs_today: number;
    msgs_today_max: number;
    in_campaigns: number;
    connected_at: string;
    last_status_at: string | null;
}

function toView(row: Awaited<ReturnType<typeof prisma.linkedInAccount.findMany>>[number]): LinkedInAccountView {
    return {
        id: row.id,
        unipile_account_id: row.unipile_account_id,
        display_name: row.display_name,
        account_type: row.account_type as LinkedInAccountView['account_type'],
        status: row.status as LinkedInAccountView['status'],
        inbox_sync_mode: row.inbox_sync_mode as LinkedInAccountView['inbox_sync_mode'],
        invites_today: row.invites_today,
        invites_today_max: row.max_invites_per_day,
        invites_week: row.invites_this_week,
        invites_week_max: row.max_invites_per_week,
        msgs_today: row.messages_today,
        msgs_today_max: row.max_messages_per_day,
        in_campaigns: 0, // populated in Phase 5 when CampaignSender exists
        connected_at: row.connected_at.toISOString(),
        last_status_at: row.last_status_at?.toISOString() ?? null,
    };
}

// ────────────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────────────

export async function listAccountsForOrg(organizationId: string): Promise<LinkedInAccountView[]> {
    const rows = await prisma.linkedInAccount.findMany({
        where: { organization_id: organizationId },
        orderBy: { connected_at: 'desc' },
    });

    // Populate `in_campaigns`: count of active (non-draft, non-completed,
    // non-archived, not soft-deleted) LinkedIn campaigns this account is
    // attached to as a sender. Surfaces in the Accounts UI so an operator
    // disconnecting a sender can see how many campaigns will be affected
    // BEFORE they confirm the destructive action.
    //
    // One groupBy query batched across all accounts - avoids the N+1
    // that the previous TODO suggested would be needed in Phase 5.
    const accountIds = rows.map(r => r.id);
    const senderRows = accountIds.length > 0
        ? await prisma.campaignLinkedInSender.findMany({
            where: {
                linkedin_account_id: { in: accountIds },
                enabled: true,
                campaign: {
                    organization_id: organizationId,
                    deleted_at: null,
                    status: { in: ['active', 'ongoing', 'starting', 'paused'] },
                },
            },
            select: { linkedin_account_id: true },
        })
        : [];
    const countByAccount = new Map<string, number>();
    for (const s of senderRows) {
        countByAccount.set(s.linkedin_account_id, (countByAccount.get(s.linkedin_account_id) ?? 0) + 1);
    }

    return rows.map(r => {
        const view = toView(r);
        view.in_campaigns = countByAccount.get(r.id) ?? 0;
        return view;
    });
}

export async function getAccountById(organizationId: string, id: string): Promise<LinkedInAccountView | null> {
    const row = await prisma.linkedInAccount.findFirst({
        where: { id, organization_id: organizationId },
    });
    return row ? toView(row) : null;
}

// ────────────────────────────────────────────────────────────────────
// Hosted-auth flow
//
// We never see LinkedIn credentials. Unipile hosts the auth UI and gives
// us back an account_id via webhook (CREATION_SUCCESS) + a query param
// when the user is redirected back to our success URL. We persist the
// organization_id in the `name` field of the hosted-auth request so the
// CREATION_SUCCESS webhook can be routed to the right org.
// ────────────────────────────────────────────────────────────────────

export interface ConnectLinkInput {
    organizationId: string;
    /** Where to send the user when the connection succeeds (or fails) */
    successRedirectUrl: string;
    failureRedirectUrl: string;
    /** Optional friendly name shown in Unipile's hosted UI */
    displayName?: string;
}

export async function generateConnectLink(input: ConnectLinkInput): Promise<{ url: string }> {
    // Gate on the tier + addon cap so we don't burn a Unipile auth flow on
    // capacity the org doesn't have. Throws AccountLimitExceededError on cap.
    await enforceCanAddAccount(input.organizationId);

    const notifyUrl = `${process.env.BACKEND_URL}/webhooks/unipile`;
    const res = await unipileAccounts.createHostedAuthLink({
        type: 'create',
        providers: ['LINKEDIN'],
        success_redirect_url: input.successRedirectUrl,
        failure_redirect_url: input.failureRedirectUrl,
        notify_url: notifyUrl,
        // Encode the org ID so we can route the CREATION_SUCCESS webhook back.
        // Unipile echoes this field in subsequent webhook payloads.
        name: `org:${input.organizationId}`,
        // 15-minute auth window - long enough to handle PIN flows, short
        // enough that stale links don't accumulate.
        expiresOn: Date.now() + 15 * 60 * 1000,
    });
    return { url: res.url };
}

export async function generateReconnectLink(organizationId: string, accountId: string): Promise<{ url: string }> {
    const acct = await prisma.linkedInAccount.findFirst({
        where: { id: accountId, organization_id: organizationId },
    });
    if (!acct) throw new Error('Account not found');

    const notifyUrl = `${process.env.BACKEND_URL}/webhooks/unipile`;
    const res = await unipileAccounts.createHostedAuthLink({
        type: 'reconnect',
        providers: ['LINKEDIN'],
        reconnect_account: acct.unipile_account_id,
        success_redirect_url: `${process.env.FRONTEND_URL}/dashboard/linkedin/accounts?reconnected=1`,
        failure_redirect_url: `${process.env.FRONTEND_URL}/dashboard/linkedin/accounts?reconnect_failed=1`,
        notify_url: notifyUrl,
        name: `org:${organizationId}`,
        expiresOn: Date.now() + 15 * 60 * 1000,
    });
    return { url: res.url };
}

// ────────────────────────────────────────────────────────────────────
// Webhook ingestion - called by unipileWebhookController.
//
// On CREATION_SUCCESS we fetch the full account detail (so we get
// display name, account type) and upsert. On status changes we just
// update the status column. On DELETED we remove the row.
// ────────────────────────────────────────────────────────────────────

const STATUS_EVENTS = new Set([
    'CREATION_SUCCESS', 'OK', 'CREDENTIALS', 'ERROR',
    'CONNECTING', 'RECONNECTED', 'SYNC_SUCCESS', 'DELETED',
]);

export async function handleStatusEvent(payload: {
    event: string;
    account_id: string;
    name?: string;
    timestamp?: string;
}): Promise<void> {
    if (!STATUS_EVENTS.has(payload.event)) return;

    // Extract organization from the `name` field we set during hosted-auth
    // generation. Existing accounts already have the FK so we can fall back
    // to looking up by unipile_account_id.
    let organizationId: string | null = null;
    if (payload.name?.startsWith('org:')) {
        organizationId = payload.name.slice('org:'.length);
    }

    if (payload.event === 'DELETED') {
        // Need to identify the org BEFORE the row is gone so the slot-
        // release logic can run. deleteMany doesn't return the row, so
        // look it up first. If the account doesn't exist locally we're
        // done - Unipile sometimes emits DELETED twice and the second
        // is a no-op.
        const orphan = await prisma.linkedInAccount.findUnique({
            where: { unipile_account_id: payload.account_id },
            select: { id: true, organization_id: true },
        });
        if (!orphan) {
            logger.info('[LINKEDIN-ACCT] DELETED webhook for unknown account - already cleaned', { unipile_account_id: payload.account_id });
            return;
        }

        const accountsBefore = await prisma.linkedInAccount.count({
            where: { organization_id: orphan.organization_id },
        });

        await prisma.linkedInAccount.delete({ where: { id: orphan.id } });
        logger.info('[LINKEDIN-ACCT] Removed account on DELETED webhook', { unipile_account_id: payload.account_id });

        // Mirror the user-initiated disconnect release - Unipile-side
        // deletions (account revoked / session expired) free paid
        // capacity the same way an operator-driven disconnect does.
        // This stops billing for the slot on the next cycle; no money
        // is refunded - it's purely a capacity-counter decrement.
        try {
            const result = await releaseAddonSlotOnDisconnect(orphan.organization_id, accountsBefore);
            if (result.released) {
                logger.info('[LINKEDIN-ACCT] Addon slot released on DELETED webhook', {
                    organizationId: orphan.organization_id, unipile_account_id: payload.account_id, reason: result.reason,
                });
            }
        } catch (err) {
            logger.warn('[LINKEDIN-ACCT] Addon release failed after DELETED webhook (row still removed)', {
                organizationId: orphan.organization_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        return;
    }

    // For CREATION_SUCCESS we hydrate the full account from Unipile so we
    // have name + type. For subsequent status events we already have the
    // row and just update status.
    if (payload.event === 'CREATION_SUCCESS') {
        if (!organizationId) {
            logger.warn('[LINKEDIN-ACCT] CREATION_SUCCESS without org context in name field', { account_id: payload.account_id });
            return;
        }
        const detail = await safeFetchAccount(payload.account_id);
        const tier = normalizeType(detail?.type);
        const tierCaps = defaultCapsForTier(tier);
        await prisma.linkedInAccount.upsert({
            where: { unipile_account_id: payload.account_id },
            create: {
                organization_id: organizationId,
                unipile_account_id: payload.account_id,
                display_name: detail?.name ?? 'LinkedIn account',
                account_type: tier,
                // Tier-aware cap defaults - Classic can't send InMail at
                // all; Premium gets 5-15/month; Sales Nav ~50/month;
                // Recruiter 30-150/month. Daily caps are conservative so
                // operators don't burn the monthly allotment in one day.
                // Operators can raise/lower these per-account on the
                // settings page.
                max_inmails_per_day: tierCaps.inmail_per_day,
                status: 'OK',
                last_status_at: new Date(),
            },
            update: {
                display_name: detail?.name ?? undefined,
                account_type: tier,
                // On reconnect we DON'T reset the operator's manual cap
                // overrides - only refresh the account_type label.
                status: 'OK',
                last_status_at: new Date(),
            },
        });
        logger.info('[LINKEDIN-ACCT] Created/refreshed account on CREATION_SUCCESS', { unipile_account_id: payload.account_id, organization_id: organizationId, tier });
        return;
    }

    // Plain status update for OK / CREDENTIALS / ERROR / CONNECTING / ...
    await prisma.linkedInAccount.updateMany({
        where: { unipile_account_id: payload.account_id },
        data: {
            status: payload.event,
            last_status_at: new Date(),
        },
    });
}

async function safeFetchAccount(unipileAccountId: string): Promise<UnipileAccount | null> {
    try {
        return await unipileAccounts.getAccount(unipileAccountId);
    } catch (err) {
        logger.warn('[LINKEDIN-ACCT] Failed to fetch account detail from Unipile', { unipileAccountId, err: (err as Error).message });
        return null;
    }
}

/**
 * Map Unipile's `type` string into our 4-value enum.
 *
 * Unipile docs reference "LinkedIn Classic & Premium", "LinkedIn Recruiter",
 * and "LinkedIn Sales Navigator" but don't pin down the exact wire values.
 * The mapping below handles every casing + word-order variant we've seen
 * across their docs + community examples. Unknown strings fall back to
 * CLASSIC (most permissive - limits restrict actions, not capabilities).
 */
/**
 * Per-tier daily-cap defaults applied at first account connection.
 *
 * Sources: LinkedIn-published monthly InMail allotments per plan, divided
 * conservatively across business days. Operators can override these
 * per-account on the settings page; we only set them once at creation
 * so existing manual overrides aren't clobbered on reconnect.
 *
 *   CLASSIC   - 0 InMails (LinkedIn doesn't expose the feature to Free)
 *   PREMIUM   - 1/day  (Career = 5/mo, Business = 15/mo → 0.2-0.7/day)
 *   SALES_NAV - 3/day  (Core / Advanced = ~50/mo → ~2.3/day)
 *   RECRUITER - 6/day  (Lite = 30/mo, Recruiter = 150+/mo)
 */
function defaultCapsForTier(tier: string): { inmail_per_day: number } {
    switch (tier) {
        case 'RECRUITER': return { inmail_per_day: 6 };
        case 'SALES_NAV': return { inmail_per_day: 3 };
        case 'PREMIUM':   return { inmail_per_day: 1 };
        case 'CLASSIC':
        default:          return { inmail_per_day: 0 };
    }
}

function normalizeType(t: string | undefined | null): string {
    if (!t) return 'CLASSIC';
    const upper = String(t).toUpperCase().replace(/[\s\-]+/g, '_');
    // Sales Navigator: "SALES_NAV", "SALES_NAVIGATOR", "LINKEDIN_SALES_NAV", "SALESNAV"
    if (upper.includes('SALES') && upper.includes('NAV')) return 'SALES_NAV';
    if (upper === 'SALES_NAV' || upper === 'SALESNAV') return 'SALES_NAV';
    // Recruiter: "RECRUITER", "LINKEDIN_RECRUITER", "RECRUITER_LITE", "RECRUITER_PRO"
    if (upper.includes('RECRUITER')) return 'RECRUITER';
    // Premium: "PREMIUM", "LINKEDIN_PREMIUM", "PREMIUM_BUSINESS", "PREMIUM_CAREER"
    if (upper.includes('PREMIUM')) return 'PREMIUM';
    // Free / Classic / Basic / Standard all collapse to CLASSIC.
    if (upper.includes('CLASSIC') || upper.includes('FREE') || upper.includes('BASIC') || upper.includes('STANDARD')) return 'CLASSIC';
    return 'CLASSIC';
}

// ────────────────────────────────────────────────────────────────────
// Disconnect (user-initiated)
//
// We call Unipile first so a failure there is reported synchronously to
// the user. The DELETED webhook will eventually clear the row regardless,
// but we also delete locally on success so the UI updates immediately.
// ────────────────────────────────────────────────────────────────────

export async function disconnectAccount(organizationId: string, id: string): Promise<void> {
    const acct = await prisma.linkedInAccount.findFirst({
        where: { id, organization_id: organizationId },
    });
    if (!acct) throw new Error('Account not found');

    // Snapshot account count BEFORE delete so the slot-release logic
    // can tell whether this account was occupying a paid (addon) slot
    // vs a free (base-tier-bundled) slot.
    const accountsBefore = await prisma.linkedInAccount.count({
        where: { organization_id: organizationId },
    });

    await unipileAccounts.deleteAccount(acct.unipile_account_id);
    await prisma.linkedInAccount.delete({ where: { id: acct.id } });

    // Best-effort release. We log but never throw - the user-facing
    // disconnect must succeed even if the addon-counter decrement
    // fails, because the LinkedInAccount row is already gone and a
    // stuck "still billed for an addon" state is recoverable via
    // support, whereas a stuck "account half-deleted" state is not.
    try {
        const result = await releaseAddonSlotOnDisconnect(organizationId, accountsBefore);
        if (result.released) {
            logger.info('[LINKEDIN-ACCT] Addon slot released on disconnect', {
                organizationId, accountId: id, reason: result.reason,
            });
        }
    } catch (err) {
        logger.warn('[LINKEDIN-ACCT] Addon release failed (account still disconnected)', {
            organizationId, accountId: id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ────────────────────────────────────────────────────────────────────
// Update (caps / display name / sync mode)
// ────────────────────────────────────────────────────────────────────

export interface UpdateAccountInput {
    display_name?: string;
    inbox_sync_mode?: 'all' | 'sequence_only';
    max_invites_per_day?: number;
    max_invites_per_week?: number;
    max_messages_per_day?: number;
    max_inmails_per_day?: number;
    max_profile_views_per_day?: number;
    max_unipile_actions_per_day?: number;
}

export async function updateAccount(organizationId: string, id: string, input: UpdateAccountInput): Promise<LinkedInAccountView | null> {
    const row = await prisma.linkedInAccount.findFirst({
        where: { id, organization_id: organizationId },
    });
    if (!row) return null;

    const updated = await prisma.linkedInAccount.update({
        where: { id: row.id },
        data: {
            display_name: input.display_name,
            inbox_sync_mode: input.inbox_sync_mode,
            max_invites_per_day: input.max_invites_per_day,
            max_invites_per_week: input.max_invites_per_week,
            max_messages_per_day: input.max_messages_per_day,
            max_inmails_per_day: input.max_inmails_per_day,
        },
    });
    return toView(updated);
}
