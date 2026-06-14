/**
 * Super Sender - dedicated SES IP service.
 *
 * Owns the lifecycle of a DedicatedIp row from Polar checkout creation
 * through SES provisioning, warmup ramp, allocation, and cancellation.
 *
 * State machine - see DedicatedIp model in schema.prisma. Transitions
 * happen in three places:
 *   1. Checkout creation - service.createCheckout() inserts a
 *      `pending_payment` row keyed to the Polar checkout id.
 *   2. Webhook arrival - webhook handler fans the line-item quantity into
 *      N rows. The first row is the existing pending_payment row (matched
 *      by checkout id), additional rows are inserted in `pending_payment`
 *      and immediately moved to `provisioning` once the agency owner
 *      assigns them to a workspace.
 *   3. Workers - provisioning poller flips provisioning → warming once
 *      SES reports the IP active; ramp worker advances warmup_day and
 *      flips warming → active on day 30.
 *
 * Tier gating: Super Sender is available to every paid tier. Trial users
 * see the marketing page but get a 403 when calling /checkout. Lower
 * tiers don't get the agency workspace picker (it's only relevant when
 * the Account has agency_mode_enabled and >1 workspace).
 */

import { prisma } from '../index';
import { logger } from './observabilityService';
import { polarApi, ensurePolarCustomer } from './polarClient';

export const SUPER_SENDER_PRICE_USD = 39;
export const REASSIGN_COOLDOWN_HOURS = 24;
export const WARMUP_DAYS = 30;

/**
 * Polar product id for Super Sender. One product, charged $39/IP/month.
 * Quantity is set on the checkout line item; the webhook handler reads
 * the quantity to fan out N DedicatedIp rows.
 */
function getSuperSenderProductId(): string {
    const id = process.env.POLAR_SUPER_SENDER_PRODUCT_ID;
    if (!id) {
        throw new Error('POLAR_SUPER_SENDER_PRODUCT_ID is not configured');
    }
    return id;
}

// ────────────────────────────────────────────────────────────────────
// Tier gate
// ────────────────────────────────────────────────────────────────────

const PURCHASE_ELIGIBLE_TIERS = new Set(['starter', 'pro', 'pro_80k', 'pro_100k', 'pro_150k', 'pro_200k', 'pro_250k', 'growth', 'scale', 'enterprise']);

export async function canPurchaseSuperSender(orgId: string): Promise<{ ok: boolean; reason?: string }> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { subscription_tier: true, subscription_status: true },
    });
    if (!org) return { ok: false, reason: 'Organization not found' };
    if (!PURCHASE_ELIGIBLE_TIERS.has(org.subscription_tier)) {
        return { ok: false, reason: 'Upgrade to a paid plan to purchase a dedicated IP' };
    }
    if (org.subscription_status !== 'active') {
        return { ok: false, reason: 'Reactivate your subscription before purchasing add-ons' };
    }
    return { ok: true };
}

// ────────────────────────────────────────────────────────────────────
// Account resolution - Super Sender is billed at the Account level so
// every IP an agency owner buys lands in one pool regardless of which
// workspace they were viewing when they clicked Buy.
// ────────────────────────────────────────────────────────────────────

async function resolveAccountIdForOrg(orgId: string): Promise<string | null> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { account_id: true },
    });
    return org?.account_id ?? null;
}

/**
 * Lazy-create an Account for a legacy single-org user.
 *
 * The Account model was added with the agency-mode rollout - orgs that
 * existed before that have `account_id = NULL`. Super Sender requires
 * an Account because IPs live in an agency-level pool, so on first
 * purchase we auto-provision one for the legacy org. The newly-created
 * Account is owned by the calling user, agency_mode_enabled=false (we
 * don't accidentally turn on the agency UX), and named after the org.
 *
 * Idempotent - racing two callers for the same org is safe because we
 * re-read after acquiring the row and skip if account_id is already set.
 */
