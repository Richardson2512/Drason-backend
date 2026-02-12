/**
 * Drason Type Definitions
 * 
 * Central location for all enums, types, and interfaces used across the application.
 * These provide type safety and explicit state definitions as required by the
 * Infrastructure Architecture Audit.
 */

// ============================================================================
// SYSTEM MODES (Section 10 of Audit)
// ============================================================================

/**
 * System mode controls how Drason responds to detected risks.
 * - OBSERVE: No automated actions, only logging
 * - SUGGEST: Generate recommendations, no auto-actions
 * - ENFORCE: Automated pausing and escalation
 */
export enum SystemMode {
    OBSERVE = 'observe',
    SUGGEST = 'suggest',
    ENFORCE = 'enforce'
}

// ============================================================================
// EVENT TYPES (Section 5 of Audit)
// ============================================================================

/**
 * All event types that can be stored in the raw event store.
 * Events are immutable and append-only.
 */
export enum EventType {
    // Lead lifecycle
    LEAD_INGESTED = 'LeadIngested',
    LEAD_ROUTED = 'LeadRouted',
    LEAD_ACTIVATED = 'LeadActivated',
    LEAD_PAUSED = 'LeadPaused',
    LEAD_COMPLETED = 'LeadCompleted',

    // Email execution events
    EMAIL_SENT = 'EmailSent',
    HARD_BOUNCE = 'HardBounce',
    SOFT_BOUNCE = 'SoftBounce',
    DELIVERY_FAILURE = 'DeliveryFailure',

    // Pause events
    MAILBOX_PAUSED = 'MailboxPaused',
    MAILBOX_RESUMED = 'MailboxResumed',
    DOMAIN_PAUSED = 'DomainPaused',
    DOMAIN_RESUMED = 'DomainResumed',
    CAMPAIGN_PAUSED = 'CampaignPaused',
    CAMPAIGN_RESUMED = 'CampaignResumed',

    // Manual actions
    MANUAL_OVERRIDE = 'ManualOverride',

    // Sync events
    SMARTLEAD_SYNC = 'SmartleadSync'
}

// ============================================================================
// BOUNCE FAILURE TAXONOMY (Section 4.1 of Implementation Plan)
// ============================================================================

/**
 * Cause-based bounce classification. Every bounce is classified by WHY
 * it failed, not just that it failed. Each type drives different diagnosis
 * and healing behaviors.
 */
export enum BounceFailureType {
    HARD_INVALID = 'hard_invalid',             // User unknown — permanent, immediate
    HARD_DOMAIN = 'hard_domain',               // Domain doesn't exist — permanent
    PROVIDER_SPAM_REJECTION = 'provider_spam_rejection', // Reputation damage — slow recovery
    PROVIDER_THROTTLE = 'provider_throttle',   // Rate limiting — self-resolving (hours)
    TEMPORARY_NETWORK = 'temporary_network',   // Network failure — self-resolving (minutes)
    AUTH_FAILURE = 'auth_failure',             // SPF/DKIM/DMARC config error — needs fix
    UNKNOWN = 'unknown'                        // Unclassifiable — treated as warning
}

/**
 * Severity and recovery metadata for each failure type.
 */
export const FAILURE_TYPE_CONFIG: Record<BounceFailureType, {
    severity: 'critical' | 'high' | 'medium' | 'low';
    recoveryExpectation: 'none' | 'slow' | 'self_resolving' | 'requires_fix';
    escalationSpeed: 'immediate' | 'fast' | 'slow' | 'none';
    degradesHealth: boolean;  // Whether this type should degrade entity health
}> = {
    [BounceFailureType.HARD_INVALID]: { severity: 'high', recoveryExpectation: 'none', escalationSpeed: 'immediate', degradesHealth: true },
    [BounceFailureType.HARD_DOMAIN]: { severity: 'high', recoveryExpectation: 'none', escalationSpeed: 'immediate', degradesHealth: true },
    [BounceFailureType.PROVIDER_SPAM_REJECTION]: { severity: 'critical', recoveryExpectation: 'slow', escalationSpeed: 'fast', degradesHealth: true },
    [BounceFailureType.PROVIDER_THROTTLE]: { severity: 'medium', recoveryExpectation: 'self_resolving', escalationSpeed: 'slow', degradesHealth: false },
    [BounceFailureType.TEMPORARY_NETWORK]: { severity: 'low', recoveryExpectation: 'self_resolving', escalationSpeed: 'none', degradesHealth: false },
    [BounceFailureType.AUTH_FAILURE]: { severity: 'critical', recoveryExpectation: 'requires_fix', escalationSpeed: 'fast', degradesHealth: true },
    [BounceFailureType.UNKNOWN]: { severity: 'medium', recoveryExpectation: 'slow', escalationSpeed: 'slow', degradesHealth: true },
};

