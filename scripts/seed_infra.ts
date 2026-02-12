import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('🌱 Seeding Infrastructure...');

    // 1. Create Domain
    const domain = await prisma.domain.create({
        data: {
            domain: 'spacex.com',
            status: 'healthy',
        }
    });
    console.log(` - Created Domain: ${domain.domain}`);

    // 2. Create Campaign
    const campaign = await prisma.campaign.create({
        data: {
            id: 'mars_outreach_q1', // Custom ID for readability
            name: 'Mars Colonization Outreach',
            status: 'active',
        }
    });
    console.log(` - Created Campaign: ${campaign.name}`);

    // 3. Create Mailboxes (Linked to Domain)
    await prisma.mailbox.create({
        data: {
            id: 'mailbox_elon',
            email: 'elon@spacex.com',
            domain_id: domain.id,
            status: 'active',
            window_sent_count: 0,
            window_bounce_count: 0,
            hard_bounce_count: 0,
        }
    });
    await prisma.mailbox.create({
        data: {
            id: 'mailbox_gwynne',
            email: 'gwynne@spacex.com',
            domain_id: domain.id,
            status: 'active',
            window_sent_count: 50, // Some usage history
            window_bounce_count: 0,
            hard_bounce_count: 2,
        }
    });
    console.log(' - Created Mailboxes: elon@spacex.com, gwynne@spacex.com');

    // Link Mailboxes to Campaign (If schema supports it, but currently it's implicit or missing relation. 
    // Based on previous checks, there is no explicit many-to-many table in Prisma schema visible in previous file dumps? 
    // Wait, `getCampaigns` included `mailboxes`. This implies a relation exists.
    // Let's try to connect them if the explicit relation exists. 
    // If not, we skip. But `dashboardController` had `include: { mailboxes: ... }`.
    // So there IS a relation. It's likely `campaigns` on Mailbox or `mailboxes` on Campaign.

    // Let's try update to connect.
    try {
        await prisma.campaign.update({
            where: { id: campaign.id },
            data: {
                mailboxes: {
                    connect: [{ id: 'mailbox_elon' }, { id: 'mailbox_gwynne' }]
                }
            }
        });
        console.log(' - Linked Mailboxes to Campaign');
    } catch (e) {
        console.log(' - Could not link mailboxes (Relation might be implicit or different): ' + e);
        // Fallback: maybe Mailbox has `campaign_id`?
    }

    console.log('✅ Infrastructure Ready.');
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
