# API Audit Findings & Recommendations

**Generated:** 2026-02-18
**Purpose:** Document API inconsistencies, unused endpoints, and standardization opportunities

---

## 1. Response Format Inconsistencies

### Current State
Different endpoints return responses in different formats:

**Format A:** Direct data array
```json
GET /api/settings
// Returns: [{ key: "KEY", value: "value" }]
```

**Format B:** Nested in `data` property
```json
GET /api/dashboard/leads
// Returns: { data: [...], meta: { total, page, limit } }
```

**Format C:** Success wrapper
```json
POST /api/sync
// Returns: { success: true, campaigns_synced: 5, mailboxes_synced: 3 }
```

### Recommendation
**Standardize all endpoints to use success wrapper:**
```json
{
  "success": true,
  "data": [...],  // or single object
  "meta": {       // optional, for paginated responses
    "total": 100,
    "page": 1,
    "limit": 20,
    "totalPages": 5
  },
  "error": null   // only present when success=false
}
```

### Files to Update
- `backend/src/controllers/dashboardController.ts` - leads, campaigns, stats, domains, mailboxes
- `backend/src/controllers/analyticsController.ts` - all endpoints
- `backend/src/controllers/findingsController.ts`
- `backend/src/routes/settings.ts`
- `backend/src/routes/assessment.ts`

---

## 2. Query Parameter Naming Inconsistency

### Current State
Mix of snake_case and camelCase in query parameters:

**Snake_case (inconsistent with JS convention):**
- `mailbox_id`
- `campaign_id`
- `entity_type`
- `entity_id`
- `bounce_type`
- `start_date`
- `end_date`
- `finding_id`

**CamelCase (JavaScript convention):**
- Some newer endpoints use camelCase

### Recommendation
**Standardize to camelCase** (JavaScript/TypeScript convention):
- `mailbox_id` → `mailboxId`
- `campaign_id` → `campaignId`
- `entity_type` → `entityType`
- `entity_id` → `entityId`
- `bounce_type` → `bounceType`
- `start_date` → `startDate`
- `end_date` → `endDate`
- `finding_id` → `findingId`

### Files to Update
**Backend:**
- `backend/src/controllers/analyticsController.ts` (lines 15-20, 50-55, 85-90, 120-125)
- `backend/src/controllers/findingsController.ts` (lines 12-15, 45-48)
- `backend/src/middleware/validation.ts` - Update schemas

**Frontend:**
- `frontend/src/components/dashboard/FindingsCard.tsx` (line 67)
- `frontend/src/app/dashboard/analytics/page.tsx` (multiple locations)
- Any other components making API calls with these parameters

---

## 3. Unused Endpoints (For Review)

### Potentially Unused - No Frontend References Found

**1. POST /api/ingest**
- **Location:** `backend/src/controllers/ingestionController.ts`
- **Purpose:** Generic event ingestion endpoint
- **Status:** Only used by external integrations (not frontend)
- **Recommendation:** Keep if used by external systems, document usage

**2. POST /api/ingest/clay**
- **Location:** `backend/src/routes/sync.ts`
- **Purpose:** Clay webhook endpoint
- **Status:** Only called by Clay webhook (not frontend)
- **Recommendation:** Keep, verify Clay integration is active

**3. POST /api/monitor/event**
- **Location:** `backend/src/controllers/monitoringController.ts`
- **Purpose:** Manual event posting
- **Status:** No frontend calls found
- **Recommendation:** Review if still needed, possibly remove

**4. GET /api/dashboard/campaign-health-stats**
- **Location:** `backend/src/controllers/dashboardController.ts` (line 245)
- **Purpose:** Campaign health statistics
- **Status:** No frontend usage found
- **Recommendation:** Check if replaced by infrastructure page, consider deprecation

**5. POST /api/leads/scoring/sync**
- **Location:** `backend/src/controllers/leadScoringController.ts`
- **Purpose:** Manual lead scoring sync trigger
- **Status:** No frontend calls, worker handles this
- **Recommendation:** Keep for admin/debug, or remove if worker is sufficient

**6. GET /api/leads/:leadId/score-breakdown**
- **Location:** `backend/src/controllers/leadScoringController.ts`
- **Purpose:** Detailed score breakdown for single lead
- **Status:** No frontend usage
- **Recommendation:** Implement in UI or remove

**7. POST /api/billing/refresh-usage**
- **Location:** `backend/src/controllers/billingController.ts`
- **Purpose:** Manual billing sync
- **Status:** No frontend calls
- **Recommendation:** Keep for admin/debug, document usage

---

## 4. Duplicate Endpoint Definitions

