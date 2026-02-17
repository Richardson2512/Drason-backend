/**
 * One-Time Migration Script: Encrypt Existing API Keys
 *
 * Run this once to encrypt all existing plain-text API keys in the database
 *
 * Usage: npx ts-node src/scripts/encryptExistingKeys.ts
 */

import { PrismaClient } from '@prisma/client';
import { encrypt, isEncrypted } from '../utils/encryption';

const prisma = new PrismaClient();

async function main() {
    console.log('🔐 Starting API key encryption migration...\n');

    // Get all organization settings that are marked as secret
    const secretSettings = await prisma.organizationSetting.findMany({
        where: { is_secret: true }
    });

    console.log(`Found ${secretSettings.length} secret settings to process\n`);

    let encryptedCount = 0;
    let alreadyEncryptedCount = 0;
    let errorCount = 0;

    for (const setting of secretSettings) {
        // Skip if already encrypted
        if (isEncrypted(setting.value)) {
            console.log(`✓ Already encrypted: ${setting.key} (org: ${setting.organization_id.substring(0, 8)}...)`);
            alreadyEncryptedCount++;
            continue;
        }

        try {
            // Encrypt the value
            const encryptedValue = encrypt(setting.value);

            // Update in database
            await prisma.organizationSetting.update({
                where: { id: setting.id },
                data: { value: encryptedValue }
            });

            console.log(`🔒 Encrypted: ${setting.key} (org: ${setting.organization_id.substring(0, 8)}...)`);
            encryptedCount++;
        } catch (error: any) {
            console.error(`❌ Failed to encrypt: ${setting.key} (org: ${setting.organization_id.substring(0, 8)}...)`);
            console.error(`   Error: ${error.message}`);
            errorCount++;
        }
    }

    console.log('\n📊 Migration Summary:');
    console.log(`   ✓ Newly encrypted: ${encryptedCount}`);
    console.log(`   ✓ Already encrypted: ${alreadyEncryptedCount}`);
    console.log(`   ✗ Errors: ${errorCount}`);
    console.log(`   Total processed: ${secretSettings.length}\n`);

    if (errorCount === 0) {
        console.log('✅ Migration completed successfully!');
    } else {
        console.log('⚠️  Migration completed with errors. Please review above.');
    }
}

main()
    .then(async () => {
        await prisma.$disconnect();
        process.exit(0);
    })
    .catch(async (error) => {
        console.error('\n❌ Migration failed:', error);
        await prisma.$disconnect();
        process.exit(1);
    });
