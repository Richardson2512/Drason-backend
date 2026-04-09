/**
 * Infrastructure Assessment Service
 * 
 * Performs initial health assessment of email infrastructure at onboarding time.
 * Checks domain DNS reputation, imports historical mailbox/campaign data from
 * Smartlead, and generates an Infrastructure Health Report.
 * 
 * This service sets initial states but does NOT bypass the existing healing pipeline.
 * Entities flagged as degraded enter the standard cooldown → recovery flow.
 * 
 * INVARIANT: The execution gate is locked (assessment_completed = false) until
 * this service completes its full assessment. Zero-tolerance race condition.
 */

import dns from 'dns';
import { promisify } from 'util';
import { Prisma } from '@prisma/client';
import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';
import * as entityStateService from './entityStateService';
import * as campaignHealthService from './campaignHealthService';
import * as eventService from './eventService';
import * as rotationService from './rotationService';
import { SlackAlertService } from './SlackAlertService';
import * as dnsblService from './dnsblService';
import { TIER_LIMITS } from './polarClient';
import { getAdapterForMailbox } from '../adapters/platformRegistry';
import { MailboxState, DomainState, TriggerType, EventType } from '../types';
import { logger } from './observabilityService';

// ============================================================================
// PERIODIC ASSESSMENT TIMERS
// ============================================================================
let periodicAssessmentInterval: NodeJS.Timeout | null = null;
const ASSESSMENT_INTERVAL_MS = parseInt(process.env.ASSESSMENT_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);

const _resolveTxt = promisify(dns.resolveTxt);
const _resolve4 = promisify(dns.resolve4);

// Dedicated DNS resolver using public DNS servers (Google + Cloudflare)
// for blacklist lookups — Railway's default resolver often can't reach DNSBL servers
const blacklistResolver = new dns.Resolver();
blacklistResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
const _blResolve4 = promisify(blacklistResolver.resolve4.bind(blacklistResolver));

// ─── DNS Cache ───────────────────────────────────────────────────────────────
// Caches DNS results for 5 minutes to avoid redundant lookups within a single
// assessment run (same domain checked for SPF, DKIM, DMARC, + N blacklists).

const DNS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

const txtCache = new Map<string, CacheEntry<string[][] | null>>();
const a4Cache = new Map<string, CacheEntry<string[] | null>>();

