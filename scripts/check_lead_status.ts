/**
 * Check Lead Status Distribution
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkLeadStatus() {
    console.log('🔍 Checking lead status distribution...\n');

    try {
        // Get all leads grouped by source and status
        const allLeads = await prisma.lead.findMany({
            select: {
                id: true,
                email: true,
                source: true,
                status: true,
                assigned_campaign_id: true,
                created_at: true,
                updated_at: true
            },
            orderBy: {
                created_at: 'desc'
            },
            take: 50
        });

        console.log(`📊 Total leads found: ${allLeads.length}\n`);

        // Group by source and status
        const grouped: Record<string, Record<string, number>> = {};
        allLeads.forEach(lead => {
            const source = lead.source || 'unknown';
            const status = lead.status;
            if (!grouped[source]) grouped[source] = {};
            grouped[source][status] = (grouped[source][status] || 0) + 1;
        });

        console.log('📈 Distribution by source and status:');
        Object.entries(grouped).forEach(([source, statuses]) => {
            console.log(`\n  ${source.toUpperCase()}:`);
            Object.entries(statuses).forEach(([status, count]) => {
                console.log(`    - ${status}: ${count}`);
            });
        });

        console.log('\n📝 Recent leads (last 20):');
        allLeads.slice(0, 20).forEach((lead, idx) => {
            const campaign = lead.assigned_campaign_id ? `Campaign: ${lead.assigned_campaign_id.slice(0, 8)}` : 'No campaign';
            console.log(`   ${idx + 1}. [${lead.status.toUpperCase()}] ${lead.email} (${lead.source}) - ${campaign}`);
        });

    } catch (error) {
        console.error('❌ Error:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

checkLeadStatus()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
