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

interface MillionVerifierRawResponse {
    result: string;         // "ok", "catch_all", "unknown", "error", "disposable", "invalid"
    resultcode: number;     // 1=ok, 2=catch_all, 3=unknown, 4=error, 5=disposable, 6=invalid
    subresult: string;      // Additional detail
    free: boolean;          // Is free email provider
    role: boolean;          // Is role-based email
    did_you_mean: string;   // Suggested correction
    credits: number;        // Remaining credits
    executed_time: number;  // Execution time in ms
}

// Normalized result — always uses string labels regardless of API response format
interface MillionVerifierResult {
    result: string;
    subresult: string;
    free: boolean;
    role: boolean;
    did_you_mean: string;
    credits: number;
    executed_time: number;
}

// Map numeric result codes to string labels (API returns both, but be safe)
const RESULT_CODE_MAP: Record<number, string> = {
    1: 'ok',
    2: 'catch_all',
    3: 'unknown',
    4: 'error',
    5: 'disposable',
    6: 'invalid',
};

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
            params: { api: API_KEY, email, timeout: 20 },
            timeout: 25000,
        });

        const raw = response.data as MillionVerifierRawResponse;

        // Normalize: ensure result is a string label even if API returns numeric code
        const normalizedResult = typeof raw.resultcode === 'number' && RESULT_CODE_MAP[raw.resultcode]
            ? RESULT_CODE_MAP[raw.resultcode]
            : (raw.result || 'unknown');

        const data: MillionVerifierResult = {
            ...raw,
            result: normalizedResult,
        };

        logger.info('[MILLION_VERIFIER] Email verified', {
            organizationId,
            email: email.substring(0, 3) + '***', // Partial for privacy
            result: data.result,
            resultcode: raw.resultcode,
            subresult: data.subresult,
            credits: data.credits,
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
