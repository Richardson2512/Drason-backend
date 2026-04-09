// ─── DNSBL Checking Engine ───────────────────────────────────────────
// Checks domains against 400+ DNS-based blacklists using a tiered
// architecture with resolver pooling and concurrency throttling.
// ─────────────────────────────────────────────────────────────────────

import * as dns from 'dns';
import { prisma } from '../index';
import type { DnsblList } from '@prisma/client';

// ─── Types ───────────────────────────────────────────────────────────

export interface SingleListResult {
  listId: string;
  listName: string;
  zone: string;
  tier: string;
  status: 'CONFIRMED' | 'NOT_LISTED' | 'UNREACHABLE' | 'SKIPPED';
  responseCode: string | null;
}

export interface BlacklistSummary {
  critical_listed: number;
  critical_checked: number;
  major_listed: number;
  major_checked: number;
  minor_listed: number;
  minor_checked: number;
  total_checked: number;
  total_listed: number;
}

export interface DnsblCheckResult {
  domainId: string;
  domainName: string;
  results: SingleListResult[];
  summary: BlacklistSummary;
  penalty: number;
}

// ─── Semaphore (concurrency throttle) ────────────────────────────────

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}

const semaphore = new Semaphore(50);

// ─── Resolver Pool ───────────────────────────────────────────────────

const DNS_SERVERS: string[][] = [
  ['8.8.8.8'],
  ['8.8.4.4'],
  ['1.1.1.1'],
  ['1.0.0.1'],
  ['9.9.9.9'],
  ['208.67.222.222'],
];

const resolvers: dns.Resolver[] = DNS_SERVERS.map((servers) => {
  const resolver = new dns.Resolver();
  resolver.setServers(servers);
  return resolver;
});

let resolverIndex = 0;

function getNextResolver(): dns.Resolver {
  const resolver = resolvers[resolverIndex % resolvers.length];
  resolverIndex++;
  return resolver;
}

// ─── IP Resolution Cache ─────────────────────────────────────────────

const ipCache = new Map<string, string | null>();

async function resolveToIp(domain: string): Promise<string | null> {
  if (ipCache.has(domain)) {
    return ipCache.get(domain)!;
  }

  try {
    const resolver = getNextResolver();
    const addresses = await new Promise<string[]>((resolve, reject) => {
      resolver.resolve4(domain, (err, addrs) => {
        if (err) reject(err);
        else resolve(addrs);
      });
    });
    const ip = addresses[0] || null;
    ipCache.set(domain, ip);
    return ip;
  } catch {
    ipCache.set(domain, null);
    return null;
  }
}

function reverseIp(ip: string): string {
  return ip.split('.').reverse().join('.');
}

// ─── DNS Query Helper ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryDnsbl(
  reversedIp: string,
  list: DnsblList
): Promise<{ status: 'CONFIRMED' | 'NOT_LISTED' | 'UNREACHABLE'; responseCode: string | null }> {
  // Build query hostname
  let query: string;
  if (list.requires_auth && list.auth_config_key && process.env[list.auth_config_key]) {
    const authKey = process.env[list.auth_config_key];
    query = `${reversedIp}.${authKey}.${list.zone}`;
  } else {
    query = `${reversedIp}.${list.zone}`;
  }

  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resolver = getNextResolver();
      const addresses = await new Promise<string[]>((resolve, reject) => {
        resolver.resolve4(query, (err, addrs) => {
          if (err) reject(err);
          else resolve(addrs);
        });
      });

      // A record found — domain is listed
      return { status: 'CONFIRMED', responseCode: addresses[0] || null };
    } catch (err: any) {
      const code = err?.code;

      // NXDOMAIN / NODATA → not listed (definitive, no retry needed)
      if (code === 'ENODATA' || code === 'ENOTFOUND') {
        return { status: 'NOT_LISTED', responseCode: null };
      }

      // Timeout / network error → retry with backoff
      if (attempt < maxRetries) {
        await sleep(500 * (attempt + 1));
        continue;
      }

      // Exhausted retries
      return { status: 'UNREACHABLE', responseCode: null };
    }
  }

  // Fallback (should not reach here)
  return { status: 'UNREACHABLE', responseCode: null };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Returns the DNSBL lists to check based on depth tier and weekly rotation.
 */
