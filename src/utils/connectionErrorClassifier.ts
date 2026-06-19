/**
 * Connection error classifier - one place every OAuth / API integration
 * goes for "what went wrong?" so the user-facing last_error message can
 * be specific instead of "permission denied" boilerplate (F5 root).
 *
 * Pre-fix: a token whose scope had been revoked at the provider would
 * fail an API call with a generic 401/403, and each client wrote its own
 * vague last_error. The user saw "permission denied" and had no clue the
 * fix was "reconnect the integration to re-grant scope X."
 *
 * Post-fix: every client classifies errors through here. The
 * scope-drift message tells the user exactly what to do.
 */

export type ConnectionErrorKind =
    | 'scope_drift'        // 403 with insufficient_scope / missing scope - user must reconnect
    | 'unauthorized'       // 401 - token revoked or invalid, reconnect required
    | 'expired_token'      // refresh failed with invalid_grant - reconnect required
    | 'rate_limit'         // 429 - back off, not a credential problem
    | 'transient'          // 5xx - upstream issue
    | 'validation'         // 422 / 400 - request shape error, not credentials
    | 'unknown';

export interface ClassifiedConnectionError {
    kind: ConnectionErrorKind;
    /** Human-readable summary written to <Connection>.last_error so the
     *  dashboard can show the operator what's wrong AND what to do. */
    message: string;
}

/**
 * Classify an upstream API error from its HTTP status and (parsed) body.
 * Tries to recognise the scope-drift signal first because that's the one
 * where the actionable user remediation differs ("reconnect" vs "retry").
 */
export function classifyConnectionError(
    httpStatus: number,
    body: unknown,
    providerLabel: string,
): ClassifiedConnectionError {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    const lc = bodyStr.toLowerCase();

    // Scope drift first - 403 + scope-related language. Every major OAuth
    // provider (HubSpot, Salesforce, Outreach, Google, Microsoft) returns
    // some flavour of these strings on scope insufficient.
    const scopeSignals = [
        'insufficient_scope',
        'insufficient scope',
        'missing scope',
        'missing required scope',
        'oauth_scope',
        'invalid_scope',
        'required scope',
    ];
    if (httpStatus === 403 && scopeSignals.some(s => lc.includes(s))) {
        return {
            kind: 'scope_drift',
            message: `${providerLabel} permissions changed - one or more required scopes were revoked. Reconnect the integration to re-grant access.`,
        };
    }

    // invalid_grant on refresh = the OAuth refresh token is no longer
    // valid. Always means "reconnect."
    if (lc.includes('invalid_grant')) {
        return {
            kind: 'expired_token',
            message: `${providerLabel} access expired - reconnect the integration to issue a fresh token.`,
        };
    }

    if (httpStatus === 401) {
        return {
            kind: 'unauthorized',
            message: `${providerLabel} rejected the credentials. The token was likely revoked or invalidated - reconnect the integration.`,
        };
    }

    if (httpStatus === 429) {
        return {
            kind: 'rate_limit',
            message: `${providerLabel} rate-limited the request. The platform will retry; no action needed.`,
        };
    }

    if (httpStatus >= 500) {
        return {
            kind: 'transient',
            message: `${providerLabel} returned a temporary error (${httpStatus}). Will retry automatically.`,
        };
    }

    if (httpStatus === 422 || httpStatus === 400) {
        return {
            kind: 'validation',
            message: `${providerLabel} rejected the request shape (${httpStatus}). This is not a credential problem.`,
        };
    }

    return {
        kind: 'unknown',
        message: `${providerLabel} returned an unexpected error (${httpStatus}).`,
    };
}
