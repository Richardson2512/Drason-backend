# Mailbox Rotation Feature (Planned)

## Problem
When a mailbox is flagged and enters recovery (warmup), the campaign it was on loses a sender.
If all mailboxes on a campaign get flagged, the campaign pauses entirely.
There is no automatic replacement — the campaign just degrades.

## What Already Exists

### Recovery Pipeline (COMPLETE)
When a mailbox is flagged:
1. Healing service transitions: `paused` → `quarantine` → `restricted_send` → `warm_recovery` → `healthy`
2. `warmupService.enableWarmupForRecovery()` enables platform warmup at restricted_send phase (10/day)
3. `warmupService.updateWarmupForPhaseTransition()` ramps up at warm_recovery phase (50/day, +5/day)
4. `warmupService.checkGraduationCriteria()` monitors until clean sends threshold met
5. `warmupService.disableWarmup()` turns off warmup when healthy again
6. All 3 platforms (Smartlead, EmailBison, Instantly) support `updateWarmupSettings()` via adapter interface

### Campaign-Mailbox Management (COMPLETE)
- `adapter.removeMailboxFromCampaign()` — removes flagged mailbox from campaign on platform
- `adapter.addMailboxToCampaign()` — adds mailbox back to campaign on platform
- `smartleadInfrastructureMutator` — executes these for Smartlead specifically

### Load Balancing Analysis (READ-ONLY)
- `loadBalancingService.ts` suggests moves but never executes them

## What's Missing: Automatic Rotation

### Concept
When a mailbox is paused and removed from a campaign:
1. Identify a **standby mailbox** — healthy, not assigned to any active campaign (or under-utilized)
2. Prefer a standby mailbox from the **same domain** (maintains domain reputation consistency)
3. **Swap**: remove flagged mailbox from campaign, add standby mailbox in its place
4. Log the rotation for audit trail
5. When the original mailbox recovers → return it to standby pool (or re-assign)

### Implementation Steps

#### 1. Identify Standby Mailboxes
Query: healthy mailboxes with zero (or few) campaign associations.
```sql
-- Pseudo-query
SELECT m.* FROM mailboxes m
LEFT JOIN _CampaignToMailbox cm ON cm.B = m.id
WHERE m.status = 'healthy'
  AND m.organization_id = ?
GROUP BY m.id
HAVING COUNT(cm.A) = 0
```

#### 2. Rotation Trigger
Hook into `healingService.transitionPhase()` — when a mailbox transitions to `paused`:
- Call `removeMailboxFromCampaign()` (already happens)
- NEW: Call `rotationService.findAndSwapStandby(campaignId, flaggedMailboxId)`

#### 3. Rotation Service (New)
```typescript
// rotationService.ts
export async function findAndSwapStandby(
  organizationId: string,
  campaignId: string,
  flaggedMailboxId: string
): Promise<{ rotated: boolean; standbyMailboxId?: string }>
```

Logic:
- Find standby mailbox (same domain preferred, then any healthy standby)
- Check campaign health — don't assign to a toxic campaign
- Call `adapter.addMailboxToCampaign()` to add standby
- Update DB relationship
- Create notification: "Mailbox X rotated in to replace Y on Campaign Z"
- Log rotation event for audit

#### 4. Guard Rails
- Don't rotate a freshly-recovered mailbox into a campaign that caused the original flag
- Check the campaign's bounce rate before assigning — if campaign is unhealthy, skip rotation
- Respect domain-level mailbox limits (don't over-concentrate)
- Rate limit rotations (max 1 per campaign per hour)

#### 5. Return-to-Pool Logic
When the original mailbox recovers to `healthy`:
- Option A: Add it back to its original campaign (if still healthy)
- Option B: Return to standby pool for next rotation
- Decision should be configurable per organization

### Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/services/rotationService.ts` | NEW — rotation logic |
| `backend/src/services/healingService.ts` | MODIFY — call rotation on pause |
| `backend/src/services/campaignHealthService.ts` | MODIFY — consider rotation before pausing campaign |
| `prisma/schema.prisma` | OPTIONAL — add rotation history model |

### Priority
High — this is the missing link between healing (which already works) and campaign uptime.
