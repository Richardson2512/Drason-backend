/**
 * Mailbox Sending-IP Resolution
 *
 * Determines the sending IP a mailbox uses for outbound mail. The result is
 * stored on `Mailbox.sending_ip` so the periodic IP-blacklist worker can
 * check it against DNSBL lists.
 *
 * IMPORTANT: this only makes sense for SMTP / relay providers (Zapmail,
 * Scaledmail, MissionInbox, custom SMTP). For Gmail and Microsoft 365 OAuth
 * mailboxes the sending IP is shared infrastructure managed by the provider
 * — there's no stable per-mailbox IP, no actionable signal if it's listed,
 * and Google/Microsoft pull every customer through the same IP pools. Those
 * mailboxes are explicitly marked 'oauth_shared' and skipped in the worker.
 *
 * Resolution method:
 *   - SMTP: DNS-resolve the mailbox's connected_account.smtp_host A record
 *   - OAuth: skip (sentinel only)
 *   - Manual: respect a previously-set 'manual' source — don't overwrite
 *
 * Approach choice (A-record, not real-time peer-IP):
 *   The connected SMTP server's A record is what we resolve; we deliberately
 *   do NOT capture the actual peer IP at TLS handshake time. Reasons:
 *     1. Peer-IP capture requires modifying every send path, which is the
 *        most fragile code in the system.
 *     2. Even with load-balanced SMTP front-ends the resolved A record is
 *        on the same provider IP block — actionable for "request delisting
 *        from Zapmail" decisions, which is the goal.
 *     3. ~95% of customers run a single SMTP front-end with a single A
 *        record; the cost/value of peer-IP doesn't justify the risk.
 *   If a customer reports their resolved IP is clean but mail still bounces
 *   (the 5% case), peer-IP capture is a clean follow-up — it stamps a more
 *   accurate value into the same column and the rest of the pipeline doesn't
 *   change.
 */

import { promises as dns } from 'dns';
import { prisma } from '../index';
import { logger } from './observabilityService';

const RESOLUTION_TTL_HOURS = 24;
const OAUTH_PROVIDERS = new Set(['google', 'microsoft', 'gmail', 'outlook']);

export interface ResolutionResult {
    /** Resolved IPv4 address. null when source='oauth_shared' or resolution failed. */
    ip: string | null;
    /** How we got the IP. Stored on Mailbox.sending_ip_source. */
    source: 'smtp_host_dns' | 'oauth_shared' | 'manual' | 'unresolved';
    /** Human-readable note; surfaced in UI when ip is null. */
    note?: string;
}

/**
 * Resolve and persist the sending IP for a single mailbox. Idempotent —
 * skips work if the resolution is fresh (within TTL) and not stale, unless
 * `force` is set.
 *
 * Manual overrides are sticky: if a row already has source='manual' we
 * never overwrite it from this service. Operators changed the IP for a
 * reason; only the manual UI path should rewrite it.
 */
