import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();
const API_URL = 'http://localhost:3001/api/monitor/event';

async function main() {
    console.log('--- Verifying Monitoring Logic ---');

    // 1. Setup Data
    const domainId = 'test-domain-' + Date.now();
    await prisma.domain.create({
        data: {
            id: domainId,
            domain: `test-${Date.now()}.com`,
            status: 'healthy',
        }
    });

    const mailboxId = 'test-mb-' + Date.now();
    await prisma.mailbox.create({
        data: {
            id: mailboxId,
            email: `monitor-test-${Date.now()}@test.com`,
            domain_id: domainId,
            status: 'active',
            hard_bounce_count: 0,
            window_bounce_count: 0
        }
    });
    console.log(`Created Mailbox: ${mailboxId}`);

    // 2. Trigger 5 Bounces
    console.log('Triggering 5 bounces...');
    for (let i = 1; i <= 5; i++) {
        await axios.post(API_URL, {
            type: 'bounce',
            mailboxId: mailboxId
        });
        console.log(`  Bounce ${i} recorded`);
    }

    // 3. Verify Status
    const updatedMailbox = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    console.log(`Mailbox Status: ${updatedMailbox?.status}`);

    if (updatedMailbox?.status === 'paused') {
        console.log('SUCCESS: Mailbox paused after threshold.');
    } else {
        console.error('FAILURE: Mailbox NOT paused.');
        process.exit(1);
    }
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
