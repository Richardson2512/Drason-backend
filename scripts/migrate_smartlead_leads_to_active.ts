/**
 * Migration Script: Update Smartlead Leads from 'held' to 'active'
 *
 * Purpose: Fix pre-existing Smartlead leads that were incorrectly synced as 'held'.
 * These leads are already in active Smartlead campaigns and should be 'active' to
 * enable the healing workflow.
 *
 * IMPORTANT: This ONLY affects leads with source='smartlead'. Clay-enriched leads
 * are NOT touched by this migration. Clay leads remain 'held' until the execution
 * gate approves them.
 *
 * Run: npx tsx scripts/migrate_smartlead_leads_to_active.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function migrateSmarpleadLeads() {
    console.log('🔄 Starting migration: Smartlead leads held → active\n');

    try {
        // Find all leads from Smartlead source that are currently 'held'
        const heldLeads = await prisma.lead.findMany({
            where: {
                source: 'smartlead',
                status: 'held'
            },
            select: {
                id: true,
                email: true,
                organization_id: true,
                assigned_campaign_id: true
            }
        });

        console.log(`📊 Found ${heldLeads.length} Smartlead leads in 'held' status\n`);

        if (heldLeads.length === 0) {
            console.log('✅ No leads to migrate. All Smartlead leads are already active.\n');
            return;
        }

        // Update all Smartlead leads from 'held' to 'active'
        const result = await prisma.lead.updateMany({
            where: {
                source: 'smartlead',
                status: 'held'
            },
            data: {
                status: 'active',
                updated_at: new Date()
            }
        });

        console.log(`✅ Successfully updated ${result.count} leads to 'active' status\n`);

        // Show sample of updated leads
        console.log('📝 Sample of updated leads:');
        heldLeads.slice(0, 10).forEach((lead, idx) => {
            console.log(`   ${idx + 1}. ${lead.email} (Campaign: ${lead.assigned_campaign_id || 'unassigned'})`);
        });

        if (heldLeads.length > 10) {
            console.log(`   ... and ${heldLeads.length - 10} more\n`);
        }

        console.log('\n✨ Migration complete! Pre-existing Smartlead leads are now active.');
        console.log('💡 Next steps:');
        console.log('   1. Verify leads appear as "Active" in the UI');
        console.log('   2. Check that healing workflow can now progress with active sends');
        console.log('   3. Monitor mailbox recovery phases (RESTRICTED_SEND → WARM_RECOVERY → HEALTHY)\n');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

// Run migration
migrateSmarpleadLeads()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
