/**
 * Debug: Find ALL leads regardless of organization
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
    log: ['query', 'info', 'warn', 'error'],
});

async function debugLeads() {
    console.log('🔍 DEBUG: Checking database for ANY leads...\n');

    try {
        // Raw count
        const totalCount = await prisma.lead.count();
        console.log(`📊 Total lead count (raw): ${totalCount}\n`);

        if (totalCount === 0) {
            console.log('❌ Database is empty. Checking campaigns and mailboxes...\n');

            const campaignCount = await prisma.campaign.count();
            const mailboxCount = await prisma.mailbox.count();
            const domainCount = await prisma.domain.count();

            console.log(`   Campaigns: ${campaignCount}`);
            console.log(`   Mailboxes: ${mailboxCount}`);
            console.log(`   Domains: ${domainCount}\n`);

            if (campaignCount > 0) {
                const campaigns = await prisma.campaign.findMany({
                    select: {
                        id: true,
                        name: true,
                        organization_id: true,
                        _count: {
                            select: { leads: true }
                        }
                    },
                    take: 5
                });

                console.log('📋 Sample campaigns:');
                campaigns.forEach(c => {
                    console.log(`   - ${c.name} (ID: ${c.id}): ${c._count.leads} leads`);
                });
            }

            return;
        }

        // Get leads with full details
        const leads = await prisma.lead.findMany({
            select: {
                id: true,
                email: true,
                source: true,
                status: true,
                organization_id: true,
                assigned_campaign_id: true,
                created_at: true
            },
            orderBy: {
                created_at: 'desc'
            },
            take: 30
        });

        console.log(`✅ Found ${leads.length} leads\n`);

        // Group by status
        const byStatus: Record<string, number> = {};
        leads.forEach(lead => {
            byStatus[lead.status] = (byStatus[lead.status] || 0) + 1;
        });

        console.log('📈 Status distribution:');
        Object.entries(byStatus).forEach(([status, count]) => {
            console.log(`   ${status}: ${count}`);
        });

        console.log('\n📝 Recent leads:');
        leads.slice(0, 20).forEach((lead, idx) => {
            console.log(`   ${idx + 1}. [${lead.status.toUpperCase()}] ${lead.email}`);
            console.log(`      Source: ${lead.source} | Org: ${lead.organization_id}`);
        });

    } catch (error) {
        console.error('❌ Error:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

debugLeads()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
