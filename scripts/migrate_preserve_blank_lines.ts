/**
 * One-time migration: normalize all stored body_html so user-intended blank
 * lines render with visible height across every preview surface.
 *
 * Tables touched:
 *   - EmailTemplate.body_html
 *   - SequenceStep.body_html
 *   - StepVariant.body_html
 *
 * Idempotent: re-running produces the same output. Safe to run multiple
 * times. Refuses to run against a production-looking DATABASE_URL.
 *
 * The transform is byte-for-byte identical to the frontend lib/preserveBlankLines.ts;
 * we duplicate it here intentionally to keep this script self-contained.
 *
 * Usage:
 *   npx tsx scripts/migrate_preserve_blank_lines.ts
 *   npx tsx scripts/migrate_preserve_blank_lines.ts --dry-run
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.argv.includes('--dry-run');

const prisma = new PrismaClient();

function assertStagingDb() {
    const url = process.env.DATABASE_URL || '';
    const looksProd = /railway|prod|production|amazonaws|supabase\.co/i.test(url);
    if (looksProd) {
        console.error('❌ DATABASE_URL looks production-y. Refusing.');
        process.exit(1);
    }
}

// ============================================================================
// TRANSFORM (mirror of frontend lib/preserveBlankLines.ts)
// ============================================================================

const VISIBLE_EMPTY = '<p>&nbsp;</p>';

function preserveBlankLines(html: string | null | undefined): string {
    if (!html) return '';
    let out = html;

    out = out.replace(
        /<p\b[^>]*>\s*(?:<br\s*\/?>\s*){0,3}<\/p>/gi,
        VISIBLE_EMPTY,
    );

    out = out.replace(
        /<p\b([^>]*)>((?:(?!<\/?p\b).)*?\S(?:(?!<\/?p\b).)*?)<br\s*\/?>(\s*)<\/p>/gi,
        '<p$1>$2</p>' + VISIBLE_EMPTY,
    );

    out = out.replace(
        /<p\b[^>]*>\s*(?:<br\s*\/?>\s*){0,3}<\/p>/gi,
        VISIBLE_EMPTY,
    );

    return out;
}

// ============================================================================
// MIGRATION
// ============================================================================

interface MigrationStats {
    scanned: number;
    changed: number;
    unchanged: number;
}

async function migrateEmailTemplates(): Promise<MigrationStats> {
    const stats: MigrationStats = { scanned: 0, changed: 0, unchanged: 0 };
    const rows = await prisma.emailTemplate.findMany({
        select: { id: true, body_html: true },
    });
    for (const row of rows) {
        stats.scanned++;
        const next = preserveBlankLines(row.body_html);
        if (next === row.body_html) {
            stats.unchanged++;
            continue;
        }
        if (!DRY_RUN) {
            await prisma.emailTemplate.update({
                where: { id: row.id },
                data: { body_html: next },
            });
        }
        stats.changed++;
    }
    return stats;
}

async function migrateSequenceSteps(): Promise<MigrationStats> {
    const stats: MigrationStats = { scanned: 0, changed: 0, unchanged: 0 };
    const rows = await prisma.sequenceStep.findMany({
        select: { id: true, body_html: true },
    });
    for (const row of rows) {
        stats.scanned++;
        const next = preserveBlankLines(row.body_html);
        if (next === row.body_html) {
            stats.unchanged++;
            continue;
        }
        if (!DRY_RUN) {
            await prisma.sequenceStep.update({
                where: { id: row.id },
                data: { body_html: next },
            });
        }
        stats.changed++;
    }
    return stats;
}

async function migrateStepVariants(): Promise<MigrationStats> {
    const stats: MigrationStats = { scanned: 0, changed: 0, unchanged: 0 };
    const rows = await prisma.stepVariant.findMany({
        select: { id: true, body_html: true },
    });
    for (const row of rows) {
        stats.scanned++;
        const next = preserveBlankLines(row.body_html);
        if (next === row.body_html) {
            stats.unchanged++;
            continue;
        }
        if (!DRY_RUN) {
            await prisma.stepVariant.update({
                where: { id: row.id },
                data: { body_html: next },
            });
        }
        stats.changed++;
    }
    return stats;
}

async function main() {
    assertStagingDb();
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  preserve-blank-lines migration');
    console.log(`  Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'WRITE'}`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    const tplStats = await migrateEmailTemplates();
    console.log(`EmailTemplate:    scanned=${tplStats.scanned}  changed=${tplStats.changed}  unchanged=${tplStats.unchanged}`);

    const stepStats = await migrateSequenceSteps();
    console.log(`SequenceStep:     scanned=${stepStats.scanned}  changed=${stepStats.changed}  unchanged=${stepStats.unchanged}`);

    const variantStats = await migrateStepVariants();
    console.log(`StepVariant:      scanned=${variantStats.scanned}  changed=${variantStats.changed}  unchanged=${variantStats.unchanged}`);

    const totalChanged = tplStats.changed + stepStats.changed + variantStats.changed;
    console.log(`\nTotal rows ${DRY_RUN ? 'that would change' : 'updated'}: ${totalChanged}`);
    console.log('Done.');
}

main()
    .catch((e) => {
        console.error('❌ Migration failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
