
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Verifying organization...');
    const orgId = process.env.DEFAULT_ORG_ID || '123e4567-e89b-12d3-a456-426614174000';
    console.log(`Checking for Org ID: ${orgId}`);

    const org = await prisma.organization.findUnique({
        where: { id: orgId },
    });

    if (org) {
        console.log('Organization found:', org);
    } else {
        console.log('Organization NOT found in database.');

        // List all organizations to see what exists
        const allOrgs = await prisma.organization.findMany();
        console.log('Existing organizations:', allOrgs);
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