async function resolveTxt(hostname: string, retries = 3): Promise<string[][]> {
    const cached = txtCache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) {
        if (cached.value === null) throw Object.assign(new Error('cached ENODATA'), { code: 'ENODATA' });
        return cached.value;
    }

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await _resolveTxt(hostname);
            txtCache.set(hostname, { value: result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
            return result;
        } catch (err: any) {
            lastErr = err;
            // ENODATA means record doesn't exist, which is a valid response, don't retry
            if (err.code === 'ENODATA') break;

            if (attempt < retries) {
                // Exponential backoff with jitter: 500ms, 1000ms, 2000ms + random(0-500)
                const delay = (500 * Math.pow(2, attempt - 1)) + Math.random() * 500;
                logger.debug(`[DNS] resolveTxt attempt ${attempt} failed for ${hostname}, retrying in ${Math.round(delay)}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    txtCache.set(hostname, { value: null, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    throw lastErr || new Error(`Failed to resolve TXT for ${hostname}`);
}

async function resolve4(hostname: string, retries = 3): Promise<string[]> {
    const cached = a4Cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) {
        if (cached.value === null) throw Object.assign(new Error('cached ENODATA'), { code: 'ENODATA' });
        return cached.value;
    }

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await _resolve4(hostname);
            a4Cache.set(hostname, { value: result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
            return result;
        } catch (err: any) {
            lastErr = err;
            if (err.code === 'ENODATA') break;

            if (attempt < retries) {
                const delay = (500 * Math.pow(2, attempt - 1)) + Math.random() * 500;
                logger.debug(`[DNS] resolve4 attempt ${attempt} failed for ${hostname}, retrying in ${Math.round(delay)}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    a4Cache.set(hostname, { value: null, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    throw lastErr || new Error(`Failed to resolve A vector for ${hostname}`);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ASSESSMENT_VERSION = '1.0';

// Blacklist checking is now handled by dnsblService.ts
// See: services/dnsblService.ts for tiered DNSBL architecture

/** Common DKIM selectors to check */
const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 's1', 's2'];

/** Mailbox classification thresholds - Volume-aware for better protection */
const MAILBOX_THRESHOLDS = {
    PAUSE_BOUNCE_RATE: 0.03,        // 3% → paused (after 60 sends)
    WARNING_BOUNCE_RATE: 0.02,      // 2% → warning (early detection)
    EARLY_WARNING: 0.03,            // 3% → warning (20-60 sends)
    MIN_SENDS_FOR_PAUSE: 60,        // Minimum sends before auto-pause
    MIN_SENDS_FOR_WARNING: 20,      // Minimum sends before warning
};

// CAMPAIGN_THRESHOLDS removed — campaigns are NEVER paused based on bounce rate.
// Campaigns pause only when ALL mailboxes are paused/removed.
// See campaignHealthService.ts for the canonical rule.

// ─── Types ───────────────────────────────────────────────────────────────────

type BlacklistStatus = 'CONFIRMED' | 'NOT_LISTED' | 'UNREACHABLE';

interface DomainDNSResult {
    domainName: string;
    spfValid: boolean | null;
    dkimValid: boolean | null;
    dmarcPolicy: string | null;
    blacklistResults: Record<string, BlacklistStatus>;
    score: number;
    _dnsblCheckResult?: dnsblService.DnsblCheckResult | null;
}

interface Finding {
    severity: 'critical' | 'warning' | 'info';
    category: string;
    entity: string;
    entityId: string;
    entityName: string;
    title: string;
    details: string;
    message: string;
    remediation: string;
}

interface Recommendation {
    priority: number;
    action: string;
    details: string;
    reason: string;
    link: string;
}

interface AssessmentResult {
    overallScore: number;
    summary: {
        domains: { total: number; healthy: number; warning: number; paused: number };
        mailboxes: { total: number; healthy: number; warning: number; paused: number };
        campaigns: { total: number; active: number; warning: number; paused: number };
    };
    findings: Finding[];
    recommendations: Recommendation[];
}

// ─── Mailbox Pause Enforcement ──────────────────────────────────────────────
// When assessment pauses a mailbox, enforce the same actions as monitoringService:
// platform removal, healing pipeline entry, Slack alert, and standby rotation.

/**
 * Enforce platform-side removal and healing pipeline entry for a mailbox
 * that the assessment has determined should be paused.
 *
 * This closes the gap where assessment-detected pauses were DB-only flags
 * without actual platform enforcement or healing entry.
 */
async function enforceMailboxPause(
    organizationId: string,
    mailbox: {
        id: string;
        email: string;
        resilience_score: number | null;
        external_email_account_id: string | null;
    },
    reason: string,
): Promise<void> {
    // ── 1. Set healing operational fields (enters healing pipeline) ──
    const currentResilience = mailbox.resilience_score ?? 50;
    const newResilience = Math.max(0, currentResilience - 15);

    await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: {
            recovery_phase: 'paused',
            resilience_score: newResilience,
            clean_sends_since_phase: 0,
            phase_entered_at: new Date(),
        },
    });

    // ── 2. Store event for audit trail ──
    try {
        await eventService.storeEvent({
            organizationId,
            eventType: EventType.MAILBOX_PAUSED,
            entityType: 'mailbox',
            entityId: mailbox.id,
            payload: { reason, source: 'infrastructure_assessment' },
        });
    } catch (err: any) {
        logger.warn(`[ASSESSMENT] Non-fatal: failed to store event for mailbox ${mailbox.id}`, {
            organizationId, error: err.message,
        });
    }

    // ── 3. Slack alert ──
    SlackAlertService.sendAlert({
        organizationId,
        eventType: 'mailbox_paused',
        entityId: mailbox.id,
        severity: 'critical',
        title: 'Mailbox Paused (Assessment)',
        message: `Mailbox \`${mailbox.email}\` has been paused during infrastructure assessment.\n*Reason:* ${reason}`,
    }).catch(err => logger.warn('[ASSESSMENT] Non-fatal Slack alert error', { error: String(err) }));

    // ── 4. Platform removal: remove mailbox from all assigned campaigns ──
    try {
        const adapter = await getAdapterForMailbox(mailbox.id);
        const campaigns = await prisma.campaign.findMany({
            where: { mailboxes: { some: { id: mailbox.id } } },
            select: { id: true, external_id: true, name: true },
        });

        for (const campaign of campaigns) {
            try {
                await adapter.removeMailboxFromCampaign(
                    organizationId,
                    campaign.external_id || campaign.id,
                    mailbox.external_email_account_id || mailbox.id,
                );
            } catch (removeErr: any) {
                logger.warn(`[ASSESSMENT] Failed to remove mailbox ${mailbox.id} from campaign ${campaign.id}`, {
                    organizationId, error: removeErr.message,
                });
            }
        }

        logger.info(`[ASSESSMENT] Removed paused mailbox ${mailbox.id} from ${campaigns.length} platform campaigns`, {
            organizationId, mailboxId: mailbox.id, platform: adapter.platform,
        });

        // ── 5. Rotation: attempt to rotate in a standby mailbox ──
        try {
            const rotationResult = await rotationService.rotateForPausedMailbox(
                organizationId,
                mailbox.id,
                campaigns,
            );
            logger.info(`[ASSESSMENT] Rotation result for paused mailbox ${mailbox.id}`, {
                organizationId,
                rotationsSucceeded: rotationResult.rotationsSucceeded,
                rotationsFailed: rotationResult.rotationsFailed,
                noStandbyAvailable: rotationResult.noStandbyAvailable,
            });
        } catch (rotationError: any) {
            logger.warn(`[ASSESSMENT] Rotation failed for paused mailbox ${mailbox.id}`, {
                organizationId, error: rotationError.message,
            });
        }
    } catch (platformError: any) {
        // Platform enforcement failure must NOT crash the assessment
        logger.error(`[ASSESSMENT] Failed platform enforcement for mailbox ${mailbox.id}`, platformError, {
            organizationId, mailboxId: mailbox.id,
        });
    }
}

// ─── DNS Assessment ──────────────────────────────────────────────────────────

/**
 * Check if a domain has a valid SPF record.
 */
async function checkSPF(domainName: string): Promise<boolean | null> {
    try {
        const records = await resolveTxt(domainName);
        const flat = records.map(r => r.join('')).join(' ');
        return flat.includes('v=spf1');
    } catch (err: any) {
        if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
            return false;
        }
        // DNS failure — cannot determine
        return null;
    }
}

/**
 * Check if a domain has a DKIM record by trying common selectors in parallel.
 */
async function checkDKIM(domainName: string): Promise<boolean | null> {
    const results = await Promise.allSettled(
        DKIM_SELECTORS.map(selector => resolveTxt(`${selector}._domainkey.${domainName}`))
    );

    for (const result of results) {
        if (result.status === 'fulfilled') {
            const flat = result.value.map(r => r.join('')).join(' ');
            if (flat.includes('v=DKIM1') || flat.includes('k=rsa') || flat.includes('p=')) {
                return true;
            }
        }
    }

    // None of the selectors matched — DKIM not configured on known selectors
    return false;
}

/**
 * Check DMARC policy for a domain.
 * Returns the policy value ('none', 'quarantine', 'reject') or null if not found.
 */
async function checkDMARC(domainName: string): Promise<string | null> {
    try {
        const records = await resolveTxt(`_dmarc.${domainName}`);
        const flat = records.map(r => r.join('')).join(' ');

        if (!flat.includes('v=DMARC1')) return null;

        const policyMatch = flat.match(/p=(\w+)/);
        return policyMatch ? policyMatch[1].toLowerCase() : null;
    } catch (err: any) {
        if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
            return null;
        }
        return null;
    }
}

// checkBlacklist() has been replaced by dnsblService.checkDomainBlacklists()
// which supports 400+ tiered DNSBL lists with concurrency throttling.

/**
 * Perform full DNS assessment for a domain.
 * Checks SPF, DKIM, DMARC, and blacklists (via dnsblService).
 *
 * @param domainName - The domain to assess
 * @param domainId - The domain's database ID (for DNSBL result persistence)
 * @param dnsblLists - Pre-fetched DNSBL lists for this run (from dnsblService.getListsForRun)
 */
export async function assessDomainDNS(
    domainName: string,
    domainId?: string,
    dnsblLists?: import('@prisma/client').DnsblList[]
): Promise<DomainDNSResult> {
    const [spfValid, dkimValid, dmarcPolicy] = await Promise.all([
        checkSPF(domainName),
        checkDKIM(domainName),
        checkDMARC(domainName),
    ]);

    // Check blacklists via dnsblService (tiered, throttled, 400+ lists)
    let blacklistResults: Record<string, BlacklistStatus> = {};
    let blacklistPenalty = 0;
    let dnsblCheckResult: dnsblService.DnsblCheckResult | null = null;

    if (domainId && dnsblLists && dnsblLists.length > 0) {
        dnsblCheckResult = await dnsblService.checkDomainBlacklists(domainName, domainId, dnsblLists);
        blacklistPenalty = dnsblCheckResult.penalty;

        // Build legacy-compatible blacklistResults for backward compatibility
        for (const r of dnsblCheckResult.results) {
            if (r.status !== 'SKIPPED') {
                blacklistResults[r.listName] = r.status;
            }
        }

        // Persist detailed results to DnsblResult table
        await dnsblService.persistResults(domainId, dnsblCheckResult.results, dnsblCheckResult.penalty, dnsblCheckResult.summary);
    } else {
        // Fallback: check critical lists only (for healingService quarantine gate calls without pre-fetched lists)
        const criticalLists = await dnsblService.getListsForRun('critical_only');
        if (criticalLists.length > 0 && domainId) {
            dnsblCheckResult = await dnsblService.checkDomainBlacklists(domainName, domainId, criticalLists);
            blacklistPenalty = dnsblCheckResult.penalty;
            for (const r of dnsblCheckResult.results) {
                if (r.status !== 'SKIPPED') {
                    blacklistResults[r.listName] = r.status;
                }
            }
            await dnsblService.persistResults(domainId, dnsblCheckResult.results, dnsblCheckResult.penalty, dnsblCheckResult.summary);
        }
    }

    // Calculate domain assessment score (0-100)
    let score = 100;

    // SPF penalty
    if (spfValid === false) score -= 25;
    else if (spfValid === null) score -= 15;

    // DKIM penalty
    if (dkimValid === false) score -= 20;
    else if (dkimValid === null) score -= 10;

    // DMARC penalty
    if (dmarcPolicy === null) score -= 15;
    else if (dmarcPolicy === 'none') score -= 10;

    // Blacklist penalty (weighted, from dnsblService)
    score += blacklistPenalty; // penalty is already negative

    score = Math.max(0, score);

    return {
        domainName,
        spfValid,
        dkimValid,
        dmarcPolicy,
        blacklistResults,
        score,
        _dnsblCheckResult: dnsblCheckResult, // Attach for tier-aware pause logic
    };
}

// ─── Main Assessment Orchestrator ────────────────────────────────────────────

/**
 * Run the full infrastructure assessment for an organization.
 * 
 * Flow:
 * 1. Lock the execution gate (assessment_completed = false)
 * 2. Assess all domains (DNS + blacklists)
 * 3. Assess all mailboxes (historical bounce rates)
 * 4. Assess all campaigns (historical performance)
 * 5. Enforce campaign-infra invariant
 * 6. Generate and persist InfrastructureReport
 * 7. Log onboarding audit summary event
 * 8. Unlock the execution gate (assessment_completed = true)
 */
export async function assessInfrastructure(
    organizationId: string,
    reportType: 'onboarding' | 'manual_reassessment' = 'onboarding'
): Promise<AssessmentResult> {
    logger.info('Infrastructure assessment started', { organizationId, reportType });

    // ── Step 1: Lock the gate ──
    await prisma.organization.update({
        where: { id: organizationId },
        data: { assessment_completed: false },
    });

    const findings: Finding[] = [];
    const recommendations: Recommendation[] = [];

    try {
        // ── Step 2: Assess all domains ──
        const domains = await prisma.domain.findMany({
            where: { organization_id: organizationId },
            include: { mailboxes: true },
        });

        const domainSummary = { total: domains.length, healthy: 0, warning: 0, paused: 0 };

        // Determine DNSBL check depth from organization's subscription tier
        const org = await prisma.organization.findUnique({ where: { id: organizationId } });
        const tierLimits = TIER_LIMITS[org?.subscription_tier || 'trial'] || TIER_LIMITS.trial;
        const dnsblDepth = (tierLimits as any).dnsblDepth || 'critical_only';

        // Pre-fetch DNSBL lists once for the entire run (avoids N queries)
        const dnsblLists = await dnsblService.getListsForRun(dnsblDepth);
        dnsblService.clearIpCache(); // Fresh cache for each assessment run

        // Assess all domains — batch in groups of 10 to avoid overwhelming DNS resolvers
        const DOMAIN_BATCH_SIZE = 10;
        const dnsResults: PromiseSettledResult<DomainDNSResult>[] = [];
        for (let b = 0; b < domains.length; b += DOMAIN_BATCH_SIZE) {
            const batch = domains.slice(b, b + DOMAIN_BATCH_SIZE);
            const batchResults = await Promise.allSettled(
                batch.map(domain => assessDomainDNS(domain.domain, domain.id, dnsblLists))
            );
            dnsResults.push(...batchResults);
        }

        // Process results and write DB updates in parallel
        await Promise.allSettled(domains.map(async (domain, i) => {
            const settled = dnsResults[i];

            if (settled.status === 'rejected') {
                // Entire DNS assessment failed for this domain — treat conservatively as warning
                findings.push({
                    severity: 'warning',
                    category: 'domain_dns',
                    entity: 'domain',
                    entityId: domain.id,
                    entityName: domain.domain,
                    title: `DNS Assessment Failed: ${domain.domain}`,
                    details: `Could not assess DNS for this domain. Trigger a manual re-assessment.`,
                    message: `Domain ${domain.domain}: DNS assessment failed — ${settled.reason?.message || 'unknown error'}.`,
                    remediation: `Verify DNS is accessible and trigger a manual re-assessment.`,
                });
                domainSummary.warning++;
                return;
            }

            const dnsResult = settled.value;

            // Determine domain state from DNS results
            let domainState = 'healthy';

            // Check blacklists — tier-aware pause logic via dnsblService
            const dnsblCheck = dnsResult._dnsblCheckResult;
            if (dnsblCheck) {
                const { shouldPause, reason } = dnsblService.isBlockingBlacklisted(dnsblCheck.results, dnsblLists);

                if (shouldPause) {
                    domainState = 'paused';
                    const confirmedLists = dnsblCheck.results
                        .filter(r => r.status === 'CONFIRMED')
                        .map(r => r.listName);

                    findings.push({
                        severity: 'critical',
                        category: 'domain_dns',
                        entity: 'domain',
                        entityId: domain.id,
                        entityName: domain.domain,
                        title: `Blacklisted: ${domain.domain}`,
                        details: `${reason}. Listed on: ${confirmedLists.join(', ')}. Submit delisting requests and trigger a manual re-assessment.`,
                        message: `Domain ${domain.domain} is listed on blacklist(s): ${confirmedLists.join(', ')}`,
                        remediation: `Visit the blacklist removal pages and submit a delisting request. After confirmed removal, trigger a manual re-assessment.`,
                    });
                } else if (dnsblCheck.summary.total_listed > 0) {
                    // Listed on minor lists only — warning, no pause
                    if (domainState === 'healthy') domainState = 'warning';
                    const minorListed = dnsblCheck.results
                        .filter(r => r.status === 'CONFIRMED' && r.tier === 'minor')
                        .map(r => r.listName);

                    findings.push({
                        severity: 'warning',
                        category: 'domain_dns',
                        entity: 'domain',
                        entityId: domain.id,
                        entityName: domain.domain,
                        title: `Minor Blacklist Listing: ${domain.domain}`,
                        details: `Listed on ${minorListed.length} minor blacklist(s): ${minorListed.join(', ')}. Monitor but no action required.`,
                        message: `Domain ${domain.domain} is listed on minor blacklist(s): ${minorListed.join(', ')}`,
                        remediation: `Minor blacklist listings typically resolve automatically. Monitor for escalation to major lists.`,
                    });
                }

                // UNREACHABLE checks → warning
                const unreachableCount = dnsblCheck.results.filter(r => r.status === 'UNREACHABLE').length;
                if (unreachableCount > 0 && domainState !== 'paused') {
                    if (domainState === 'healthy') domainState = 'warning';
                    findings.push({
                        severity: 'warning',
                        category: 'domain_dns',
                        entity: 'domain',
                        entityId: domain.id,
                        entityName: domain.domain,
                        title: `Blacklist Check Unreachable: ${domain.domain}`,
                        details: `${unreachableCount} blacklist check(s) could not be completed. Re-assess later.`,
                        message: `Domain ${domain.domain}: ${unreachableCount} blacklist check(s) unreachable. Cannot confirm clean status.`,
                        remediation: `Trigger a manual re-assessment later to verify blacklist status. Do not assume clean.`,
                    });
                }
            } else {
                // No DNSBL check was performed — legacy fallback
                const hasConfirmedBlacklist = Object.values(dnsResult.blacklistResults)
                    .some(s => s === 'CONFIRMED');
                if (hasConfirmedBlacklist) {
                    domainState = 'paused';
                    const confirmedLists = Object.entries(dnsResult.blacklistResults)
                        .filter(([, s]) => s === 'CONFIRMED')
                        .map(([name]) => name);
                    findings.push({
                        severity: 'critical',
                        category: 'domain_dns',
                        entity: 'domain',
                        entityId: domain.id,
                        entityName: domain.domain,
                        title: `Blacklisted: ${domain.domain}`,
                        details: `Listed on: ${confirmedLists.join(', ')}. Submit delisting requests.`,
                        message: `Domain ${domain.domain} is listed on blacklist(s): ${confirmedLists.join(', ')}`,
                        remediation: `Visit the blacklist removal pages and submit a delisting request.`,
                    });
                }
            }

            // Missing SPF → warning
            if (dnsResult.spfValid === false) {
                if (domainState === 'healthy') domainState = 'warning';
                findings.push({
                    severity: 'warning',
                    category: 'domain_dns',
                    entity: 'domain',
                    entityId: domain.id,
                    entityName: domain.domain,
                    title: `Missing SPF: ${domain.domain}`,
                    details: `No SPF record found. Add a TXT record: "v=spf1 include:_spf.google.com ~all"`,
                    message: `Domain ${domain.domain} has no SPF record configured.`,
                    remediation: `Add a TXT record to your DNS: "v=spf1 include:_spf.google.com ~all" (adjust for your email provider).`,
                });
            } else if (dnsResult.spfValid === null) {
                if (domainState === 'healthy') domainState = 'warning';
                findings.push({
                    severity: 'warning',
                    category: 'domain_dns',
                    entity: 'domain',
                    entityId: domain.id,
                    entityName: domain.domain,
                    title: `SPF Check Failed: ${domain.domain}`,
                    details: `DNS unreachable — cannot verify SPF. Trigger manual re-assessment.`,
                    message: `Domain ${domain.domain}: SPF record check failed (DNS unreachable).`,
                    remediation: `Verify DNS configuration is accessible. Trigger manual re-assessment.`,
                });
            }

            // Missing DKIM → warning
            if (dnsResult.dkimValid === false) {
                if (domainState === 'healthy') domainState = 'warning';
                findings.push({
                    severity: 'warning',
                    category: 'domain_dns',
                    entity: 'domain',
                    entityId: domain.id,
                    entityName: domain.domain,
                    title: `Missing DKIM: ${domain.domain}`,
                    details: `No DKIM record found on common selectors. Enable DKIM signing in your email provider.`,
                    message: `Domain ${domain.domain} has no DKIM record configured (checked common selectors).`,
                    remediation: `Enable DKIM signing in your email provider and add the DKIM TXT record to DNS.`,
                });
            }

            // Missing DMARC → info (not as critical, but worth noting)
            if (dnsResult.dmarcPolicy === null) {
                findings.push({
                    severity: 'info',
                    category: 'domain_dns',
                    entity: 'domain',
                    entityId: domain.id,
                    entityName: domain.domain,
                    title: `Missing DMARC: ${domain.domain}`,
                    details: `Add a DMARC record at _dmarc.${domain.domain} to improve deliverability.`,
                    message: `Domain ${domain.domain} has no DMARC policy configured.`,
                    remediation: `Add a TXT record at _dmarc.${domain.domain}: "v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain.domain}"`,
                });
            } else if (dnsResult.dmarcPolicy === 'none') {
                findings.push({
                    severity: 'info',
                    category: 'domain_dns',
                    entity: 'domain',
                    entityId: domain.id,
                    entityName: domain.domain,
                    title: `Weak DMARC: ${domain.domain}`,
                    details: `DMARC set to 'none' (monitoring only). Upgrade to p=quarantine or p=reject.`,
                    message: `Domain ${domain.domain} has DMARC policy set to 'none' (monitoring only, not enforcing).`,
                    remediation: `Consider upgrading to p=quarantine or p=reject once SPF and DKIM are stable.`,
                });
            }

            // Update domain DNS results (operational fields)
            // Note: blacklist_results and blacklist_score are already persisted by dnsblService.persistResults()
            // inside assessDomainDNS(). Here we only update SPF/DKIM/DMARC and the assessment score.
            await prisma.domain.update({
                where: { id: domain.id },
                data: {
                    spf_valid: dnsResult.spfValid,
                    dkim_valid: dnsResult.dkimValid,
                    dmarc_policy: dnsResult.dmarcPolicy,
                    dns_checked_at: new Date(),
                    initial_assessment_score: dnsResult.score,
                    ...(domainState === 'paused' ? {
                        paused_reason: 'Infrastructure assessment: domain health issues detected',
                    } : {}),
                },
            });

            // Set domain status via state machine (assessment uses setInitial to bypass transition validation)
            if (domainState !== domain.status) {
                await entityStateService.setInitialDomainStatus(
                    organizationId, domain.id, domainState as DomainState,
                    `Infrastructure assessment: DNS health check`, TriggerType.SYSTEM
                );
            }

            // Count states
            if (domainState === 'healthy') domainSummary.healthy++;
            else if (domainState === 'warning') domainSummary.warning++;
            else if (domainState === 'paused') domainSummary.paused++;
        }));

        // ── Step 3: Assess all mailboxes (historical data) ──
        const mailboxes = await prisma.mailbox.findMany({
            where: { organization_id: organizationId },
            include: { domain: true },
        });

        const mailboxSummary = { total: mailboxes.length, healthy: 0, warning: 0, paused: 0 };

        for (const mailbox of mailboxes) {
            // CRITICAL: Respect connection status from Smartlead sync
            // Disconnected mailboxes must remain paused regardless of bounce metrics
            if (mailbox.smtp_status === false || mailbox.imap_status === false) {
                const connectionError = mailbox.connection_error || 'Unknown connection issue';
                findings.push({
                    severity: 'critical' as const,
                    category: 'mailbox_health',
                    entity: 'mailbox',
                    entityId: mailbox.id,
                    entityName: mailbox.email,
                    title: `Connection Failed: ${mailbox.email}`,
                    details: `SMTP: ${mailbox.smtp_status ? 'OK' : 'FAILED'}, IMAP: ${mailbox.imap_status ? 'OK' : 'FAILED'}. Error: ${connectionError}`,
                    message: `Mailbox ${mailbox.email} has a broken connection and cannot send/receive email.`,
                    remediation: `Re-authorize this email account in Smartlead → Email Accounts → Reconnect.`,
                });

                // Force paused via state machine — skip bounce rate logic entirely
                if (mailbox.status !== 'paused') {
                    const pauseReason = `Connection failed: SMTP=${mailbox.smtp_status}, IMAP=${mailbox.imap_status}`;
                    await entityStateService.setInitialMailboxStatus(
                        organizationId, mailbox.id, MailboxState.PAUSED,
                        pauseReason, TriggerType.SYSTEM
                    );
                    // Enforce platform removal + healing pipeline entry
                    await enforceMailboxPause(organizationId, mailbox, pauseReason);
                }
                await prisma.mailbox.update({
                    where: { id: mailbox.id },
                    data: { initial_assessment_at: new Date() },
                });
                mailboxSummary.paused++;
                continue; // Skip bounce rate assessment for disconnected mailboxes
            }

            // Calculate bounce rate from existing counters
            // (These are populated by Smartlead sync if getMailboxStats was called)
            const totalSent = mailbox.total_sent_count;
            const totalBounced = mailbox.hard_bounce_count;
            const bounceRate = totalSent > 0 ? totalBounced / totalSent : 0;

            let mailboxState = 'healthy';

            // Volume-aware bounce rate assessment (3% threshold after 60 sends)
            if (totalSent >= MAILBOX_THRESHOLDS.MIN_SENDS_FOR_PAUSE) {
                // After 60 sends: Apply 3% pause threshold
                if (bounceRate >= MAILBOX_THRESHOLDS.PAUSE_BOUNCE_RATE) {
                    mailboxState = 'paused';
                    findings.push({
                        severity: 'critical',
                        category: 'mailbox_health',
                        entity: 'mailbox',
                        entityId: mailbox.id,
                        entityName: mailbox.email,
                        title: `High Bounce Rate: ${mailbox.email}`,
                        details: `Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds ${(MAILBOX_THRESHOLDS.PAUSE_BOUNCE_RATE * 100)}% threshold after ${totalSent} sends. Mailbox paused; enters healing pipeline.`,
                        message: `Mailbox ${mailbox.email} has a bounce rate of ${(bounceRate * 100).toFixed(1)}% (>${(MAILBOX_THRESHOLDS.PAUSE_BOUNCE_RATE * 100)}% threshold) after ${totalSent} sends.`,
                        remediation: `This mailbox has been paused to protect domain reputation. Review email list quality and remove invalid addresses before resuming.`,
                    });
                } else if (bounceRate >= MAILBOX_THRESHOLDS.WARNING_BOUNCE_RATE) {
                    mailboxState = 'warning';
                    findings.push({
                        severity: 'warning',
                        category: 'mailbox_health',
                        entity: 'mailbox',
                        entityId: mailbox.id,
                        entityName: mailbox.email,
                        title: `Elevated Bounce Rate: ${mailbox.email}`,
                        details: `Bounce rate ${(bounceRate * 100).toFixed(1)}% approaching 3% threshold. Clean email list recommended.`,
                        message: `Mailbox ${mailbox.email} has a bounce rate of ${(bounceRate * 100).toFixed(1)}% (approaching 3% pause threshold).`,
                        remediation: `Monitor closely. Verify email list quality and remove invalid addresses to prevent auto-pause.`,
                    });
                }
            } else if (totalSent >= MAILBOX_THRESHOLDS.MIN_SENDS_FOR_WARNING) {
                // Early phase (20-60 sends): Show warning at 3%
                if (bounceRate >= MAILBOX_THRESHOLDS.EARLY_WARNING) {
                    mailboxState = 'warning';
                    findings.push({
                        severity: 'warning',
                        category: 'mailbox_health',
                        entity: 'mailbox',
                        entityId: mailbox.id,
                        entityName: mailbox.email,
                        title: `Early Bounce Signal: ${mailbox.email}`,
                        details: `Bounce rate ${(bounceRate * 100).toFixed(1)}% on ${totalSent} sends. Will auto-pause at 3% after 60 sends.`,
                        message: `Mailbox ${mailbox.email} showing ${(bounceRate * 100).toFixed(1)}% bounce rate in early sending phase.`,
                        remediation: `Monitor email list quality. Small sample size - pattern will be confirmed after 60 sends.`,
                    });
                }
            }
            // Below 20 sends: Too early to judge, remain healthy

            // NOTE: Domain-health ceiling removed. Mailboxes are assessed independently
            // on their own bounce metrics. A domain DNS issue does not mean the mailbox
            // itself is unhealthy — the mailbox status should reflect its own sending health.

            // Update operational fields
            await prisma.mailbox.update({
                where: { id: mailbox.id },
                data: {
                    initial_bounce_rate: bounceRate,
                    initial_assessment_at: new Date(),
                },
            });

            // Set mailbox status via state machine (assessment uses setInitial to bypass transition validation)
            if (mailboxState !== mailbox.status) {
                const assessmentReason = `Infrastructure assessment: bounce rate ${(bounceRate * 100).toFixed(1)}%`;
                await entityStateService.setInitialMailboxStatus(
                    organizationId, mailbox.id, mailboxState as MailboxState,
                    assessmentReason, TriggerType.SYSTEM
                );
                // If paused: enforce platform removal + healing pipeline entry
                if (mailboxState === 'paused') {
                    await enforceMailboxPause(organizationId, mailbox, assessmentReason);
                }
            }

            if (mailboxState === 'healthy') mailboxSummary.healthy++;
            else if (mailboxState === 'warning') mailboxSummary.warning++;
            else if (mailboxState === 'paused') mailboxSummary.paused++;
        }

        // ── Step 4: Assess all campaigns ──
        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: organizationId, status: { not: 'deleted' } },
            include: {
                mailboxes: { include: { domain: true } },
            },
        });

        const campaignSummary = { total: campaigns.length, active: 0, warning: 0, paused: 0 };

        for (const campaign of campaigns) {
            let campaignState = campaign.status; // Preserve existing status if already set

            // ── INFRASTRUCTURE-ONLY CAMPAIGN ASSESSMENT ──
            // RULE: Campaigns are NEVER paused based on bounce rate.
            //       Campaigns pause ONLY when ALL mailboxes are paused/removed.
            //       Campaigns warn when >50% of mailboxes are degraded.
            if (campaignState === 'active') {
                if (campaign.mailboxes.length === 0) {
                    // No mailboxes — campaign cannot send
                    campaignState = 'paused';
                    findings.push({
                        severity: 'critical',
                        category: 'campaign_health',
                        entity: 'campaign',
                        entityId: campaign.id,
                        entityName: campaign.name,
                        title: `No Mailboxes: ${campaign.name}`,
                        details: `Campaign has no mailboxes assigned and cannot send emails.`,
                        message: `Campaign "${campaign.name}" has no mailboxes assigned.`,
                        remediation: `Assign healthy mailboxes to this campaign to resume sending.`,
                    });
                } else {
                    const healthyMailboxes = campaign.mailboxes.filter(m =>
                        m.status === 'healthy' && m.domain.status !== 'paused'
                    );
                    const pausedMailboxes = campaign.mailboxes.filter(m =>
                        m.status === 'paused' || m.domain.status === 'paused'
                    );

                    if (healthyMailboxes.length === 0) {
                        // ALL mailboxes paused/removed — pause campaign
                        campaignState = 'paused';
                        findings.push({
                            severity: 'critical',
                            category: 'campaign_health',
                            entity: 'campaign',
                            entityId: campaign.id,
                            entityName: campaign.name,
                            title: `All Mailboxes Paused: ${campaign.name}`,
                            details: `All ${campaign.mailboxes.length} mailboxes are paused or have paused domains. Campaign cannot send.`,
                            message: `Campaign "${campaign.name}" paused because all mailboxes are paused/removed.`,
                            remediation: `Resolve mailbox health issues. Campaign will resume when healthy mailboxes are available.`,
                        });
                    } else if (pausedMailboxes.length > campaign.mailboxes.length * 0.5) {
                        // >50% mailboxes degraded — warn
                        campaignState = 'warning';
                        findings.push({
                            severity: 'warning',
                            category: 'campaign_health',
                            entity: 'campaign',
                            entityId: campaign.id,
                            entityName: campaign.name,
                            title: `Degraded Infrastructure: ${campaign.name}`,
                            details: `${pausedMailboxes.length}/${campaign.mailboxes.length} mailboxes are paused. Campaign at risk of stalling.`,
                            message: `Campaign "${campaign.name}" has ${pausedMailboxes.length} of ${campaign.mailboxes.length} mailboxes paused.`,
                            remediation: `Resolve mailbox issues to maintain sending capacity. Campaign will auto-pause if all mailboxes are removed.`,
                        });
                    }
                }
            }

            // Update campaign status via central authority (campaignHealthService handles platform sync)
            if (campaignState !== campaign.status) {
                if (campaignState === 'paused') {
                    await campaignHealthService.pauseCampaign(
                        organizationId, campaign.id,
                        'Infrastructure assessment: all mailboxes paused/removed'
                    );
                } else if (campaignState === 'warning') {
                    await campaignHealthService.warnCampaign(
                        organizationId, campaign.id,
                        'Infrastructure assessment: >50% mailboxes degraded'
                    );
                } else if (campaignState === 'active' && campaign.status === 'paused') {
                    await campaignHealthService.resumeCampaign(organizationId, campaign.id);
                }
            }

            if (campaignState === 'active' || campaignState === 'completed' || campaignState === 'drafted') campaignSummary.active++;
            else if (campaignState === 'warning') campaignSummary.warning++;
            else if (campaignState === 'paused' || campaignState === 'stopped' || campaignState === 'inactive') campaignSummary.paused++;
        }

        // ── Step 5: Generate recommendations ──
        // Sort findings by severity for prioritised recommendations
        const criticalCount = findings.filter(f => f.severity === 'critical').length;
        const warningCount = findings.filter(f => f.severity === 'warning').length;

        if (criticalCount > 0) {
            recommendations.push({
                priority: 1,
                action: 'Address critical issues immediately',
                details: `${criticalCount} critical issue(s) found. Blacklisted domains and high-bounce mailboxes have been paused. Resolve blacklist listings and verify email list quality before resuming.`,
                reason: `${criticalCount} critical issue(s) found. Blacklisted domains and high-bounce mailboxes have been paused. Resolve blacklist listings and verify email list quality before resuming.`,
                link: '/dashboard/domains',
            });
        }

        if (warningCount > 0) {
            recommendations.push({
                priority: 2,
                action: 'Review warning-level issues',
                details: `${warningCount} warning(s) found. Missing DNS authentication records and elevated bounce rates need attention. These entities are operational but at elevated risk.`,
                reason: `${warningCount} warning(s) found. Missing DNS authentication records and elevated bounce rates need attention. These entities are operational but at elevated risk.`,
                link: '/dashboard/domains',
            });
        }

        const domainsWithoutDMARC = domains.filter(d => !findings.some(
            f => f.entityId === d.id && f.message.includes('DMARC')
        )).length === 0;

        if (!domainsWithoutDMARC) {
            recommendations.push({
                priority: 3,
                action: 'Configure DMARC policies',
                details: `Some domains are missing DMARC policies. While not blocking, DMARC significantly improves deliverability and protects against spoofing.`,
                reason: `Some domains are missing DMARC policies. While not blocking, DMARC significantly improves deliverability and protects against spoofing.`,
                link: '/dashboard/domains',
            });
        }

        // ── Step 6: Calculate overall score ──
        const totalEntities = domainSummary.total + mailboxSummary.total + campaignSummary.total;
        const healthyEntities = domainSummary.healthy + mailboxSummary.healthy + campaignSummary.active;
        const overallScore = totalEntities > 0
            ? Math.round((healthyEntities / totalEntities) * 100)
            : 100;

        const summary = {
            domains: domainSummary,
            mailboxes: mailboxSummary,
            campaigns: campaignSummary,
        };

        // ── Step 7: Persist report ──
        await prisma.infrastructureReport.create({
            data: {
                organization_id: organizationId,
                report_type: reportType,
                assessment_version: ASSESSMENT_VERSION,
                overall_score: overallScore,
                summary,
                findings: findings as unknown as Prisma.InputJsonValue,
                recommendations: recommendations as unknown as Prisma.InputJsonValue,
            },
        });

        // ── Step 8: Log onboarding audit summary event ──
        await auditLogService.logAction({
            organizationId,
            entity: 'system',
            trigger: 'infrastructure_assessment',
            action: 'assessment_completed',
            details: JSON.stringify({
                reportType,
                overallScore,
                domains: domainSummary,
                mailboxes: mailboxSummary,
                campaigns: campaignSummary,
                criticalFindings: criticalCount,
                warningFindings: warningCount,
            }),
        });

        logger.info('Infrastructure assessment completed', {
            organizationId,
            overallScore,
            domains: domainSummary,
            mailboxes: mailboxSummary,
            campaigns: campaignSummary,
        });

        // ── Step 9: Unlock the gate ──
        await prisma.organization.update({
            where: { id: organizationId },
            data: { assessment_completed: true },
        });

        // ── Step 10: Notify user of assessment results ──
        try {
            const notifType = criticalCount > 0 ? 'ERROR' as const : warningCount > 0 ? 'WARNING' as const : 'SUCCESS' as const;
            const statusSummary = [
                criticalCount > 0 ? `${criticalCount} critical` : null,
                warningCount > 0 ? `${warningCount} warning` : null,
            ].filter(Boolean).join(', ');

            await notificationService.createNotification(organizationId, {
                type: notifType,
                title: 'Infrastructure Assessment Complete',
                message: `Your infrastructure scored ${overallScore}/100. ${statusSummary ? `Found: ${statusSummary} issue(s).` : 'No issues found.'} View the full report on the Infrastructure page.`,
            });
        } catch (notifError) {
            logger.warn('Failed to create assessment notification', { organizationId });
        }

        return { overallScore, summary, findings, recommendations };

    } catch (error: any) {
        logger.error(`Infrastructure assessment failed for org ${organizationId}: ${error.message}`);

        // Log the failure
        await auditLogService.logAction({
            organizationId,
            entity: 'system',
            trigger: 'infrastructure_assessment',
            action: 'assessment_failed',
            details: error.message,
        });

        // Notify user of failure
        try {
            await notificationService.createNotification(organizationId, {
                type: 'ERROR',
                title: 'Infrastructure Assessment Failed',
                message: `The infrastructure assessment could not be completed: ${error.message}. The execution gate remains locked — trigger a manual reassessment from the Infrastructure page.`,
            });
        } catch (notifError) {
            logger.warn('Failed to create assessment failure notification', { organizationId });
        }

        // Unlock the gate on failure so the user isn't permanently stuck
        await prisma.organization.update({
            where: { id: organizationId },
            data: { assessment_completed: true },
        });

        throw error;
    }
}