export async function getListsForRun(
  depth: 'critical_only' | 'standard' | 'comprehensive',
  dayOfWeek?: number
): Promise<DnsblList[]> {
  const day = dayOfWeek ?? new Date().getDay(); // 0-6

  if (depth === 'critical_only') {
    return prisma.dnsblList.findMany({
      where: { tier: 'critical', enabled: true },
    });
  }

  if (depth === 'standard') {
    return prisma.dnsblList.findMany({
      where: {
        tier: { in: ['critical', 'major'] },
        enabled: true,
      },
    });
  }

  // comprehensive: all enabled, but minor lists only if their rotation_group
  // matches today's slot (dayOfWeek % 7). Critical + major always included.
  const [criticalMajor, minorToday] = await Promise.all([
    prisma.dnsblList.findMany({
      where: {
        tier: { in: ['critical', 'major'] },
        enabled: true,
      },
    }),
    prisma.dnsblList.findMany({
      where: {
        tier: 'minor',
        enabled: true,
        rotation_group: day % 7,
      },
    }),
  ]);

  return [...criticalMajor, ...minorToday];
}

/**
 * Check a single domain against the provided DNSBL lists.
 */
export async function checkDomainBlacklists(
  domainName: string,
  domainId: string,
  lists: DnsblList[]
): Promise<DnsblCheckResult> {
  console.log(`[DNSBL] Starting assessment for ${domainName} against ${lists.length} lists`);

  // Resolve domain to IP
  const ip = await resolveToIp(domainName);

  if (!ip) {
    console.log(`[DNSBL] Could not resolve ${domainName} to IP — skipping all lists`);
    const skippedResults: SingleListResult[] = lists.map((list) => ({
      listId: list.id,
      listName: list.name,
      zone: list.zone,
      tier: list.tier,
      status: 'SKIPPED' as const,
      responseCode: null,
    }));

    const summary = buildSummary(skippedResults);
    return {
      domainId,
      domainName,
      results: skippedResults,
      summary,
      penalty: 0,
    };
  }

  const reversed = reverseIp(ip);

  // Query all lists concurrently (throttled by semaphore)
  const results: SingleListResult[] = await Promise.all(
    lists.map(async (list) => {
      await semaphore.acquire();
      try {
        const { status, responseCode } = await queryDnsbl(reversed, list);
        return {
          listId: list.id,
          listName: list.name,
          zone: list.zone,
          tier: list.tier,
          status,
          responseCode,
        };
      } finally {
        semaphore.release();
      }
    })
  );

  // Log listings
  const listed = results.filter((r) => r.status === 'CONFIRMED');
  if (listed.length > 0) {
    console.log(
      `[DNSBL] ${domainName} listed on ${listed.length} blacklist(s): ${listed.map((r) => r.listName).join(', ')}`
    );
  } else {
    console.log(`[DNSBL] ${domainName} is clean across all ${results.length} lists checked`);
  }

  const summary = buildSummary(results);
  const penalty = calculateBlacklistPenalty(results, lists);

  return {
    domainId,
    domainName,
    results,
    summary,
    penalty,
  };
}

/**
 * Calculate weighted penalty from blacklist check results.
 * Formula: SUM(weight * 3) for CONFIRMED, SUM(ceil(weight/3) * 3) for UNREACHABLE.
 * Capped at -60.
 */
export function calculateBlacklistPenalty(results: SingleListResult[], lists: DnsblList[]): number {
  const listMap = new Map(lists.map((l) => [l.id, l]));
  let penalty = 0;

  for (const result of results) {
    const list = listMap.get(result.listId);
    if (!list) continue;

    if (result.status === 'CONFIRMED') {
      penalty -= list.weight * 3;
    } else if (result.status === 'UNREACHABLE') {
      penalty -= Math.ceil(list.weight / 3) * 3;
    }
  }

  return Math.max(penalty, -60);
}

/**
 * Determine if a domain should be auto-paused based on blacklist results.
 */
