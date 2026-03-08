# Deep Architecture Analysis — Drason Backend

> Produced by distributed systems analysis. Covers dependency graphs, state writers,
> critical execution paths, redundancy, coupling, and a simplified architecture proposal.

---

## 1. Dependency Graph (Adjacency List)

### Services

```
auditLogService:
  imports: [prisma]
  reads: [auditLog]
  writes: [auditLog]
  external_calls: []
  called_by: [ALL controllers, ALL services via logAction()]

SlackAlertService:
  imports: [prisma, axios, crypto, observabilityService]
  reads: [slackIntegration, slackAlertLog]
  writes: [slackIntegration, slackAlertLog]
  external_calls: [Slack API — POST chat.postMessage, retry backoff 5s→30s→120s]
  called_by: [healingService, monitoringService, executionGateService, eventQueue, notificationService]

billingService:
  imports: [prisma, observabilityService, notificationService, auditLogService, polarClient]
  reads: [organization, subscriptionEvent, lead, domain, mailbox]
  writes: [organization, subscriptionEvent]
  external_calls: []
  called_by: [billingController (Polar webhooks)]

bounceClassifier:
  imports: [types]
  reads: []
  writes: []
  external_calls: []
  called_by: [monitoringService, eventQueue, smartleadEventParserService]

campaignHealthService:
  imports: [prisma, auditLogService, notificationService, observabilityService]
  reads: [campaign (with mailbox _count)]
  writes: [campaign (status, pause_reason, warning_count, total_bounced, total_sent)]
  external_calls: []
  called_by: [monitoringService, smartleadEventParserService]

complianceService:
  imports: [prisma, auditLogService, observabilityService]
  reads: [rawEvent, stateTransition, lead, auditLog, organization]
  writes: [rawEvent (deleteMany), stateTransition (deleteMany), lead (soft delete/anonymize), mailbox (status→deleted)]
  external_calls: []
  called_by: [Scheduled retention job]

correlationService:
  imports: [prisma, types, logger]
  reads: [mailbox, rawEvent]
  writes: []
  external_calls: []
  called_by: [monitoringService, healingService]

eventQueue:
  imports: [bullmq, observabilityService, monitoringService, eventService, notificationService, prisma]
  reads: [rawEvent]
  writes: [rawEvent (processed status), lead (engagement counters), campaign (engagement), mailbox (engagement)]
  external_calls: []
  called_by: [ingestionController, smartleadWebhookController via enqueueEvent()]

eventService:
  imports: [prisma, types, observabilityService]
  reads: [rawEvent (idempotency check, replay queries)]
  writes: [rawEvent (create, update processed/error/retry)]
  external_calls: []
  called_by: [ingestionController, smartleadWebhookController, monitoringService, eventQueue, replayService]

executionGateService:
  imports: [prisma, auditLogService, healingService, notificationService, observabilityService, types]
  reads: [organization, campaign, mailbox, mailboxMetrics]
  writes: []
  external_calls: []
  called_by: [ingestionController, smartleadClient]

healingService:
  imports: [prisma, types, auditLogService, notificationService, platformRegistry, SlackAlertService, logger]
  reads: [mailbox, domain, campaign, recovery phases]
  writes: [mailbox (recovery_phase, resilience_score, cooldown_until), domain (recovery_phase)]
  external_calls: [adapter.pauseCampaign(), adapter.resumeCampaign() via platformRegistry]
  called_by: [executionGateService, monitoringService, smartleadEventParserService]

infrastructureAssessmentService:
  imports: [dns, prisma, auditLogService, notificationService, observabilityService]
  reads: [domain, mailbox, campaign, mailboxMetrics]
  writes: [domain (health fields), mailbox (cooldown), organization (assessment_completed)]
  external_calls: [DNS lookups — SPF/DKIM/DMARC/blacklist]
  called_by: [Scheduled assessment workers]

leadAssignmentService:
  imports: [prisma, observabilityService, auditLogService]
  reads: [campaign (with mailbox count), lead]
  writes: [lead (assigned_campaign_id, status→ACTIVE)]
  external_calls: []
  called_by: [ingestionController, smartleadClient]

leadHealthService:
  imports: [prisma, auditLogService, notificationService]
  reads: [lead]
  writes: [lead (health fields)]
  external_calls: []
  called_by: [ingestionController, smartleadEventParserService]

metricsService:
  imports: [prisma, types, observabilityService]
  reads: [mailboxMetrics, campaign]
  writes: [mailboxMetrics (window counters, rates)]
  external_calls: []
  called_by: [monitoringService, eventQueue]

monitoringService:
  imports: [prisma, auditLogService, eventService, bounceClassifier, healingService, correlationService, platformRegistry, executionGateService, notificationService, SlackAlertService, logger, types]
  reads: [mailbox, mailboxMetrics, domain, campaign, rawEvent]
  writes: [mailbox (status, bounce counts, cooldown), mailboxMetrics, domain (status), stateTransition, campaign (total_bounced), rawEvent]
  external_calls: [adapter.pauseMailbox(), adapter.resumeMailbox(), adapter.pauseDomain(), adapter.pauseCampaign()]
  called_by: [eventQueue, smartleadEventParserService]

notificationService:
  imports: [prisma]
  reads: [notification]
  writes: [notification (create, update is_read, deleteMany)]
  external_calls: []
  called_by: [billingService, campaignHealthService, executionGateService, healingService, SlackAlertService, monitoringService, smartleadClient]

routingService:
  imports: [prisma, types, auditLogService, observabilityService]
  reads: [routingRule, campaign]
  writes: []
  external_calls: []
  called_by: [ingestionController, leadService]

smartleadClient:
  imports: [axios, prisma, auditLogService, eventService, assessmentService, notificationService, types, observabilityService, circuitBreaker, rateLimiter, redis, leadScoringService, syncProgressService, polarClient, encryption]
  reads: [organizationSetting, lead, campaign, mailbox, domain, organization]
  writes: [lead, campaign, mailbox, domain, syncProgress]
  external_calls: [Smartlead API — campaigns, email-accounts, leads, engagement; rate limit 10 req/2s, circuit breaker]
  called_by: [smartleadSyncWorker, ingestionController]

smartleadEventParserService:
  imports: [monitoringService, campaignHealthService, warmupService, healingService, bounceClassifier, logger]
  reads: []
  writes: []
  external_calls: []
  called_by: [smartleadWebhookController]

stateTransitionService:
  imports: [prisma, types, auditLogService, notificationService, observabilityService]
  reads: [mailbox, domain, lead (state checks), stateTransition (history)]
  writes: [mailbox/domain/lead (status), stateTransition]
  external_calls: []
  called_by: [monitoringService, healingService]

warmupService:
  imports: [prisma, observabilityService, platformRegistry, notificationService, types]
  reads: [mailbox (external IDs)]
  writes: [mailbox (warmup_status, warmup_limit)]
  external_calls: [adapter.enableWarmup() via platformRegistry]
  called_by: [healingService, smartleadEventParserService]

syncProgressService:
  imports: [prisma]
  reads: [syncProgress]
  writes: [syncProgress (create, update)]
  external_calls: []
  called_by: [smartleadClient during syncs]
```

