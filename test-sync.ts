import { syncSmartlead } from './src/services/smartleadSyncWorker';
import { prisma } from './src/index';

async function testSync() {
    try {
        // Find an organization that has a smartlead api key
        const orgSetting = await prisma.organizationSetting.findFirst({
            where: { key: 'SMARTLEAD_API_KEY' }
        });

        if (!orgSetting) {
            console.error("No Smartlead API key found in database.");
            process.exit(1);
        }

        console.log(`Testing sync for organization: ${orgSetting.organization_id}`);
        const result = await syncSmartlead(orgSetting.organization_id);
        console.log("Sync completed successfully:", result);
    } catch (e) {
        console.error("Sync failed:", e);
    } finally {
        await prisma.$disconnect();
    }
}

testSync();
