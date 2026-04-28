import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
    const cols = await p.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name='Organization' ORDER BY ordinal_position;`
    );
    console.log(JSON.stringify(cols, null, 2));
    await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