### Controllers

```
ingestionController:
  → routingService, leadHealthService, executionGateService, smartleadClient,
    leadAssignmentService, auditLogService, eventService

campaignController:
  → prisma, platformRegistry, loadBalancingService, predictiveMonitoringService, auditLogService

dashboardController:
  → prisma, loadBalancingService, campaignHealthService

leadController:
  → prisma, auditLogService

settingsController:
  → prisma, auditLogService, encryption

authController / googleAuthController:
  → prisma, googleOAuthService, billingService

billingController:
  → billingService, polarClient

smartleadWebhookController:
  → smartleadEventParserService, eventService, auditLogService

emailbisonWebhookController:
  → prisma, eventQueue, eventService

instantlyWebhookController:
  → prisma, eventService
```

### Critical Dependency Chains

```
1. Lead Ingestion → Execution:
   ingestionController → routingService → executionGateService → smartleadClient → [Smartlead API]

2. Event Processing → Monitoring → Healing:
   webhookController → smartleadEventParserService → monitoringService → bounceClassifier
     → correlationService → healingService → platformRegistry → [External API]

3. Sync & Assessment Loop:
   platformSyncWorker → smartleadClient → infrastructureAssessmentService → [Smartlead API + DNS]

4. Audit & Compliance:
   ALL ENTITIES → auditLogService → complianceService → [retention policies]

5. Notifications & Alerts:
   [Most services] → notificationService → SlackAlertService → [Slack API]
```

