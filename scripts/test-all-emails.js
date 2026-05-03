/* eslint-disable */
/**
 * End-to-end test for all 22 transactional emails.
 *
 * For each registered email kind, calls the template render function
 * with realistic sample data, then dispatches via the canonical
 * dispatcher to demo@superkabe.com (forced recipient — bypasses
 * org-admin resolution to avoid surprising real org admins).
 *
 * Run: node scripts/test-all-emails.js
 */

const path = require('path');
process.env.RESEND_API_KEY ||= require('fs').readFileSync(
    path.join(__dirname, '..', '.env'), 'utf8'
).split(/\r?\n/).find(l => l.startsWith('RESEND_API_KEY='))?.slice('RESEND_API_KEY='.length).trim() || '';

// ts-node so the .ts modules are loadable
require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs', target: 'es2020' },
});

const { dispatchEmail } = require('../src/services/emailTemplates/dispatcher');
const { passwordResetEmail } = require('../src/services/emailTemplates/passwordReset');
const { welcomeEmail } = require('../src/services/emailTemplates/welcome');
const { accountLockedEmail } = require('../src/services/emailTemplates/accountLocked');
const { passwordChangedEmail } = require('../src/services/emailTemplates/passwordChanged');
const { accountDeletionScheduledEmail } = require('../src/services/emailTemplates/accountDeletionScheduled');
const { accountDeletionExecutedEmail } = require('../src/services/emailTemplates/accountDeletionExecuted');
const billing = require('../src/services/emailTemplates/billing');
const ops = require('../src/services/emailTemplates/operationalAlerts');
const integrations = require('../src/services/emailTemplates/integrations');
const { dataExportReadyEmail } = require('../src/services/emailTemplates/dataExport');
const { weeklyDigestEmail } = require('../src/services/emailTemplates/weeklyDigest');

const TO = process.env.TEST_TO || 'demo@superkabe.com';
const NOW = Date.now();
const FRONTEND = 'http://localhost:3000';
const TEST_RUN_ID = NOW.toString(36);

