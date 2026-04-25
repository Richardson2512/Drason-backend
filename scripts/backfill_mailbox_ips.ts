/**
 * Backfill sending IPs for every existing mailbox.
 *
 * Idempotent — re-running re-resolves rows whose TTL has expired and skips
 * fresh ones. Use --force to override the TTL and re-resolve everything.
 *
 * Usage:
 *   npx ts-node scripts/backfill_mailbox_ips.ts                 # all orgs
 *   npx ts-node scripts/backfill_mailbox_ips.ts --org=ORG_ID    # one org
 *   npx ts-node scripts/backfill_mailbox_ips.ts --force         # ignore TTL
 */

import { PrismaClient } from '@prisma/client';
import { resolveAndPersistMailboxIp } from '../src/services/mailboxIpResolutionService';

const prisma = new PrismaClient();

async function main() {
    const args = process.argv.slice(2);
    const orgFlag = args.find(a => a.startsWith('--org='));
    const orgId = orgFlag ? orgFlag.slice(6) : null;
    const force = args.includes('--force');

    console.log('Mailbox IP backfill —', JSON.stringify({ orgId, force }, null, 2));

    const where: any = {};
    if (orgId) where.organization_id = orgId;

    const mailboxes = await prisma.mailbox.findMany({
        where,
        select: { id: true, email: true, organization_id: true },
        orderBy: { last_activity_at: 'desc' },
    });

    console.log(`Total mailboxes: ${mailboxes.length}`);
    if (mailboxes.length === 0) return;

    const counts = { resolved: 0, oauthShared: 0, manual: 0, failed: 0 };

    for (let i = 0; i < mailboxes.length; i++) {
        const m = mailboxes[i];
        const r = await resolveAndPersistMailboxIp(m.id, { force });
        if (r.source === 'oauth_shared') counts.oauthShared++;
        else if (r.source === 'manual') counts.manual++;
        else if (r.ip) counts.resolved++;
        else counts.failed++;

        if ((i + 1) % 25 === 0) {
            console.log(`  …${i + 1}/${mailboxes.length} processed`);
        }
    }

    console.log('\nBreakdown:');
    console.log(`  resolved (SMTP):   ${counts.resolved}`);
    console.log(`  shared (OAuth):    ${counts.oauthShared}`);
    console.log(`  manual (skipped):  ${counts.manual}`);
    console.log(`  failed:            ${counts.failed}`);
    console.log('\nDone.');
}

main()
    .catch(err => { console.error('Backfill failed:', err); process.exit(1); })
    .finally(() => prisma.$disconnect());
