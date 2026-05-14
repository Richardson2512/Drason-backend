/**
 * Prisma client — extracted from index.ts so importing the database
 * client doesn't transitively boot the Express server.
 *
 * Before this split, every service file that read `import { prisma }
 * from '../index'` would re-execute index.ts at module-load time —
 * including the route table, middleware setup, OAuth router, Redis
 * connection, and (in dev) the full worker scheduler. That made the
 * codebase untestable: any unit test that depended on a service
 * touching the DB would spin up a full server with 20+ background
 * timers, mask test output with startup logs, and prevent process
 * exit.
 *
 * This module declares the singleton Prisma client and nothing else.
 * Import from here (`import { prisma } from './prisma'` /
 * `'../prisma'` / `'../../prisma'`) anywhere that needs the DB
 * client. The legacy `from './index'` re-export remains so existing
 * call sites keep working without a mass rename — but new code should
 * point at this module directly.
 */

import { PrismaClient } from '@prisma/client';

/**
 * Append statement_timeout to the PostgreSQL connection string.
 * Prevents any single query from running longer than 30 seconds.
 */
function appendStatementTimeout(url: string): string {
    if (!url) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}statement_timeout=30000&connect_timeout=10`;
}

export const prisma = new PrismaClient({
    datasourceUrl: appendStatementTimeout(process.env.DATABASE_URL || ''),
});
