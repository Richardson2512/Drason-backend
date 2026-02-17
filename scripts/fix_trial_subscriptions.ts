/**
 * Fix Trial Subscriptions
 *
 * Backfills subscription fields for existing organizations that don't have them.
 * Run this script to fix organizations created before subscription system was added.
 *
 * Usage: npx ts-node scripts/fix_trial_subscriptions.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixTrialSubscriptions() {
    console.log('[FIX-TRIALS] Starting trial subscription backfill...\n');

    // Find all organizations without subscription fields populated
    const allOrgs = await prisma.organization.findMany({
        select: {
            id: true,
            name: true,
            slug: true,
            subscription_tier: true,
            subscription_status: true,
            trial_started_at: true,
            trial_ends_at: true,
            created_at: true
        }
    });

    // Filter in JavaScript for missing fields
    const orgs = allOrgs.filter(org =>
        !org.subscription_tier ||
        !org.subscription_status ||
        !org.trial_started_at
    );

    // Get full org data for processing
    const fullOrgs = await prisma.organization.findMany({
        where: {
            id: { in: orgs.map(o => o.id) }
        },
        select: {
            id: true,
            name: true,
            slug: true,
            subscription_tier: true,
            subscription_status: true,
            trial_started_at: true,
            trial_ends_at: true,
            created_at: true
        }
    });

    if (orgs.length === 0) {
        console.log('✅ No organizations need fixing. All trial subscriptions are properly configured.\n');
        return;
    }

    console.log(`Found ${orgs.length} organization(s) that need subscription field backfill:\n`);

    for (const org of fullOrgs) {
        console.log(`📦 Fixing: ${org.name} (${org.slug})`);
        console.log(`   ID: ${org.id}`);
        console.log(`   Created: ${org.created_at.toLocaleDateString()}`);
        console.log(`   Current Status: ${org.subscription_status || 'NULL'}`);
        console.log(`   Current Tier: ${org.subscription_tier || 'NULL'}`);

        // Calculate trial dates
        const now = new Date();
        const trialStartedAt = org.created_at; // Use org creation date as trial start
        const trialEndsAt = new Date(trialStartedAt.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days later

        // Check if trial has expired
        const isExpired = now > trialEndsAt;
        const subscriptionStatus = isExpired ? 'expired' : 'trialing';

        // Update organization with subscription fields
        await prisma.organization.update({
            where: { id: org.id },
            data: {
                subscription_tier: 'trial',
                subscription_status: subscriptionStatus,
                trial_started_at: trialStartedAt,
                trial_ends_at: trialEndsAt,
                current_lead_count: 0,
                current_domain_count: 0,
                current_mailbox_count: 0,
                usage_last_updated_at: now
            }
        });

        console.log(`   ✅ Updated to: ${subscriptionStatus}`);
        console.log(`   Trial Started: ${trialStartedAt.toLocaleDateString()}`);
        console.log(`   Trial Ends: ${trialEndsAt.toLocaleDateString()}`);

        if (isExpired) {
            console.log(`   ⚠️  Trial has expired (ended ${Math.floor((now.getTime() - trialEndsAt.getTime()) / (1000 * 60 * 60 * 24))} days ago)`);
        } else {
            const daysLeft = Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            console.log(`   ⏰ ${daysLeft} day(s) remaining in trial`);
        }
        console.log('');
    }

    console.log(`\n✅ Successfully fixed ${orgs.length} organization(s)\n`);

    // Refresh usage counts for all fixed organizations
    console.log('[FIX-TRIALS] Refreshing usage counts...\n');

    for (const org of fullOrgs) {
        const [leadCount, domainCount, mailboxCount] = await Promise.all([
            prisma.lead.count({
                where: {
                    organization_id: org.id,
                    status: { in: ['held', 'active', 'paused'] }
                }
            }),
            prisma.domain.count({ where: { organization_id: org.id } }),
            prisma.mailbox.count({ where: { organization_id: org.id } })
        ]);

        await prisma.organization.update({
            where: { id: org.id },
            data: {
                current_lead_count: leadCount,
                current_domain_count: domainCount,
                current_mailbox_count: mailboxCount,
                usage_last_updated_at: new Date()
            }
        });

        console.log(`📊 ${org.name}: ${leadCount} leads, ${domainCount} domains, ${mailboxCount} mailboxes`);
    }

    console.log('\n✅ All done! Organizations are now properly configured with subscription fields.\n');
}

// Run the fix
fixTrialSubscriptions()
    .catch((error) => {
        console.error('❌ Error fixing trial subscriptions:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
