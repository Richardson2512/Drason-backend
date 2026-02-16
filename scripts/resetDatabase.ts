/**
 * Database Reset Script
 *
 * DANGER: This script will DELETE ALL DATA from the database.
 * Use this to start fresh with the new billing system.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resetDatabase() {
    console.log('🚨 WARNING: This will delete ALL data from the database!');
    console.log('⏳ Starting database reset in 3 seconds...');

    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
        console.log('\n📊 Current database counts:');

        // Get counts before deletion
        const counts = {
            users: await prisma.user.count(),
            organizations: await prisma.organization.count(),
            leads: await prisma.lead.count(),
            campaigns: await prisma.campaign.count(),
            mailboxes: await prisma.mailbox.count(),
            domains: await prisma.domain.count()
        };

        console.log(JSON.stringify(counts, null, 2));

        console.log('\n🗑️  Deleting all data...');

        // Delete in correct order to respect foreign key constraints
        // Start with tables that have no dependencies on them

        // 1. Subscription events
        const deletedSubscriptionEvents = await prisma.subscriptionEvent.deleteMany({});
        console.log(`   ✓ Deleted ${deletedSubscriptionEvents.count} subscription events`);

        // 2. Infrastructure reports
        const deletedInfraReports = await prisma.infrastructureReport.deleteMany({});
        console.log(`   ✓ Deleted ${deletedInfraReports.count} infrastructure reports`);

        // 3. Notifications
        const deletedNotifications = await prisma.notification.deleteMany({});
        console.log(`   ✓ Deleted ${deletedNotifications.count} notifications`);

        // 4. Audit logs
        const deletedAuditLogs = await prisma.auditLog.deleteMany({});
        console.log(`   ✓ Deleted ${deletedAuditLogs.count} audit logs`);

        // 5. State transitions
        const deletedStateTransitions = await prisma.stateTransition.deleteMany({});
        console.log(`   ✓ Deleted ${deletedStateTransitions.count} state transitions`);

        // 6. Raw events
        const deletedRawEvents = await prisma.rawEvent.deleteMany({});
        console.log(`   ✓ Deleted ${deletedRawEvents.count} raw events`);

        // 7. Routing rules
        const deletedRoutingRules = await prisma.routingRule.deleteMany({});
        console.log(`   ✓ Deleted ${deletedRoutingRules.count} routing rules`);

        // 8. Leads
        const deletedLeads = await prisma.lead.deleteMany({});
        console.log(`   ✓ Deleted ${deletedLeads.count} leads`);

        // 9. Mailbox metrics
        const deletedMailboxMetrics = await prisma.mailboxMetrics.deleteMany({});
        console.log(`   ✓ Deleted ${deletedMailboxMetrics.count} mailbox metrics`);

        // 10. Mailboxes
        const deletedMailboxes = await prisma.mailbox.deleteMany({});
        console.log(`   ✓ Deleted ${deletedMailboxes.count} mailboxes`);

        // 11. Campaigns
        const deletedCampaigns = await prisma.campaign.deleteMany({});
        console.log(`   ✓ Deleted ${deletedCampaigns.count} campaigns`);

        // 12. Domains
        const deletedDomains = await prisma.domain.deleteMany({});
        console.log(`   ✓ Deleted ${deletedDomains.count} domains`);

        // 13. API Keys
        const deletedApiKeys = await prisma.apiKey.deleteMany({});
        console.log(`   ✓ Deleted ${deletedApiKeys.count} API keys`);

        // 14. System settings
        const deletedSystemSettings = await prisma.systemSetting.deleteMany({});
        console.log(`   ✓ Deleted ${deletedSystemSettings.count} system settings`);

        // 15. Organization settings
        const deletedSettings = await prisma.organizationSetting.deleteMany({});
        console.log(`   ✓ Deleted ${deletedSettings.count} organization settings`);

        // 16. Users
        const deletedUsers = await prisma.user.deleteMany({});
        console.log(`   ✓ Deleted ${deletedUsers.count} users`);

        // 17. Organizations (last, as everything depends on it)
        const deletedOrganizations = await prisma.organization.deleteMany({});
        console.log(`   ✓ Deleted ${deletedOrganizations.count} organizations`);

        console.log('\n✅ Database reset complete!');
        console.log('📊 All tables are now empty and ready for fresh data.');
        console.log('\n💡 Next steps:');
        console.log('   1. Sign up a new account at /signup');
        console.log('   2. Your organization will automatically start with a 14-day trial');
        console.log('   3. Test the billing features in /dashboard/settings');

    } catch (error) {
        console.error('\n❌ Error resetting database:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

// Run the script
resetDatabase()
    .then(() => {
        console.log('\n🎉 Done!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n💥 Fatal error:', error);
        process.exit(1);
    });
