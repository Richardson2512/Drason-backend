/**
 * Phase 1 data migration — wrap every existing Organization in a new Account.
 *
 * For each Organization in the DB:
 *   1. Pick the "owner" User: preferred role='admin', tiebreak by created_at ASC.
 *   2. Create an Account with that user as owner. Account name = Org name.
 *   3. Update Organization.account_id = new Account.id, is_seed = true.
 *   4. Update every User in that Org: set account_id = new Account.id.
 *      The owner additionally gets is_agency_owner = true.
 *
 * Idempotent: re-running on an already-migrated DB skips Orgs that already
 * have account_id set.
 *
 * Run from the backend-staging dir:
 *   ts-node scripts/migrate-org-to-account.ts
 *
 * Use --dry to preview without writing.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry');

async function main() {
    console.log(`\n=== Phase 1 data migration ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`);

    const orgs = await prisma.organization.findMany({
        include: {
            users: {
                orderBy: [
                    // Prefer role='admin' first
                    { role: 'asc' }, // alphabetical, but we'll re-sort below
                    { created_at: 'asc' },
                ],
            },
        },
    });

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const org of orgs) {
        const tag = `[${org.slug}]`;

        if (org.account_id) {
            console.log(`${tag} already migrated (account_id=${org.account_id}) — skipping`);
            skipped++;
            continue;
        }

        if (org.users.length === 0) {
            console.warn(`${tag} has zero users — skipping (cannot determine owner)`);
            skipped++;
            continue;
        }

        // Pick owner: admin first, then oldest user
        const sortedUsers = [...org.users].sort((a, b) => {
            if (a.role === 'admin' && b.role !== 'admin') return -1;
            if (b.role === 'admin' && a.role !== 'admin') return 1;
            return a.created_at.getTime() - b.created_at.getTime();
        });
        const owner = sortedUsers[0];

        console.log(`${tag} → creating Account "${org.name}" with owner=${owner.email} (role=${owner.role})`);
        console.log(`         users to attach: ${org.users.length}`);

        if (DRY_RUN) {
            processed++;
            continue;
        }

        try {
            await prisma.$transaction(async (tx) => {
                // 1. Create the Account
                const account = await tx.account.create({
                    data: {
                        name: org.name,
                        agency_display_name: org.name,
                        owner_user_id: owner.id,
                        agency_mode_enabled: false, // opt-in only; never auto-enabled by migration
                    },
                });

                // 2. Update Organization
                await tx.organization.update({
                    where: { id: org.id },
                    data: {
                        account_id: account.id,
                        is_seed: true, // first (and only) workspace in this Account
                    },
                });

                // 3. Update all users in the org
                await tx.user.updateMany({
                    where: { organization_id: org.id },
                    data: { account_id: account.id },
                });

                // 4. Mark only the owner as is_agency_owner
                await tx.user.update({
                    where: { id: owner.id },
                    data: { is_agency_owner: true },
                });

                console.log(`         ✓ Account ${account.id} created and wired`);
            });
            processed++;
        } catch (err: any) {
            console.error(`${tag} ✗ failed: ${err.message}`);
            failed++;
        }
    }

    console.log('\n=== Summary ===');
    console.log(`  processed: ${processed}`);
    console.log(`  skipped:   ${skipped}`);
    console.log(`  failed:    ${failed}`);
    console.log(`  total:     ${orgs.length}`);

    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
