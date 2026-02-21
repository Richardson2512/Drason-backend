# Enforce Mode Implementation

## Overview
The Drason monitoring system now properly respects the **System Mode** setting (OBSERVE, SUGGEST, ENFORCE) when making automatic health decisions.

## System Modes

### 1. OBSERVE Mode
- **Behavior**: Passive monitoring only
- **Actions**: All health violations are logged but NO automatic state changes occur
- **Use Case**: Initial deployment, testing, or when you want to observe system behavior without intervention
- **What happens**:
  - Bounces are tracked and logged
  - Threshold violations logged as "would_pause_observe" or "would_warn_observe"
  - NO mailboxes/campaigns/domains are paused
  - NO state transitions occur

### 2. SUGGEST Mode
- **Behavior**: Active monitoring with recommendations
- **Actions**: Health violations trigger notifications but NO automatic enforcement
- **Use Case**: When you want to be alerted to issues but retain manual control
- **What happens**:
  - Bounces are tracked and logged
  - Threshold violations trigger ERROR/WARNING notifications
  - User receives actionable recommendations
  - NO automatic pausing (user must take manual action)

### 3. ENFORCE Mode ✅
- **Behavior**: Fully automated health enforcement
- **Actions**: Health violations trigger AUTOMATIC pausing and recovery
- **Use Case**: Production environment with full automation
- **What happens**:
  - Bounces are tracked and logged
  - Threshold violations AUTOMATICALLY pause entities
  - Healing process starts AUTOMATICALLY
  - Entities recover and restart AUTOMATICALLY
  - Full protection against deliverability damage

## Automatic Workflows (ENFORCE Mode Only)

### 1. Automatic Pausing
When bounce thresholds are exceeded:
- **Mailboxes**: Auto-paused at 5 bounces (monitoringService.ts:325)
- **Domains**: Auto-paused when 50%+ mailboxes unhealthy (monitoringService.ts:512)
- **Campaigns**: Auto-paused via correlation logic (monitoringService.ts:751)

### 2. Automatic Healing
Entities progress through recovery phases automatically:
- **PAUSED** → Cooldown period
- **QUARANTINE** → DNS/blacklist verification (no sending)
- **RESTRICTED_SEND** → Limited sends (5-10/day)
- **WARM_RECOVERY** → Increased sends (25-50/day)
- **HEALTHY** → Full recovery, normal operations

Graduation checks run every 24 hours via warmupTrackingWorker.

### 3. Automatic Restart
When mailboxes recover to HEALTHY:
- Mailboxes automatically re-added to Smartlead campaigns (healingService.ts:804-838)
- Campaigns paused for health automatically restart (healingService.ts:1022-1112)
- Full production operations resume without manual intervention

### 4. Manual Operations
**Lead rerouting remains manual** when all mailboxes in a campaign are paused. This requires user decision on routing strategy.

## Implementation Details

### Modified Files
- `backend/src/services/monitoringService.ts`
  - Added SystemMode imports
  - Added mode checks to: `warnMailbox()`, `pauseMailbox()`, `pauseDomain()`, `pauseCampaign()`
  - Added mode checks to domain health aggregation logic

### Code Pattern
Every pause/warn function now follows this pattern:

```typescript
// 1. Check system mode
const systemMode = await executionGateService.getSystemMode(orgId);

// 2. OBSERVE mode - log only
if (systemMode === SystemMode.OBSERVE) {
    await auditLogService.logAction({
        action: 'would_pause_observe',
        details: `OBSERVE: Would pause - ${reason} (not enforcing)`
    });
    return;
}

// 3. SUGGEST mode - notify only
if (systemMode === SystemMode.SUGGEST) {
    await notificationService.createNotification({
        type: 'ERROR',
        title: 'Pause Recommended',
        message: `Entity should be paused: ${reason}`
    });
    return;
}

// 4. ENFORCE mode - actually pause
await actuallyPauseEntity();
```

## Configuration

To change system mode, update the organization's `system_mode` field:

```sql
UPDATE organizations
SET system_mode = 'ENFORCE'  -- or 'OBSERVE' or 'SUGGEST'
WHERE id = '<org_id>';
```

Or via the frontend settings page.

## Audit Trail

All mode-aware decisions are logged with mode prefix:
- `[OBSERVE]` - Would have taken action but in observe mode
- `[SUGGEST]` - Recommended action but in suggest mode
- `[ENFORCE]` - Actually took action

Example:
```
[MONITOR] [ENFORCE] Pausing mailbox abc123: Exceeded 5 bounces
[MONITOR] [SUGGEST] Pause recommended for domain example.com: 50% mailboxes unhealthy
[MONITOR] [OBSERVE] Would pause campaign xyz789: No healthy mailboxes available
```

## Migration Impact
- **No breaking changes**: Existing behavior is preserved in ENFORCE mode
- **Default mode**: Organizations should explicitly set their preferred mode
- **Recommended**: Start in OBSERVE mode, move to SUGGEST, then ENFORCE after verification

## Testing Recommendations
1. Set to OBSERVE mode and trigger bounce thresholds - verify no pausing occurs
2. Set to SUGGEST mode and trigger thresholds - verify notifications appear
3. Set to ENFORCE mode and trigger thresholds - verify automatic pausing works

## Related Documentation
- See `/backend/docs/ROUTING_TO_SMARTLEAD_IMPLEMENTATION.md` for lead routing details
- See Prisma schema for full state machine definitions