// ============================================================================
// RECOVERY PHASES (Section 5.2 of Implementation Plan)
// ============================================================================

/**
 * 5-phase graduated recovery. No binary paused→healthy jumps.
 * paused → quarantine → restricted_send → warm_recovery → healthy
 */
export enum RecoveryPhase {
    HEALTHY = 'healthy',
    WARNING = 'warning',
    PAUSED = 'paused',
    QUARANTINE = 'quarantine',        // Cooldown expired, no sending
    RESTRICTED_SEND = 'restricted_send', // Very low volume, safest leads
    WARM_RECOVERY = 'warm_recovery',  // Controlled ramp-up
}

/**
 * Graduation criteria for each phase transition.
 */
export const GRADUATION_CRITERIA = {
    paused_to_quarantine: {
        firstOffenseCooldownMs: 86400000,    // 24 hours
        repeatCooldownMs: 259200000,         // 72 hours
        thirdPlusCooldownMs: 604800000,      // 7 days
    },
    quarantine_to_restricted: {
        requiresDnsPass: true,               // DNS/blacklist re-check must pass
        requiresRootCauseResolved: true,
    },
    restricted_to_warm: {
        firstOffenseCleanSends: 15,          // 15 clean sends with 0 hard bounces
        repeatCleanSends: 25,
    },
    warm_to_healthy: {
        minSends: 50,                        // 50 sends minimum
        minDays: 3,                          // Over at least 3 days
        maxBounceRate: 0.02,                 // Below 2% bounce rate
    },
    rehabMultipliers: {
        sendMultiplier: 2.0,                 // Rehab entities need 2× clean sends
        timeMultiplier: 1.5,                 // Rehab entities need 1.5× time
    }
} as const;

// ============================================================================
// TREND STATES (Section 4.2 of Implementation Plan)
// ============================================================================

/**
 * Behavioral trajectory classification.
 * Deterministic rules over rolling windows.
 */
export enum TrendState {
    STABLE = 'stable',           // Last 3 windows within ±1%
    DEGRADING = 'degrading',     // 2 consecutive worsening windows
    ACCELERATING = 'accelerating', // Degrading + rate of change increasing
    OSCILLATING = 'oscillating', // Alternating improve/decline across 4+ windows
    RECOVERING = 'recovering',   // 2 consecutive improving windows
}

// ============================================================================
// DATA QUALITY (Section 4.5 of Implementation Plan)
// ============================================================================

/**
 * Data quality tag for diagnosis findings.
 * Replaces confidence buckets — simpler, more actionable.
 */
export enum DataQuality {
    SUFFICIENT = 'sufficient_data',     // ≥50 sends, ≥2 windows
    LIMITED = 'limited_data',           // 20-49 sends or 1 window
    INSUFFICIENT = 'insufficient_data', // <20 sends, no state change allowed
}

// ============================================================================
// EMAIL PROVIDER (Section 4.2 of Implementation Plan)
// ============================================================================

/**
 * Receiving email provider classification.
 * Used for provider-specific bounce tracking and restrictions.
 */
export enum EmailProvider {
    GMAIL = 'gmail',
    MICROSOFT = 'microsoft',
    YAHOO = 'yahoo',
    OTHER = 'other',
}

/**
 * Healing origin — distinguishes inherited damage from operational damage.
 */
export enum HealingOrigin {
    REHAB = 'rehab',       // Inherited from brownfield onboarding
    RECOVERY = 'recovery', // Caused during Drason operation
}

// ============================================================================
// ENTITY STATES (Section 8 of Audit - State Machine Architecture)
// ============================================================================

/**
 * Mailbox states with explicit transition rules.
 * - HEALTHY: Normal operation
 * - WARNING: Elevated bounce rate, monitoring closely
 * - PAUSED: Execution stopped due to threshold breach
 * - RECOVERING: In cooldown period after pause, testing health
 */
export enum MailboxState {
    HEALTHY = 'healthy',
    WARNING = 'warning',
    PAUSED = 'paused',
    QUARANTINE = 'quarantine',
    RESTRICTED_SEND = 'restricted_send',
    WARM_RECOVERY = 'warm_recovery',
    RECOVERING = 'recovering'       // Legacy — kept for backward compat
}