export function isBlockingBlacklisted(
  results: SingleListResult[],
  lists: DnsblList[]
): { shouldPause: boolean; reason: string | null } {
  // Rule 1: Any critical CONFIRMED → pause
  const criticalListed = results.filter(
    (r) => r.tier === 'critical' && r.status === 'CONFIRMED'
  );
  if (criticalListed.length > 0) {
    return {
      shouldPause: true,
      reason: `Listed on critical blacklist: ${criticalListed[0].listName}`,
    };
  }

  // Rule 2: 2+ major CONFIRMED → pause
  const majorListed = results.filter(
    (r) => r.tier === 'major' && r.status === 'CONFIRMED'
  );
  if (majorListed.length >= 2) {
    const names = majorListed.map((r) => r.listName).join(', ');
    return {
      shouldPause: true,
      reason: `Listed on ${majorListed.length} major blacklists: ${names}`,
    };
  }

  // Rule 3: Aggregate penalty exceeds threshold
  const penalty = calculateBlacklistPenalty(results, lists);
  if (penalty < -45) {
    return {
      shouldPause: true,
      reason: 'Aggregate blacklist penalty exceeds threshold',
    };
  }

  return { shouldPause: false, reason: null };
}

/**
 * Persist DNSBL results to the database and update domain summary fields.
 */
export async function persistResults(
  domainId: string,
  results: SingleListResult[],
  penalty: number,
  summary: BlacklistSummary
): Promise<void> {
  // Upsert each result into DnsblResult
  const upserts = results
    .filter((r) => r.status !== 'SKIPPED')
    .map((r) =>
      prisma.dnsblResult.upsert({
        where: {
          domain_id_dnsbl_list_id: {
            domain_id: domainId,
            dnsbl_list_id: r.listId,
          },
        },
        create: {
          domain_id: domainId,
          dnsbl_list_id: r.listId,
          status: r.status,
          response_code: r.responseCode,
        },
        update: {
          status: r.status,
          response_code: r.responseCode,
          checked_at: new Date(),
        },
      })
    );

  // Update domain summary fields
  const domainUpdate = prisma.domain.update({
    where: { id: domainId },
    data: {
      blacklist_results: summary as any,
      blacklist_score: penalty,
      last_full_blacklist_check: new Date(),
    },
  });

  await prisma.$transaction([...upserts, domainUpdate]);

  console.log(
    `[DNSBL] Persisted ${results.length} results for domain ${domainId} (penalty: ${penalty})`
  );
}

/**
 * Seed the DnsblList table from the seed data file.
 */
export async function seedDnsblLists(): Promise<{ created: number; updated: number }> {
  const { dnsblLists } = await import('../data/dnsblLists');

  let created = 0;
  let updated = 0;

  for (const listData of dnsblLists) {
    const existing = await prisma.dnsblList.findUnique({
      where: { name: listData.name },
    });

    if (existing) {
      await prisma.dnsblList.update({
        where: { name: listData.name },
        data: listData,
      });
      updated++;
    } else {
      await prisma.dnsblList.create({
        data: listData,
      });
      created++;
    }
  }

  console.log(`[DNSBL] Seeded DNSBL lists: ${created} created, ${updated} updated`);
  return { created, updated };
}

// ─── Internal Helpers ────────────────────────────────────────────────

function buildSummary(results: SingleListResult[]): BlacklistSummary {
  const summary: BlacklistSummary = {
    critical_listed: 0,
    critical_checked: 0,
    major_listed: 0,
    major_checked: 0,
    minor_listed: 0,
    minor_checked: 0,
    total_checked: 0,
    total_listed: 0,
  };

  for (const r of results) {
    if (r.status === 'SKIPPED') continue;

    const isListed = r.status === 'CONFIRMED';

    switch (r.tier) {
      case 'critical':
        summary.critical_checked++;
        if (isListed) summary.critical_listed++;
        break;
      case 'major':
        summary.major_checked++;
        if (isListed) summary.major_listed++;
        break;
      case 'minor':
        summary.minor_checked++;
        if (isListed) summary.minor_listed++;
        break;
    }

    summary.total_checked++;
    if (isListed) summary.total_listed++;
  }

  return summary;
}

/**
 * Clear the IP resolution cache. Useful between assessment runs
 * to avoid stale DNS data.
 */
export function clearIpCache(): void {
  ipCache.clear();
}
