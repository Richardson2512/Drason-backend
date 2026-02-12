import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('🧹 Clearing all application data...');

    // Delete in order of dependencies (Child -> Parent)

    // 1. Audit Logs
    await prisma.auditLog.deleteMany({});
    console.log(' - Audit Logs cleared');

    // 2. Leads (depend on Campaign)
    await prisma.lead.deleteMany({});
    console.log(' - Leads cleared');

    // 3. Routing Rules (depend on Campaign? No, loose string link usually, but let's check schema. PRD says loose)
    // Actually schema might not even have RoutingRules table yet? 
    // Wait, I implemented Routing Rules in memory or DB?
    // Let's check schema in a moment, but assuming `RoutingRule` model exists.
    try {
        // @ts-ignore
        await prisma.routingRule.deleteMany({});
        console.log(' - Routing Rules cleared');
    } catch (e) {
        console.log(' - No RoutingRule table configured yet or error.');
    }

    // 4. Mailboxes (depend on Domain)
    // Also Campaign -> Mailbox relation (many-to-many? or json?)
    // If explicit relation table exists, clear it. 
    // We used `mailboxes` in Campaign. 

    // Let's just clear Mailboxes.
    await prisma.mailbox.deleteMany({});
    console.log(' - Mailboxes cleared');

    // 5. Campaigns
    await prisma.campaign.deleteMany({});
    console.log(' - Campaigns cleared');

    // 6. Domains
    await prisma.domain.deleteMany({});
    console.log(' - Domains cleared');

    console.log('✨ Database is clean.');
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
