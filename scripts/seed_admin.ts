import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = 'richsamven12@gmail.com';
    const password = 'Richardson2512@';
    const orgName = 'Superkabe';
    const orgSlug = 'superkabe';

    console.log(`Seeding admin user: ${email}...`);

    // 1. Hash Password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 2. Create Organization with enterprise tier (unlimited everything)
    const org = await prisma.organization.upsert({
        where: { slug: orgSlug },
        update: {
            name: orgName,
            subscription_tier: 'enterprise',
            subscription_status: 'active',
        },
        create: {
            name: orgName,
            slug: orgSlug,
            system_mode: 'enforce',
            subscription_tier: 'enterprise',
            subscription_status: 'active',
        }
    });

    console.log(`Organization ensured: ${org.name} (${org.id})`);

    // 3. Create Admin User
    const user = await prisma.user.upsert({
        where: { email },
        update: {
            role: 'admin',
            password_hash: passwordHash,
            organization_id: org.id,
            name: 'Richardson'
        },
        create: {
            email,
            name: 'Richardson',
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
