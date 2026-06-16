/**
 * JWT secret resolver - the ONE place every JWT issuer/verifier in the
 * backend reads the signing key from.
 *
 * Before this util existed, eight different files resolved
 * `process.env.JWT_SECRET` themselves, and they disagreed on what to do
 * when the env var was missing in production:
 *   - services/tokenService.ts / middleware/orgContext.ts / controllers/
 *     googleAuthController.ts: threw at boot (correct)
 *   - mcp/oauthProvider.ts / services/crm/hubspot/oauthService.ts /
 *     services/crm/salesforce/oauthService.ts / services/outreach/
 *     oauthService.ts: silently fell back to the hardcoded string
 *     'dev-secret-change-me' (WRONG - anyone who knows the fallback can
 *     forge consent-session / OAuth-state JWTs against a misconfigured
 *     prod instance).
 *
 * This module collapses all of those readers into one contract: in
 * production, missing JWT_SECRET is fatal; in non-production, we warn
 * loudly and fall back to a development-only constant. Every caller
 * imports `JWT_SECRET` from here.
 *
 * Audit trail: API/MCP audit finding G3, root-cause fix.
 */

import { logger } from '../services/observabilityService';

export const DEV_FALLBACK_SECRET = 'drason_dev_only_secret_DO_NOT_USE_IN_PROD';

/**
 * Pure resolver - reads from the env it's handed (defaults to
 * process.env). Exported so tests can hit the contract directly
 * without fighting dotenv's module-load side effects.
 */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
    const secret = env.JWT_SECRET;
    if (!secret) {
        if (env.NODE_ENV === 'production') {
            // Refuse to boot. The startup env-validator in index.ts will
            // usually catch this earlier, but this throw is the defense-
            // in-depth tripwire in case anything bypasses that check.
            throw new Error('FATAL: JWT_SECRET is not set in production');
        }
        logger.warn('JWT_SECRET not set - using dev-only fallback. NEVER use this in production.');
        return DEV_FALLBACK_SECRET;
    }
    return secret;
}

/**
 * The resolved JWT signing/verifying secret. Reading this at module top
 * level (vs. lazily) keeps the throw-on-missing contract loud at boot,
 * not lurking until the first /login attempt.
 */
export const JWT_SECRET = resolveJwtSecret();

