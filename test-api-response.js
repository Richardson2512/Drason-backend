/**
 * Test script to check what the API endpoints are actually returning
 * Run this to see if stat fields are present in API responses
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testAPIResponses() {
    console.log('🔍 Testing API Response Structure...\n');

    try {
        // Get first organization
        const org = await prisma.organization.findFirst();
        if (!org) {
            console.log('❌ No organization found. Please create an organization first.');
            return;
        }

        console.log(`✅ Organization: ${org.name} (${org.id})\n`);

        // Test 1: Check what getLeads endpoint would return
        console.log('📧 TEST 1: Leads API Response Structure');
        console.log('=' .repeat(60));
        const leads = await prisma.lead.findMany({
            where: { organization_id: org.id },
            take: 1
        });

        if (leads.length > 0) {
            const lead = leads[0];
            console.log('Sample Lead Object Keys:', Object.keys(lead));
            console.log('\nStat Fields Present:');
            console.log(`  - emails_sent: ${lead.emails_sent} ${typeof lead.emails_sent === 'number' ? '✅' : '❌'}`);
            console.log(`  - emails_opened: ${lead.emails_opened} ${typeof lead.emails_opened === 'number' ? '✅' : '❌'}`);
            console.log(`  - emails_clicked: ${lead.emails_clicked} ${typeof lead.emails_clicked === 'number' ? '✅' : '❌'}`);
            console.log(`  - emails_replied: ${lead.emails_replied} ${typeof lead.emails_replied === 'number' ? '✅' : '❌'}`);
            console.log(`  - last_activity_at: ${lead.last_activity_at || 'null'} ${lead.last_activity_at ? '✅' : '⚠️  (null is ok if no activity)'}`);
            console.log(`  - lead_score: ${lead.lead_score} ${typeof lead.lead_score === 'number' ? '✅' : '❌'}`);

            console.log('\nSample Lead Full Object:');
            console.log(JSON.stringify(lead, null, 2));
        } else {
            console.log('⚠️  No leads found');
        }

        // Test 2: Check what getCampaigns endpoint would return
        console.log('\n\n📊 TEST 2: Campaigns API Response Structure');
        console.log('=' .repeat(60));
        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: org.id },
            take: 1,
            include: {
                mailboxes: {
                    select: {
                        id: true,
                        email: true,
                        status: true,
                        domain: {
                            select: { id: true, domain: true, status: true }
                        }
                    }
                }
            }
        });

        if (campaigns.length > 0) {
            const campaign = campaigns[0];
            console.log('Sample Campaign Object Keys:', Object.keys(campaign));
            console.log('\nStat Fields Present:');
            console.log(`  - total_sent: ${campaign.total_sent} ${typeof campaign.total_sent === 'number' ? '✅' : '❌'}`);
            console.log(`  - open_count: ${campaign.open_count} ${typeof campaign.open_count === 'number' ? '✅' : '❌'}`);
            console.log(`  - click_count: ${campaign.click_count} ${typeof campaign.click_count === 'number' ? '✅' : '❌'}`);
            console.log(`  - reply_count: ${campaign.reply_count} ${typeof campaign.reply_count === 'number' ? '✅' : '❌'}`);
            console.log(`  - open_rate: ${campaign.open_rate} ${typeof campaign.open_rate === 'number' ? '✅' : '❌'}`);
            console.log(`  - click_rate: ${campaign.click_rate} ${typeof campaign.click_rate === 'number' ? '✅' : '❌'}`);
            console.log(`  - reply_rate: ${campaign.reply_rate} ${typeof campaign.reply_rate === 'number' ? '✅' : '❌'}`);
            console.log(`  - bounce_rate: ${campaign.bounce_rate} ${typeof campaign.bounce_rate === 'number' ? '✅' : '❌'}`);

            console.log('\nSample Campaign Full Object:');
            console.log(JSON.stringify(campaign, null, 2));
        } else {
            console.log('⚠️  No campaigns found');
        }

        // Test 3: Check what getMailboxes endpoint would return
        console.log('\n\n📮 TEST 3: Mailboxes API Response Structure');
        console.log('=' .repeat(60));
        const mailboxes = await prisma.mailbox.findMany({
            where: { organization_id: org.id },
            take: 1,
            include: {
                domain: {
                    select: { id: true, domain: true, status: true }
                },
                campaigns: {
                    select: { id: true, name: true, status: true }
                }
            }
        });

        if (mailboxes.length > 0) {
            const mailbox = mailboxes[0];
            console.log('Sample Mailbox Object Keys:', Object.keys(mailbox));
            console.log('\nStat Fields Present:');
            console.log(`  - total_sent_count: ${mailbox.total_sent_count} ${typeof mailbox.total_sent_count === 'number' ? '✅' : '❌'}`);
            console.log(`  - open_count_lifetime: ${mailbox.open_count_lifetime} ${typeof mailbox.open_count_lifetime === 'number' ? '✅' : '❌'}`);
            console.log(`  - click_count_lifetime: ${mailbox.click_count_lifetime} ${typeof mailbox.click_count_lifetime === 'number' ? '✅' : '❌'}`);
            console.log(`  - reply_count_lifetime: ${mailbox.reply_count_lifetime} ${typeof mailbox.reply_count_lifetime === 'number' ? '✅' : '❌'}`);
            console.log(`  - engagement_rate: ${mailbox.engagement_rate} ${typeof mailbox.engagement_rate === 'number' ? '✅' : '❌'}`);
            console.log(`  - warmup_status: ${mailbox.warmup_status || 'null'} ${mailbox.warmup_status ? '✅' : '⚠️  (null is ok if not configured)'}`);
            console.log(`  - warmup_reputation: ${mailbox.warmup_reputation || 'null'} ${mailbox.warmup_reputation ? '✅' : '⚠️  (null is ok if not configured)'}`);

            console.log('\nSample Mailbox Full Object:');
            console.log(JSON.stringify(mailbox, null, 2));
        } else {
            console.log('⚠️  No mailboxes found');
        }

        // Test 4: Check what getDomains endpoint would return
        console.log('\n\n🌐 TEST 4: Domains API Response Structure');
        console.log('=' .repeat(60));
        const domains = await prisma.domain.findMany({
            where: { organization_id: org.id },
            take: 1,
            include: {
                mailboxes: {
                    select: {
                        id: true,
                        email: true,
                        status: true,
                        hard_bounce_count: true,
                        window_bounce_count: true,
                        campaigns: {
                            select: {
                                id: true,
                                name: true,
                                status: true
                            }
                        }
                    }
                }
            }
        });

        if (domains.length > 0) {
            const domain = domains[0];
            console.log('Sample Domain Object Keys:', Object.keys(domain));
            console.log('\nStat Fields Present:');
            console.log(`  - total_sent_lifetime: ${domain.total_sent_lifetime} ${typeof domain.total_sent_lifetime === 'number' ? '✅' : '❌'}`);
            console.log(`  - total_opens: ${domain.total_opens} ${typeof domain.total_opens === 'number' ? '✅' : '❌'}`);
            console.log(`  - total_clicks: ${domain.total_clicks} ${typeof domain.total_clicks === 'number' ? '✅' : '❌'}`);
            console.log(`  - total_replies: ${domain.total_replies} ${typeof domain.total_replies === 'number' ? '✅' : '❌'}`);
            console.log(`  - total_bounces: ${domain.total_bounces} ${typeof domain.total_bounces === 'number' ? '✅' : '❌'}`);
            console.log(`  - engagement_rate: ${domain.engagement_rate} ${typeof domain.engagement_rate === 'number' ? '✅' : '❌'}`);
            console.log(`  - bounce_rate: ${domain.bounce_rate} ${typeof domain.bounce_rate === 'number' ? '✅' : '❌'}`);

            console.log('\nSample Domain Full Object:');
            console.log(JSON.stringify(domain, null, 2));
        } else {
            console.log('⚠️  No domains found');
        }

        console.log('\n\n🎯 DIAGNOSIS:');
        console.log('=' .repeat(60));

        const leadsHaveStats = leads.length > 0 && (leads[0].emails_sent > 0 || leads[0].emails_opened > 0);
        const campaignsHaveStats = campaigns.length > 0 && (campaigns[0].total_sent > 0 || campaigns[0].open_count > 0);
        const mailboxesHaveStats = mailboxes.length > 0 && (mailboxes[0].total_sent_count > 0 || mailboxes[0].open_count_lifetime > 0);

        if (!leadsHaveStats && !campaignsHaveStats && !mailboxesHaveStats) {
            console.log('❌ ALL STATS ARE 0 - No data has been synced from Smartlead yet');
            console.log('\nREQUIRED ACTION:');
            console.log('1. ✅ Verify Railway deployment is complete');
            console.log('2. ⚠️  Trigger Manual Sync in Settings page (ON RAILWAY, not localhost)');
            console.log('3. ⚠️  Wait 2-5 minutes for sync to complete');
            console.log('4. ⚠️  Refresh dashboard pages to see stats');
        } else {
            console.log('✅ Stat fields exist and have the correct structure!');
            console.log('\nIf frontend shows 0s or blanks:');
            console.log('1. Check browser console for JavaScript errors');
            console.log('2. Verify frontend is calling correct API endpoints');
            console.log('3. Check if backend URL is configured correctly in frontend');
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

testAPIResponses();
