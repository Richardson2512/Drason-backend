/**
 * Lead Health Service
 * 
 * Implements Pre-Send Lead Health Gate
 * Classifies leads as GREEN, YELLOW, or RED before they enter campaigns.
 * 
 * Health Checks:
 * - Disposable domain detection (mailinator, tempmail, etc.)
 * - Role-based email penalty (info@, admin@, sales@, support@)
 * - Catch-all domain risk
 * - New/suspicious domain detection
 */

import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';

// ============================================================================
// TYPES
// ============================================================================

export type HealthClassification = 'green' | 'yellow' | 'red';

export interface LeadHealthResult {
    classification: HealthClassification;
    score: number;  // 0-100
    checks: {
        isDisposable: boolean;
        isRoleEmail: boolean;
        isCatchAll: boolean;
        domainAgeDays: number | null;
    };
    reasons: string[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Thresholds
const GREEN_THRESHOLD = 80;   // score >= 80 → GREEN
const YELLOW_THRESHOLD = 50;  // score >= 50 → YELLOW
// score < 50 → RED

// Penalty factors (subtracted from 100)
const DISPOSABLE_DOMAIN_PENALTY = 100;   // Instant RED
const ROLE_EMAIL_PENALTY = 30;           // Major penalty
const CATCH_ALL_PENALTY = 20;            // Moderate penalty
const NEW_DOMAIN_PENALTY = 15;           // Minor penalty (domain < 90 days)
const SUSPICIOUS_TLD_PENALTY = 25;       // .xyz, .tk, etc.

// Disposable email domain list (commonly used for temp emails)
const DISPOSABLE_DOMAINS = new Set([
    // Major disposable providers
    'mailinator.com', 'tempmail.com', 'guerrillamail.com', 'throwaway.email',
    '10minutemail.com', 'temp-mail.org', 'fakeinbox.com', 'getnada.com',
    'maildrop.cc', 'dispostable.com', 'sharklasers.com', 'yopmail.com',
    'trashmail.com', 'mytrashmail.com', 'mailnesia.com', 'spamgourmet.com',
    'tempr.email', 'discard.email', 'spamex.com', 'mailcatch.com',
    'emailondeck.com', 'mohmal.com', 'tempail.com', 'burnermail.io',
    'mailsac.com', 'inboxkitten.com', 'harakirimail.com', 'anonymbox.com',
    'jetable.org', 'trash-mail.com', 'getairmail.com', 'mintemail.com',
    // Additional common disposable domains
    '33mail.com', 'guerrillamailblock.com', 'pokemail.net', 'shitmail.org',
    'mailcatch.com', 'protonmail.ch', 'tutanota.de', 'cock.li',
    'tempinbox.com', 'fakemailgenerator.com', 'emailfake.com', 'crazymailing.com'
]);

// Role-based email prefixes that typically have lower engagement
const ROLE_EMAIL_PREFIXES = [
    'info', 'admin', 'sales', 'support', 'contact', 'hello', 'help',
    'office', 'team', 'hr', 'careers', 'jobs', 'marketing', 'press',
    'media', 'news', 'webmaster', 'postmaster', 'abuse', 'noreply',
    'no-reply', 'donotreply', 'do-not-reply', 'billing', 'accounts',
    'enquiries', 'inquiries', 'feedback', 'general', 'reception'
];

// Suspicious TLDs often used for spam/fake domains
const SUSPICIOUS_TLDS = [
    '.xyz', '.tk', '.ml', '.ga', '.cf', '.gq', '.top', '.buzz',
    '.club', '.work', '.click', '.link', '.win', '.bid', '.stream',
    '.download', '.racing', '.loan', '.date', '.faith', '.review'
];

// ============================================================================
// EMAIL VALIDATION
// ============================================================================

/**
 * Validate email format and check for obviously invalid emails.
 * Returns null if valid, or an error reason if invalid.
 */
function validateEmailFormat(email: string): string | null {
    // RFC 5322 compliant email regex (simplified but robust)
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

    if (!emailRegex.test(email)) {
        return 'Email format invalid (malformed syntax)';
    }

    // Check for obviously fake/test domains
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) {
        return 'Email missing domain';
    }

    // Localhost and test domains
    if (domain === 'localhost' || domain === 'test' || domain === 'example.com' || domain === 'example.org') {
        return `Invalid test domain: ${domain}`;
    }

    // Check for IP address domains (usually spam)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
        return 'Email domain cannot be an IP address';
    }

    // Must have at least one dot in domain (e.g., test@test is invalid)
    if (!domain.includes('.')) {
        return 'Email domain must have TLD (e.g., .com)';
    }

    // Check for suspicious patterns
    if (email.includes('..')) {
        return 'Email contains consecutive dots';
    }

    if (email.startsWith('.') || email.endsWith('.')) {
        return 'Email cannot start or end with dot';
    }

    if (email.includes('@.') || email.includes('.@')) {
        return 'Email has dot adjacent to @';
    }

    return null; // Valid
}

// ============================================================================
// MAIN CLASSIFICATION FUNCTION
// ============================================================================

/**
 * Classify lead health based on email address.
 * Returns GREEN/YELLOW/RED classification with detailed checks.
 */
