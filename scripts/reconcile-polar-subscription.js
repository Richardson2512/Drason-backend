/**
 * One-shot reconciliation for a Polar purchase that didn't update our DB
 * because the webhook handler was rejecting the signature / crashing.
 *
 * Run on Railway against prod:
 *   node scripts/reconcile-polar-subscription.js \
 *     --org-id b5d0d249-2ced-4146-887f-2767de18d3c7 \
 *     --polar-customer-id a655e9db-9a50-4ca9-a034-6ba1ffb22731 \
 *     --polar-subscription-id 13f52043-b652-4f55-8533-b0d8bb900dd9 \
 *     --tier growth \
 *     --amount-cents 19900 \
 *     --currency USD \
 *     --period-end 2026-06-04T09:40:24.132256Z \
 *     --invoice-number SUPERKABE-TWLANPNYRM-0001
 *
 * Idempotent: if a SubscriptionEvent for this subscription_id already
 * exists, the script just re-asserts the org row state.
 */

const { PrismaClient } = require('@prisma/client');

function parseArgs() {
    const args = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (!flag.startsWith('--')) continue;
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) {
            args[flag.slice(2)] = true;
        } else {
            args[flag.slice(2)] = value;
            i++;
        }
    }
    return args;
}

async function main() {
    const args = parseArgs();
    const required = ['org-id', 'polar-customer-id', 'polar-subscription-id', 'tier', 'period-end'];
    for (const r of required) {
        if (!args[r]) {
            console.error(`Missing --${r}`);
            process.exit(1);
        }
    }

    const orgId = args['org-id'];
    const polarCustomerId = args['polar-customer-id'];
    const polarSubscriptionId = args['polar-subscription-id'];
    const tier = args['tier'];
    const amountCents = args['amount-cents'] ? parseInt(args['amount-cents'], 10) : null;
    const currency = (args['currency'] || 'USD').toUpperCase();
    const periodEnd = new Date(args['period-end']);
    const invoiceNumber = args['invoice-number'] || null;
    const invoiceUrl = args['invoice-url'] || null;

    if (!['starter', 'pro', 'growth', 'scale', 'enterprise'].includes(tier)) {
        console.error(`Invalid tier "${tier}"`);
        process.exit(1);
    }
    if (Number.isNaN(periodEnd.getTime())) {
        console.error(`Invalid --period-end: ${args['period-end']}`);
        process.exit(1);
    }

    const prisma = new PrismaClient();
    try {
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { id: true, name: true, slug: true, subscription_tier: true, subscription_status: true, polar_customer_id: true, polar_subscription_id: true },
        });
        if (!org) {
            console.error(`Org ${orgId} not found in DB.`);
            process.exit(1);
        }
        console.log('Before:', org);

        const updated = await prisma.organization.update({
            where: { id: orgId },
            data: {
                subscription_tier: tier,
                subscription_status: 'active',
                polar_customer_id: polarCustomerId,
                polar_subscription_id: polarSubscriptionId,
                subscription_started_at: new Date(),
                trial_ends_at: new Date(),
                next_billing_date: periodEnd,
            },
        });
        console.log('After:', {
            id: updated.id,
            tier: updated.subscription_tier,
            status: updated.subscription_status,
            polar_customer_id: updated.polar_customer_id,
            polar_subscription_id: updated.polar_subscription_id,
            next_billing_date: updated.next_billing_date,
        });

        // Backfill a SubscriptionEvent so the dashboard's invoice list shows
        // this purchase. Idempotent on (organization_id, polar_event_id).
        const polarEventId = `reconcile:subscription.created:${polarSubscriptionId}`;
        try {
            const created = await prisma.subscriptionEvent.create({
                data: {
                    organization_id: orgId,
                    event_type: 'subscription.created',
                    polar_event_id: polarEventId,
                    new_tier: tier,
                    amount_cents: amountCents,
                    currency,
                    polar_invoice_url: invoiceUrl,
                    polar_invoice_number: invoiceNumber,
                    payload: { reconciled: true, polarSubscriptionId, polarCustomerId },
                },
            });
            console.log('Created SubscriptionEvent', created.id);
        } catch (err) {
            if (err && err.code === 'P2002') {
                console.log('SubscriptionEvent already exists, skipped');
            } else {
                throw err;
            }
        }

        console.log('Reconciliation complete.');
    } finally {
        await prisma.$disconnect();
    }
}

main().catch(err => {
    console.error('Reconciliation failed:', err);
    process.exit(1);
});