/**
 * Domain states aggregate mailbox health.
 */
export enum DomainState {
    HEALTHY = 'healthy',
    WARNING = 'warning',
    PAUSED = 'paused',
    QUARANTINE = 'quarantine',
    RESTRICTED_SEND = 'restricted_send',
    WARM_RECOVERY = 'warm_recovery',
    RECOVERING = 'recovering'       // Legacy — kept for backward compat
}

/**
 * Lead states track lifecycle through the system.
 * - HELD: Awaiting execution gate clearance
 * - ACTIVE: Pushed to campaign, in execution
 * - PAUSED: Execution halted due to system health issues
 * - COMPLETED: Lead has finished execution (replied, converted, etc.)
 * - BLOCKED: Lead blocked by health gate (RED classification)
 */
export enum LeadState {
    HELD = 'held',
    ACTIVE = 'active',
    PAUSED = 'paused',
    COMPLETED = 'completed',
    BLOCKED = 'blocked'
}

/**
 * Campaign states from Smartlead.
 */
export enum CampaignState {
    ACTIVE = 'active',
    PAUSED = 'paused',
    COMPLETED = 'completed'
}

// ============================================================================
// USER ROLES (Section 14.4 of Audit - Access Control)
// ============================================================================

/**
 * Role-based access control levels.
 * - ADMIN: Full access, can modify settings and users
 * - OPERATOR: Can manage campaigns, leads, routing rules
 * - VIEWER: Read-only access to dashboards and logs
 */
export enum UserRole {
    ADMIN = 'admin',
    OPERATOR = 'operator',
    VIEWER = 'viewer'
}

// ============================================================================
// API KEY SCOPES (Section 14.1 of Audit)
// ============================================================================

/**
 * Granular permission scopes for API keys.
 */
export enum ApiScope {
    LEADS_READ = 'leads:read',
    LEADS_WRITE = 'leads:write',
    CAMPAIGNS_READ = 'campaigns:read',
    CAMPAIGNS_WRITE = 'campaigns:write',
    SETTINGS_READ = 'settings:read',
    SETTINGS_WRITE = 'settings:write',
    AUDIT_READ = 'audit:read',
    WEBHOOKS = 'webhooks'
}

// ============================================================================
// ENTITY TYPES
// ============================================================================

/**
 * Entity types for audit logging and event tracking.
 */
export enum EntityType {
    LEAD = 'lead',
    MAILBOX = 'mailbox',
    DOMAIN = 'domain',
    CAMPAIGN = 'campaign',
    ROUTING_RULE = 'routing_rule',
    ORGANIZATION = 'organization',
    USER = 'user'
}

// ============================================================================
// TRIGGER TYPES
// ============================================================================

/**
 * What triggered an action or state change.
 */
export enum TriggerType {
    SYSTEM = 'system',
    MANUAL = 'manual',
    WEBHOOK = 'webhook',
    SCHEDULED = 'scheduled',
    THRESHOLD_BREACH = 'threshold_breach',
    COOLDOWN_COMPLETE = 'cooldown_complete'
}

/**
 * Failure classification for execution gate.
 * Different failure types get different responses.
 */
export enum FailureType {
    HEALTH_ISSUE = 'health_issue',     // Block - bounce threshold breached
    INFRA_ISSUE = 'infra_issue',       // Retry - API timeout, network error
    SYNC_ISSUE = 'sync_issue',         // Defer - missing campaign/mailbox sync
    SOFT_WARNING = 'soft_warning'      // Allow with log - velocity warning
}

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Execution gate result with detailed reasoning.
 */
export interface GateResult {
    allowed: boolean;
    reason: string;
    riskScore: number;
    recommendations: string[];
    mode: SystemMode;
    checks: {
        campaignActive: boolean;
        domainHealthy: boolean;
        mailboxAvailable: boolean;
        belowCapacity: boolean;
        riskAcceptable: boolean;
    };
    // Failure classification (new)
    failureType?: FailureType;         // Type of failure for response logic
    retryable?: boolean;               // Can this be retried?
    deferrable?: boolean;              // Can this be deferred?
}

/**
 * Risk score calculation components.
 */
export interface RiskComponents {
    // Hard signals (bounce-based) - CAN trigger pause
    bounceRatio: number;         // 0-100, from bounce/sent ratio
    failureRatio: number;        // 0-100, from delivery failures
    hardScore: number;           // Combined bounce + failure (0-100)

    // Soft signals (behavior-based) - LOG only, don't pause
    velocity: number;            // 0-100, send rate acceleration
    escalationFactor: number;    // 0-100, from consecutive pauses
    softScore: number;           // Combined velocity + escalation (0-100)

