import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding Campaign Relations...');

    // 1. Ensure a Campaign exists
    const campaign = await prisma.campaign.upsert({
        where: { id: 'camp_123' },
        update: {},
        create: {
            id: 'camp_123',
            name: 'Outbound Alpha Q1',
            status: 'active',
            channel: 'email'
        }
    });
    console.log('Campaign ensured:', campaign.id);

    // 2. Get Mailboxes and link them
    const mailboxes = await prisma.mailbox.findMany();
    if (mailboxes.length > 0) {
        console.log(`Linking ${mailboxes.length} mailboxes to campaign...`);
        for (const mb of mailboxes) {
            await prisma.mailbox.update({
                where: { id: mb.id },
                data: {
                    campaigns: {
                        connect: { id: campaign.id }
                    }
                }
            });
        }
    } else {
        console.log('No mailboxes found to link.');
    }

    // 3. Assign Leads to this Campaign
    const result = await prisma.lead.updateMany({
        where: { assigned_campaign_id: null },
        data: { assigned_campaign_id: campaign.id }
    });
    console.log(`Assigned ${result.count} leads to campaign ${campaign.id}`);
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
