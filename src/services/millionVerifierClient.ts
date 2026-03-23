/**
 * MillionVerifier API Client
 *
 * Wraps the MillionVerifier single-email verification API.
 * API key stored in OrganizationSetting as MILLION_VERIFIER_API_KEY.
 *
 * Rate limit: ~10 req/sec. Uses existing rate limiter pattern.
 * Docs: https://api.millionverifier.com/
 */

import axios from 'axios';
import { logger } from './observabilityService';

const MV_API_BASE = 'https://api.millionverifier.com/api/v3';

// Platform-level API key — NOT per-org. Set via MILLION_VERIFIER_API_KEY env var on Railway.
const API_KEY = process.env.MILLION_VERIFIER_API_KEY || '';

interface MillionVerifierResult {
    result: string;         // ok, catch_all, unknown, invalid, disposable, error
    subresult: string;      // Additional detail
    free: boolean;          // Is free email provider
    role: boolean;          // Is role-based email
    did_you_mean: string;   // Suggested correction
    credits: number;        // Remaining credits
    executed_time: number;  // Execution time in ms
}

/**
 * Verify a single email address via MillionVerifier API.
 * Returns null if the org doesn't have an API key configured.
 */
export async function verifyEmail(
    organizationId: string,
    email: string
): Promise<MillionVerifierResult | null> {
    if (!API_KEY) return null;

    try {
        const response = await axios.get(MV_API_BASE, {
            params: { api: API_KEY, email },
            timeout: 15000,
        });

        const data = response.data as MillionVerifierResult;

        logger.info('[MILLION_VERIFIER] Email verified', {
            organizationId,
            email: email.substring(0, 3) + '***', // Partial for privacy
            result: data.result,
            subresult: data.subresult,
            executionTime: data.executed_time,
        });

        return data;
    } catch (error: any) {
        logger.error('[MILLION_VERIFIER] API call failed', error, {
            organizationId,
            status: error.response?.status,
        });
        return null;
    }
}

/**
 * Map MillionVerifier result to our internal validation status and score.
 */
export function mapResult(mvResult: MillionVerifierResult): {
    status: string;
    score: number;
    is_disposable: boolean;
    is_catch_all: boolean;
} {
    switch (mvResult.result) {
        case 'ok':
            return { status: 'valid', score: 95, is_disposable: false, is_catch_all: false };
        case 'catch_all':
            return { status: 'risky', score: 55, is_disposable: false, is_catch_all: true };
        case 'unknown':
            return { status: 'unknown', score: 40, is_disposable: false, is_catch_all: false };
        case 'disposable':
            return { status: 'invalid', score: 5, is_disposable: true, is_catch_all: false };
        case 'invalid':
            return { status: 'invalid', score: 5, is_disposable: false, is_catch_all: false };
        default:
            return { status: 'unknown', score: 30, is_disposable: false, is_catch_all: false };
    }
}

/**
 * Check if an organization has MillionVerifier configured.
 */
export function isConfigured(): boolean {
    return API_KEY.length > 0;
}