---

## 2. All State Writers Per Model

### Lead

| Location | Function | Operation | Fields Changed | Condition |
|----------|----------|-----------|----------------|-----------|
| ingestionController.ts:71 | ingestLead() | upsert | email, persona, lead_score, source, health_*, status | API ingestion |
| ingestionController.ts:212 | ingestLead() | update | status→ACTIVE | Smartlead push succeeds |
| ingestionController.ts:386 | ingestClayWebhook() | upsert | email, persona, lead_score, source, health_*, status | Clay webhook |
| ingestionController.ts:520 | ingestClayWebhook() | update | status→ACTIVE | Smartlead push succeeds |
| smartleadEventParserService.ts:263 | handleBounceEvent() | update | status→paused, health_state→unhealthy, health_classification→red | Bounce detected |
| smartleadEventParserService.ts:316 | handleSentEvent() | update | emails_sent +1, last_activity_at | Email sent |
| smartleadEventParserService.ts:397 | handleOpenEvent() | update | lead_score +5, emails_opened +1, last_activity_at | Email opened |
| smartleadEventParserService.ts:517 | handleClickEvent() | update | lead_score +10, emails_clicked +1, last_activity_at | Email clicked |
| smartleadEventParserService.ts:637 | handleReplyEvent() | update | lead_score +15, emails_replied +1, last_activity_at | Reply received |
| smartleadEventParserService.ts:744 | handleUnsubscribeEvent() | updateMany | health_classification→red, status→paused | Unsubscribe |
| leadHealthWorker.ts:206 | checkLeadHealth() | update | health_classification, health_score_calc, health_checks | Periodic re-eval |
| leadScoringService.ts:157 | scoreLeadEngagement() | update | lead_score | Engagement recalc |
| smartleadSyncWorker.ts:825 | syncSmartlead() | upsert | email, persona, assigned_campaign_id, engagement counters | Lead sync from CSV |
| complianceService.ts:196 | enforceLeadComplianceLimits() | updateMany | status→paused | Compliance policy |
| complianceService.ts:285 | deleteLeadDueToCompliance() | update | deleted_at | Soft delete |
| eventQueue.ts:209 | processEngagementMetrics() | updateMany | engagement counters bulk | Batch engagement |
| stateTransitionService.ts:373 | updateEntityState() | update | status | State machine |

**Writer count: 17 distinct write paths**

### Campaign

| Location | Function | Operation | Fields Changed | Condition |
|----------|----------|-----------|----------------|-----------|
| smartleadSyncWorker.ts:385 | syncSmartlead() | upsert | name, status, bounce_rate, total_sent, total_bounced, open/click/reply counts, rates | Smartlead sync |
| smartleadSyncWorker.ts:657 | syncSmartlead() | update | mailboxes.connect | Linking mailboxes |
| smartleadEventParserService.ts:244 | handleBounceEvent() | update | total_bounced +1, bounce_rate | Bounce detected |
| smartleadEventParserService.ts:329 | handleSentEvent() | updateMany | total_sent +1 | Email sent |
| smartleadEventParserService.ts:443 | handleOpenEvent() | update | open_count +1, open_rate | Email opened |
| smartleadEventParserService.ts:563 | handleClickEvent() | update | click_count +1, click_rate | Email clicked |
| smartleadEventParserService.ts:683 | handleReplyEvent() | update | reply_count +1, reply_rate | Reply received |
| smartleadEventParserService.ts:722 | handleUnsubscribeEvent() | updateMany | unsubscribed_count +1 | Unsubscribe |
| smartleadClient.ts:168 | pushLeadToCampaign() | update | status→inactive, paused_reason | Campaign 404 from Smartlead |
| campaignHealthService.ts | pauseCampaign/resume | update | status, paused_reason, paused_at, warning_count | Manual/auto pause |

**Writer count: 10 distinct write paths**

### Mailbox