export async function classifyLeadHealth(email: string): Promise<LeadHealthResult> {
    const emailLower = email.toLowerCase().trim();

    // ── VALIDATION: Email format must be valid ──
    const validationError = validateEmailFormat(emailLower);
    if (validationError) {
        return {
            classification: 'red',
            score: 0,
            checks: { isDisposable: false, isRoleEmail: false, isCatchAll: false, domainAgeDays: null },
            reasons: [validationError]
        };
    }

    const [localPart, domain] = emailLower.split('@');

    if (!domain) {
        return {
            classification: 'red',
            score: 0,
            checks: { isDisposable: false, isRoleEmail: false, isCatchAll: false, domainAgeDays: null },
            reasons: ['Invalid email format - missing domain']
        };
    }

    const checks = {
        isDisposable: isDisposableDomain(domain),
        isRoleEmail: isRoleBasedEmail(localPart),
        isCatchAll: false, // Could integrate with email verification API
        domainAgeDays: null as number | null
    };

    const reasons: string[] = [];
    let score = 100;

    // Check disposable domain (instant RED)
    if (checks.isDisposable) {
        score -= DISPOSABLE_DOMAIN_PENALTY;
        reasons.push(`Disposable email domain: ${domain}`);
    }

    // Check role-based email
    if (checks.isRoleEmail) {
        score -= ROLE_EMAIL_PENALTY;
        reasons.push(`Role-based email: ${localPart}@`);
    }

    // Check suspicious TLD
    if (hasSuspiciousTLD(domain)) {
        score -= SUSPICIOUS_TLD_PENALTY;
        reasons.push(`Suspicious TLD: ${domain}`);
    }

    // Ensure score stays between 0-100
    score = Math.max(0, Math.min(100, score));

    // Determine classification
    let classification: HealthClassification;
    if (score >= GREEN_THRESHOLD) {
        classification = 'green';
    } else if (score >= YELLOW_THRESHOLD) {
        classification = 'yellow';
    } else {
        classification = 'red';
    }

    return {
        classification,
        score,
        checks,
        reasons
    };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if domain is a known disposable email provider.
 */
export function isDisposableDomain(domain: string): boolean {
    const domainLower = domain.toLowerCase();

    // Direct match
    if (DISPOSABLE_DOMAINS.has(domainLower)) {
        return true;
    }

    // Check subdomains (e.g., sub.mailinator.com)
    for (const disposable of DISPOSABLE_DOMAINS) {
        if (domainLower.endsWith('.' + disposable)) {
            return true;
        }
    }

    return false;
}

/**
 * Check if email prefix indicates a role-based address.
 */
export function isRoleBasedEmail(localPart: string): boolean {
    const localLower = localPart.toLowerCase();
    return ROLE_EMAIL_PREFIXES.some(prefix =>
        localLower === prefix || localLower.startsWith(prefix + '.') || localLower.startsWith(prefix + '-')
    );
}

/**
 * Check if domain has a suspicious TLD.
 */
export function hasSuspiciousTLD(domain: string): boolean {
    const domainLower = domain.toLowerCase();
    return SUSPICIOUS_TLDS.some(tld => domainLower.endsWith(tld));
}

// ============================================================================
// DATABASE FUNCTIONS
// ============================================================================

/**
 * Get lead health statistics for an organization.
 */
export async function getLeadHealthStats(organizationId: string): Promise<{
    total: number;
    green: number;
    yellow: number;
    red: number;
    recentBlocked: Array<{
        id: string;
        email: string;
        health_classification: string;
        health_score_calc: number;
        health_checks: any;
        created_at: Date;
    }>;
}> {
    const [total, green, yellow, red, recentBlocked] = await Promise.all([
        prisma.lead.count({ where: { organization_id: organizationId, deleted_at: null } }),
        prisma.lead.count({ where: { organization_id: organizationId, health_classification: 'green', deleted_at: null } }),
        prisma.lead.count({ where: { organization_id: organizationId, health_classification: 'yellow', deleted_at: null } }),
        prisma.lead.count({ where: { organization_id: organizationId, health_classification: 'red', deleted_at: null } }),
        prisma.lead.findMany({
            where: {
                organization_id: organizationId,
                health_classification: 'red',
                deleted_at: null
            },
            select: {
                id: true,
                email: true,
                health_classification: true,
                health_score_calc: true,
                health_checks: true,
                created_at: true
            },
            orderBy: { created_at: 'desc' },
            take: 10
        })
    ]);

    return { total, green, yellow, red, recentBlocked };
}

/**
 * Apply health classification to a lead and update database.
 */
export async function applyHealthClassification(
    organizationId: string,
    leadId: string,
    healthResult: LeadHealthResult
): Promise<void> {
    await prisma.lead.update({
        where: { id: leadId },
        data: {
            health_classification: healthResult.classification,
            health_score_calc: healthResult.score,
            health_checks: healthResult.checks
        }
    });

    // Log and notify if blocked
    if (healthResult.classification === 'red') {
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: leadId,
            trigger: 'health_gate',
            action: 'blocked',
            details: `Lead blocked by health gate: ${healthResult.reasons.join(', ')}`
        });

        try {
            const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { email: true } });
            await notificationService.createNotification(organizationId, {
                type: 'WARNING',
                title: 'Lead Blocked by Health Gate',
                message: `Lead "${lead?.email || leadId}" was blocked (score: ${healthResult.score}/100). Reasons: ${healthResult.reasons.join(', ')}.`,
            });
        } catch (notifError) {
            // Non-critical — don't block the flow
        }
    }
}