async function ensureAccountForOrg(orgId: string, userId: string): Promise<string> {
    const existing = await resolveAccountIdForOrg(orgId);
    if (existing) return existing;

    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, slug: true, account_id: true },
    });
    if (!org) throw new Error('Organization not found');
    if (org.account_id) return org.account_id;

    const created = await prisma.account.create({
        data: {
            name: org.name,
            owner_user_id: userId,
            agency_mode_enabled: false,
        },
        select: { id: true },
    });

    // Link the org. Conditional on account_id IS NULL so a concurrent
    // racer that won the create race wins permanently.
    const linked = await prisma.organization.updateMany({
        where: { id: orgId, account_id: null },
        data: { account_id: created.id },
    });

    if (linked.count === 0) {
        // Lost the race - read the winner's account_id and use that.
        const fresh = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { account_id: true },
        });
        // Best-effort cleanup of our orphaned Account row. Ignore errors
        // because losing the race is rare and an orphan Account does no harm.
        await prisma.account.delete({ where: { id: created.id } }).catch(() => undefined);
        if (fresh?.account_id) return fresh.account_id;
        throw new Error('Failed to link Account to Organization');
    }

    logger.info('[SUPER_SENDER] Lazy-provisioned Account for legacy org', {
        orgId,
        accountId: created.id,
        userId,
    });
    return created.id;
}

// ────────────────────────────────────────────────────────────────────
// Checkout creation - option B from the product spec: a single Polar
// line item with `quantity = N`, where N = number of workspaces the
// agency owner ticked. Webhook fans the quantity out into N rows.
// ────────────────────────────────────────────────────────────────────

export interface CreateCheckoutInput {
    /** Org of the user who clicked Buy. Used for Polar customer + tier check. */
    orgId: string;
    /** User id of the buyer. Used to lazy-create an Account for legacy
     *  single-org users that pre-date the agency-mode rollout. */
    userId: string;
    /** Number of dedicated IPs to purchase. 1 for non-agency users. */
    quantity: number;
    /**
     * Workspaces the agency owner ticked. Carried in Polar metadata so the
     * webhook can pre-allocate IPs straight to the chosen workspaces - no
     * manual allocation step needed when the user pre-selected.
     *
     * Empty array = unallocated; rows land in the account pool and the user
     * assigns them later from the Pending IPs inbox.
     */
    workspaceIds: string[];
}

export interface CreateCheckoutResult {
    checkoutUrl: string;
    checkoutId: string;
    quantity: number;
}

export async function createSuperSenderCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    if (input.quantity < 1 || input.quantity > 50) {
        throw new Error('Quantity must be between 1 and 50');
    }
    if (input.workspaceIds.length > 0 && input.workspaceIds.length !== input.quantity) {
        throw new Error('workspaceIds length must equal quantity, or be empty');
    }

    const gate = await canPurchaseSuperSender(input.orgId);
    if (!gate.ok) {
        throw new Error(gate.reason || 'Not eligible');
    }

    // Lazy-create an Account for legacy single-org users that pre-date
    // agency mode. agency_mode_enabled stays false - we don't accidentally
    // flip on the multi-workspace UX.
    const accountId = await ensureAccountForOrg(input.orgId, input.userId);

    // Validate every workspace belongs to this account - never let a
    // user smuggle in a workspace_id from another tenant.
    if (input.workspaceIds.length > 0) {
        const owned = await prisma.organization.findMany({
            where: { account_id: accountId, id: { in: input.workspaceIds } },
            select: { id: true },
        });
        if (owned.length !== input.workspaceIds.length) {
            throw new Error('One or more workspaces are not part of this account');
        }
    }

    const productId = getSuperSenderProductId();
    const customerId = await ensurePolarCustomer(input.orgId);

    // Polar line-item with quantity. The webhook handler reads `quantity`
    // off the order/subscription event payload to size the fan-out.
    const response = await polarApi.post('/checkouts', {
        product_id: productId,
        customer_id: customerId,
        // Polar does not currently expose a `quantity` parameter on the
        // public Checkouts API for the legacy single-line shape, so we
        // pass it through metadata. The webhook handler reads
        // `metadata.super_sender_quantity` to size the fan-out - same
        // mechanism that carries workspace_ids.
        success_url: `${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/sequencer/super-sender?checkout=success`,
        cancel_url: `${process.env.APP_URL || process.env.FRONTEND_URL}/dashboard/sequencer/super-sender?checkout=canceled`,
        metadata: {
            // The org the user was viewing when they clicked Buy. Used by
            // the webhook to resolve the account.
            organization_id: input.orgId,
            // Marker so the billingService webhook router knows to hand
            // this event to the Super Sender handler instead of treating
            // it as a tier upgrade.
            super_sender: 'true',
            super_sender_quantity: String(input.quantity),
            super_sender_workspace_ids: input.workspaceIds.join(','),
        },
    });

    const checkoutId: string = response.data.id;
    const checkoutUrl: string = response.data.url;

    // Pre-create one pending row keyed to the checkout id. Additional rows
    // are created when the webhook arrives (we don't know the subscription
    // id yet, and we don't want to create N rows that might be orphaned if
    // the user closes the checkout). The single placeholder row anchors
    // the audit trail and lets the UI show "purchase in progress."
    await prisma.dedicatedIp.create({
        data: {
            account_id: accountId,
            // First workspace pre-allocation if provided, else NULL.
            organization_id: input.workspaceIds[0] ?? null,
            polar_checkout_id: checkoutId,
            state: 'pending_payment',
        },
    });

    logger.info('[SUPER_SENDER] Checkout created', {
        accountId,
        orgId: input.orgId,
        checkoutId,
        quantity: input.quantity,
        preAllocated: input.workspaceIds.length,
    });

    return { checkoutUrl, checkoutId, quantity: input.quantity };
}

