/**
 * /api/linkedin - Super LinkedIn module routes.
 * Org-scoped via the global orgContext middleware mounted at /api.
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import * as accounts from '../controllers/linkedinAccountController';
import * as campaigns from '../controllers/linkedinCampaignController';
import * as unibox from '../controllers/linkedinUniboxController';
import * as analytics from '../controllers/linkedinAnalyticsController';
import * as icp from '../controllers/linkedinIcpController';
import * as customers from '../controllers/linkedinCustomerController';
import * as watchlists from '../controllers/linkedinWatchlistController';
import * as signals from '../controllers/linkedinSignalsController';
import * as leads from '../controllers/linkedinLeadController';
import * as contacts from '../controllers/linkedinContactsController';

const router = Router();

// Accounts
router.get('/accounts', asyncHandler(accounts.list));
router.get('/accounts/limits', asyncHandler(accounts.limits));
router.post('/accounts/connect-link', asyncHandler(accounts.connectLink));
router.post('/accounts/addons/purchase', asyncHandler(accounts.purchaseAddonSlot));
router.get('/accounts/:id', asyncHandler(accounts.detail));
router.get('/accounts/:id/posts', asyncHandler(accounts.listPosts));
router.get('/accounts/:id/posts/:postId/engagements', asyncHandler(accounts.listPostEngagements));
router.post('/accounts/:id/reconnect', asyncHandler(accounts.reconnect));
router.patch('/accounts/:id', asyncHandler(accounts.update));
router.delete('/accounts/:id', asyncHandler(accounts.remove));

// Campaigns - Super LinkedIn is single-channel by design. These endpoints
// own LinkedIn-only campaign create / launch / detail. Mixed-channel
// campaigns belong on the unified /api/sequencer/campaigns surface.
router.get('/campaigns/step-types', asyncHandler(campaigns.listStepTypes));
router.post('/campaigns', asyncHandler(campaigns.create));
router.get('/campaigns/:id', asyncHandler(campaigns.detail));
router.patch('/campaigns/:id', asyncHandler(campaigns.update));
router.post('/campaigns/:id/launch', asyncHandler(campaigns.launch));
router.post('/campaigns/:id/pause', asyncHandler(campaigns.pause));
router.post('/campaigns/:id/resume', asyncHandler(campaigns.resume));
router.post('/campaigns/:id/validate', asyncHandler(campaigns.validate));
router.get('/campaigns/:id/senders', asyncHandler(campaigns.listSenders));
router.post('/campaigns/:id/senders', asyncHandler(campaigns.attachSender));
router.delete('/campaigns/:id/senders/:senderId', asyncHandler(campaigns.detachSender));

// Signals feed - engagement events with resolved mode + outcome.
router.get('/signals/feed', asyncHandler(signals.feed));

// SUGGEST review queue - pending approval rows from the supervisor.
router.get('/signals/review-queue', asyncHandler(signals.reviewQueue));
router.post('/signals/review-queue/:eventId/approve', asyncHandler(signals.approveReview));
router.post('/signals/review-queue/:eventId/dismiss', asyncHandler(signals.dismissReview));

// Diagnostic: list SignalMonitoringRule rows pointing at deleted refs
// (campaign, cold-call list). Powers the "your rule is broken" banner
// on the signals page.
router.get('/signals/rule-health', asyncHandler(signals.ruleHealth));

// Lead-detail surface for the AI signal icebreaker (view + regenerate).
router.get('/leads/:id/icebreaker', asyncHandler(leads.getIcebreaker));
router.post('/leads/:id/icebreaker/regenerate', asyncHandler(leads.regenerateIcebreaker));

// LinkedIn Contacts - workspace-level Lead rows that carry a linkedin_url,
// joined with LinkedIn connection-edge state + LinkedIn campaign enrollment
// counts. Tag operations (per-row PUT + bulk-tag) reuse the unified
// /api/sequencer/contacts/* endpoints since the underlying Lead is shared.
router.get('/contacts', asyncHandler(contacts.list));
router.get('/contacts/facets', asyncHandler(contacts.facets));
router.post('/contacts', asyncHandler(contacts.create));
router.post('/contacts/bulk', asyncHandler(contacts.bulk));
router.post('/contacts/delete', asyncHandler(contacts.remove));
router.post('/contacts/enroll-in-campaign', asyncHandler(contacts.enrollInCampaign));

// Topics watchlist - lemlist-style keyword monitoring for signal-based outbound.
router.get('/watchlists', asyncHandler(watchlists.list));
router.post('/watchlists', asyncHandler(watchlists.create));
router.get('/watchlists/:id', asyncHandler(watchlists.detail));
router.patch('/watchlists/:id', asyncHandler(watchlists.update));
router.delete('/watchlists/:id', asyncHandler(watchlists.remove));
router.post('/watchlists/:id/run-now', asyncHandler(watchlists.runNow));
router.get('/watchlists/:id/matches', asyncHandler(watchlists.listMatches));
router.post('/watchlists/:id/matches/:matchId/push', asyncHandler(watchlists.pushMatch));
router.post('/watchlists/:id/matches/:matchId/skip', asyncHandler(watchlists.skipMatch));

// Customer registry - powers the engager-relationship label.
router.get('/customers', asyncHandler(customers.list));
router.post('/customers/import', asyncHandler(customers.importFromCsv));
router.delete('/customers/:id', asyncHandler(customers.remove));

// ICP profiles
router.get('/icp', asyncHandler(icp.list));
router.post('/icp', asyncHandler(icp.create));
router.get('/icp/:id', asyncHandler(icp.get));
router.patch('/icp/:id', asyncHandler(icp.update));
router.delete('/icp/:id', asyncHandler(icp.remove));
router.post('/icp/:id/toggle', asyncHandler(icp.toggle));
// Dry-run an ICP against a sample profile - no audit row, no side
// effects. Surfaces the per-filter hit/miss breakdown so operators
// can verify their ICP before saving.
router.post('/icp/:id/test', asyncHandler(icp.testIcp));
// Pre-delete impact report - count of audit rows + rules referencing
// this ICP. Powers the delete-confirmation modal.
router.get('/icp/:id/delete-impact', asyncHandler(icp.deleteImpact));
// Operator-triggered re-evaluation of stuck SUGGEST events after
// editing an ICP. Resets processed_at on supervisor decisions that
// came out as no_icp_match within the lookback window.
router.post('/icp/reevaluate-no-match', asyncHandler(icp.reevaluateNoMatchEvents));

// Unibox
router.get('/unibox/threads', asyncHandler(unibox.listThreads));
router.get('/unibox/threads/:id', asyncHandler(unibox.getThread));
router.post('/unibox/threads/:id/reply', asyncHandler(unibox.sendReply));
router.post('/unibox/threads/:id/read', asyncHandler(unibox.markRead));

// Analytics
router.get('/analytics/kpi', asyncHandler(analytics.kpi));
router.get('/analytics/sender-perf', asyncHandler(analytics.senderPerformance));
router.get('/analytics/campaign-perf', asyncHandler(analytics.campaignPerformance));
router.get('/analytics/daily-sent', asyncHandler(analytics.dailySent));
router.get('/analytics/signal-funnel', asyncHandler(analytics.signalFunnel));
router.get('/analytics/acceptance-funnel', asyncHandler(analytics.acceptanceFunnel));
router.get('/analytics/reply-quality', asyncHandler(analytics.replyQuality));
router.get('/analytics/step-level', asyncHandler(analytics.stepLevelPerformance));
router.get('/analytics/sender-capacity', asyncHandler(analytics.senderCapacity));
router.get('/analytics/auto-tag-distribution', asyncHandler(analytics.autoTagDistribution));
router.get('/analytics/signal-lead-funnel', asyncHandler(analytics.signalLeadFunnel));
router.get('/analytics/account-status', asyncHandler(analytics.accountStatus));
router.get('/analytics/acceptance-by-type', asyncHandler(analytics.acceptanceByType));
router.get('/analytics/working-hours-compliance', asyncHandler(analytics.workingHoursCompliance));
router.get('/analytics/campaign-sender-affinity', asyncHandler(analytics.campaignSenderAffinity));
router.get('/analytics/failure-taxonomy', asyncHandler(analytics.failureTaxonomy));
router.get('/analytics/agent-telemetry', asyncHandler(analytics.agentTelemetry));
router.get('/analytics/sender-comparison', asyncHandler(analytics.senderComparison));

export default router;
