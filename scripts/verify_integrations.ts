import axios from 'axios';
import { prisma } from '../src/index';

const BASE_URL = 'http://localhost:3001/api';

async function runVerification() {
    console.log('--- Starting Integration Verification ---');

    // 1. Verify Clay Webhook
    console.log('\n[TEST] 1. Clay Webhook Ingestion');
    try {
        const clayPayload = {
            'Email': 'test_clay_' + Date.now() + '@example.com',
            'Job Title': 'CTO',
            'Lead Score': '85',
            'Company': 'Tech Corp'
        };
        const res = await axios.post(`${BASE_URL}/ingest/clay`, clayPayload);
        console.log('Response:', res.data);

        if (res.data.success && res.data.leadId) {
            console.log('✅ Clay Webhook - Success');
            // Verify in DB
            const lead = await prisma.lead.findUnique({ where: { id: res.data.leadId } });
            console.log('DB Verification:', lead ? `Found lead ${lead.email}` : 'Lead not found!');
        } else {
            console.error('❌ Clay Webhook - Failed', res.data);
        }
    } catch (e: any) {
        console.error('❌ Clay Webhook - Error', e.message);
    }

    // 2. Verify Smartlead Bounce Webhook
    // First, ensure we have a mailbox and campaign
    console.log('\n[TEST] 2. Smartlead Bounce Webhook');
    // Seed a mailbox
    const domain = await prisma.domain.upsert({
        where: { domain: 'verify-infra.com' },
        create: { domain: 'verify-infra.com', status: 'healthy' },
        update: {}
    });
    const mailbox = await prisma.mailbox.upsert({
        where: { id: '99999' },
        create: { id: '99999', email: 'bouncer@verify-infra.com', domain_id: domain.id, status: 'active' },
        update: { status: 'active', window_bounce_count: 0 } // Reset for test
    });
    // Seed a campaign
    const campaign = await prisma.campaign.upsert({
        where: { id: '88888' },
        create: { id: '88888', name: 'Verification Campaign', status: 'active' },
        update: {}
    });

    try {
        const bouncePayload = {
            event_type: 'EMAIL_BOUNCE',
            data: {
                campaign_id: 88888,
                email_account_id: 99999,
                from_email: 'bouncer@verify-infra.com',
                to_email: 'victim@target.com'
            }
        };
        const res = await axios.post(`${BASE_URL}/monitor/smartlead-webhook`, bouncePayload);
        console.log('Response:', res.data);

        // Verify Bounce Count increment
        const updatedMailbox = await prisma.mailbox.findUnique({ where: { id: '99999' } });
        console.log(`Mailbox Bounce Count: ${updatedMailbox?.window_bounce_count}`);

        if (updatedMailbox && updatedMailbox.window_bounce_count > 0) {
            console.log('✅ Smartlead Bounce - Success (Count incremented)');
        } else {
            console.error('❌ Smartlead Bounce - Failed (Count not incremented)');
        }

    } catch (e: any) {
        console.error('❌ Smartlead Bounce - Error', e.message);
    }

    console.log('\n--- Verification Complete ---');
}

// Call the function if running directly, but wait for server?
// For this script we assume server is running.
// If run via ts-node, we need to handle the async execution.
runVerification().catch(console.error).finally(() => prisma.$disconnect());