const tests = [
    // ─── Account security (5)
    {
        name: '01 password_reset',
        category: 'account_security',
        eventKind: 'password_reset_requested',
        render: () => passwordResetEmail({
            name: 'Demo User',
            resetUrl: `${FRONTEND}/reset-password?token=test-${TEST_RUN_ID}`,
            requesterContext: 'Chrome on macOS · 1.2.3.4',
            ttlLabel: '1 hour',
        }),
    },
    {
        name: '02 welcome',
        category: 'account_security',
        eventKind: 'welcome',
        render: () => welcomeEmail({
            name: 'Demo User',
            organizationName: 'Demo Agency',
            trialDaysRemaining: 14,
            dashboardUrl: `${FRONTEND}/dashboard`,
        }),
    },
    {
        name: '03 account_locked',
        category: 'account_security',
        eventKind: 'account_locked',
        render: () => accountLockedEmail({
            name: 'Demo User',
            lockedUntil: new Date(Date.now() + 15 * 60_000),
            failedAttempts: 10,
            requesterContext: 'Firefox on Windows · 5.6.7.8',
            forgotPasswordUrl: `${FRONTEND}/forgot-password`,
        }),
    },
    {
        name: '04 password_changed',
        category: 'account_security',
        eventKind: 'password_changed',
        render: () => passwordChangedEmail({
            name: 'Demo User',
            changedAt: new Date(),
            requesterContext: 'Chrome on macOS · 1.2.3.4',
            source: 'self_service',
            forgotPasswordUrl: `${FRONTEND}/forgot-password`,
        }),
    },
    {
        name: '05 account_deletion_scheduled',
        category: 'compliance',
        eventKind: 'account_deletion_scheduled',
        render: () => accountDeletionScheduledEmail({
            requesterName: 'Demo User',
            organizationName: 'Demo Agency',
            executesAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            cancellationToken: 'cancel-token-' + TEST_RUN_ID.slice(0, 12),
            cancelUrl: `${FRONTEND}/dashboard/data-rights`,
        }),
    },
    {
        name: '06 account_deletion_executed',
        category: 'compliance',
        eventKind: 'account_deletion_executed',
        render: () => accountDeletionExecutedEmail({
            requesterName: 'Demo User',
            organizationName: 'Demo Agency',
            executedAt: new Date(),
        }),
    },

    // ─── Billing (7)
    {
        name: '07 trial_ending',
        category: 'billing',
        eventKind: 'trial_ending',
        render: () => billing.trialEndingEmail({
            organizationName: 'Demo Agency',
            daysRemaining: 3,
            trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60_000),
            sendsUsed: 1248,
            billingUrl: `${FRONTEND}/dashboard/billing`,
        }),
    },
    {
        name: '08 trial_expired',
        category: 'billing',
        eventKind: 'trial_expired',
        render: () => billing.trialExpiredEmail({
            organizationName: 'Demo Agency',
            billingUrl: `${FRONTEND}/dashboard/billing`,
        }),
    },
    {
        name: '09 payment_failed',
        category: 'billing',
        eventKind: 'payment_failed',
        render: () => billing.paymentFailedEmail({
            organizationName: 'Demo Agency',
            attemptId: 'pay_test_' + TEST_RUN_ID.slice(0, 8),
            amountLabel: '49.00 USD',
            nextRetryAt: new Date(Date.now() + 3 * 24 * 60 * 60_000),
            billingUrl: `${FRONTEND}/dashboard/billing`,
        }),
    },
    {
        name: '10 subscription_canceled',
        category: 'billing',
        eventKind: 'subscription_canceled',
        render: () => billing.subscriptionCanceledEmail({
            organizationName: 'Demo Agency',
            activeUntil: new Date(Date.now() + 14 * 24 * 60 * 60_000),
            reason: 'Test cancellation',
            billingUrl: `${FRONTEND}/dashboard/billing`,
        }),
    },
    {
        name: '11 subscription_changed',
        category: 'billing',
        eventKind: 'subscription_changed',
        render: () => billing.subscriptionChangedEmail({
            organizationName: 'Demo Agency',
            fromTier: 'starter',
            toTier: 'growth',
            direction: 'upgrade',
            effectiveAt: new Date(),
            billingUrl: `${FRONTEND}/dashboard/billing`,
        }),
    },
    {
        name: '12 invoice_paid',
        category: 'billing',
        eventKind: 'invoice_paid',
        render: () => billing.invoicePaidEmail({
            organizationName: 'Demo Agency',
            invoiceId: 'inv_test_' + TEST_RUN_ID.slice(0, 8),
            amountLabel: '49.00 USD',
            paidAt: new Date(),
            nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            receiptUrl: 'https://polar.sh/dashboard/invoice/test',
            billingUrl: `${FRONTEND}/dashboard/billing`,
        }),
    },
    {
        name: '13 usage_threshold',
        category: 'billing',
        eventKind: 'usage_threshold',
        render: () => billing.usageThresholdEmail({
            organizationName: 'Demo Agency',
            metric: 'sends',
            percentUsed: 90,
            used: 27000,
            limit: 30000,
            resetsAt: new Date(Date.now() + 8 * 24 * 60 * 60_000),
            billingUrl: `${FRONTEND}/dashboard/billing`,
        }),
    },

    // ─── Operational alerts (7)
    {
        name: '14 mailbox_paused',
        category: 'operational_alert',
        eventKind: 'mailbox_paused',
        render: () => ops.mailboxPausedEmail({
            organizationName: 'Demo Agency',
            mailboxEmail: 'alex@acme-demo.com',
            domainName: 'acme-demo.com',
            reason: '1h bounce rate 4.2% exceeds 3.0% threshold',
            pausedAt: new Date(),
            mailboxUrl: `${FRONTEND}/dashboard/mailboxes`,
        }),
    },
    {
        name: '15 mailbox_quarantine',
        category: 'operational_alert',
        eventKind: 'mailbox_quarantine',
        render: () => ops.mailboxQuarantineEmail({
            organizationName: 'Demo Agency',
            mailboxEmail: 'alex@acme-demo.com',
            domainName: 'acme-demo.com',
            relapseCount: 2,
            resilienceScore: 42,
            healingUrl: `${FRONTEND}/dashboard/healing`,
        }),
    },
    {
        name: '16 mailbox_recovered',
        category: 'operational_alert',
        eventKind: 'mailbox_recovered',
        render: () => ops.mailboxRecoveredEmail({
            organizationName: 'Demo Agency',
            mailboxEmail: 'alex@acme-demo.com',
            domainName: 'acme-demo.com',
            recoveredAt: new Date(),
            durationLabel: '3d 4h',
            mailboxUrl: `${FRONTEND}/dashboard/mailboxes`,
        }),
    },
    {
        name: '17 domain_paused',
        category: 'operational_alert',
        eventKind: 'domain_paused',
        render: () => ops.domainPausedEmail({
            organizationName: 'Demo Agency',
            domainName: 'beta-outreach.io',
            reason: 'aggregated bounce rate 5.1% across 4 mailboxes',
            pausedAt: new Date(),
            domainUrl: `${FRONTEND}/dashboard/domains`,
        }),
    },
    {
        name: '18 manual_intervention',
        category: 'operational_alert',
        eventKind: 'manual_intervention_required',
        render: () => ops.manualInterventionEmail({
            organizationName: 'Demo Agency',
            entityType: 'mailbox',
            entityLabel: 'alex@acme-demo.com',
            relapseCount: 3,
            reason: 'Auto-flagged after 3 relapses. Operator review required.',
            healingUrl: `${FRONTEND}/dashboard/healing`,
        }),
    },
    {
        name: '19 campaign_paused',
        category: 'operational_alert',
        eventKind: 'campaign_paused',
        render: () => ops.campaignPausedEmail({
            organizationName: 'Demo Agency',
            campaignName: 'Q2 SaaS Founders Outbound',
            reason: 'Bounce rate 3.4% exceeds 3.0% threshold',
            pausedAt: new Date(),
            sentSoFar: 487,
            bounceRate: 0.034,
            campaignUrl: `${FRONTEND}/dashboard/campaigns`,
        }),
    },
    {
        name: '20 mailbox_oauth_disconnected',
        category: 'integration',
        eventKind: 'mailbox_oauth_disconnected',
        render: () => ops.mailboxOAuthDisconnectedEmail({
            organizationName: 'Demo Agency',
            mailboxEmail: 'alex@acme-demo.com',
            provider: 'google',
            providerError: 'invalid_grant: Token has been expired or revoked',
            detectedAt: new Date(),
            reconnectUrl: `${FRONTEND}/dashboard/sequencer/accounts`,
        }),
    },

    // ─── Integrations (2 — beyond OAuth-disconnect)
    {
        name: '21 crm_sync_failed',
        category: 'integration',
        eventKind: 'crm_sync_failed',
        render: () => integrations.crmSyncFailedEmail({
            organizationName: 'Demo Agency',
            provider: 'HubSpot',
            operation: 'contact_import',
            errorMessage: '401 Unauthorized: refresh_token expired',
            consecutiveFailures: 3,
            lastSuccessAt: new Date(Date.now() - 7 * 24 * 60 * 60_000),
            integrationUrl: `${FRONTEND}/dashboard/integrations/crm/hubspot`,
        }),
    },
    {
        name: '22 import_completed',
        category: 'integration',
        eventKind: 'import_completed',
        render: () => integrations.importCompletedEmail({
            organizationName: 'Demo Agency',
            sourceLabel: 'Apollo',
            totalProcessed: 542,
            totalCreated: 487,
            totalUpdated: 38,
            totalSkipped: 12,
            totalFailed: 5,
            durationLabel: '2m 14s',
            creditsConsumed: 542,
            contactsUrl: `${FRONTEND}/dashboard/sequencer/contacts`,
        }),
    },

    // ─── Compliance (1 beyond deletion-scheduled/executed)
    {
        name: '23 data_export_ready',
        category: 'compliance',
        eventKind: 'data_export_ready',
        render: () => dataExportReadyEmail({
            name: 'Demo User',
            organizationName: 'Demo Agency',
            exportedAt: new Date(),
            requesterContext: 'Chrome on macOS · 1.2.3.4',
            counts: {
                mailboxes: 4,
                leads: 30,
                campaigns: 3,
                emailsSent: 1248,
                emailsValidated: 250,
            },
            dataRightsUrl: `${FRONTEND}/dashboard/data-rights`,
        }),
    },

    // ─── Reporting (1)
    {
        name: '24 weekly_digest',
        category: 'reporting',
        eventKind: 'weekly_digest',
        render: () => weeklyDigestEmail({
            organizationName: 'Demo Agency',
            weekStart: new Date(Date.now() - 7 * 24 * 60 * 60_000),
            weekEnd: new Date(),
            totals: { sent: 1248, opens: 524, clicks: 117, replies: 83, bounces: 21 },
            sendsDeltaPct: 0.12,
            topCampaigns: [
                { name: 'Q2 SaaS Founders Outbound', replies: 47, sent: 612 },
                { name: 'VP Marketing — Mid-Market', replies: 24, sent: 380 },
                { name: 'Enterprise Champions', replies: 12, sent: 256 },
            ],
            operationalSummary: { mailboxesPaused: 1, mailboxesRecovered: 1, domainsPaused: 0 },
            dashboardUrl: `${FRONTEND}/dashboard`,
        }),
    },
];

