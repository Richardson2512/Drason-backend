/**
 * Campaign-level lead suppression.
 *
 * Resolves the set of emails that should be skipped when inserting leads
 * into a campaign. Reads CampaignSuppression rules and expands each kind:
 *
 *   'all_campaigns' — every email present in any other campaign in the org.
 *                     Functionally identical to the legacy
 *                     skipDuplicatesAcrossCampaigns boolean.
 *   'campaign'      — every email present in the named source campaign.
 *                     Multiple rules union into one set.
 *   'email'         — the literal email value, lowercased.
 *
 * The resolver is the only path the wizard, the edit flow, and any future
 * automation should call before inserting leads — so suppressions are
 * enforced uniformly without per-call-site logic drift.
 */

import { prisma } from '../index';
import type { Prisma, PrismaClient } from '@prisma/client';

export interface SuppressionInput {
    kind: 'all_campaigns' | 'campaign' | 'email';
    suppressed_campaign_id?: string | null;
    suppressed_email?: string | null;
}

/** Prisma client OR a transaction client — both expose the same model
 *  surface, so the helper accepts either to compose cleanly with outer
 *  transactions (createCampaign) or run standalone (updateCampaign). */
type PrismaLike = PrismaClient | Prisma.TransactionClient;

function normalizeEmail(s: string): string {
    return s.trim().toLowerCase();
}

/**
 * Replace this campaign's suppression rules. Idempotent — wipes prior
 * rules and inserts the new set in a single transaction so the campaign
 * never has half-applied rules visible to a concurrent lead insert.
 *
 * Cross-tenant safe: every suppressed_campaign_id is verified to belong
 * to the same organization before insertion.
 */
export async function setSuppressionRules(opts: {
    campaignId: string;
    organizationId: string;
    rules: SuppressionInput[];
    /** Optional Prisma transaction client. When provided, runs inside the
     *  caller's transaction (createCampaign path); otherwise the helper
     *  opens its own transaction. */
    client?: PrismaLike;
}): Promise<void> {
    const db: PrismaLike = opts.client ?? prisma;

    // Validate every campaign id belongs to this org.
    const sourceCampaignIds = Array.from(new Set(
        opts.rules
            .filter(r => r.kind === 'campaign' && r.suppressed_campaign_id)
            .map(r => r.suppressed_campaign_id as string),
    ));
    if (sourceCampaignIds.length > 0) {
        const owned = await db.campaign.findMany({
            where: { id: { in: sourceCampaignIds }, organization_id: opts.organizationId },
            select: { id: true },
        });
        const ownedSet = new Set(owned.map(c => c.id));
        const orphan = sourceCampaignIds.find(id => !ownedSet.has(id));
        if (orphan) {
            throw new Error(`Suppression references campaign ${orphan} which is not in this organization`);
        }
    }

    // Dedup + normalize the rule set client-side so the unique index can
    // be a safety net rather than the dedup primary.
    const seen = new Set<string>();
    const cleaned: Array<{ kind: string; suppressed_campaign_id: string | null; suppressed_email: string | null }> = [];
    for (const r of opts.rules) {
        if (r.kind === 'all_campaigns') {
            const key = `all_campaigns||`;
            if (seen.has(key)) continue;
            seen.add(key);
            cleaned.push({ kind: 'all_campaigns', suppressed_campaign_id: null, suppressed_email: null });
        } else if (r.kind === 'campaign' && r.suppressed_campaign_id) {
            const key = `campaign|${r.suppressed_campaign_id}|`;
            if (seen.has(key)) continue;
            seen.add(key);
            cleaned.push({ kind: 'campaign', suppressed_campaign_id: r.suppressed_campaign_id, suppressed_email: null });
        } else if (r.kind === 'email' && r.suppressed_email) {
            const email = normalizeEmail(r.suppressed_email);
            if (!email) continue;
            const key = `email||${email}`;
            if (seen.has(key)) continue;
            seen.add(key);
            cleaned.push({ kind: 'email', suppressed_campaign_id: null, suppressed_email: email });
        }
    }

    // When the caller provided a transaction client, run inline (we're
    // already in their atomic boundary). Otherwise open our own.
    const runWrites = async (writer: PrismaLike) => {
        await writer.campaignSuppression.deleteMany({ where: { campaign_id: opts.campaignId } });
        if (cleaned.length > 0) {
            await writer.campaignSuppression.createMany({
                data: cleaned.map(c => ({ ...c, campaign_id: opts.campaignId })),
            });
        }
    };
    if (opts.client) {
        await runWrites(opts.client);
    } else {
        await prisma.$transaction(async (tx) => runWrites(tx));
    }
}