    // Combined for display
    totalScore: number;          // 0-100, weighted combination
}

/**
 * Rolling window metrics for monitoring.
 */
export interface WindowMetrics {
    sent: number;
    bounces: number;
    failures: number;
    startTime: Date;
}

/**
 * State transition record.
 */
export interface StateTransition {
    entityType: EntityType;
    entityId: string;
    fromState: string;
    toState: string;
    reason: string;
    triggeredBy: TriggerType;
    timestamp: Date;
}

/**
 * Organization context for request scoping.
 */
export interface OrgContext {
    organizationId: string;
    userId?: string;
    role?: UserRole;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const MONITORING_THRESHOLDS = {
    // =========================================================================
    // Mailbox-level thresholds (Tiered: Warning → Pause)
    // =========================================================================

    // WARNING threshold: Early warning before damage
    MAILBOX_WARNING_BOUNCES: 3,       // 3 bounces → WARNING
    MAILBOX_WARNING_WINDOW: 60,       // within 60 sends (5% rate)

    // PAUSE threshold: Hard stop
    MAILBOX_PAUSE_BOUNCES: 5,         // 5 bounces → PAUSE
    MAILBOX_PAUSE_WINDOW: 100,        // within 100 sends (5% rate)

    // =========================================================================
    // Domain-level thresholds (Ratio-based for scale)
    // =========================================================================
    DOMAIN_WARNING_RATIO: 0.3,        // 30% unhealthy → warning
    DOMAIN_PAUSE_RATIO: 0.5,          // 50% unhealthy → pause
    DOMAIN_MINIMUM_MAILBOXES: 3,      // Below this, use absolute (2 unhealthy = pause)

    // =========================================================================
    // Risk score thresholds (Separated: Hard vs Soft signals)
    // =========================================================================
    // Hard signals (bounce/failure-based) - these BLOCK execution
    HARD_RISK_WARNING: 40,            // Enter warning state
    HARD_RISK_CRITICAL: 60,           // Trigger pause (lower since it's pure bounce)

    // Soft signals (velocity/history-based) - these LOG only
    SOFT_RISK_WARNING: 50,            // Log warning
    SOFT_RISK_HIGH: 75,               // Log high alert, don't block

    // Combined (for UI display)
    RISK_SCORE_WARNING: 50,           // Enter warning state
    RISK_SCORE_CRITICAL: 75,          // Display critical

    // =========================================================================
    // Cooldown periods (milliseconds)
    // =========================================================================
    COOLDOWN_MINIMUM_MS: 3600000,     // 1 hour minimum cooldown
    COOLDOWN_MULTIPLIER: 2,           // Exponential backoff multiplier
    COOLDOWN_MAX_MS: 57600000,        // 16 hours maximum

    // =========================================================================
    // Rolling windows (milliseconds) - for event-based queries
    // =========================================================================
    WINDOW_1H_MS: 3600000,
    WINDOW_24H_MS: 86400000,
    WINDOW_7D_MS: 604800000,

    // Rolling window for bounce calculations (event count, not time)
    ROLLING_WINDOW_SIZE: 100          // Last 100 sends for bounce rate
} as const;

/**
 * Valid state transitions for state machine validation.
 */
export const STATE_TRANSITIONS = {
    mailbox: {
        healthy: ['warning', 'paused'],
        warning: ['healthy', 'paused'],
        paused: ['quarantine', 'recovering'],                    // quarantine is the new primary path
        quarantine: ['restricted_send', 'paused'],               // can regress to paused on relapse
        restricted_send: ['warm_recovery', 'paused', 'quarantine'], // relapse → paused or quarantine
        warm_recovery: ['healthy', 'quarantine', 'paused'],      // relapse → quarantine
        recovering: ['healthy', 'warning', 'quarantine']         // legacy path, also can enter new phases
    },
    domain: {
        healthy: ['warning', 'paused'],
        warning: ['healthy', 'paused'],
        paused: ['quarantine', 'recovering'],
        quarantine: ['restricted_send', 'paused'],
        restricted_send: ['warm_recovery', 'paused', 'quarantine'],
        warm_recovery: ['healthy', 'quarantine', 'paused'],
        recovering: ['healthy', 'warning', 'quarantine']
    },
    lead: {
        held: ['active', 'paused'],
        active: ['paused', 'completed'],
        paused: ['active', 'completed'],
        completed: []  // Terminal state
    }
} as const;
