/**
 * Simple in-memory response cache with per-org TTL.
 *
 * Designed for heavy dashboard endpoints that hit multiple DB queries.
 * Each cache entry is scoped to an organization ID to prevent data leaks.
 */

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

const DEFAULT_TTL_MS = 15_000; // 15 seconds

/**
 * Get a cached value, or execute the factory and cache the result.
 */
export async function cached<T>(
    orgId: string,
    key: string,
    factory: () => Promise<T>,
    ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
    const cacheKey = `${orgId}:${key}`;
    const existing = cache.get(cacheKey);

    if (existing && existing.expiresAt > Date.now()) {
        return existing.data as T;
    }

    const data = await factory();
    cache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
    return data;
}

/**
 * Invalidate all cache entries for an organization.
 */
export function invalidateOrg(orgId: string): void {
    for (const key of cache.keys()) {
        if (key.startsWith(`${orgId}:`)) {
            cache.delete(key);
        }
    }
}

/**
 * Invalidate a specific cache entry.
 */
export function invalidateKey(orgId: string, key: string): void {
    cache.delete(`${orgId}:${key}`);
}

// Periodic cleanup of expired entries (every 60 seconds)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
        if (entry.expiresAt <= now) {
            cache.delete(key);
        }
    }
}, 60_000).unref();
