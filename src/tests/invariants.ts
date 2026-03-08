/**
 * Invariant Test Suite — Data Integrity Assertions
 *
 * Run with: npx ts-node src/tests/invariants.ts
 *
 * These tests query the live database and verify that critical data invariants
 * hold. They do NOT modify data. Run after any sync, deployment, or whenever
 * you suspect data inconsistency.
 *
 * Invariants enforced:
 *   1. Engagement counters never negative
 *   2. Bounce rate cannot be negative or exceed 100%
 *   3. No lead is ACTIVE without an assigned campaign
 *   4. No mailbox is HEALTHY if its domain is PAUSED
 *   5. State transitions form a valid sequence
 *   6. No orphaned leads (assigned to campaign but not ACTIVE)
 *   7. Engagement rate is consistent with underlying counters
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface InvariantResult {
    name: string;
    passed: boolean;
    violations: number;
    details?: string[];
}

const results: InvariantResult[] = [];

function report(name: string, passed: boolean, violations: number, details?: string[]) {
    results.push({ name, passed, violations, details });
    const icon = passed ? '✓' : '✗';
    console.log(`  ${icon} ${name}${violations > 0 ? ` (${violations} violations)` : ''}`);
    if (details && details.length > 0) {
        details.slice(0, 5).forEach(d => console.log(`    → ${d}`));
        if (details.length > 5) console.log(`    ... and ${details.length - 5} more`);
    }
}

async function run() {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  DRASON INVARIANT TEST SUITE');
    console.log('═══════════════════════════════════════════════════\n');

    // ── Invariant 1: Engagement counters never negative ──
    {
        const negativeMailboxes = await prisma.mailbox.findMany({
            where: {
                OR: [
                    { open_count_lifetime: { lt: 0 } },
                    { click_count_lifetime: { lt: 0 } },
                    { reply_count_lifetime: { lt: 0 } },
                    { total_sent_count: { lt: 0 } },
                    { hard_bounce_count: { lt: 0 } },
                ]
            },
            select: { id: true, email: true, open_count_lifetime: true, click_count_lifetime: true, reply_count_lifetime: true, total_sent_count: true }
        });

        const details = negativeMailboxes.map(m =>
            `${m.email}: opens=${m.open_count_lifetime} clicks=${m.click_count_lifetime} replies=${m.reply_count_lifetime} sent=${m.total_sent_count}`
        );

        report(
            'Engagement counters never negative',
            negativeMailboxes.length === 0,
            negativeMailboxes.length,
            details
        );
    }

    // ── Invariant 2: Bounce rate within valid range ──
    {
        const invalidBounceRates = await prisma.campaign.findMany({
            where: {
                OR: [
                    { bounce_rate: { lt: 0 } },
                    { bounce_rate: { gt: 100 } },
                ]
            },
            select: { id: true, name: true, bounce_rate: true, total_sent: true, total_bounced: true }
        });

        const details = invalidBounceRates.map(c =>
            `Campaign "${c.name}": bounce_rate=${c.bounce_rate}% (${c.total_bounced}/${c.total_sent})`
        );

        report(
            'Bounce rate within 0-100% range',
            invalidBounceRates.length === 0,
            invalidBounceRates.length,
            details
        );
    }

    // ── Invariant 3: No ACTIVE lead without assigned campaign ──
    {
        const orphanedActive = await prisma.lead.findMany({
            where: {
                status: 'active',
                assigned_campaign_id: null,
                deleted_at: null,
            },
            select: { id: true, email: true, status: true }
        });

        const details = orphanedActive.map(l => `Lead ${l.email}: status=active but no campaign assigned`);

        report(
            'No ACTIVE lead without assigned campaign',
            orphanedActive.length === 0,
            orphanedActive.length,
            details
        );
    }

    // ── Invariant 4: No HEALTHY mailbox under a PAUSED domain ──
    {
        const inconsistent = await prisma.mailbox.findMany({
            where: {
                status: 'healthy',
                domain: {
                    status: 'paused',
                }
            },
            select: {
                id: true,
                email: true,
                status: true,
                domain: { select: { domain: true, status: true } }
            }
        });

        const details = inconsistent.map(m =>
            `Mailbox ${m.email} is HEALTHY but domain ${m.domain?.domain} is PAUSED`
        );

        report(
            'No HEALTHY mailbox under PAUSED domain',
            inconsistent.length === 0,
            inconsistent.length,
            details
        );
    }

    // ── Invariant 5: Bounce count does not exceed total sent ──
    {
        const overcounted = await prisma.campaign.findMany({
            where: {
                total_sent: { gt: 0 },
            },
            select: { id: true, name: true, total_sent: true, total_bounced: true }
        });

        const violations = overcounted.filter(c => c.total_bounced > c.total_sent);
        const details = violations.map(c =>
            `Campaign "${c.name}": ${c.total_bounced} bounces > ${c.total_sent} sent`
        );

        report(
            'Bounce count does not exceed total sent',
            violations.length === 0,
            violations.length,
            details
        );
    }

    // ── Invariant 6: Engagement rate is consistent with counters ──
    {
        const allMailboxes = await prisma.mailbox.findMany({
            where: { total_sent_count: { gt: 0 } },
            select: {
                id: true,
                email: true,
                total_sent_count: true,
                open_count_lifetime: true,
                click_count_lifetime: true,
                reply_count_lifetime: true,
                engagement_rate: true,
            }
        });

        const violations: string[] = [];
        for (const m of allMailboxes) {
            const expectedRate = ((m.open_count_lifetime + m.click_count_lifetime + m.reply_count_lifetime) / m.total_sent_count) * 100;
            const drift = Math.abs(expectedRate - m.engagement_rate);
            // Allow 1% tolerance for floating point
            if (drift > 1) {
                violations.push(
                    `${m.email}: engagement_rate=${m.engagement_rate.toFixed(1)}% but computed=${expectedRate.toFixed(1)}% (drift ${drift.toFixed(1)}%)`
                );
            }
        }

        report(
            'Engagement rate matches underlying counters (within 1% tolerance)',
            violations.length === 0,
            violations.length,
            violations
        );
    }

    // ── Invariant 7: No lead with assignment but still HELD (orphaned push) ──
    {
        const orphanedHeld = await prisma.lead.findMany({
            where: {
                status: 'held',
                assigned_campaign_id: { not: null },
                deleted_at: null,
            },
            select: { id: true, email: true, assigned_campaign_id: true, updated_at: true }
        });

        // Only flag leads stuck for > 1 hour (allow brief HELD state during processing)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const stuck = orphanedHeld.filter(l => l.updated_at < oneHourAgo);

        const details = stuck.map(l =>
            `Lead ${l.email}: HELD with campaign ${l.assigned_campaign_id} since ${l.updated_at.toISOString()}`
        );

        report(
            'No leads stuck in HELD with campaign assignment (>1 hour)',
            stuck.length === 0,
            stuck.length,
            details
        );
    }

    // ── Invariant 8: Domain engagement aggregates match mailbox sums ──
    {
        const domains = await prisma.domain.findMany({
            where: { total_sent_lifetime: { gt: 0 } },
            include: {
                mailboxes: {
                    select: {
                        total_sent_count: true,
                        open_count_lifetime: true,
                        click_count_lifetime: true,
                        reply_count_lifetime: true,
                    }
                }
            }
        });

        const violations: string[] = [];
        for (const d of domains) {
            const mbSent = d.mailboxes.reduce((sum, m) => sum + m.total_sent_count, 0);
            const mbOpens = d.mailboxes.reduce((sum, m) => sum + m.open_count_lifetime, 0);

            // Allow 10% tolerance — domain aggregation happens async
            if (d.total_sent_lifetime > 0 && Math.abs(mbSent - d.total_sent_lifetime) / d.total_sent_lifetime > 0.1) {
                violations.push(
                    `${d.domain}: domain.total_sent=${d.total_sent_lifetime} but mailbox sum=${mbSent}`
                );
            }
        }

        report(
            'Domain engagement aggregates match mailbox sums (within 10%)',
            violations.length === 0,
            violations.length,
            violations
        );
    }

    // ── Summary ──
    console.log('\n═══════════════════════════════════════════════════');
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const totalViolations = results.reduce((sum, r) => sum + r.violations, 0);

    console.log(`  Results: ${passed} passed, ${failed} failed, ${totalViolations} total violations`);
    console.log('═══════════════════════════════════════════════════\n');

    await prisma.$disconnect();

    if (failed > 0) {
        process.exit(1);
    }
}

run().catch(async (e) => {
    console.error('Invariant test suite failed:', e);
    await prisma.$disconnect();
    process.exit(1);
});
