const fs = require('fs');
const path = require('path');

const clientPath = path.join(__dirname, '../src/services/smartleadClient.ts');
const syncWorkerPath = path.join(__dirname, '../src/services/smartleadSyncWorker.ts');
const mutatorPath = path.join(__dirname, '../src/services/smartleadInfrastructureMutator.ts');

const lines = fs.readFileSync(clientPath, 'utf8').split('\n');

// Headers (1 to 30) - 0-indexed, so 0 to 29
const headers = lines.slice(0, 30);
// Add exported utils to headers of new files
const headersForNewFiles = [...headers];
headersForNewFiles.push(`import { getApiKey, SMARTLEAD_API_BASE } from './smartleadClient';`);

// Export getApiKey and SMARTLEAD_API_BASE in the client
const modifyClientHeaders = [...headers].map(line => {
    if (line.startsWith('const SMARTLEAD_API_BASE')) {
        return `export const SMARTLEAD_API_BASE = 'https://server.smartlead.ai/api/v1';`;
    }
    return line;
});

// getApiKey: 30 to 48 (lines 31-49)
const getApiKeyLines = lines.slice(30, 49).map(line => {
    if (line.startsWith('async function getApiKey')) {
        return `export async function getApiKey(organizationId: string): Promise<string | null> {`;
    }
    return line;
});

// syncSmartlead: 49 to 1346
const syncSmartleadLines = lines.slice(49, 1346);

// pushLeadToCampaign: 1347 to 1544
const pushLeadLines = lines.slice(1346, 1544);

// Mutators: 1544 to 1984
const mutatorLines = lines.slice(1544, 1984);

// Warmup: 1984 to 2156
const warmupLines = lines.slice(1984);

// Write smartleadSyncWorker.ts
fs.writeFileSync(syncWorkerPath, headersForNewFiles.join('\n') + '\n' + syncSmartleadLines.join('\n'));

// Write smartleadInfrastructureMutator.ts
fs.writeFileSync(mutatorPath, headersForNewFiles.join('\n') + '\n' + mutatorLines.join('\n'));

// Write smartleadClient.ts
const newClientLines = [
    ...modifyClientHeaders,
    ...getApiKeyLines,
    ...pushLeadLines,
    ...warmupLines
];
fs.writeFileSync(clientPath, newClientLines.join('\n'));

console.log('Successfully refactored smartleadClient.ts');