| Location | Function | Operation | Fields Changed | Condition |
|----------|----------|-----------|----------------|-----------|
| smartleadSyncWorker.ts:572 | syncSmartlead() | upsert | email, smartlead_email_account_id, status, smtp/imap, warmup_*, domain_id | Mailbox sync |
| smartleadSyncWorker.ts:694 | syncSmartlead() | updateMany | engagement counters→0 | Reset before lead sync |
| smartleadEventParserService.ts:72 | handleBounceEvent() | update | hard_bounce_count +1, window_bounce_count +1 | Bounce |
| smartleadEventParserService.ts:155 | handleBounceEvent() | update | status→paused, recovery_phase→paused, cooldown, resilience -15 | 3% threshold |
| smartleadEventParserService.ts:342 | handleSentEvent() | updateMany | total_sent_count +1, window_sent_count +1 | Email sent |
| smartleadEventParserService.ts:478 | handleOpenEvent() | update | open_count_lifetime +1, engagement_rate | Open |
| smartleadEventParserService.ts:598 | handleClickEvent() | update | click_count_lifetime +1, engagement_rate | Click |
| smartleadEventParserService.ts:718 | handleReplyEvent() | update | reply_count_lifetime +1, engagement_rate | Reply |
| healingService.ts:291 | checkWarmToHealthy() | update | resilience_score, healing_origin→null, relapse_count→0 | Graduation |
| healingService.ts:379 | handleRelapse() | update | relapse_count, resilience_score, recovery_phase, cooldown, status | Relapse |
| healingService.ts:588 | recordCleanSend() | update | clean_sends_since_phase +1 | Clean send |
| stateTransitionService.ts:177 | setCooldown() | update | cooldown_until, last_pause_at, consecutive_pauses +1 | Entering pause |
| stateTransitionService.ts:207 | clearCooldown() | update | cooldown_until→null, consecutive_pauses→0 | Full recovery |

**Writer count: 13 distinct write paths**

### Domain

| Location | Function | Operation | Fields Changed | Condition |
|----------|----------|-----------|----------------|-----------|
| smartleadSyncWorker.ts:496 | syncSmartlead() | createMany | domain, status→healthy | New domains from mailboxes |
| healingService.ts:381 | handleRelapse() | update | relapse_count, resilience_score, recovery_phase, cooldown, status | Relapse |
| stateTransitionService.ts:186 | setCooldown() | update | cooldown_until, consecutive_pauses +1 | Entering pause |
| stateTransitionService.ts:215 | clearCooldown() | update | cooldown_until→null, consecutive_pauses→0 | Full recovery |
| infrastructureAssessmentService.ts | assessDomain() | update | spf_valid, dkim_valid, dmarc_valid, blacklist_results, health_score | DNS assessment |

**Writer count: 5 distinct write paths**

### Organization

| Location | Function | Operation | Fields Changed | Condition |
|----------|----------|-----------|----------------|-----------|
| polarClient.ts | handleSubscriptionEvent() | update | subscription_tier, subscription_status, billing dates | Subscription change |
| trialWorker.ts | checkTrialExpiration() | update | subscription_status, trial_ends_at | Trial expires |
| smartleadSyncWorker.ts:498 | syncSmartlead() | update | current_domain_count, current_mailbox_count | Capacity tracking |

**Writer count: 3 distinct write paths**

---

## 3. Critical Execution Path Traces

### Path 1: Lead Ingestion (API/Clay → Health Gate → Routing → Smartlead Push)

```
Step 1: [ingestionController.ts:ingestLead()]
  → Receive lead (email, persona, lead_score)
  → DB: Lead.upsert (idempotent by org_id + email)
  → DB: RawEvent.create (idempotency key)

Step 2: [leadHealthService.ts:classifyLeadHealth()]
  → Disposable domain check, catch-all detection, role email check, TLD analysis
  → Returns: { classification: green|yellow|red, score: 0-100, checks: JSON }
  → Pure computation (no writes)

Step 3: HEALTH GATE DECISION
  → IF red: Lead.update(status=BLOCKED), audit log, return early
  → IF already assigned: skip routing, return early
  → ELSE: proceed to routing

Step 4: [routingService.ts:resolveCampaignForLead()]
  → DB: RoutingRule.findFirst(persona match, min_score ≤ lead_score, priority order)
  → Returns: campaignId or null (read-only)

Step 5: [leadAssignmentService.ts:assignLeadToCampaignWithCapacityCheck()]
  → DB TRANSACTION: Lead.update(assigned_campaign_id, status→HELD)
  → Validates: campaign capacity not exceeded
  → Returns: { assigned, currentLoad, capacity, reason }

Step 6: [platformAdapter:pushLeadToCampaign()]
  → Smartlead: axios.post(/campaigns/{id}/leads) with field mapping (company→company_name)
  → Idempotency: skip if lead already active in campaign
  → On 404: Campaign.update(status=inactive) + notify user
  → On failure: return false (lead stays HELD for retry)

Step 7: Status Finalization
  → IF push success: Lead.update(status→ACTIVE)
  → ELSE: Lead remains HELD
  → Response: { success, leadId, assignedCampaignId, pushedToPlatform }
```

