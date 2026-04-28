import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const NEW_PASSWORD = 'Demo2026!';
const EMAIL = 'demo@superkabe.com';

const p = new PrismaClient();
async function main() {
    const hash = await bcrypt.hash(NEW_PASSWORD, 12);
    const updated = await p.user.update({
        where: { email: EMAIL },
        data: { password_hash: hash },
        select: { email: true, role: true },
    });
    console.log(`Reset password for ${updated.email} (role=${updated.role}) → ${NEW_PASSWORD}`);
    await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
