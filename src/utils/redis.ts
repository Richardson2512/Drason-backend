/**
 * Redis Client
 * 
 * Provides a shared Redis connection for rate limiting and caching.
 * Falls back gracefully when REDIS_URL is not set (development mode).
 */

import Redis from 'ioredis';
import { logger } from '../services/observabilityService';

let redisClient: Redis | null = null;
let isConnected = false;

/**
 * Initialize Redis connection.
 * Returns null if REDIS_URL is not configured (dev fallback).
 */
export function initRedis(): Redis | null {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
        logger.warn('REDIS_URL not set — using in-memory fallback for rate limiting');
        return null;
    }

    try {
        redisClient = new Redis(redisUrl, {
            maxRetriesPerRequest: 3,
            retryStrategy(times: number) {
                if (times > 10) return null; // Stop retrying after 10 attempts
                return Math.min(times * 200, 5000);
            },
            lazyConnect: false
        });

        redisClient.on('connect', () => {
            isConnected = true;
            logger.info('Redis connected');
        });

        redisClient.on('error', (err: Error) => {
            isConnected = false;
            logger.error('Redis connection error', err);
        });

        redisClient.on('close', () => {
            isConnected = false;
            logger.warn('Redis connection closed');
        });

        return redisClient;
    } catch (err) {
        logger.error('Failed to initialize Redis', err as Error);
        return null;
    }
}

/**
 * Get the active Redis client (or null if unavailable).
 */
export function getRedisClient(): Redis | null {
    return redisClient;
}

/**
 * Check if Redis is connected and healthy.
 */
export async function checkRedisHealth(): Promise<{ status: string; latencyMs?: number }> {
    if (!redisClient || !isConnected) {
        return { status: redisClient ? 'disconnected' : 'not_configured' };
    }

    try {
        const start = Date.now();
        await redisClient.ping();
        return { status: 'healthy', latencyMs: Date.now() - start };
    } catch {
        return { status: 'unhealthy' };
    }
}

/**
 * Gracefully disconnect Redis.
 */
export async function disconnectRedis(): Promise<void> {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
        isConnected = false;
        logger.info('Redis disconnected');
    }
}

/**
 * Acquire a distributed lock.
 * Returns true if lock was acquired, false if it's already held by another instance.
 */
export async function acquireLock(key: string, ttlSeconds: number = 600): Promise<boolean> {
    if (!redisClient || !isConnected) {
        // Fail closed: if Redis is unavailable, deny the lock to prevent concurrent execution
        logger.warn(`[REDIS] Lock denied for ${key} — Redis unavailable`);
        return false;
    }
    try {
        const result = await redisClient.set(key, 'locked', 'EX', ttlSeconds, 'NX');
        return result === 'OK';
    } catch (err) {
        logger.error(`Failed to acquire lock for key ${key}`, err as Error);
        return false; // Fail closed if Redis throws an error
    }
}

/**
 * Release a previously acquired distributed lock.
 */
export async function releaseLock(key: string): Promise<void> {
    if (!redisClient || !isConnected) {
        return;
    }
    try {
        await redisClient.del(key);
    } catch (err) {
        logger.error(`Failed to release lock for key ${key}`, err as Error);
    }
}

/**
 * Set a cancellation flag for a running sync.
 * The sync worker checks this flag at key checkpoints and aborts if set.
 */
export async function setSyncCancelled(orgId: string, platform: string): Promise<void> {
    const key = `sync:cancelled:${orgId}:${platform}`;
    if (!redisClient || !isConnected) {
        // Fallback: store in-memory
        inMemoryCancelFlags.add(key);
        return;
    }
    try {
        await redisClient.set(key, '1', 'EX', 300); // 5 min TTL
    } catch (err) {
        logger.error(`Failed to set sync cancel flag for ${key}`, err as Error);
        inMemoryCancelFlags.add(key);
    }
}

/**
 * Check if a sync has been cancelled.
 */
export async function isSyncCancelled(orgId: string, platform: string): Promise<boolean> {
    const key = `sync:cancelled:${orgId}:${platform}`;
    if (!redisClient || !isConnected) {
        return inMemoryCancelFlags.has(key);
    }
    try {
        const val = await redisClient.get(key);
        return val !== null;
    } catch {
        return inMemoryCancelFlags.has(key);
    }
}

/**
 * Clear a cancellation flag (after sync acknowledges it).
 */
export async function clearSyncCancelled(orgId: string, platform: string): Promise<void> {
    const key = `sync:cancelled:${orgId}:${platform}`;
    inMemoryCancelFlags.delete(key);
    if (!redisClient || !isConnected) return;
    try {
        await redisClient.del(key);
    } catch (err) {
        logger.error(`Failed to clear sync cancel flag for ${key}`, err as Error);
    }
}

// In-memory fallback for cancel flags when Redis is unavailable
const inMemoryCancelFlags = new Set<string>();