### Path 2: Bounce → Pause (Webhook → Threshold → Auto-Pause → Quarantine)

```
Step 1: [smartleadWebhookController.ts]
  → Receive: { email_account_id, campaign_id, lead_email, bounce_type, bounce_reason }

Step 2: [smartleadEventParserService.ts:handleBounceEvent()]
  → DB: BounceEvent.create (lead_id, mailbox_id, campaign_id, type, reason)
  → DB: Mailbox.update(hard_bounce_count +1, window_bounce_count +1)

Step 3: THRESHOLD CHECK (3% bounce rate)
  → Calculate: bounceRate = hard_bounce_count / total_sent_count
  → IF ≥ 3% AND status ≠ paused:
    → DB: Mailbox.update(status=paused, recovery_phase=paused, cooldown_until=now+48h,
           consecutive_pauses+1, resilience_score-15, healing_origin=bounce_threshold)
    → API: smartleadInfrastructureMutator.removeMailboxFromCampaigns()
    → DB: Notification.create (auto-pause alert)
    → DB: AuditLog.create(auto_paused_bounce_threshold)

Step 4: ZERO TOLERANCE during recovery
  → IF recovery_phase IN (restricted_send, warm_recovery):
    → healingService.transitionPhase(→paused) — REGRESSION
    → Cooldown doubled, resilience_score -25

Step 5: Campaign + Lead updates
  → DB: Campaign.update(total_bounced +1, bounce_rate recalculated)
  → DB: Lead.update(status=paused, health_state=unhealthy, health_classification=red)

Step 6: [metricsWorker — async graduation check]
  → IF cooldown_until < now: transition paused→quarantine
  → DB: Mailbox.update(recovery_phase=quarantine, clean_sends_since_phase=0)
  → DB: StateTransition.create(paused→quarantine)
```

### Path 3: Full Sync (Smartlead API → DB Update → Engagement Attribution)

```
Step 1: Acquire Redis lock: sync:smartlead:org:{id} (TTL 15min)

Step 2: CAMPAIGN SYNC
  → API: GET /campaigns — fetch all campaigns
  → API: GET /campaigns/{id}/analytics — per-campaign stats
  → DB: Campaign.upsert (batch 50) — name, status, bounce_rate, engagement counts/rates

Step 3: MAILBOX SYNC
  → API: GET /email-accounts — all mailboxes
  → Domain auto-creation: extract domain, check capacity
  → DB: Domain.createMany (new domains)
  → DB: Mailbox.upsert (batch 50) — email, status, smtp/imap, warmup fields
  → DB: Organization.update (domain_count, mailbox_count)

Step 4: CAMPAIGN-MAILBOX LINKING
  → API: GET /campaigns/{id}/email-accounts — per-campaign mailbox IDs
  → DB: Campaign.update(mailboxes.connect [ids])

Step 5: RESET ENGAGEMENT STATS
  → DB: Mailbox.updateMany (all engagement counters → 0)

Step 6: LEAD SYNC + ENGAGEMENT ATTRIBUTION
  → API: GET /campaigns/{id}/leads?offset=N&limit=100 (paginated)
  → DB: Lead.upsert per lead (engagement counters from CSV)
  → Hash-based attribution: hash(email + campaignId) % mailboxCount
  → DB: Mailbox.update (per-mailbox engagement from hash distribution)
  → DB: Mailbox.update (weighted total_sent from lead count distribution)

Step 7: BOUNCE BACKFILL (one-time per campaign)
  → API: GET /campaigns/{id}/statistics?email_status=bounced
  → DB: BounceEvent.create per bounce
  → DB: Mailbox.update(hard_bounce_count +1)

Step 8: Release Redis lock, emit completion, audit log
```

### Path 4: Recovery (Paused → 5-Phase Healing → Healthy)

