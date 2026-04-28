/**
 * Superkabe Type Definitions
 * 
 * Central location for all enums, types, and interfaces used across the application.
 * These provide type safety and explicit state definitions as required by the
 * Infrastructure Architecture Audit.
 */

// ============================================================================
// SYSTEM MODES (Section 10 of Audit)
// ============================================================================

/**
 * System mode controls how Superkabe responds to detected risks.
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
 *
 * minDays values are anchored in industry recovery-timeline guidance:
 *   - Spamhaus: 2-4 weeks of low-volume sending after a reputation incident
 *   - Microsoft sender-reputation recovery: minor 2-4 weeks, moderate 4-8 weeks
 *   - Practitioner consensus (Mailreach, Lemwarm, AWS SES): graduated ramp, not same-day
 * The 3d/7d RESTRICTED_SEND floor and 7d/14d WARM_RECOVERY floor sit at the
 * conservative end of that range — enough to surface delayed bounce signals
 * without dragging recovery out unnecessarily.
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
        firstOffenseMinDays: 3,              // Time floor — prevents same-day burst graduation
        repeatMinDays: 7,                    // Repeat offenders held longer at low volume
    },
    warm_to_healthy: {
        minSends: 50,                        // 50 sends minimum
        firstOffenseMinDays: 7,              // Sustained recovery window — Microsoft reputation lag
        repeatMinDays: 14,                   // Repeat offenders held longer
        maxBounceRate: 0.02,                 // Below 2% bounce rate (industry standard)
        maxComplaintRate: 0.001,             // Below 0.1% spam-complaint rate (Gmail/Yahoo target)
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
    RECOVERY = 'recovery', // Caused during Superkabe operation
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
    SUPER_ADMIN = 'super_admin',
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
    scopes?: string[];
}

// ============================================================================
// EMAIL VALIDATION (Hybrid Validation Layer)
// ============================================================================

export const ValidationStatus = {
    PENDING: 'pending',
    VALID: 'valid',
    RISKY: 'risky',
    INVALID: 'invalid',
    UNKNOWN: 'unknown',
} as const;
export type ValidationStatusType = typeof ValidationStatus[keyof typeof ValidationStatus];

export const ValidationSource = {
    INTERNAL: 'internal',
    MILLION_VERIFIER: 'millionverifier',
} as const;
export type ValidationSourceType = typeof ValidationSource[keyof typeof ValidationSource];

export interface ValidationResult {
    status: ValidationStatusType;
    score: number;
    source: ValidationSourceType;
    is_catch_all: boolean;
    is_disposable: boolean;
    details: {
        syntax_ok: boolean;
        mx_found: boolean;
        disposable_check: boolean;
        catch_all_check: boolean;
        api_response?: any;
    };
    /** Attempt data to be persisted after lead upsert (since lead may not exist at validation time) */
    attempt?: {
        source: ValidationSourceType;
        result_status: ValidationStatusType;
        result_score: number;
        result_details: any;
        duration_ms: number;
    };
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

    // PAUSE threshold: Hard stop (absolute bounce count — safety net)
    MAILBOX_PAUSE_BOUNCES: 5,         // 5 bounces → PAUSE
    MAILBOX_PAUSE_WINDOW: 100,        // within 100 sends (5% rate)

    // PAUSE threshold: Percentage-based (primary — fires once total_sent_count ≥ MIN_SENDS)
    MAILBOX_PAUSE_BOUNCE_RATE: 0.03,        // 3% bounce rate → PAUSE
    MAILBOX_PAUSE_BOUNCE_RATE_MIN_SENDS: 60, // Only applies once mailbox has sent this many
    MAILBOX_WARNING_BOUNCE_RATE: 0.02,      // 2% bounce rate → WARNING (used in infrastructure assessment)

    // Rotation: campaigns above this bounce rate are considered toxic — skip rotating into them
    ROTATION_MAX_CAMPAIGN_BOUNCE_RATE: 0.05, // 5%

    // =========================================================================
    // Domain-level thresholds (Ratio-based for scale)
    // =========================================================================
    DOMAIN_WARNING_RATIO: 0.3,        // 30% unhealthy → warning
    DOMAIN_PAUSE_RATIO: 0.5,          // 50% unhealthy → pause
    DOMAIN_MINIMUM_MAILBOXES: 3,      // Below this, use absolute (2 unhealthy = pause)

    // =========================================================================
    // Campaign-level thresholds (Infrastructure-driven)
    // =========================================================================
    // Campaigns NEVER pause on bounce rate. They WARN when this fraction of their
    // mailboxes are in a degraded state (paused/warning/recovering).
    CAMPAIGN_DEGRADATION_RATIO: 0.5,  // 50% degraded mailboxes → campaign warning

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
    RISK_SCORE_MEDIUM: 25,            // Enter medium risk band
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
    ROLLING_WINDOW_SIZE: 100,         // Last 100 sends for bounce rate

    // =========================================================================
    // Spam-complaint thresholds (Gmail/Yahoo Feb 2024 bulk sender enforcement)
    // =========================================================================
    // Source: Google's published bulk-sender guidelines and Yahoo Sender Hub.
    // - >0.10% has measurable negative impact on inbox placement
    // - >0.30% triggers "ineligible for mitigation" status at Gmail
    // We treat 0.30% as a relapse trigger and 0.10% as the healthy ceiling.
    COMPLAINT_RATE_HEALTHY_THRESHOLD: 0.001,   // 0.1% — required for HEALTHY graduation
    COMPLAINT_RATE_RELAPSE_THRESHOLD: 0.003,   // 0.3% — triggers relapse during recovery
    COMPLAINT_RATE_MIN_SENDS: 1000,            // Minimum sample size before complaint-rate gate applies

    // =========================================================================
    // Soft-bounce spike detection (Microsoft RP-001/002/003 throttling signal)
    // =========================================================================
    // Soft bounces from PROVIDER_THROTTLE classification are reputation signals
    // at Microsoft (documented). A spike (>10% over 50 sends) escalates the
    // mailbox to WARNING — not full pause, since soft bounces self-resolve.
    SOFT_BOUNCE_SPIKE_RATE: 0.10,
    SOFT_BOUNCE_SPIKE_WINDOW: 50,

    // =========================================================================
    // consecutive_pauses decay (no industry standard — defensible practitioner choice)
    // =========================================================================
    // After 30 days of clean HEALTHY operation, decrement consecutive_pauses
    // by 1. Mirrors the inactivity-decay pattern from warmup vendor consensus
    // (Apollo/Smartlead: 60+ days inactive = restart warmup).
    CONSECUTIVE_PAUSES_DECAY_DAYS: 30,

    // =========================================================================
    // DNS check fail-closed (extrapolated from RFC 5321 deferral semantics)
    // =========================================================================
    // When live DNS check fails during graduation, defer for 1 hour and retry.
    // After 5 consecutive failures (~5h), escalate domain to manual intervention.
    DNS_CHECK_FAILURE_DEFER_MS: 3600000,       // 1 hour
    DNS_CHECK_FAILURE_ESCALATE_COUNT: 5,

    // =========================================================================
    // YELLOW lead differential treatment (M3AAWG Senders BCP v3 §4.2)
    // =========================================================================
    // Risky leads (catch-all, role, new-domain, suspicious-TLD) score 50–79.
    // Industry guidance: segment risky addresses to a separate stream capped at
    // 10–20% of volume. We use 25% (slightly conservative) and limit to first 2
    // sequence steps so we don't burn reputation on unproven addresses.
    YELLOW_LEAD_CAMPAIGN_VOLUME_CAP: 0.25,      // 25% of campaign daily volume
    YELLOW_LEAD_MAX_STEP: 2,                    // Stop YELLOW leads after step 2

    // =========================================================================
    // DomainInsight cache TTL (RFC 2182 + Office 365 MX TTL guidance)
    // =========================================================================
    // MX records are typically cached 1–4h; max 6h for Office 365 hosts.
    // Application-layer cache should not materially exceed DNS cache windows.
    // Reduced from 7 days to 24 hours to catch domains that go dark or change
    // catch-all status without waiting for a hard bounce.
    DOMAIN_INSIGHT_TTL_HOURS: 24,

    // =========================================================================
    // Recipient-domain complaint rate gate (Google/Yahoo Feb 2024 thresholds)
    // =========================================================================
    // Computed locally from BounceEvent + SendEvent (we don't get per-recipient-
    // domain reputation from Postmaster Tools — only per sending domain).
    // Mirrors the same 0.10% / 0.30% framework Google uses, applied to recipient
    // domains we send TO. Prevents enrolling more leads from a domain we already
    // generate complaints to.
    RECIPIENT_DOMAIN_COMPLAINT_THRESHOLD: 0.003,    // 0.3% — block enrollment
    RECIPIENT_DOMAIN_THROTTLE_THRESHOLD: 0.001,     // 0.1% — throttle to 30%
    RECIPIENT_DOMAIN_THROTTLE_FACTOR: 0.30,         // Volume cap when throttled
    RECIPIENT_DOMAIN_MIN_SENDS: 1000,               // Min sample size before gate applies
    RECIPIENT_DOMAIN_WINDOW_DAYS: 30,               // Rolling window for rate calc

    // =========================================================================
    // Soft-risk down-ranking (no direct industry standard; defensible practice)
    // =========================================================================
    // Soft score covers velocity + escalation history. Used to be log-only.
    // Now down-ranks the mailbox in selection scoring so healthier mailboxes
    // are preferred. At ≥85, defer the lead 1h instead of selecting.
    SOFT_RISK_DOWNRANK_PENALTY: 30,                  // Subtract from mailbox score
    SOFT_RISK_DEFER_THRESHOLD: 85,                   // Defer lead 1h above this
    SOFT_RISK_DEFER_MS: 3600000,                     // 1 hour

    // =========================================================================
    // Health re-evaluation downgrade thresholds (M3AAWG BCP §3.4)
    // =========================================================================
    // Bi-directional list hygiene. Downgrade only when score drops materially
    // (≥20 points) AND the lead is not currently in an active sequence step,
    // to avoid disrupting in-flight campaigns.
    HEALTH_DOWNGRADE_MIN_DROP: 20,
    HEALTH_FULL_REVERIFY_DAYS: 90                    // Full bi-directional re-eval window
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
        held: ['active', 'paused', 'blocked'],
        active: ['paused', 'completed', 'blocked'],
        paused: ['active', 'completed', 'blocked'],
        blocked: [],  // Terminal state — health gate rejection
        completed: []  // Terminal state
    }
} as const;
