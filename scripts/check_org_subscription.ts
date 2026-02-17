/**
 * Check Organization Subscription Status
 *
 * Diagnostic script to view an organization's subscription data.
 *
 * Usage: npx ts-node scripts/check_org_subscription.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkOrgSubscription() {
    console.log('[DIAGNOSTIC] Checking organization subscription status...\n');

    // Get all organizations
    const orgs = await prisma.organization.findMany({
        select: {
            id: true,
            name: true,
            slug: true,
            subscription_tier: true,
            subscription_status: true,
            trial_started_at: true,
            trial_ends_at: true,
            subscription_started_at: true,
            next_billing_date: true,
            current_lead_count: true,
            current_domain_count: true,
            current_mailbox_count: true,
            polar_customer_id: true,
            polar_subscription_id: true,
            created_at: true
        }
    });

    if (orgs.length === 0) {
        console.log('❌ No organizations found in database.\n');
        return;
    }

    console.log(`Found ${orgs.length} organization(s):\n`);
    console.log('='.repeat(80));

    for (const org of orgs) {
        console.log(`\n📦 ${org.name} (${org.slug})`);
        console.log(`   ID: ${org.id}`);
        console.log(`   Created: ${org.created_at.toLocaleString()}`);
        console.log('');
        console.log('   SUBSCRIPTION:');
        console.log(`   ├─ Tier: ${org.subscription_tier || 'NULL ❌'}`);
        console.log(`   ├─ Status: ${org.subscription_status || 'NULL ❌'}`);
        console.log(`   ├─ Trial Started: ${org.trial_started_at ? org.trial_started_at.toLocaleString() : 'NULL ❌'}`);
        console.log(`   ├─ Trial Ends: ${org.trial_ends_at ? org.trial_ends_at.toLocaleString() : 'NULL ❌'}`);
        console.log(`   ├─ Subscription Started: ${org.subscription_started_at ? org.subscription_started_at.toLocaleString() : 'N/A'}`);
        console.log(`   ├─ Next Billing: ${org.next_billing_date ? org.next_billing_date.toLocaleString() : 'N/A'}`);
        console.log(`   ├─ Polar Customer ID: ${org.polar_customer_id || 'N/A'}`);
        console.log(`   └─ Polar Subscription ID: ${org.polar_subscription_id || 'N/A'}`);
        console.log('');
        console.log('   USAGE:');
        console.log(`   ├─ Leads: ${org.current_lead_count}`);
        console.log(`   ├─ Domains: ${org.current_domain_count}`);
        console.log(`   └─ Mailboxes: ${org.current_mailbox_count}`);

        // Check if trial is active or expired
        if (org.trial_ends_at) {
            const now = new Date();
            if (now > org.trial_ends_at) {
                const daysExpired = Math.floor((now.getTime() - org.trial_ends_at.getTime()) / (1000 * 60 * 60 * 24));
                console.log(`\n   ⚠️  TRIAL EXPIRED ${daysExpired} day(s) ago`);
            } else {
                const daysLeft = Math.ceil((org.trial_ends_at.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                console.log(`\n   ⏰ ${daysLeft} day(s) remaining in trial`);
            }
        }

        console.log('\n' + '='.repeat(80));
    }

    console.log('\n✅ Diagnostic complete\n');
}

// Run the check
checkOrgSubscription()
    .catch((error) => {
        console.error('❌ Error checking organization:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