```
PHASE 1: PAUSED (entry)
  → Trigger: bounce threshold OR manual pause
  → State: status=paused, recovery_phase=paused, cooldown_until=now+48h
  → Waits: cooldown period (48h base, doubled on relapse)

PHASE 2: QUARANTINE (cooldown expired)
  → Trigger: metricsWorker detects cooldown_until < now
  → State: recovery_phase=quarantine, clean_sends_since_phase=0
  → Waits: DNS verification (SPF + DKIM + no blacklist)

PHASE 3: RESTRICTED_SEND (DNS verified)
  → Trigger: SPF ✓, DKIM ✓, NOT blacklisted
  → State: recovery_phase=restricted_send, clean_sends_since_phase=0
  → Waits: N clean sends (adjusted by resilience_score + healing_origin)
  → Multipliers: resilience≤30 = 2.0x slower, 70+ = 0.75x faster, rehab = 1.2x

PHASE 4: WARM_RECOVERY (clean sends accumulated)
  → Trigger: clean_sends_since_phase ≥ threshold
  → State: recovery_phase=warm_recovery, warmup re-enabled
  → Waits: M clean sends + K days + bounce_rate ≤ 1%
  → ZERO TOLERANCE: any bounce during this phase → back to PAUSED (relapse)

PHASE 5: HEALTHY (graduation)
  → Trigger: all warm_recovery criteria met
  → State: recovery_phase=healthy, status=healthy
  → Actions: resilience_score +10, healing_origin=null, relapse_count=0
  → Mailbox resumes normal operation

RELAPSE PATH (any bounce during phase 3-4):
  → recovery_phase → paused
  → cooldown doubled (48h → 96h → 192h)
  → resilience_score -25
  → relapse_count +1
  → Restart from PHASE 1
```

---

## 4. Redundant Computation Detection

### 4.1 Duplicate Ingestion Logic (ingestLead vs ingestClayWebhook)

**File A:** `ingestionController.ts:47` — `classifyLeadHealth(email)` for API leads
**File B:** `ingestionController.ts:364` — `classifyLeadHealth(email)` for Clay leads

Both endpoints execute identical health classification, lead upsert, routing, assignment, and Smartlead push logic. The ONLY difference is `source: 'api'` vs `source: 'clay'`.

**Impact:** ~300 lines of duplicated code. Any bug fix must be applied twice.
**Fix:** Extract shared `processLead(email, persona, score, source, orgId)` function.

### 4.2 Redundant External ID Lookups (7+ occurrences)

**Files:** `campaignController.ts` lines 55, 326, 364, 410, 419, 619+

Each campaign operation queries `Campaign.findUnique({ select: { external_id: true } })` separately, even when the campaign was already loaded in the same request.

**Impact:** 5-10 extra DB queries per bulk campaign operation (e.g., pause all campaigns).
**Fix:** Include `external_id` in initial campaign fetch, or cache per-request.

### 4.3 Redundant Campaign Name Lookups for Notifications

**Files:** `campaignHealthService.ts` lines 157, 198, 238

Three functions (`pauseCampaign`, `resumeCampaign`, `warnCampaign`) each fetch `campaign.name` from DB just for the notification message.

**Impact:** 3 extra DB queries per campaign health action.
**Fix:** Accept `campaignName` as a parameter.

### 4.4 Quadruple Lead Count Queries

**File:** `leadHealthService.ts:284-288`

Four parallel `COUNT` queries for total, green, yellow, red leads when a single `groupBy(health_classification)` would suffice.

**Impact:** 4 DB round-trips instead of 1.
**Fix:** Use `prisma.lead.groupBy({ by: ['health_classification'], _count: true })`.

### 4.5 Overlapping Engagement Stat Updates

**Sync path:** `smartleadSyncWorker.ts` resets ALL mailbox engagement to 0, then recalculates from CSV.
**Webhook path:** `smartleadEventParserService.ts` increments engagement counters in real-time.

**Impact:** If a webhook arrives during sync, the increment is wiped by the reset. Post-sync, the counter is stale until the next webhook.
**Risk:** Engagement stats can temporarily regress during sync windows.

---

## 5. Implicit Coupling

### 5.1 Health Classification String Mismatch

- `leadHealthService.ts` uses lowercase: `'green' | 'yellow' | 'red'`
- `leadHealthWorker.ts:30-55` uses UPPERCASE: `'GREEN' | 'YELLOW' | 'RED'`
- Database stores lowercase

