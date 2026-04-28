import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const stmts = [
    'ALTER TABLE "BounceEvent" ADD COLUMN IF NOT EXISTS "smtp_code" TEXT;',
    'ALTER TABLE "BounceEvent" ADD COLUMN IF NOT EXISTS "smtp_response" TEXT;',
    'ALTER TABLE "BounceEvent" ADD COLUMN IF NOT EXISTS "bounce_source" TEXT;',
];

async function main() {
    for (const sql of stmts) {
        await p.$executeRawUnsafe(sql);
        console.log('OK', sql);
    }
    await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
