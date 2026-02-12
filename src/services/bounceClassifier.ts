/**
 * Bounce Classifier Service
 * 
 * Implements Section 4.1 (Failure Taxonomy) and Section 4.2 (Provider Fingerprinting)
 * of the Diagnosis & Healing Implementation Plan.
 * 
 * Every bounce is classified by:
 *   1. WHY it failed (BounceFailureType)
 *   2. WHO rejected it (EmailProvider)
 * 
 * This enables cause-specific and provider-specific diagnosis and healing.
 */

import { BounceFailureType, EmailProvider, FAILURE_TYPE_CONFIG } from '../types';

// ============================================================================
// SMTP RESPONSE CLASSIFICATION
// ============================================================================

/**
 * Classification result from analyzing a bounce event.
 */
export interface BounceClassification {
    failureType: BounceFailureType;
    provider: EmailProvider;
    severity: 'critical' | 'high' | 'medium' | 'low';
    degradesHealth: boolean;
    recoveryExpectation: string;
    rawReason: string;
}

/**
 * SMTP response pattern matchers.
 * Ordered by specificity — first match wins.
 * Patterns are derived from real SMTP responses from major providers.
 */
const SMTP_PATTERNS: Array<{
    pattern: RegExp;
    failureType: BounceFailureType;
}> = [
        // ── Hard Invalid (User Unknown) ──
        { pattern: /user unknown/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /no such user/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /mailbox not found/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /recipient rejected/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /address rejected/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /invalid recipient/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /user doesn.t exist/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /unknown user/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /550[- ]5\.1\.1/i, failureType: BounceFailureType.HARD_INVALID },
        { pattern: /550[- ]invalid/i, failureType: BounceFailureType.HARD_INVALID },

        // ── Hard Domain (Domain Doesn't Exist) ──
        { pattern: /domain not found/i, failureType: BounceFailureType.HARD_DOMAIN },
        { pattern: /no mx record/i, failureType: BounceFailureType.HARD_DOMAIN },
        { pattern: /host not found/i, failureType: BounceFailureType.HARD_DOMAIN },
        { pattern: /name or service not known/i, failureType: BounceFailureType.HARD_DOMAIN },
        { pattern: /550[- ]5\.1\.2/i, failureType: BounceFailureType.HARD_DOMAIN },

        // ── Provider Spam Rejection (Reputation) ──
        { pattern: /spam/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /blocked/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /blacklisted/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /rejected.*policy/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /550[- ]5\.7\.1/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /550[- ]5\.7\.26/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /message rejected/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /reputation/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /bulk mail/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /dnsbl/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /rbl/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },
        { pattern: /listed.*black/i, failureType: BounceFailureType.PROVIDER_SPAM_REJECTION },

        // ── Provider Throttle (Rate Limiting) ──
        { pattern: /too many/i, failureType: BounceFailureType.PROVIDER_THROTTLE },
        { pattern: /rate limit/i, failureType: BounceFailureType.PROVIDER_THROTTLE },
        { pattern: /try again later/i, failureType: BounceFailureType.PROVIDER_THROTTLE },
        { pattern: /throttl/i, failureType: BounceFailureType.PROVIDER_THROTTLE },
        { pattern: /452[- ]4\.2\.2/i, failureType: BounceFailureType.PROVIDER_THROTTLE },
        { pattern: /421[- ]/i, failureType: BounceFailureType.PROVIDER_THROTTLE },
        { pattern: /temporarily deferred/i, failureType: BounceFailureType.PROVIDER_THROTTLE },

        // ── Auth Failure (SPF/DKIM/DMARC) ──
        { pattern: /spf.*fail/i, failureType: BounceFailureType.AUTH_FAILURE },
        { pattern: /dkim.*fail/i, failureType: BounceFailureType.AUTH_FAILURE },
        { pattern: /dmarc.*fail/i, failureType: BounceFailureType.AUTH_FAILURE },
        { pattern: /authentication.*fail/i, failureType: BounceFailureType.AUTH_FAILURE },
        { pattern: /550[- ]5\.7\.23/i, failureType: BounceFailureType.AUTH_FAILURE },
        { pattern: /550[- ]5\.7\.25/i, failureType: BounceFailureType.AUTH_FAILURE },

        // ── Temporary Network ──
        { pattern: /connection timed out/i, failureType: BounceFailureType.TEMPORARY_NETWORK },
        { pattern: /connection refused/i, failureType: BounceFailureType.TEMPORARY_NETWORK },
        { pattern: /network.*unreachable/i, failureType: BounceFailureType.TEMPORARY_NETWORK },
        { pattern: /temporary.*error/i, failureType: BounceFailureType.TEMPORARY_NETWORK },
        { pattern: /service unavailable/i, failureType: BounceFailureType.TEMPORARY_NETWORK },
        { pattern: /45\d[- ]/i, failureType: BounceFailureType.TEMPORARY_NETWORK },
    ];

// ============================================================================
// PROVIDER FINGERPRINTING
// ============================================================================

/**
 * Known provider MX record patterns.
 * Used to determine which provider rejected the email.
 */
