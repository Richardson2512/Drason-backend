/**
 * Backfill Subscriptions Script
 *
 * Initializes existing organizations with trial subscription status.
 * Run this once after deploying subscription schema changes.
 *
 * Usage: npx ts-node src/scripts/backfillSubscriptions.ts
 */

import { prisma } from '../index';
import { logger } from '../services/observabilityService';

async function backfillSubscriptions() {
    try {
        logger.info('[BACKFILL] Starting subscription backfill...');

        // Get all organizations that don't have trial dates set
        const orgs = await prisma.organization.findMany({
            where: {
                trial_started_at: null
            },
            select: {
                id: true,
                name: true,
                created_at: true
            }
        });

        logger.info(`[BACKFILL] Found ${orgs.length} organizations to backfill`);

        for (const org of orgs) {
            // Set trial to start from org creation date
            const trialStartedAt = org.created_at;
            const trialEndsAt = new Date(org.created_at.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days

            await prisma.organization.update({
                where: { id: org.id },
                data: {
                    subscription_tier: 'trial',
                    subscription_status: trialEndsAt > new Date() ? 'trialing' : 'expired',
                    trial_started_at: trialStartedAt,
                    trial_ends_at: trialEndsAt
                }
            });

            logger.info(`[BACKFILL] Updated organization ${org.name} (${org.id})`);
        }

        logger.info('[BACKFILL] Subscription backfill completed successfully');
        process.exit(0);
    } catch (error) {
        logger.error('[BACKFILL] Backfill failed', error instanceof Error ? error : new Error(String(error)));
        process.exit(1);
    }
}

backfillSubscriptions();
