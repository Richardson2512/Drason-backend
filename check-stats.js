const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkStats() {
    console.log('🔍 Checking database for stats data...\n');

    try {
        // Get first organization
        const org = await prisma.organization.findFirst();
        if (!org) {
            console.log('❌ No organization found. Please create an organization first.');
            return;
        }

        console.log(`✅ Organization: ${org.name} (${org.id})\n`);

        // Check Leads
        console.log('📧 LEADS:');
        const leads = await prisma.lead.findMany({
            where: { organization_id: org.id },
            take: 5,
            select: {
                email: true,
                emails_sent: true,
                emails_opened: true,
                emails_clicked: true,
                emails_replied: true,
                last_activity_at: true
            }
        });

        if (leads.length === 0) {
            console.log('  ⚠️  No leads found');
        } else {
            leads.forEach(lead => {
                console.log(`  ${lead.email}:`);
                console.log(`    - Sent: ${lead.emails_sent}`);
                console.log(`    - Opened: ${lead.emails_opened}`);
                console.log(`    - Clicked: ${lead.emails_clicked}`);
                console.log(`    - Replied: ${lead.emails_replied}`);
                console.log(`    - Last Activity: ${lead.last_activity_at || 'Never'}`);
            });
        }

        // Check Campaigns
        console.log('\n📊 CAMPAIGNS:');
        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: org.id },
            take: 3,
            select: {
                name: true,
                total_sent: true,
                open_count: true,
                open_rate: true,
                click_count: true,
                click_rate: true,
                reply_count: true,
                reply_rate: true,
                total_bounced: true,
                bounce_rate: true
            }
        });

        if (campaigns.length === 0) {
            console.log('  ⚠️  No campaigns found');
        } else {
            campaigns.forEach(campaign => {
                console.log(`  ${campaign.name}:`);
                console.log(`    - Total Sent: ${campaign.total_sent}`);
                console.log(`    - Opens: ${campaign.open_count} (${campaign.open_rate.toFixed(1)}%)`);
                console.log(`    - Clicks: ${campaign.click_count} (${campaign.click_rate.toFixed(1)}%)`);
                console.log(`    - Replies: ${campaign.reply_count} (${campaign.reply_rate.toFixed(1)}%)`);
                console.log(`    - Bounces: ${campaign.total_bounced} (${campaign.bounce_rate.toFixed(1)}%)`);
            });
        }

        // Check Mailboxes
        console.log('\n📮 MAILBOXES:');
        const mailboxes = await prisma.mailbox.findMany({
            where: { organization_id: org.id },
            take: 3,
            select: {
                email: true,
                total_sent_count: true,
                open_count_lifetime: true,
                click_count_lifetime: true,
                reply_count_lifetime: true,
                engagement_rate: true,
                warmup_status: true,
                warmup_reputation: true
            }
        });

        if (mailboxes.length === 0) {
            console.log('  ⚠️  No mailboxes found');
        } else {
            mailboxes.forEach(mailbox => {
                console.log(`  ${mailbox.email}:`);
                console.log(`    - Total Sent: ${mailbox.total_sent_count}`);
                console.log(`    - Opens: ${mailbox.open_count_lifetime}`);
                console.log(`    - Clicks: ${mailbox.click_count_lifetime}`);
                console.log(`    - Replies: ${mailbox.reply_count_lifetime}`);
                console.log(`    - Engagement Rate: ${mailbox.engagement_rate.toFixed(1)}%`);
                console.log(`    - Warmup: ${mailbox.warmup_status || 'Not configured'}`);
            });
        }

        // Check Domains
        console.log('\n🌐 DOMAINS:');
        const domains = await prisma.domain.findMany({
            where: { organization_id: org.id },
            take: 3,
            select: {
                domain: true,
                total_sent_lifetime: true,
                total_opens: true,
                total_clicks: true,
                total_replies: true,
                total_bounces: true,
                engagement_rate: true,
                bounce_rate: true
            }
        });

        if (domains.length === 0) {
            console.log('  ⚠️  No domains found');
        } else {
            domains.forEach(domain => {
                console.log(`  ${domain.domain}:`);
                console.log(`    - Total Sent: ${domain.total_sent_lifetime}`);
                console.log(`    - Opens: ${domain.total_opens}`);
                console.log(`    - Clicks: ${domain.total_clicks}`);
                console.log(`    - Replies: ${domain.total_replies}`);
                console.log(`    - Bounces: ${domain.total_bounces}`);
                console.log(`    - Engagement Rate: ${domain.engagement_rate.toFixed(1)}%`);
                console.log(`    - Bounce Rate: ${domain.bounce_rate.toFixed(1)}%`);
            });
        }

        console.log('\n\n🎯 DIAGNOSIS:');

        const leadsHaveStats = leads.some(l => l.emails_sent > 0 || l.emails_opened > 0);
        const campaignsHaveStats = campaigns.some(c => c.total_sent > 0 || c.open_count > 0);
        const mailboxesHaveStats = mailboxes.some(m => m.total_sent_count > 0 || m.open_count_lifetime > 0);

        if (!leadsHaveStats && !campaignsHaveStats && !mailboxesHaveStats) {
            console.log('❌ NO STATS DATA FOUND IN DATABASE');
            console.log('\nREQUIRED ACTIONS:');
            console.log('1. ⚠️  Trigger Manual Sync in Settings page to backfill historical data');
            console.log('2. ⚠️  Configure Smartlead webhooks for real-time updates:');
            console.log('   - URL: https://your-railway-backend.railway.app/webhooks/smartlead');
            console.log('   - Events: email_sent, email_opened, email_clicked, email_replied, email_bounced');
        } else if (campaignsHaveStats && !leadsHaveStats) {
            console.log('⚠️  PARTIAL DATA: Campaigns have stats but leads don\'t');
            console.log('\nLIKELY CAUSE: CSV backfill failed or leads not linked to campaigns');
            console.log('ACTION: Check backend logs for CSV parsing errors');
        } else if (mailboxesHaveStats && !leadsHaveStats) {
            console.log('⚠️  PARTIAL DATA: Mailboxes have stats but leads don\'t');
            console.log('\nLIKELY CAUSE: Webhooks working but CSV backfill not run');
            console.log('ACTION: Trigger manual sync to backfill lead engagement stats');
        } else {
            console.log('✅ DATA FOUND! Stats exist in database.');
            console.log('\nIf stats not showing in UI:');
            console.log('1. Check browser console for API errors');
            console.log('2. Verify frontend is calling /api/dashboard/leads endpoint');
            console.log('3. Check that backend deployment is complete');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

checkStats();