const PROVIDER_MX_PATTERNS: Array<{
    pattern: RegExp;
    provider: EmailProvider;
}> = [
        // Gmail / Google Workspace
        { pattern: /google\.com$/i, provider: EmailProvider.GMAIL },
        { pattern: /googlemail\.com$/i, provider: EmailProvider.GMAIL },
        { pattern: /smtp\.google\.com$/i, provider: EmailProvider.GMAIL },

        // Microsoft / Office365
        { pattern: /outlook\.com$/i, provider: EmailProvider.MICROSOFT },
        { pattern: /microsoft\.com$/i, provider: EmailProvider.MICROSOFT },
        { pattern: /hotmail\.com$/i, provider: EmailProvider.MICROSOFT },
        { pattern: /onmicrosoft\.com$/i, provider: EmailProvider.MICROSOFT },
        { pattern: /protection\.outlook\.com$/i, provider: EmailProvider.MICROSOFT },

        // Yahoo / AOL
        { pattern: /yahoodns\.net$/i, provider: EmailProvider.YAHOO },
        { pattern: /yahoo\.com$/i, provider: EmailProvider.YAHOO },
        { pattern: /aol\.com$/i, provider: EmailProvider.YAHOO },
    ];

/**
 * Known email domain → provider mappings for fast lookups.
 */
const DOMAIN_PROVIDER_MAP: Record<string, EmailProvider> = {
    'gmail.com': EmailProvider.GMAIL,
    'googlemail.com': EmailProvider.GMAIL,
    'outlook.com': EmailProvider.MICROSOFT,
    'hotmail.com': EmailProvider.MICROSOFT,
    'live.com': EmailProvider.MICROSOFT,
    'msn.com': EmailProvider.MICROSOFT,
    'yahoo.com': EmailProvider.YAHOO,
    'yahoo.co.uk': EmailProvider.YAHOO,
    'yahoo.co.in': EmailProvider.YAHOO,
    'aol.com': EmailProvider.YAHOO,
    'ymail.com': EmailProvider.YAHOO,
};

// ============================================================================
// CLASSIFICATION API
// ============================================================================

/**
 * Classify a bounce event by cause and provider.
 * 
 * @param smtpResponse - Raw SMTP response or bounce reason string
 * @param recipientEmail - Recipient email address (for provider detection)
 * @returns Full classification with failure type, provider, and metadata
 */
export function classifyBounce(
    smtpResponse: string,
    recipientEmail?: string
): BounceClassification {
    const failureType = classifyFailureType(smtpResponse);
    const provider = resolveProvider(recipientEmail, smtpResponse);
    const config = FAILURE_TYPE_CONFIG[failureType];

    return {
        failureType,
        provider,
        severity: config.severity,
        degradesHealth: config.degradesHealth,
        recoveryExpectation: config.recoveryExpectation,
        rawReason: smtpResponse,
    };
}

/**
 * Classify the failure type from an SMTP response string.
 * First match wins — patterns are ordered by specificity.
 */
export function classifyFailureType(smtpResponse: string): BounceFailureType {
    if (!smtpResponse || smtpResponse.trim().length === 0) {
        return BounceFailureType.UNKNOWN;
    }

    for (const { pattern, failureType } of SMTP_PATTERNS) {
        if (pattern.test(smtpResponse)) {
            return failureType;
        }
    }

    return BounceFailureType.UNKNOWN;
}

/**
 * Resolve the receiving email provider from recipient email or SMTP response.
 * Uses domain mapping first (fast), falls back to MX pattern matching.
 */
export function resolveProvider(
    recipientEmail?: string,
    smtpResponse?: string
): EmailProvider {
    // 1. Try direct domain mapping from recipient email
    if (recipientEmail) {
        const domain = recipientEmail.split('@')[1]?.toLowerCase();
        if (domain && DOMAIN_PROVIDER_MAP[domain]) {
            return DOMAIN_PROVIDER_MAP[domain];
        }
    }

    // 2. Try to infer from SMTP response (some providers include their name)
    if (smtpResponse) {
        const lower = smtpResponse.toLowerCase();
        if (lower.includes('google') || lower.includes('gmail')) return EmailProvider.GMAIL;
        if (lower.includes('microsoft') || lower.includes('outlook') || lower.includes('hotmail')) return EmailProvider.MICROSOFT;
        if (lower.includes('yahoo') || lower.includes('aol')) return EmailProvider.YAHOO;
    }

    return EmailProvider.OTHER;
}

/**
 * Check if a bounce failure type should degrade entity health.
 * Transient failures (throttling, network) should NOT count toward
 * health degradation.
 */
export function shouldDegradeHealth(failureType: BounceFailureType): boolean {
    return FAILURE_TYPE_CONFIG[failureType].degradesHealth;
}

/**
 * Check if a bounce failure type is transient and expected to self-resolve.
 */
export function isTransientFailure(failureType: BounceFailureType): boolean {
    const recovery = FAILURE_TYPE_CONFIG[failureType].recoveryExpectation;
    return recovery === 'self_resolving';
}

/**
 * Get the escalation speed for a failure type.
 * 'immediate' types should trigger state changes right away.
 * 'none' types should be logged but not escalated.
 */
export function getEscalationSpeed(failureType: BounceFailureType): string {
    return FAILURE_TYPE_CONFIG[failureType].escalationSpeed;
}
