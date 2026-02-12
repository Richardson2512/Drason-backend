import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Ensuring Healthy Environment...');

    // 1. Ensure Domain
    const domain = await prisma.domain.upsert({
        where: { domain: 'healthy-sender.com' },
        update: { status: 'healthy' },
        create: {
            domain: 'healthy-sender.com',
            status: 'healthy',
            aggregated_bounce_rate_trend: 0.1
        }
    });

    // 2. Ensure Mailbox
    const mailbox = await prisma.mailbox.upsert({
        where: { id: 'mb_healthy_1' },
        update: { status: 'active', domain_id: domain.id },
        create: {
            id: 'mb_healthy_1',
            email: 'sender@healthy-sender.com',
            domain_id: domain.id,
            status: 'active'
        }
    });

    // 3. Link to Campaign
    await prisma.campaign.update({
        where: { id: 'camp_123' },
        data: {
            mailboxes: {
                connect: { id: mailbox.id }
            }
        }
    });

    console.log('Environment is HEALTHY.');
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
