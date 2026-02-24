const fs = require('fs');
const path = require('path');

const controllerPath = path.join(__dirname, '../src/controllers/smartleadWebhookController.ts');
const servicePath = path.join(__dirname, '../src/services/smartleadEventParserService.ts');

const lines = fs.readFileSync(controllerPath, 'utf8').split('\n');

// Find the line where `handleBounceEvent` starts (around line 111)
let splitIndex = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('async function handleBounceEvent(') || lines[i].includes('export const handleBounceEvent =')) {
        splitIndex = i;
        // Search backwards to include the JSDoc/comment block if present
        while (splitIndex > 0 && (lines[splitIndex-1].trim().startsWith('//') || lines[splitIndex-1].trim().startsWith('/*'))) {
            splitIndex--;
        }
        break;
    }
}

if (splitIndex === -1) {
    console.error('Could not find handleBounceEvent');
    process.exit(1);
}

const controllerLines = lines.slice(0, splitIndex);
const serviceLines = lines.slice(splitIndex);

// Define headers for the new service based on controller's headers
const serviceHeaders = `/**
 * Smartlead Event Parser Service
 *
 * Handles the heavy business logic for parsing and processing real-time events.
 */
import { prisma } from '../index';
import { logger } from '../services/observabilityService';
import * as auditLogService from '../services/auditLogService';
import { RecoveryPhase } from '../types';
import * as eventQueue from '../services/eventQueue';
// Add any other necessary imports that might have been left in controller
`;

// Modify controller lines to import from the new service
// handleSmartleadWebhook routes the payload to these functions
const newControllerLines = controllerLines.map(line => {
    // Add import statement at the end of the imports
    if (line.includes('import { RecoveryPhase }')) {
        return line + '\nimport * as eventParserService from "../services/smartleadEventParserService";';
    }
    // Change handleBounceEvent to eventParserService.handleBounceEvent
    if (line.includes('await handleBounceEvent(')) return line.replace('await handleBounceEvent(', 'await eventParserService.handleBounceEvent(');
    if (line.includes('await handleSentEvent(')) return line.replace('await handleSentEvent(', 'await eventParserService.handleSentEvent(');
    if (line.includes('await handleOpenEvent(')) return line.replace('await handleOpenEvent(', 'await eventParserService.handleOpenEvent(');
    if (line.includes('await handleClickEvent(')) return line.replace('await handleClickEvent(', 'await eventParserService.handlehandleClickEvent(');
    if (line.includes('await handleReplyEvent(')) return line.replace('await handleReplyEvent(', 'await eventParserService.handleReplyEvent(');
    if (line.includes('await handleUnsubscribeEvent(')) return line.replace('await handleUnsubscribeEvent(', 'await eventParserService.handleUnsubscribeEvent(');
    if (line.includes('await handleSpamEvent(')) return line.replace('await handleSpamEvent(', 'await eventParserService.handleSpamEvent(');
    
    return line;
});

// Since we're exporting the functions in the service, we need to add `export`
const newServiceLines = serviceLines.map(line => {
    if (line.startsWith('async function handle')) {
        return 'export ' + line;
    }
    return line;
});

fs.writeFileSync(servicePath, serviceHeaders + '\n' + newServiceLines.join('\n'));
fs.writeFileSync(controllerPath, newControllerLines.join('\n').replace('eventParserService.handlehandleClickEvent', 'eventParserService.handleClickEvent'));

console.log('Successfully refactored smartleadWebhookController.ts');
