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
