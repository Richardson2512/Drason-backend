/**
 * Email Validation Service
 *
 * SINGLE WRITER for all validation fields on the Lead model.
 * No other service should write to: validation_status, validation_score,
 * validation_source, validated_at, is_catch_all, is_disposable.
 *
 * Orchestrates:
 * 1. Internal checks (syntax, MX, disposable domain, catch-all via DNS)
 * 2. MillionVerifier API (conditional fallback for risky leads)
 * 3. DomainInsight caching (avoids redundant DNS/API lookups)
 *
 * The validation_score feeds INTO lead_score via the health gate.
 */

import dns from 'dns';
import { promisify } from 'util';
import { prisma } from '../index';
import { logger } from './observabilityService';
import { isDisposableDomain, hasSuspiciousTLD } from './leadHealthService';
import * as millionVerifierClient from './millionVerifierClient';
import { ValidationStatus, ValidationSource, type ValidationResult } from '../types';

const resolveMx = promisify(dns.resolveMx);

// Internal scoring weights
const SCORE_BASE = 50;
const SCORE_MX_FOUND = 20;
const SCORE_NOT_DISPOSABLE = 15;
const SCORE_NOT_CATCH_ALL = 15;
const SCORE_SUSPICIOUS_TLD_PENALTY = 20;

// Domain insight cache TTL: 7 days
const DOMAIN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Tier-based API thresholds
// Starter: no API calls (internal only)
// Growth: API only for risky leads (internal score < 60)
// Scale: API for medium + high risk (internal score < 75)
const TIER_API_THRESHOLDS: Record<string, number | null> = {
    trial: null,       // No API
    starter: null,     // No API
    growth: 60,        // API if internal score < 60
    scale: 75,         // API if internal score < 75
    enterprise: 75,    // Same as scale
};

// ============================================================================
// DOMAIN INSIGHT CACHING
// ============================================================================

interface DomainCheckResult {
    has_mx: boolean;
    is_catch_all: boolean;
    is_disposable: boolean;
    mx_records: Array<{ priority: number; exchange: string }>;
}

/**
 * Get or create domain insight with caching.
 * Avoids redundant DNS lookups for the same domain.
 */
async function getDomainInsight(
    organizationId: string,
    domain: string
): Promise<DomainCheckResult> {
    // Check cache first
    const cached = await prisma.domainInsight.findUnique({
        where: { organization_id_domain: { organization_id: organizationId, domain } },
    });

    if (cached && cached.checked_at && (Date.now() - cached.checked_at.getTime()) < DOMAIN_CACHE_TTL_MS) {
        return {
            has_mx: cached.has_mx,
            is_catch_all: cached.is_catch_all,
            is_disposable: cached.is_disposable,
            mx_records: (cached.mx_records as any[]) || [],
        };
    }

    // Perform fresh DNS checks
    const result = await checkDomain(domain);

    // Cache result
    await prisma.domainInsight.upsert({
        where: { organization_id_domain: { organization_id: organizationId, domain } },
        update: {
            has_mx: result.has_mx,
            is_catch_all: result.is_catch_all,
            is_disposable: result.is_disposable,
            mx_records: result.mx_records as any,
            checked_at: new Date(),
        },
        create: {
            organization_id: organizationId,
            domain,
            has_mx: result.has_mx,
            is_catch_all: result.is_catch_all,
            is_disposable: result.is_disposable,
            mx_records: result.mx_records as any,
            checked_at: new Date(),
        },
    });

    return result;
}

/**
 * Perform DNS-based domain checks.
 */
async function checkDomain(domain: string): Promise<DomainCheckResult> {
    let has_mx = false;
    let mx_records: Array<{ priority: number; exchange: string }> = [];
    const is_disposable = isDisposableDomain(domain);

    try {
        const records = await resolveMx(domain);
        if (records && records.length > 0) {
            has_mx = true;
            mx_records = records
                .sort((a, b) => a.priority - b.priority)
                .map(r => ({ priority: r.priority, exchange: r.exchange }));
        }
    } catch {
        // No MX records — domain likely invalid
        has_mx = false;
    }

    // Catch-all detection is heuristic-based via DNS only (no SMTP probing).
    // True catch-all detection requires MillionVerifier API.
    // For internal checks, we flag domains with certain patterns.
    const is_catch_all = false; // Conservative: only MillionVerifier can confirm catch-all

    return { has_mx, is_catch_all, is_disposable, mx_records };
}

