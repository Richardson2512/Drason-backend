/**
 * Backfill Reply Quality classification.
 *
 * Iterates every inbound EmailMessage that doesn't yet have a quality_class
 * and runs it through the rule-based replyClassifierService. Idempotent —
 * rerun whenever the lexicons are tuned to refresh historical data without
 * affecting the live IMAP worker hot path.
 *
 * Usage:
 *   npx ts-node scripts/backfill_reply_quality.ts            # all unclassified
 *   npx ts-node scripts/backfill_reply_quality.ts --all      # re-run everyone
 *   npx ts-node scripts/backfill_reply_quality.ts --org=ORG  # one org only
 *   npx ts-node scripts/backfill_reply_quality.ts --dry      # report counts, no writes
 */

import { PrismaClient } from '@prisma/client';
import { classifyReply } from '../src/services/replyClassifierService';

const prisma = new PrismaClient();

const BATCH_SIZE = 500;

async function main() {
    const args = process.argv.slice(2);
    const flag = (k: string) => args.includes(k) || args.find(a => a.startsWith(`${k}=`));
    const orgFlag = args.find(a => a.startsWith('--org='));
    const orgId = orgFlag ? orgFlag.slice(6) : null;
    const reclassifyAll = !!flag('--all');
    const dryRun = !!flag('--dry');

    console.log('Reply Quality backfill —', JSON.stringify({ orgId, reclassifyAll, dryRun }, null, 2));

    // Build the where clause:
    //   - inbound only
    //   - if --all: every row gets re-classified (lexicon tuning)
    //   - else: only rows with no quality_class yet (fresh backfill)
    //   - if --org: scope to a single org via thread.organization_id
    const where: any = { direction: 'inbound' };
    if (!reclassifyAll) where.quality_class = null;
    if (orgId) where.thread = { organization_id: orgId };

    const total = await prisma.emailMessage.count({ where });
    console.log(`Eligible rows: ${total}`);
    if (total === 0) {
        console.log('Nothing to do.');
        return;
    }

    let processed = 0;
    let cursor: string | null = null;
    const classCounts: Record<string, number> = {};

    while (processed < total) {
        const batch: Array<{
            id: string;
            subject: string;
            body_text: string | null;
            body_html: string;
        }> = await prisma.emailMessage.findMany({
            where,
            take: BATCH_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: 'asc' },
            select: {
                id: true,
                subject: true,
                body_text: true,
                body_html: true,
            },
        });

        if (batch.length === 0) break;

        for (const row of batch) {
            const c = classifyReply({
                subject: row.subject,
                body_text: row.body_text,
                body_html: row.body_html,
            });

            classCounts[c.class] = (classCounts[c.class] || 0) + 1;

            if (!dryRun) {
                await prisma.emailMessage.update({
                    where: { id: row.id },
                    data: {
                        quality_class: c.class,
                        quality_confidence: c.confidence,
                        quality_signals: c.signals,
                        quality_classified_at: new Date(),
                    },
                });
            }
        }

        processed += batch.length;
        cursor = batch[batch.length - 1].id;
        console.log(`  …${processed}/${total} processed`);
    }

    console.log('\nClassification breakdown:');
    Object.entries(classCounts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}`));

    console.log('\nDone.', dryRun ? '(dry run — no rows updated)' : `${processed} rows updated.`);
}

main()
    .catch(err => {
        console.error('Backfill failed:', err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