/**
 * Get the latest infrastructure report for an organization.
 */
export async function getLatestReport(organizationId: string) {
    return prisma.infrastructureReport.findFirst({
        where: { organization_id: organizationId },
        orderBy: { created_at: 'desc' },
    });
}

/**
 * Get infrastructure reports for an organization.
 * @param days — how many days of history to return (default 30, max 90)
 */
export async function getReports(organizationId: string, days: number = 30) {
    const since = new Date();
    since.setDate(since.getDate() - Math.min(days, 90));

    return prisma.infrastructureReport.findMany({
        where: {
            organization_id: organizationId,
            created_at: { gte: since },
        },
        orderBy: { created_at: 'desc' },
    });
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * State severity ranking (higher = worse).
 */
function stateRank(state: string): number {
    switch (state) {
        case 'healthy':
        case 'active':
            return 0;
        case 'warning':
            return 1;
        case 'paused':
            return 2;
        default:
            return 0;
    }
}

/**
 * Get the worst (highest severity) state from a list of states.
 */
function getWorstState(states: string[]): string {
    let worst = 'healthy';
    for (const state of states) {
        if (stateRank(state) > stateRank(worst)) {
            worst = state;
        }
    }
    return worst;
}

// ============================================================================
// PERIODIC SCHEDULING (Task #2: Domain health check sync intervals)
// ============================================================================

export function startPeriodicAssessment() {
    if (periodicAssessmentInterval) {
        clearInterval(periodicAssessmentInterval);
    }
    logger.info(`Starting periodic infrastructure assessment worker (interval: ${ASSESSMENT_INTERVAL_MS}ms)`);
    periodicAssessmentInterval = setInterval(async () => {
        try {
            logger.info('[PeriodicAssessment] Running scheduled infrastructure assessment for all orgs');
            // Fetch all active organizations
            const orgs = await prisma.organization.findMany({ select: { id: true } });
            for (const org of orgs) {
                try {
                    // Start assessment but do not block the gate permanently.
                    // "manual_reassessment" creates report, metricsWorker picks it up.
                    await assessInfrastructure(org.id, 'manual_reassessment');
                } catch (orgErr) {
                    logger.error(`[PeriodicAssessment] Error assessing org ${org.id}`, orgErr instanceof Error ? orgErr : new Error(String(orgErr)));
                }
            }
        } catch (error) {
            logger.error('[PeriodicAssessment] Error in periodic infrastructure assessment loop', error instanceof Error ? error : new Error(String(error)));
        }
    }, ASSESSMENT_INTERVAL_MS);
}

export function stopPeriodicAssessment() {
    if (periodicAssessmentInterval) {
        clearInterval(periodicAssessmentInterval);
        periodicAssessmentInterval = null;
        logger.info('Stopped periodic infrastructure assessment worker');
    }
}