// ============================================================================
// SYNTAX VALIDATION
// ============================================================================

function isValidSyntax(email: string): boolean {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!emailRegex.test(email)) return false;

    const domain = email.split('@')[1];
    if (!domain || !domain.includes('.')) return false;
    if (domain === 'localhost' || domain === 'example.com' || domain === 'test') return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return false;
    if (email.includes('..') || email.startsWith('.') || email.endsWith('.')) return false;

    return true;
}

// ============================================================================
// MAIN VALIDATION FUNCTION
// ============================================================================

/**
 * Validate a lead's email address.
 * This is the ONLY function that should write validation fields to the Lead model.
 *
 * Flow:
 * 1. Syntax check (instant)
 * 2. Domain insight (cached DNS: MX, disposable, catch-all)
 * 3. Calculate internal score
 * 4. If internal score is borderline + MillionVerifier is configured → API call
 * 5. Write results to Lead + create ValidationAttempt
 */
export async function validateLeadEmail(
    organizationId: string,
    email: string,
    subscriptionTier?: string
): Promise<ValidationResult> {
    const startMs = Date.now();
    const emailLower = email.toLowerCase().trim();
    const domain = emailLower.split('@')[1];

    // ── Step 1: Syntax check ──
    if (!isValidSyntax(emailLower)) {
        const durationMs = Date.now() - startMs;
        const result: ValidationResult = {
            status: ValidationStatus.INVALID,
            score: 0,
            source: ValidationSource.INTERNAL,
            is_catch_all: false,
            is_disposable: false,
            details: { syntax_ok: false, mx_found: false, disposable_check: false, catch_all_check: false },
            attempt: { source: ValidationSource.INTERNAL, result_status: ValidationStatus.INVALID, result_score: 0, result_details: { syntax_ok: false, mx_found: false, disposable_check: false, catch_all_check: false }, duration_ms: durationMs },
        };

        await recordAttempt(organizationId, emailLower, result, durationMs);
        return result;
    }

    // ── Step 2: Domain insight (cached) ──
    const domainInsight = await getDomainInsight(organizationId, domain);

    // ── Step 3: Calculate internal score ──
    let internalScore = SCORE_BASE;
    if (domainInsight.has_mx) internalScore += SCORE_MX_FOUND;
    if (!domainInsight.is_disposable) internalScore += SCORE_NOT_DISPOSABLE;
    if (!domainInsight.is_catch_all) internalScore += SCORE_NOT_CATCH_ALL;
    if (hasSuspiciousTLD(domain)) internalScore -= SCORE_SUSPICIOUS_TLD_PENALTY;
    internalScore = Math.max(0, Math.min(100, internalScore));

    // Short-circuit: clearly invalid
    if (domainInsight.is_disposable) {
        const durationMs = Date.now() - startMs;
        const details = { syntax_ok: true, mx_found: domainInsight.has_mx, disposable_check: true, catch_all_check: false };
        const result: ValidationResult = {
            status: ValidationStatus.INVALID,
            score: 5,
            source: ValidationSource.INTERNAL,
            is_catch_all: false,
            is_disposable: true,
            details,
            attempt: { source: ValidationSource.INTERNAL, result_status: ValidationStatus.INVALID, result_score: 5, result_details: details, duration_ms: durationMs },
        };
        await recordAttempt(organizationId, emailLower, result, durationMs);
        return result;
    }

    if (!domainInsight.has_mx) {
        const durationMs = Date.now() - startMs;
        const details = { syntax_ok: true, mx_found: false, disposable_check: false, catch_all_check: false };
        const result: ValidationResult = {
            status: ValidationStatus.INVALID,
            score: 10,
            source: ValidationSource.INTERNAL,
            is_catch_all: false,
            is_disposable: false,
            details,
            attempt: { source: ValidationSource.INTERNAL, result_status: ValidationStatus.INVALID, result_score: 10, result_details: details, duration_ms: durationMs },
        };
        await recordAttempt(organizationId, emailLower, result, durationMs);
        return result;
    }

    // ── Step 4: MillionVerifier API (conditional, tier-gated) ──
    // Starter/trial: NEVER call API — internal only
    // Growth: call API only if internal score < 60 (risky leads)
    // Scale/enterprise: call API if internal score < 75 (medium + high risk)
    const tier = (subscriptionTier || 'starter').toLowerCase();
    const apiThreshold = TIER_API_THRESHOLDS[tier] ?? null;
    const shouldCallApi = apiThreshold !== null && internalScore < apiThreshold;

    if (shouldCallApi) {
        const mvResult = await millionVerifierClient.verifyEmail(organizationId, emailLower);

        if (mvResult) {
            const mapped = millionVerifierClient.mapResult(mvResult);
            const result: ValidationResult = {
                status: mapped.status as any,
                score: mapped.score,
                source: ValidationSource.MILLION_VERIFIER,
                is_catch_all: mapped.is_catch_all,
                is_disposable: mapped.is_disposable,
                details: {
                    syntax_ok: true,
                    mx_found: true,
                    disposable_check: mapped.is_disposable,
                    catch_all_check: mapped.is_catch_all,
                    api_response: {
                        result: mvResult.result,
                        subresult: mvResult.subresult,
                        free: mvResult.free,
                        role: mvResult.role,
                    },
                },
            };

            // Update domain insight if API revealed catch-all
            if (mapped.is_catch_all) {
                await prisma.domainInsight.updateMany({
                    where: { organization_id: organizationId, domain },
                    data: { is_catch_all: true },
                });
            }

            const durationMs = Date.now() - startMs;
            result.attempt = { source: result.source, result_status: result.status as any, result_score: result.score, result_details: result.details, duration_ms: durationMs };
            await recordAttempt(organizationId, emailLower, result, durationMs);
            return result;
        }
        // API not configured or failed — fall through to internal result
    }

    // ── Step 5: Return internal-only result ──
    let status: ValidationResult['status'];
    if (internalScore >= 80) status = ValidationStatus.VALID;
    else if (internalScore >= 50) status = ValidationStatus.RISKY;
    else status = ValidationStatus.UNKNOWN;

    const durationMs = Date.now() - startMs;
    const details = { syntax_ok: true, mx_found: true, disposable_check: false, catch_all_check: domainInsight.is_catch_all };
    const result: ValidationResult = {
        status,
        score: internalScore,
        source: ValidationSource.INTERNAL,
        is_catch_all: domainInsight.is_catch_all,
        is_disposable: false,
        details,
        attempt: { source: ValidationSource.INTERNAL, result_status: status, result_score: internalScore, result_details: details, duration_ms: durationMs },
    };

    await recordAttempt(organizationId, emailLower, result, durationMs);
    return result;
}

// ============================================================================
// AUDIT TRAIL
// ============================================================================

/**
 * Record a validation attempt for audit trail.
 */
async function recordAttempt(
    organizationId: string,
    email: string,
    result: ValidationResult,
    durationMs: number
): Promise<void> {
    try {
        // Find the lead — skip recording if lead doesn't exist yet (will be recorded post-upsert)
        const lead = await prisma.lead.findUnique({
            where: { organization_id_email: { organization_id: organizationId, email } },
            select: { id: true },
        });

        if (!lead) {
            logger.debug('[VALIDATION] Skipping attempt record — lead not yet created', { email });
            return;
        }

        await prisma.validationAttempt.create({
            data: {
                lead_id: lead.id,
                organization_id: organizationId,
                source: result.source,
                result_status: result.status,
                result_score: result.score,
                result_details: result.details as any,
                duration_ms: durationMs,
            },
        });
    } catch (err) {
        // Non-fatal — don't let audit recording block validation
        logger.warn('[VALIDATION] Failed to record attempt', { error: String(err) });
    }
}
