import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = 'richsamven12@gmail.com';
    const password = 'Richardson2512@';
    const orgName = 'DrasonHQ';
    const orgSlug = 'drason-hq';

    console.log(`Seeding admin user: ${email}...`);

    // 1. Hash Password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 2. Create Organization
    // Use slug as unique identifier for finding
    const org = await prisma.organization.upsert({
        where: { slug: orgSlug },
        update: {},
        create: {
            name: orgName,
            slug: orgSlug,
            system_mode: 'enforce' // Set to enforce for production-ready feel
        }
    });

    console.log(`Organization ensured: ${org.name} (${org.id})`);

    // 3. Create Admin User
    const user = await prisma.user.upsert({
        where: { email },
        update: {
            role: 'admin',
            password_hash: passwordHash,
            organization_id: org.id
        },
        create: {
            email,
            name: 'Richardson Admin',
            password_hash: passwordHash,
            role: 'admin',
            organization_id: org.id
        }
    });

    console.log(`Admin user created/updated: ${user.email} (${user.id})`);
    console.log('Seed completed successfully.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