/**
 * Read the full set of emails to suppress when inserting leads into
 * `campaignId`. Returns a normalized (lowercased) Set for O(1) `has` checks.
 *
 * Performance note: the campaign-scoped read scans CampaignLead by
 * campaign_id (indexed). For an agency with ~1M total leads across
 * campaigns, a typical suppression load (3-5 campaigns + a few hundred
 * email rules) returns 50k–200k emails in <100ms.
 */
export async function getSuppressedEmails(opts: {
    campaignId: string;
    organizationId: string;
    client?: PrismaLike;
}): Promise<Set<string>> {
    const db: PrismaLike = opts.client ?? prisma;
    const rules = await db.campaignSuppression.findMany({
        where: { campaign_id: opts.campaignId },
        select: { kind: true, suppressed_campaign_id: true, suppressed_email: true },
    });

    if (rules.length === 0) return new Set();

    const sourceCampaignIds: string[] = [];
    const literalEmails: string[] = [];
    let allCampaigns = false;
    for (const r of rules) {
        if (r.kind === 'all_campaigns') allCampaigns = true;
        else if (r.kind === 'campaign' && r.suppressed_campaign_id) sourceCampaignIds.push(r.suppressed_campaign_id);
        else if (r.kind === 'email' && r.suppressed_email) literalEmails.push(r.suppressed_email);
    }

    const suppressed = new Set<string>();
    for (const e of literalEmails) suppressed.add(normalizeEmail(e));

    if (allCampaigns) {
        // Every email across all of the org's campaigns (excluding self —
        // a lead can be re-added to its own campaign via the normal flow).
        const all = await db.campaignLead.findMany({
            where: {
                campaign: { organization_id: opts.organizationId },
                campaign_id: { not: opts.campaignId },
            },
            select: { email: true },
        });
        for (const r of all) suppressed.add(normalizeEmail(r.email));
    } else if (sourceCampaignIds.length > 0) {
        const scoped = await db.campaignLead.findMany({
            where: {
                campaign_id: { in: sourceCampaignIds },
                // Re-confirm org membership inside the join so a stale
                // rule (campaign deleted, FK left dangling pre-cascade)
                // can't leak emails from another tenant.
                campaign: { organization_id: opts.organizationId },
            },
            select: { email: true },
        });
        for (const r of scoped) suppressed.add(normalizeEmail(r.email));
    }

    return suppressed;
}

/**
 * Filter a lead array, dropping any whose email is in the suppression set.
 * Returns the filtered array + the count of dropped entries.
 */
export function applySuppression<T extends { email?: string | null }>(
    leads: T[],
    suppressed: Set<string>,
): { kept: T[]; skipped: number } {
    if (suppressed.size === 0) return { kept: leads, skipped: 0 };
    const before = leads.length;
    const kept = leads.filter(l => {
        const email = typeof l.email === 'string' ? normalizeEmail(l.email) : '';
        return !email || !suppressed.has(email);
    });
    return { kept, skipped: before - kept.length };
}

/** Read raw rules for the GET endpoint (frontend hydration). */
export async function listSuppressionRules(campaignId: string) {
    return prisma.campaignSuppression.findMany({
        where: { campaign_id: campaignId },
        select: {
            id: true,
            kind: true,
            suppressed_campaign_id: true,
            suppressed_email: true,
            created_at: true,
        },
        orderBy: { created_at: 'asc' },
    });
}
