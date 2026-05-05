import { generateDailySnapshot } from '../src/services/coldCallListService';

const orgId = process.argv[2];
if (!orgId) {
    console.error('Usage: ts-node scripts/trigger-coldcall-snapshot.ts <organizationId>');
    process.exit(1);
}

generateDailySnapshot(orgId)
    .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