export async function resolveAndPersistMailboxIp(
    mailboxId: string,
    opts: { force?: boolean } = {},
): Promise<ResolutionResult> {
    const mailbox = await prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: {
            id: true,
            email: true,
            sending_ip: true,
            sending_ip_source: true,
            sending_ip_resolved_at: true,
        },
    });
    if (!mailbox) {
        return { ip: null, source: 'unresolved', note: 'Mailbox not found' };
    }

    // Don't overwrite an operator's manual entry.
    if (mailbox.sending_ip_source === 'manual') {
        return {
            ip: mailbox.sending_ip,
            source: 'manual',
            note: 'Manually set by operator — not overwritten',
        };
    }

    // Skip if fresh (TTL-based caching at the row level — saves DNS queries).
    if (!opts.force && mailbox.sending_ip_resolved_at) {
        const ageHours = (Date.now() - mailbox.sending_ip_resolved_at.getTime()) / 36e5;
        if (ageHours < RESOLUTION_TTL_HOURS) {
            return {
                ip: mailbox.sending_ip,
                source: (mailbox.sending_ip_source as ResolutionResult['source']) || 'unresolved',
                note: 'Cached',
            };
        }
    }

    // Find the connected account so we can read smtp_host or detect OAuth.
    // Connected account id == mailbox id by convention (mailboxProvisioningService).
    const account = await prisma.connectedAccount.findUnique({
        where: { id: mailboxId },
        select: { provider: true, smtp_host: true },
    });

    let result: ResolutionResult;

    if (account && OAUTH_PROVIDERS.has((account.provider || '').toLowerCase())) {
        result = {
            ip: null,
            source: 'oauth_shared',
            note: 'Shared provider infrastructure (Gmail / Microsoft) — IP is not blacklist-actionable',
        };
    } else if (account?.smtp_host) {
        result = await resolveSmtpHost(account.smtp_host);
    } else {
        result = {
            ip: null,
            source: 'unresolved',
            note: 'No SMTP host or OAuth provider configured',
        };
    }

    // Persist. Even null+unresolved gets persisted so the worker doesn't
    // retry every cycle for a misconfigured mailbox.
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            sending_ip: result.ip,
            sending_ip_source: result.source,
            sending_ip_resolved_at: new Date(),
        },
    });

    return result;
}

/**
 * Resolve an SMTP host's first A record. Uses node's built-in DNS resolver
 * with a short timeout so a misconfigured host can't stall the worker.
 */
export async function resolveSmtpHost(smtpHost: string): Promise<ResolutionResult> {
    const host = smtpHost.trim().toLowerCase();
    if (!host) {
        return { ip: null, source: 'unresolved', note: 'Empty SMTP host' };
    }

    try {
        const addresses = await Promise.race([
            dns.resolve4(host),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('DNS timeout')), 5000),
            ),
        ]);

        const ip = addresses[0];
        if (!ip) {
            return { ip: null, source: 'unresolved', note: `No A records for ${host}` };
        }

        return {
            ip,
            source: 'smtp_host_dns',
            note: addresses.length > 1
                ? `Load-balanced (${addresses.length} A records); checking ${ip}`
                : undefined,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[MAILBOX_IP] Failed to resolve ${host}: ${msg}`);
        return {
            ip: null,
            source: 'unresolved',
            note: `DNS resolution failed: ${msg}`,
        };
    }
}

/**
 * Manual override — operator-typed IP. Bypasses DNS, marks sticky.
 */
export async function setManualSendingIp(mailboxId: string, ip: string): Promise<void> {
    if (!isValidIpv4(ip)) {
        throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    await prisma.mailbox.update({
        where: { id: mailboxId },
        data: {
            sending_ip: ip,
            sending_ip_source: 'manual',
            sending_ip_resolved_at: new Date(),
        },
    });
}

function isValidIpv4(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => {
        const n = Number(p);
        return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === p;
    });
}

/**
 * Bulk-resolve IPs for every mailbox in an org. Used by the backfill script
 * and by the IP blacklist worker as its first pass before checking DNSBL.
 */
export async function resolveOrgMailboxIps(
    organizationId: string,
    opts: { force?: boolean } = {},
): Promise<{ resolved: number; oauthShared: number; failed: number }> {
    const mailboxes = await prisma.mailbox.findMany({
        where: { organization_id: organizationId },
        select: { id: true },
    });

    let resolved = 0;
    let oauthShared = 0;
    let failed = 0;

    // Sequential — DNS is fast enough that we don't need concurrency, and
    // keeping it sequential avoids hammering the resolver during a batch.
    for (const m of mailboxes) {
        const r = await resolveAndPersistMailboxIp(m.id, opts);
        if (r.source === 'oauth_shared') oauthShared++;
        else if (r.ip) resolved++;
        else failed++;
    }

    return { resolved, oauthShared, failed };
}