### Issue 1: Smartlead Webhook Defined Twice
**Locations:**
- `backend/src/routes/smartleadWebhook.ts` (dedicated route file)
- `backend/src/index.ts` line 197 (direct definition)

**Recommendation:** Keep only the route file version, remove from index.ts

### Issue 2: Multiple Health Check Endpoints
**Locations:**
- `GET /health` (public, comprehensive)
- `GET /api/health` (behind auth?)

**Current Status:** Both are documented
**Recommendation:** Keep both but clarify:
- `/health` - Public, for load balancers/monitoring
- `/api/health` - Authenticated, detailed internal status

---

## 5. Missing Endpoints Identified

### 1. Batch Lead Operations ✅ FIXED
- **Need:** Bulk pause/resume/delete leads
- **Status:** Partially fixed - campaigns can be batch paused
- **Recommendation:** Add bulk lead operations if needed

### 2. Mailbox Batch Operations
- **Need:** Bulk pause/resume mailboxes
- **Current:** Only single mailbox pause exists
- **Recommendation:** Add if UX requires bulk operations

### 3. Domain Health History
- **Need:** Historical domain reputation tracking
- **Current:** Only current status available
- **Recommendation:** Add time-series domain health tracking

---

## 6. TODO Comments Found in Code

### High Priority - Security Issue

**File:** `backend/src/middleware/orgContext.ts` line 190
```typescript
// TODO: Hash API keys in database (security best practice)
```
**Impact:** API keys stored in plain text
**Recommendation:** ⚠️ CRITICAL - Implement bcrypt hashing for API keys

### Medium Priority - Feature Completeness

**File:** `backend/src/services/leadScoringService.ts` line 214
```typescript
// TODO: Call Smartlead API to get engagement metrics
```
**Impact:** Lead scoring incomplete without engagement data
**Recommendation:** Implement Smartlead engagement API integration

**File:** `backend/src/services/leadScoringService.ts` line 258
```typescript
// TODO: Implement Event model for tracking lead interactions
```
**Impact:** Event tracking not fully implemented
**Recommendation:** Complete Event model or remove TODO

---

## 7. Console.log Statements (Production Code)

### Files with Console.log (Review for Removal)

**Backend:**
- `backend/src/services/observabilityService.ts` line 96
  ```typescript
  console.log(JSON.stringify(entry))
  ```
  **Recommendation:** Remove or replace with logger

**Frontend:**
- `frontend/src/app/dashboard/settings/page.tsx` lines 54, 62
  ```typescript
  console.log('[SETTINGS] Raw webhook response:', data);
  console.log('[SETTINGS] Webhook config fetched:', {...});
  ```
  **Recommendation:** Remove after debugging complete

- `frontend/src/app/dashboard/campaigns/page.tsx` lines 108-114
  ```typescript
  console.log('Diagnostic: No mailboxes linked to campaign', ...);
  ```
  **Recommendation:** Remove diagnostic logs

---

## 8. Dead Code Identified

### Files with No References

**File:** `backend/src/services/trajectoryService.ts`
- **Status:** No imports or calls found in codebase
- **Grep Results:** 0 matches outside the file itself
- **Recommendation:** Review with team, likely safe to remove
- **Action:** Mark as deprecated, remove in next major version

---

## Implementation Priority

### Phase 1: High Impact (Do First)
1. ⚠️ Fix API key hashing security issue
2. Standardize response formats (improves frontend consistency)
3. Document/remove unused endpoints (reduce maintenance)

### Phase 2: Medium Impact
4. Standardize query parameter naming (improves API consistency)
5. Remove console.log statements (production cleanliness)
6. Resolve duplicate endpoint definitions

### Phase 3: Low Impact (Nice to Have)
7. Remove dead code (trajectoryService.ts)
8. Complete TODO implementations (engagement tracking, Event model)
9. Add missing batch operation endpoints

---

## Testing Checklist

After implementing changes:

### Response Format Changes
- [ ] Test all dashboard page loads
- [ ] Verify analytics page filters work
- [ ] Check settings page functionality
- [ ] Test pagination on leads/campaigns/mailboxes

### Query Parameter Changes
- [ ] Test analytics filters with new param names
- [ ] Verify findings filtering works
- [ ] Check bounce event filtering
- [ ] Test all search/filter functionality

### Endpoint Removal
- [ ] Verify no broken frontend calls
- [ ] Check external integrations (Clay, Smartlead webhooks)
- [ ] Test worker jobs still function
- [ ] Verify admin/debug tools work

---

## Notes

- **User Request:** All removal decisions to be reviewed together before implementation
- **Approach:** Document findings first, implement changes after approval
- **Priority:** Focus on standardization and consistency improvements