// ────────────────────────────────────────────────────────────────────
// Webhook fan-out - called from billingService when the event metadata
// carries super_sender=true. Idempotent on (subscription_id, account_id).
// ────────────────────────────────────────────────────────────────────

interface WebhookEventLike {
    type: string;
    data?: {
        id?: string;
        metadata?: Record<string, string | number>;
    } & Record<string, unknown>;
}

export async function handleSuperSenderWebhook(event: WebhookEventLike, resolvedOrgId: string): Promise<void> {
    const subscriptionId = event.data?.id;
    if (!subscriptionId) {
        logger.warn('[SUPER_SENDER] Webhook missing subscription id', { type: event.type });
        return;
    }

    const accountId = await resolveAccountIdForOrg(resolvedOrgId);
    if (!accountId) {
        logger.warn('[SUPER_SENDER] Webhook for org with no account', { resolvedOrgId, subscriptionId });
        return;
    }

    if (event.type === 'subscription.canceled' || event.type === 'subscription.revoked') {
        await handleCancellation(String(subscriptionId), accountId);
        return;
    }

    // subscription.created / subscription.active path. Read fan-out hints
    // from metadata. The pre-created pending row (keyed to checkout id)
    // becomes row 1; we insert quantity-1 additional rows here.
    const metadata = event.data?.metadata || {};
    const quantity = Number(metadata.super_sender_quantity || 1);
    const workspaceIds = String(metadata.super_sender_workspace_ids || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    // Idempotency guard - if any row already exists for this subscription,
    // assume the fan-out already happened. (Polar can fire .created and
    // .active for the same sub_id; without this guard we'd 2x the rows.)
    const existing = await prisma.dedicatedIp.findFirst({
        where: { polar_subscription_id: String(subscriptionId), account_id: accountId },
        select: { id: true },
    });
    if (existing) {
        logger.info('[SUPER_SENDER] Webhook idempotency hit - fan-out already done', {
            subscriptionId,
            accountId,
        });
        return;
    }

    // Promote the pre-created pending row to row 1.
    const eventData = event.data as Record<string, unknown> | undefined;
    const rawCheckoutId =
        (eventData?.checkout_id as string | undefined) ??
        ((eventData?.checkout as { id?: string } | undefined)?.id);
    const checkoutId = rawCheckoutId ?? null;
    let firstRowUpdated = false;
    if (checkoutId) {
        const existingByCheckout = await prisma.dedicatedIp.findUnique({
            where: { polar_checkout_id: String(checkoutId) },
        });
        if (existingByCheckout) {
            await prisma.dedicatedIp.update({
                where: { id: existingByCheckout.id },
                data: {
                    polar_subscription_id: String(subscriptionId),
                    // If pre-allocation included workspace_ids[0], it's
                    // already on the row. Move into provisioning.
                    state: existingByCheckout.organization_id ? 'provisioning' : 'pending_payment',
                },
            });
            firstRowUpdated = true;
        }
    }

    const rowsToCreate = quantity - (firstRowUpdated ? 1 : 0);
    if (rowsToCreate > 0) {
        const createMany: Array<{
            account_id: string;
            organization_id: string | null;
            polar_subscription_id: string;
            state: string;
        }> = [];
        // Workspace IDs at index 0 already used on the pre-created row.
        const offset = firstRowUpdated ? 1 : 0;
        for (let i = 0; i < rowsToCreate; i++) {
            const workspaceId = workspaceIds[offset + i] || null;
            createMany.push({
                account_id: accountId,
                organization_id: workspaceId,
                polar_subscription_id: String(subscriptionId),
                // If pre-allocated, jump straight to provisioning so the
                // SES worker picks it up; otherwise sit in the pool.
                state: workspaceId ? 'provisioning' : 'pending_payment',
            });
        }
        await prisma.dedicatedIp.createMany({ data: createMany });
    }

    logger.info('[SUPER_SENDER] Webhook fan-out complete', {
        accountId,
        subscriptionId,
        quantity,
        preAllocatedCount: workspaceIds.length,
    });
}

async function handleCancellation(subscriptionId: string, accountId: string): Promise<void> {
    const updated = await prisma.dedicatedIp.updateMany({
        where: {
            polar_subscription_id: subscriptionId,
            account_id: accountId,
            state: { not: 'canceled' },
        },
        data: {
            state: 'canceled',
            canceled_at: new Date(),
        },
    });
    logger.info('[SUPER_SENDER] Subscription canceled - IPs marked', {
        accountId,
        subscriptionId,
        rowsUpdated: updated.count,
    });
}

// ────────────────────────────────────────────────────────────────────
// Allocation - assigning a pending IP to a workspace, reassigning, or
// returning it to the pool. Reassignment cooldown is enforced here.
// ────────────────────────────────────────────────────────────────────

export class AllocationError extends Error {
    constructor(message: string, public code: 'NOT_FOUND' | 'COOLDOWN' | 'INVALID_STATE' | 'CROSS_TENANT') {
        super(message);
        this.name = 'AllocationError';
    }
}

export async function assignIpToWorkspace(opts: {
    ipId: string;
    workspaceId: string;
    accountId: string;
}): Promise<void> {
    const ip = await prisma.dedicatedIp.findFirst({
        where: { id: opts.ipId, account_id: opts.accountId },
    });
    if (!ip) throw new AllocationError('IP not found in this account', 'NOT_FOUND');
    if (ip.state === 'canceled' || ip.state === 'failed') {
        throw new AllocationError(`Cannot assign an IP in ${ip.state} state`, 'INVALID_STATE');
    }

    // Confirm target workspace belongs to this account.
    const workspace = await prisma.organization.findFirst({
        where: { id: opts.workspaceId, account_id: opts.accountId },
        select: { id: true },
    });
    if (!workspace) throw new AllocationError('Workspace not part of this account', 'CROSS_TENANT');

    // Reassignment cooldown - only applies if the IP is currently assigned
    // to a different workspace and was reassigned recently.
    if (ip.organization_id && ip.organization_id !== opts.workspaceId && ip.last_reassigned_at) {
        const ageMs = Date.now() - ip.last_reassigned_at.getTime();
        const cooldownMs = REASSIGN_COOLDOWN_HOURS * 60 * 60 * 1000;
        if (ageMs < cooldownMs) {
            const hoursLeft = Math.ceil((cooldownMs - ageMs) / (60 * 60 * 1000));
            throw new AllocationError(`Reassignment cooldown active - try again in ${hoursLeft}h`, 'COOLDOWN');
        }
    }

    await prisma.dedicatedIp.update({
        where: { id: ip.id },
        data: {
            organization_id: opts.workspaceId,
            // First-time allocation flips pending_payment → provisioning so
            // the SES worker picks it up. Subsequent reassignment leaves
            // state alone (the IP is already provisioned/warming/active).
            state: ip.state === 'pending_payment' ? 'provisioning' : ip.state,
            last_reassigned_at: ip.organization_id ? new Date() : null,
        },
    });

    logger.info('[SUPER_SENDER] IP assigned', {
        ipId: ip.id,
        accountId: opts.accountId,
        workspaceId: opts.workspaceId,
        priorWorkspaceId: ip.organization_id,
    });
}

/**
 * Manual pause - agency owner can hold sends on an IP without canceling
 * the Polar subscription. The send-path skips paused IPs (paused_reason
 * IS NOT NULL → routing resolver falls back to native), so this is the
 * operator-controllable lever to stop bleeding reputation while they
 * investigate.
 */
export async function pauseIp(opts: { ipId: string; accountId: string; reason?: string }): Promise<void> {
    const ip = await prisma.dedicatedIp.findFirst({
        where: { id: opts.ipId, account_id: opts.accountId },
        select: { id: true, paused_reason: true },
    });
    if (!ip) throw new AllocationError('IP not found in this account', 'NOT_FOUND');
    if (ip.paused_reason) {
        // Already paused - keep the existing reason (don't overwrite an
        // auto-pause indicator with a manual one).
        return;
    }
    await prisma.dedicatedIp.update({
        where: { id: ip.id },
        data: {
            paused_reason: opts.reason || 'manual',
            paused_at: new Date(),
        },
    });
    logger.info('[SUPER_SENDER] IP paused', { ipId: ip.id, reason: opts.reason || 'manual' });
}

/** Manual resume - clears any pause flag. Counters are NOT reset (the
 *  worker decays them daily); resuming an IP whose 24h aggregates still
 *  exceed thresholds is the operator's call. */
export async function resumeIp(opts: { ipId: string; accountId: string }): Promise<void> {
    const ip = await prisma.dedicatedIp.findFirst({
        where: { id: opts.ipId, account_id: opts.accountId },
        select: { id: true },
    });
    if (!ip) throw new AllocationError('IP not found in this account', 'NOT_FOUND');
    await prisma.dedicatedIp.update({
        where: { id: ip.id },
        data: { paused_reason: null, paused_at: null },
    });
    logger.info('[SUPER_SENDER] IP resumed', { ipId: ip.id });
}

export async function unassignIp(opts: { ipId: string; accountId: string }): Promise<void> {
    const ip = await prisma.dedicatedIp.findFirst({
        where: { id: opts.ipId, account_id: opts.accountId },
    });
    if (!ip) throw new AllocationError('IP not found in this account', 'NOT_FOUND');

    await prisma.dedicatedIp.update({
        where: { id: ip.id },
        data: {
            organization_id: null,
            last_reassigned_at: ip.organization_id ? new Date() : ip.last_reassigned_at,
        },
    });

    logger.info('[SUPER_SENDER] IP unassigned', { ipId: ip.id, accountId: opts.accountId });
}

// ────────────────────────────────────────────────────────────────────
// Read APIs - for the Super Sender page UI.
// ────────────────────────────────────────────────────────────────────

export interface DedicatedIpView {
    id: string;
    organization_id: string | null;
    workspace_name: string | null;
    state: string;
    ses_pool_name: string | null;
    ses_ip_address: string | null;
    warmup_day: number;
    daily_cap: number;
    sends_today: number;
    sends_reset_at: Date;
    bounce_count_24h: number;
    complaint_count_24h: number;
    delivered_count_24h: number;
    paused_reason: string | null;
    paused_at: Date | null;
    activated_at: Date | null;
    warmup_completed_at: Date | null;
    canceled_at: Date | null;
    last_error: string | null;
    polar_subscription_id: string | null;
    created_at: Date;
}

export async function listAccountIps(accountId: string): Promise<DedicatedIpView[]> {
    const rows = await prisma.dedicatedIp.findMany({
        where: { account_id: accountId },
        include: { organization: { select: { id: true, name: true, slug: true } } },
        orderBy: [{ state: 'asc' }, { created_at: 'asc' }],
    });
    return rows.map(r => ({
        id: r.id,
        organization_id: r.organization_id,
        workspace_name: r.organization?.name ?? null,
        state: r.state,
        ses_pool_name: r.ses_pool_name,
        ses_ip_address: r.ses_ip_address,
        warmup_day: r.warmup_day,
        daily_cap: r.daily_cap,
        sends_today: r.sends_today,
        sends_reset_at: r.sends_reset_at,
        bounce_count_24h: r.bounce_count_24h,
        complaint_count_24h: r.complaint_count_24h,
        delivered_count_24h: r.delivered_count_24h,
        paused_reason: r.paused_reason,
        paused_at: r.paused_at,
        activated_at: r.activated_at,
        warmup_completed_at: r.warmup_completed_at,
        canceled_at: r.canceled_at,
        last_error: r.last_error,
        polar_subscription_id: r.polar_subscription_id,
        created_at: r.created_at,
    }));
}

/** Lightweight check used by the banner - does this account have an IP yet? */
export async function accountHasAnyIp(accountId: string): Promise<boolean> {
    const count = await prisma.dedicatedIp.count({
        where: {
            account_id: accountId,
            state: { in: ['pending_payment', 'provisioning', 'warming', 'active'] },
        },
    });
    return count > 0;
}

/** Workspaces in this account that already have an active or pending IP. */
export async function workspacesWithIp(accountId: string): Promise<string[]> {
    const rows = await prisma.dedicatedIp.findMany({
        where: {
            account_id: accountId,
            organization_id: { not: null },
            state: { in: ['pending_payment', 'provisioning', 'warming', 'active'] },
        },
        select: { organization_id: true },
    });
    return Array.from(new Set(rows.map(r => r.organization_id!).filter(Boolean)));
}