**Risk:** If `leadHealthWorker` writes uppercase values, queries checking for lowercase will miss them.

### 5.2 Status String Dependencies

Campaign statuses flow from Smartlead (uppercase: 'COMPLETED', 'DRAFTED') through sync (normalized to lowercase) and are checked by multiple services against hardcoded lowercase strings. No single enum enforces consistency.

**Affected files:** smartleadSyncWorker, infrastructureAssessmentService, campaignController, dashboardController

### 5.3 Implicit Lead State Contract

`ingestionController.ts` maps `health_classification === 'red'` → `LeadState.BLOCKED`, and anything else → `LeadState.HELD`. This mapping exists in raw code, not as an enforced function.

**Risk:** Adding a new classification (e.g., 'orange') requires finding every implicit mapping.

### 5.4 External ID Null Assumption

`campaignController.ts` fallback: `external_id || campaignId` — assumes our internal ID is valid as a Smartlead campaign ID when external_id is null. This will silently fail if Smartlead's ID format differs.

### 5.5 Shared Database State Without Interface

- `smartleadSyncWorker` writes `mailbox.open_count_lifetime`
- `smartleadEventParserService` reads+increments `mailbox.open_count_lifetime`
- No interface defines ownership. The sync worker resets counters that the parser increments.

---

## 6. Temporal Coupling

### 6.1 Race Condition: Concurrent Capacity Assignment (HIGH)

**Location:** `ingestionController.ts:142-177`

Two concurrent requests both call `resolveCampaignForLead()` and get the same campaign with 1 slot remaining. Both proceed to `assignLeadToCampaignWithCapacityCheck()`. The SERIALIZABLE isolation should prevent this, but routing and assignment happen in separate non-transactional calls.

**Failure scenario:** Campaign exceeds capacity limit.

### 6.2 Two-Phase Failure: Assignment → Push (MEDIUM)

**Location:** `ingestionController.ts:147-228`

If `assignLeadToCampaignWithCapacityCheck()` succeeds but `pushLeadToCampaign()` fails, the lead is assigned in our DB but never reaches Smartlead. Lead stays HELD but assignment is permanent.

**Fix:** Roll back `assigned_campaign_id` on push failure.

### 6.3 Sync Interruption: Partial State (MEDIUM)

**Location:** `smartleadSyncWorker.ts:230-1277`

If sync crashes after campaign sync but before mailbox linking, campaigns exist with 0 mailboxes. Next lead ingestion fails routing with "Campaign has ZERO mailboxes."

**Fix:** Implement sync checkpoints with resumption logic.

### 6.4 Engagement Counter Race: Sync Reset vs Webhooks (MEDIUM)

**Location:** `smartleadSyncWorker.ts` line 694 (reset) vs `smartleadEventParserService.ts` (increment)

During the sync window between engagement reset (counters→0) and recalculation from CSV, any incoming webhook increments will be lost when the CSV recalculation overwrites them.

**Fix:** Use atomic increment from CSV delta instead of reset-and-recalculate.

### 6.5 Concurrent Lead Upsert: Last-Write-Wins (MEDIUM)

**Location:** `ingestionController.ts:386-413`

Two concurrent Clay webhooks for the same email produce indeterminate state — persona, score, and classification may come from different requests.

**Fix:** Add optimistic locking with version field or timestamp comparison.

### 6.6 Routing with Stale Campaign State (LOW)

**Location:** `routingService.ts:47-54`

Between fetching a routing rule and validating the campaign exists, the campaign could be deleted or paused. Lead routing falls through to "no match."

### 6.7 Health Update → Audit Gap (LOW)

**Location:** `leadHealthService.ts:314-326`

Lead health update and audit log creation are separate operations. If notification service crashes between them, audit trail is incomplete.

| Issue | Severity | Type |
|-------|----------|------|
| Concurrent capacity assignment | HIGH | Race condition |
| Assignment → push two-phase failure | MEDIUM | Non-atomic |
| Sync interruption partial state | MEDIUM | No resumption |
| Engagement counter race during sync | MEDIUM | Counter loss |
| Concurrent upsert last-write-wins | MEDIUM | Indeterminate |
| Routing with stale campaign | LOW | Stale read |
| Health update → audit gap | LOW | Missing atomicity |

