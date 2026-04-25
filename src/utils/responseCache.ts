/**
 * Response cache with per-org TTL.
 *
 * Designed for heavy dashboard endpoints that hit multiple DB queries.
 * Each cache entry is scoped to an organization ID to prevent data leaks.
 *
 * Primary backend: Redis (shared across backend replicas — safe for horizontal
 * scaling). Falls back to an in-process Map when Redis is unavailable (dev,
 * or when the Redis connection is temporarily down), so a cache miss or
 * network glitch never breaks the request — it just turns into a DB hit.
 */

import { getRedisClient } from './redis';
import { logger } from '../services/observabilityService';

interface LocalEntry<T> {
    data: T;
    expiresAt: number;
}

const localCache = new Map<string, LocalEntry<unknown>>();
const REDIS_KEY_PREFIX = 'cache:response:';
const DEFAULT_TTL_MS = 15_000; // 15 seconds

function localKey(orgId: string, key: string): string {
    return `${orgId}:${key}`;
}
function redisKey(orgId: string, key: string): string {
    return `${REDIS_KEY_PREFIX}${orgId}:${key}`;
}

/**
 * Get a cached value, or execute the factory and cache the result.
 * Tries Redis first; on any Redis error silently falls back to the local
 * in-process cache so a Redis outage can't take the dashboard down.
 */
export async function cached<T>(
    orgId: string,
    key: string,
    factory: () => Promise<T>,
    ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
    const redis = getRedisClient();
    const lKey = localKey(orgId, key);
    const rKey = redisKey(orgId, key);
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));

    // 1. Check Redis if available
    if (redis) {
        try {
            const hit = await redis.get(rKey);
            if (hit !== null) {
                return JSON.parse(hit) as T;
            }
        } catch (err) {
            logger.warn(`[CACHE] Redis GET failed for ${rKey} — falling back`, { error: (err as Error).message });
        }
    }

    // 2. Check local cache (covers Redis-down and single-instance dev mode)
    const local = localCache.get(lKey);
    if (local && local.expiresAt > Date.now()) {
        return local.data as T;
    }

    // 3. Miss — call factory and populate both layers.
    const data = await factory();
    const serialized = JSON.stringify(data);

    if (redis) {
        try {
            await redis.set(rKey, serialized, 'EX', ttlSec);
        } catch (err) {
            logger.warn(`[CACHE] Redis SET failed for ${rKey} — local only`, { error: (err as Error).message });
        }
    }
    localCache.set(lKey, { data, expiresAt: Date.now() + ttlMs });
    return data;
}

/**
 * Invalidate all cache entries for an organization.
 * Uses scanStream on Redis (never KEYS — non-blocking iteration) and wipes
 * matching local-cache entries.
 */
export async function invalidateOrg(orgId: string): Promise<void> {
    // Local cache
    for (const k of localCache.keys()) {
        if (k.startsWith(`${orgId}:`)) localCache.delete(k);
    }

    // Redis (best-effort)
    const redis = getRedisClient();
    if (!redis) return;

    const pattern = `${REDIS_KEY_PREFIX}${orgId}:*`;
    try {
        const stream = redis.scanStream({ match: pattern, count: 100 });
        const pipeline = redis.pipeline();
        let queued = 0;

        await new Promise<void>((resolve, reject) => {
            stream.on('data', (keys: string[]) => {
                for (const k of keys) {
                    pipeline.del(k);
                    queued++;
                }
            });
            stream.on('end', resolve);
            stream.on('error', reject);
        });

        if (queued > 0) await pipeline.exec();
    } catch (err) {
        logger.warn(`[CACHE] invalidateOrg failed for ${orgId}`, { error: (err as Error).message });
    }
}

/**
 * Invalidate a specific cache entry.
 */
export async function invalidateKey(orgId: string, key: string): Promise<void> {
    localCache.delete(localKey(orgId, key));

    const redis = getRedisClient();
    if (!redis) return;
    try {
        await redis.del(redisKey(orgId, key));
    } catch (err) {
        logger.warn(`[CACHE] invalidateKey failed for ${orgId}:${key}`, { error: (err as Error).message });
    }
}

// Periodic cleanup of expired local entries (every 60 seconds) — Redis entries
// expire automatically via EX, so we only need this for the in-process fallback.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of localCache.entries()) {
        if (entry.expiresAt <= now) {
            localCache.delete(key);
        }
    }
}, 60_000).unref();
