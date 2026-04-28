import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
    const users = await p.user.findMany({
        select: { email: true, role: true, created_at: true },
        orderBy: { created_at: 'asc' },
        take: 20,
    });
    console.log(JSON.stringify(users, null, 2));
    await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