(async () => {
    const startedAt = Date.now();
    let pass = 0;
    let fail = 0;
    const failures = [];

    console.log('═════════════════════════════════════════════════════════════');
    console.log(`Testing ${tests.length} email types → ${TO}`);
    console.log(`Run id: ${TEST_RUN_ID}`);
    console.log('═════════════════════════════════════════════════════════════');

    for (const t of tests) {
        const padded = t.name.padEnd(40, ' ');
        try {
            const rendered = t.render();
            // Sanity: the renderer must produce all four required fields.
            if (!rendered.subject || !rendered.html || !rendered.text || !rendered.preheader) {
                throw new Error('renderer returned incomplete envelope');
            }
            const result = await dispatchEmail({
                rendered,
                audience: { kind: 'email', email: TO },
                category: t.category,
                eventKind: t.eventKind,
                idempotencyKey: `test:${t.eventKind}:${TEST_RUN_ID}`,
            });
            if (result.delivered) {
                pass += 1;
                console.log(`✔ ${padded}  resend ${result.messageId}`);
            } else {
                fail += 1;
                failures.push({ name: t.name, reason: result.skippedReason || 'not delivered' });
                console.log(`✘ ${padded}  ${result.skippedReason || 'not delivered'}`);
            }
        } catch (err) {
            fail += 1;
            failures.push({ name: t.name, reason: err.message || String(err) });
            console.log(`✘ ${padded}  ${err.message || err}`);
        }
        // Small inter-send delay so we don't trip Resend's burst-rate limit.
        await new Promise(r => setTimeout(r, 250));
    }

    const tookMs = Date.now() - startedAt;
    console.log('═════════════════════════════════════════════════════════════');
    console.log(`Pass ${pass}  /  Fail ${fail}  /  Total ${tests.length}   (${tookMs}ms)`);
    if (failures.length > 0) {
        console.log('');
        console.log('Failures:');
        failures.forEach(f => console.log(`  - ${f.name}: ${f.reason}`));
    }
    console.log('═════════════════════════════════════════════════════════════');
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    console.error('Fatal:', e);
    process.exit(2);
});
