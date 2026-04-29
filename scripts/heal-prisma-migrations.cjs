/**
 * One-time heal script — clears an orphan failed migration row from
 * `_prisma_migrations` so subsequent `prisma migrate deploy` calls can
 * proceed past P3009 errors.
 *
 * Background: a migration directory was renamed from
 *   20260429000000_add_oauth_tables  →  20260429220000_add_oauth_tables
 * after the original had already been applied to prod. The renamed
 * version then attempted to recreate existing tables and was recorded
 * as `failed` in _prisma_migrations. The directory was later renamed
 * back, leaving an orphan failed row that Prisma refuses to ignore.
 *
 * This script removes that single orphan row. Idempotent: deleting
 * zero rows is fine. Always exits 0 so the deploy pipeline continues.
 *
 * Once a deploy completes successfully, this script + its invocation
 * in the Procfile + railway.json should be removed in a follow-up
 * commit.
 */

const { PrismaClient } = require('@prisma/client');

const ORPHAN_NAME = '20260429220000_add_oauth_tables';

(async () => {
    const prisma = new PrismaClient();
    try {
        const deleted = await prisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE migration_name = ${ORPHAN_NAME} AND finished_at IS NULL`;
        if (deleted > 0) {
            console.log(`[heal-prisma-migrations] cleared ${deleted} orphan failed row(s) for ${ORPHAN_NAME}`);
        } else {
            console.log(`[heal-prisma-migrations] no orphan rows to clear (already healed)`);
        }
    } catch (err) {
        // Never block the deploy. Surface the error and continue.
        console.warn('[heal-prisma-migrations] cleanup skipped:', err && err.message ? err.message : err);
    } finally {
        await prisma.$disconnect().catch(() => undefined);
        process.exit(0);
    }
})();
