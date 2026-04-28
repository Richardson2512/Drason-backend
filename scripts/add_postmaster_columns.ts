/**
 * Adds postmaster_* columns to Organization. Schema has them, DB doesn't —
 * pre-existing drift. Idempotent (uses IF NOT EXISTS).
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const stmts = [
    'ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "postmaster_access_token" TEXT;',
    'ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "postmaster_refresh_token" TEXT;',
    'ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "postmaster_token_expires_at" TIMESTAMP;',
    'ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "postmaster_connected_at" TIMESTAMP;',
    'ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "postmaster_last_fetch_at" TIMESTAMP;',
    'ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "postmaster_last_error" TEXT;',
];

async function main() {
    for (const sql of stmts) {
        await p.$executeRawUnsafe(sql);
        console.log('OK', sql);
    }
    await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
