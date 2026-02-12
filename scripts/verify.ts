/**
 * Verification Script
 * 
 * Tests the complete flow: Lead ingestion -> Routing -> Execution Gate -> Monitoring
 * Updated for multi-tenant schema.
 */

import { prisma } from './index';
import * as routingService from './services/routingService';
import * as executionGateService from './services/executionGateService';
import * as monitoringService from './services/monitoringService';

const DEFAULT_ORG_ID = 'test-org';

const run = async () => {
    console.log('=== DRASON VERIFICATION SCRIPT ===\n');

    // Clean existing test data
    console.log('1. Cleaning existing data...');
    await prisma.auditLog.deleteMany({ where: { organization_id: DEFAULT_ORG_ID } });
    await prisma.stateTransition.deleteMany({ where: { organization_id: DEFAULT_ORG_ID } });
    await prisma.rawEvent.deleteMany({ where: { organization_id: DEFAULT_ORG_ID } });
    await prisma.lead.deleteMany({ where: { organization_id: DEFAULT_ORG_ID } });
    await prisma.routingRule.deleteMany({ where: { organization_id: DEFAULT_ORG_ID } });
    await prisma.mailbox.deleteMany({ where: { organization_id: DEFAULT_ORG_ID } });
    await prisma.domain.deleteMany({ where: { organization_id: DEFAULT_ORG_ID } });
    await prisma.campaign.deleteMany({ where: { organization_id: DEFAULT_ORG_ID } });

    // Ensure test organization exists
    await prisma.organization.upsert({
        where: { id: DEFAULT_ORG_ID },
        update: {},
        create: {
            id: DEFAULT_ORG_ID,
            name: 'Test Organization',
            slug: 'test-org',
            system_mode: 'enforce'
        }
    });
    console.log('   Done.\n');

    // Setup test campaign
    console.log('2. Creating test campaign...');
    const campaign = await prisma.campaign.create({
        data: {
            id: 'campaign-123',
            name: 'Enterprise Sales Q1',
            status: 'active',
            channel: 'email',
            organization_id: DEFAULT_ORG_ID
        }
    });
    console.log(`   Created Campaign: ${campaign.id}\n`);

    // Setup test domain
    console.log('3. Creating test domain...');
    const domain = await prisma.domain.create({
        data: {
            domain: 'drasontest.io',
            status: 'healthy',
            organization_id: DEFAULT_ORG_ID
        }
    });
    console.log(`   Created Domain: ${domain.domain}\n`);

    // Setup test mailbox
    console.log('4. Creating test mailbox...');
    await prisma.mailbox.create({
        data: {
            id: 'mailbox-001',
            email: 'sales@drasontest.io',
            domain_id: domain.id,
            status: 'healthy',
            organization_id: DEFAULT_ORG_ID
        }
    });
    console.log('   Created Mailbox: sales@drasontest.io\n');

    // Create routing rule
    console.log('5. Creating routing rule...');
    await routingService.createRule(DEFAULT_ORG_ID, {
        persona: 'CTO',
        min_score: 70,
        target_campaign_id: campaign.id,
        priority: 100
    });
    console.log('   Created Rule: CTO >= 70 -> campaign-123\n');

    // Simulate lead ingestion
    console.log('6. Simulating lead ingestion...');
    const lead = await prisma.lead.create({
        data: {
            email: 'test.cto@example.com',
            persona: 'CTO',
            lead_score: 85,
            status: 'held',
            health_state: 'healthy',
            source: 'clay',
            organization_id: DEFAULT_ORG_ID
        }
    });
    console.log(`   Created Lead: ${lead.email} (Score: ${lead.lead_score})\n`);

    // Resolve routing
    console.log('7. Resolving routing...');
    const assignedCampaign = await routingService.resolveCampaignForLead(DEFAULT_ORG_ID, lead);
    console.log(`   Assigned Campaign: ${assignedCampaign || 'NONE'}\n`);

    if (assignedCampaign) {
        await prisma.lead.update({
            where: { id: lead.id },
            data: { assigned_campaign_id: assignedCampaign }
        });
    }

    // Check execution gate
    console.log('8. Checking execution gate...');
    const gateResult = await executionGateService.canExecuteLead(
        DEFAULT_ORG_ID,
        assignedCampaign || '',
        lead.id
    );
    console.log(`   Gate Result: ${gateResult.allowed ? 'PASSED' : 'BLOCKED'}`);
    console.log(`   Risk Score: ${gateResult.riskScore}`);
    console.log(`   Mode: ${gateResult.mode}`);
    console.log(`   Reason: ${gateResult.reason}\n`);

    // Simulate bounce events
    console.log('9. Simulating bounce events...');
    for (let i = 0; i < 3; i++) {
        await monitoringService.recordBounce('mailbox-001', campaign.id);
        console.log(`   Bounce ${i + 1} recorded`);
    }
    console.log('');

    // Check mailbox status after bounces
    const mailboxAfter = await prisma.mailbox.findUnique({
        where: { id: 'mailbox-001' }
    });
    console.log(`10. Mailbox Status After Bounces: ${mailboxAfter?.status}`);
    console.log(`    Window Bounces: ${mailboxAfter?.window_bounce_count}`);
    console.log(`    Total Hard Bounces: ${mailboxAfter?.hard_bounce_count}\n`);

    // Check domain status
    const domainAfter = await prisma.domain.findUnique({
        where: { id: domain.id }
    });
    console.log(`11. Domain Status: ${domainAfter?.status}\n`);

    // Print audit log summary
    console.log('12. Recent Audit Logs:');
    const logs = await prisma.auditLog.findMany({
        where: { organization_id: DEFAULT_ORG_ID },
        orderBy: { timestamp: 'desc' },
        take: 5
    });
    for (const log of logs) {
        console.log(`    [${log.entity}] ${log.action}: ${log.details?.substring(0, 60) || '-'}`);
    }
    console.log('');

    console.log('=== VERIFICATION COMPLETE ===');
};

run()
    .then(() => prisma.$disconnect())
    .catch((e) => {
        console.error(e);
        prisma.$disconnect();
    });
