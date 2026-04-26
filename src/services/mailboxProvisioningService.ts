/**
 * Mailbox Provisioning Service — Option B unification bridge
 *
 * When a user connects a mailbox via the Sequencer (SMTP/OAuth), we create
 * a "shadow" Mailbox + Domain record in the Protection layer. This lets the
 * entire existing Protection stack (healing, correlation, auto-pause,
 * ESP performance tracking) operate on Sequencer mailboxes without any
 * special-casing inside those services.
 *
 * Key behaviors:
 * - Domain record is unique per (organization_id, domain). Reused if exists.
 * - Mailbox.id mirrors ConnectedAccount.id for stable cross-referencing
 *   (no auto-UUID because legacy sync systems set Mailbox.id from external IDs).
 * - source_platform = 'sequencer' distinguishes these from synced mailboxes.
 */

import { prisma } from '../index';
import { logger } from './observabilityService';

interface ProvisionInput {
    connectedAccountId: string;
    organizationId: string;
    email: string;
    displayName?: string | null;
}

/**
 * Idempotent: creates Domain + Mailbox records for a ConnectedAccount.
 * Safe to call multiple times — subsequent calls return the existing IDs.
 *
 * Returns { mailboxId, domainId } so callers can wire relations immediately.
 */
export async function provisionMailboxForConnectedAccount(
    input: ProvisionInput
): Promise<{ mailboxId: string; domainId: string }> {
    const { connectedAccountId, organizationId, email, displayName } = input;

    const domainName = email.split('@')[1]?.toLowerCase().trim();
    if (!domainName) {
        throw new Error(`Cannot derive domain from email: ${email}`);
    }

    // 1. Upsert Domain record (reuse if user has multiple mailboxes on same domain)
    const domain = await prisma.domain.upsert({
        where: { organization_id_domain: { organization_id: organizationId, domain: domainName } },
        create: {
            domain: domainName,
            organization_id: organizationId,
                        status: 'healthy',
            recovery_phase: 'healthy',
        },
        update: {}, // No-op on existing domain
    });

    // If this domain has never been DNS-checked, kick off a background DNS + DNSBL scan
    // so SPF/DKIM/DMARC + blacklist status is available immediately for the Protection layer.
    if (!domain.dns_checked_at) {
        // Fire and forget — don't block mailbox provisioning on DNS resolution
        (async () => {
            try {
                const [{ assessDomainDNS }, dnsblService] = await Promise.all([
                    import('./infrastructureAssessmentService'),
                    import('./dnsblService'),
                ]);
                const dnsblLists = await dnsblService.getListsForRun('critical_only');
                const result = await assessDomainDNS(domainName, domain.id, dnsblLists);
                await prisma.domain.update({
                    where: { id: domain.id },
                    data: {
                        spf_valid: result.spfValid,
                        dkim_valid: result.dkimValid,
                        dmarc_policy: result.dmarcPolicy,
                        blacklist_score: result.score,
                        dns_checked_at: new Date(),
                    },
                });
                logger.info(`[PROVISION] DNS check complete for ${domainName}`, {
                    spf: result.spfValid, dkim: result.dkimValid, dmarc: result.dmarcPolicy, blacklistScore: result.score,
                });
            } catch (err: any) {
                logger.warn(`[PROVISION] Background DNS check failed for ${domainName}: ${err.message}`);
            }
        })();
    }

    // 2. Upsert Mailbox record. Use the ConnectedAccount.id as the Mailbox.id
    //    so cross-references are stable and we can look up either direction.
    const mailbox = await prisma.mailbox.upsert({
        where: { id: connectedAccountId },
        create: {
            id: connectedAccountId,
            email: email.toLowerCase(),
            status: 'healthy',
                        recovery_phase: 'healthy',
            domain_id: domain.id,
            organization_id: organizationId,
            connected_account_id: connectedAccountId,
        },
        update: {
            // Keep these in sync on re-provisioning (e.g. display_name changed during OAuth)
            email: email.toLowerCase(),
            connected_account_id: connectedAccountId,
        },
    });

    logger.info(`[PROVISION] Shadow mailbox ready for ${email}`, {
        mailboxId: mailbox.id,
        domainId: domain.id,
        domain: domainName,
    });

    // Resolve sending IP (or mark as oauth_shared) so the periodic IP blacklist
    // worker can pick it up on its next cycle. Fire-and-forget — never block
    // provisioning on a DNS lookup. Errors are logged inside the service.
    import('./mailboxIpResolutionService').then(m => m.resolveAndPersistMailboxIp(mailbox.id))
        .catch(err => logger.warn('[PROVISION] IP resolution failed', { mailboxId: mailbox.id, error: err?.message }));

    return { mailboxId: mailbox.id, domainId: domain.id };
}

/**
 * Soft-delete the shadow Mailbox when a ConnectedAccount is removed.
 * We don't cascade-delete because SendEvent/BounceEvent history should be preserved
 * for analytics. Instead mark the Mailbox as disconnected.
 */
export async function deprovisionMailboxForConnectedAccount(connectedAccountId: string): Promise<void> {
    try {
        await prisma.mailbox.updateMany({
            where: { connected_account_id: connectedAccountId },
            data: {
                status: 'disconnected',
                connected_account_id: null,
            },
        });
        logger.info(`[PROVISION] Deprovisioned shadow mailbox for account ${connectedAccountId}`);
    } catch (err: any) {
        logger.warn(`[PROVISION] Deprovision failed for ${connectedAccountId}: ${err.message}`);
    }
}