---

## 7. Simplified Architecture Proposal

### Current Pain Points

1. **17 writers for Lead, 13 for Mailbox** — impossible to reason about state
2. **300+ lines of duplicated ingestion logic** — double maintenance burden
3. **Engagement counters managed two ways** (sync resets + webhook increments) — race conditions
4. **No transaction boundaries** around multi-step operations
5. **Magic strings** for status values across 10+ files
6. **monitoringService imports 12 services** — god service

### Proposed Simplifications

#### A. Unify Lead Ingestion

```
CURRENT:  ingestLead() [300 lines] + ingestClayWebhook() [300 lines]
PROPOSED: processLead(source: 'api' | 'clay' | 'webhook', data: LeadInput)
```

Single function, single code path. Source is just a parameter.

#### B. Centralize Entity State Machine

```
CURRENT:  17 files write Lead.status independently
PROPOSED: leadStateMachine.transition(leadId, fromState, toState, reason)
```

All status changes go through a single function that:
- Validates the transition is legal
- Writes the update
- Creates the StateTransition record
- Fires the audit log
- Sends notifications

Same pattern for Mailbox (13 writers → 1 function) and Domain (5 writers → 1 function).

#### C. Event-Sourced Engagement

```
CURRENT:  Sync resets counters to 0, then recalculates from CSV
          Webhooks increment counters in real-time
          → Race conditions during sync

PROPOSED: Store engagement events as immutable facts
          Counters are materialized views (computed on read or by scheduled job)
          Sync imports events, doesn't overwrite counters
          → No race conditions, full audit trail
```

#### D. Extract Adapter Resolution

```
CURRENT:  7+ places query external_id then call adapter
PROPOSED: adapterService.execute(campaignId, 'pause')
          → Internally resolves external_id, gets adapter, executes
```

#### E. Type-Safe Status Enums

```
CURRENT:  Hardcoded strings: 'active', 'paused', 'healthy', 'completed', etc.
PROPOSED: enum CampaignStatus { ACTIVE, PAUSED, COMPLETED, DRAFTED, STOPPED, INACTIVE }
          enum MailboxStatus { HEALTHY, PAUSED, QUARANTINE, RESTRICTED, WARMING, DELETED }
          enum LeadStatus { HELD, ACTIVE, BLOCKED, PAUSED }
```

All comparisons use enum values. Sync normalizes on ingest. Zero string mismatch risk.

#### F. Split monitoringService

```
CURRENT:  monitoringService imports 12 services (god service)
PROPOSED:
  bounceHandler      → handles bounce events, threshold checks
  engagementTracker  → handles open/click/reply/unsubscribe events
  healthEvaluator    → evaluates mailbox/domain health, triggers pauses
  metricsAggregator  → manages window counters and rates
```

Each service has 2-3 dependencies instead of 12.

#### G. Atomic Ingestion Pipeline

```
CURRENT:  5 separate async steps with no transaction wrapper
PROPOSED:
  await prisma.$transaction(async (tx) => {
    const health = classifyHealth(email);
    const lead = tx.lead.upsert(...);
    if (health.red) return { blocked: true };
    const campaign = routingService.resolve(lead, tx);
    const assigned = leadAssignment.assign(lead, campaign, tx);
    // Push happens OUTSIDE transaction (external API)
  });
  const pushed = await adapter.push(lead, campaign);
  if (!pushed) await rollbackAssignment(lead.id);
```

Transaction covers all DB writes. External API call happens after. Rollback on failure.

### Impact Summary

| Change | Effort | Risk Reduction | Lines Saved |
|--------|--------|---------------|-------------|
| Unify ingestion | Low | Medium (eliminate duplicate bugs) | ~300 |
| Centralize state machine | Medium | High (17 writers → 1) | ~200 |
| Event-sourced engagement | High | High (eliminate sync races) | ~100 |
| Extract adapter resolution | Low | Low (DRY improvement) | ~80 |
| Type-safe enums | Low | Medium (eliminate string bugs) | ~50 |
| Split monitoringService | Medium | Medium (reduce coupling) | 0 (restructure) |
| Atomic ingestion | Medium | High (eliminate orphaned leads) | ~30 |

**Recommended order:** Enums → Unify ingestion → Centralize state machine → Atomic ingestion → Split monitoring → Adapter extraction → Event sourcing
