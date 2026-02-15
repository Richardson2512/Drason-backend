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
import { prisma } from '../index';
import * as auditLogService from './auditLogService';
import * as notificationService from './notificationService';
import { logger } from './observabilityService';

const _resolveTxt = promisify(dns.resolveTxt);
const _resolve4 = promisify(dns.resolve4);

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

async function resolveTxt(hostname: string): Promise<string[][]> {
    const cached = txtCache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) {
        if (cached.value === null) throw Object.assign(new Error('cached ENODATA'), { code: 'ENODATA' });
        return cached.value;
    }
    try {
        const result = await _resolveTxt(hostname);
        txtCache.set(hostname, { value: result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
        return result;
    } catch (err) {
        txtCache.set(hostname, { value: null, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
        throw err;
    }
}

async function resolve4(hostname: string): Promise<string[]> {
    const cached = a4Cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) {
        if (cached.value === null) throw Object.assign(new Error('cached ENODATA'), { code: 'ENODATA' });
        return cached.value;
    }
    try {
        const result = await _resolve4(hostname);
        a4Cache.set(hostname, { value: result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
        return result;
    } catch (err) {
        a4Cache.set(hostname, { value: null, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
        throw err;
    }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ASSESSMENT_VERSION = '1.0';

/** Blacklists to check via DNSBL reverse DNS lookup */
const BLACKLISTS = [
    { name: 'spamhaus', zone: 'zen.spamhaus.org' },
    { name: 'barracuda', zone: 'b.barracudacentral.org' },
    { name: 'sorbs', zone: 'dnsbl.sorbs.net' },
    { name: 'spamcop', zone: 'bl.spamcop.net' },
] as const;

/** Common DKIM selectors to check */
const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 's1', 's2'];

/** Mailbox classification thresholds */
const MAILBOX_THRESHOLDS = {
    PAUSE_BOUNCE_RATE: 0.10,   // >10% → paused
    WARNING_BOUNCE_RATE: 0.05, // 5-10% → warning
};

/** Campaign classification thresholds */
const CAMPAIGN_THRESHOLDS = {
    PAUSE_BOUNCE_RATE: 0.10,   // >10% → paused
    WARNING_BOUNCE_RATE: 0.05, // 5-10% → warning
};

// ─── Types ───────────────────────────────────────────────────────────────────

type BlacklistStatus = 'CONFIRMED' | 'NOT_LISTED' | 'UNREACHABLE';

interface DomainDNSResult {
    domainName: string;
    spfValid: boolean | null;
    dkimValid: boolean | null;
    dmarcPolicy: string | null;
    blacklistResults: Record<string, BlacklistStatus>;
    score: number;
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
 * Check if a domain has a DKIM record by trying common selectors.
 */
async function checkDKIM(domainName: string): Promise<boolean | null> {
    for (const selector of DKIM_SELECTORS) {
        try {
            const records = await resolveTxt(`${selector}._domainkey.${domainName}`);
            const flat = records.map(r => r.join('')).join(' ');
            if (flat.includes('v=DKIM1') || flat.includes('k=rsa') || flat.includes('p=')) {
                return true;
            }
        } catch {
            // Try next selector
        }
    }

    // None of the selectors resolved — could be DKIM not configured or custom selector
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

/**
 * Check a domain's IP against a single DNSBL blacklist.
 * Returns tri-state: CONFIRMED, NOT_LISTED, or UNREACHABLE.
 * 
 * RULE: UNREACHABLE is NEVER treated as clean.
 */
async function checkBlacklist(
    domainName: string,
    blacklistZone: string
): Promise<BlacklistStatus> {
    try {
        // First resolve the domain to IP
        const ips = await resolve4(domainName);
        if (!ips || ips.length === 0) return 'UNREACHABLE';

        const ip = ips[0];
        const reversed = ip.split('.').reverse().join('.');
        const query = `${reversed}.${blacklistZone}`;

        try {
            await resolve4(query);
            // If it resolves, the IP IS listed
            return 'CONFIRMED';
        } catch (err: any) {
            if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
                // Not listed — this is the clean result
                return 'NOT_LISTED';
            }
            // DNS lookup failed for unknown reason
            return 'UNREACHABLE';
        }
    } catch (err: any) {
        // Cannot resolve domain IP — cannot check
        return 'UNREACHABLE';
    }
}

/**
 * Perform full DNS assessment for a domain.
 * Checks SPF, DKIM, DMARC, and blacklists.
 */
export async function assessDomainDNS(domainName: string): Promise<DomainDNSResult> {
    const [spfValid, dkimValid, dmarcPolicy] = await Promise.all([
        checkSPF(domainName),
        checkDKIM(domainName),
        checkDMARC(domainName),
    ]);

    // Check all blacklists in parallel
    const blacklistChecks = await Promise.all(
        BLACKLISTS.map(async (bl) => ({
            name: bl.name,
            status: await checkBlacklist(domainName, bl.zone),
        }))
    );

    const blacklistResults: Record<string, BlacklistStatus> = {};
    for (const check of blacklistChecks) {
        blacklistResults[check.name] = check.status;
    }

    // Calculate domain assessment score (0-100)
    let score = 100;

    // SPF penalty
    if (spfValid === false) score -= 25;
    else if (spfValid === null) score -= 15; // Cannot determine

    // DKIM penalty
    if (dkimValid === false) score -= 20;
    else if (dkimValid === null) score -= 10;

    // DMARC penalty
    if (dmarcPolicy === null) score -= 15;
    else if (dmarcPolicy === 'none') score -= 10;

    // Blacklist penalties
    for (const [, status] of Object.entries(blacklistResults)) {
        if (status === 'CONFIRMED') score -= 30;
        else if (status === 'UNREACHABLE') score -= 10;
    }

    score = Math.max(0, score);

    return {
        domainName,
        spfValid,
        dkimValid,
        dmarcPolicy,
        blacklistResults,
        score,
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

        for (const domain of domains) {
            const dnsResult = await assessDomainDNS(domain.domain);

            // Determine domain state from DNS results
            let domainState = 'healthy';

            // Check blacklists — any CONFIRMED → paused
            const hasConfirmedBlacklist = Object.values(dnsResult.blacklistResults)
                .some(s => s === 'CONFIRMED');
            const hasUnreachableBlacklist = Object.values(dnsResult.blacklistResults)
                .some(s => s === 'UNREACHABLE');

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
                    details: `Listed on: ${confirmedLists.join(', ')}. Submit delisting requests and trigger a manual re-assessment.`,
                    message: `Domain ${domain.domain} is listed on blacklist(s): ${confirmedLists.join(', ')}`,
                    remediation: `Visit the blacklist removal pages for ${confirmedLists.join(', ')} and submit a delisting request. After confirmed removal, trigger a manual re-assessment.`,
                });
            }

            // UNREACHABLE blacklist checks → warning (never healthy)
            if (hasUnreachableBlacklist && domainState !== 'paused') {
                domainState = 'warning';
                const unreachableLists = Object.entries(dnsResult.blacklistResults)
                    .filter(([, s]) => s === 'UNREACHABLE')
                    .map(([name]) => name);

                findings.push({
                    severity: 'warning',
                    category: 'domain_dns',
                    entity: 'domain',
                    entityId: domain.id,
                    entityName: domain.domain,
                    title: `Blacklist Check Unreachable: ${domain.domain}`,
                    details: `Cannot confirm clean status for: ${unreachableLists.join(', ')}. Re-assess later.`,
                    message: `Domain ${domain.domain}: blacklist check(s) unreachable for: ${unreachableLists.join(', ')}. Cannot confirm clean status.`,
                    remediation: `Trigger a manual re-assessment later to verify blacklist status. Do not assume clean.`,
                });
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

            // Update domain with DNS results
            await prisma.domain.update({
                where: { id: domain.id },
                data: {
                    status: domainState,
                    spf_valid: dnsResult.spfValid,
                    dkim_valid: dnsResult.dkimValid,
                    dmarc_policy: dnsResult.dmarcPolicy,
                    blacklist_results: dnsResult.blacklistResults,
                    dns_checked_at: new Date(),
                    initial_assessment_score: dnsResult.score,
                    ...(domainState === 'paused' ? {
                        paused_reason: 'Infrastructure assessment: domain health issues detected',
                        last_pause_at: new Date(),
                    } : {}),
                },
            });

            // Count states
            if (domainState === 'healthy') domainSummary.healthy++;
            else if (domainState === 'warning') domainSummary.warning++;
            else if (domainState === 'paused') domainSummary.paused++;
        }

        // ── Step 3: Assess all mailboxes (historical data) ──
        const mailboxes = await prisma.mailbox.findMany({
            where: { organization_id: organizationId },
            include: { domain: true },
        });

        const mailboxSummary = { total: mailboxes.length, healthy: 0, warning: 0, paused: 0 };

        for (const mailbox of mailboxes) {
            // Calculate bounce rate from existing counters
            // (These are populated by Smartlead sync if getMailboxStats was called)
            const totalSent = mailbox.total_sent_count;
            const totalBounced = mailbox.hard_bounce_count;
            const bounceRate = totalSent > 0 ? totalBounced / totalSent : 0;

            let mailboxState = 'healthy';

            if (bounceRate >= MAILBOX_THRESHOLDS.PAUSE_BOUNCE_RATE) {
                mailboxState = 'paused';
                findings.push({
                    severity: 'critical',
                    category: 'mailbox_health',
                    entity: 'mailbox',
                    entityId: mailbox.id,
                    entityName: mailbox.email,
                    title: `High Bounce Rate: ${mailbox.email}`,
                    details: `Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds ${(MAILBOX_THRESHOLDS.PAUSE_BOUNCE_RATE * 100)}% threshold. Mailbox paused; enters healing pipeline.`,
                    message: `Mailbox ${mailbox.email} has a historical bounce rate of ${(bounceRate * 100).toFixed(1)}% (>${(MAILBOX_THRESHOLDS.PAUSE_BOUNCE_RATE * 100)}% threshold).`,
                    remediation: `This mailbox has been paused and will enter the healing pipeline. It will be available for sending after cooldown and recovery.`,
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
                    details: `Bounce rate ${(bounceRate * 100).toFixed(1)}% approaching threshold. Reduce volume or verify email list quality.`,
                    message: `Mailbox ${mailbox.email} has a historical bounce rate of ${(bounceRate * 100).toFixed(1)}% (approaching threshold).`,
                    remediation: `This mailbox is under elevated monitoring. Reduce sending volume or verify email list quality.`,
                });
            }

            // Domain-health ceiling: mailbox cannot be healthier than its domain
            const domainStatus = mailbox.domain.status;
            if (domainStatus === 'paused' && mailboxState !== 'paused') {
                mailboxState = 'paused';
            } else if (domainStatus === 'warning' && mailboxState === 'healthy') {
                mailboxState = 'warning';
            }

            // Update mailbox
            await prisma.mailbox.update({
                where: { id: mailbox.id },
                data: {
                    status: mailboxState,
                    initial_bounce_rate: bounceRate,
                    initial_assessment_at: new Date(),
                    ...(mailboxState === 'paused' ? {
                        last_pause_at: new Date(),
                        consecutive_pauses: mailbox.consecutive_pauses + 1,
                    } : {}),
                },
            });

            if (mailboxState === 'healthy') mailboxSummary.healthy++;
            else if (mailboxState === 'warning') mailboxSummary.warning++;
            else if (mailboxState === 'paused') mailboxSummary.paused++;
        }

        // ── Step 4: Assess all campaigns ──
        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: organizationId },
            include: {
                mailboxes: { include: { domain: true } },
            },
        });

        const campaignSummary = { total: campaigns.length, active: 0, warning: 0, paused: 0 };

        for (const campaign of campaigns) {
            const bounceRate = campaign.total_sent > 0
                ? campaign.total_bounced / campaign.total_sent
                : 0;

            let campaignState = campaign.status; // Preserve existing status if already set

            // Only assess if currently active
            if (campaignState === 'active') {
                if (bounceRate >= CAMPAIGN_THRESHOLDS.PAUSE_BOUNCE_RATE && campaign.total_sent >= 20) {
                    campaignState = 'paused';
                    findings.push({
                        severity: 'critical',
                        category: 'campaign_health',
                        entity: 'campaign',
                        entityId: campaign.id,
                        entityName: campaign.name,
                        title: `High Bounce Rate: ${campaign.name}`,
                        details: `Campaign bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds ${(CAMPAIGN_THRESHOLDS.PAUSE_BOUNCE_RATE * 100)}% threshold. Campaign paused.`,
                        message: `Campaign "${campaign.name}" has a bounce rate of ${(bounceRate * 100).toFixed(1)}% (>${(CAMPAIGN_THRESHOLDS.PAUSE_BOUNCE_RATE * 100)}% threshold).`,
                        remediation: `Campaign has been paused. Review the email list quality and domain reputation before resuming.`,
                    });
                } else if (bounceRate >= CAMPAIGN_THRESHOLDS.WARNING_BOUNCE_RATE && campaign.total_sent >= 20) {
                    campaignState = 'warning';
                    findings.push({
                        severity: 'warning',
                        category: 'campaign_health',
                        entity: 'campaign',
                        entityId: campaign.id,
                        entityName: campaign.name,
                        title: `Elevated Bounce Rate: ${campaign.name}`,
                        details: `Campaign bounce rate ${(bounceRate * 100).toFixed(1)}% approaching threshold. Review email list and remove invalid addresses.`,
                        message: `Campaign "${campaign.name}" has a bounce rate of ${(bounceRate * 100).toFixed(1)}% (approaching threshold).`,
                        remediation: `Monitor closely. Consider reviewing email list and removing invalid addresses.`,
                    });
                }
            }

            // ── INVARIANT: Campaign can NEVER be healthier than its infrastructure ──
            // Campaign pause is additive, never compensatory.
            if (campaign.mailboxes.length > 0) {
                const worstDomainState = getWorstState(
                    [...new Set(campaign.mailboxes.map(m => m.domain.status))]
                );
                const worstMailboxState = getWorstState(
                    campaign.mailboxes.map(m => m.status)
                );
                const worstInfraState = getWorstState([worstDomainState, worstMailboxState]);

                // Campaign cannot be better than worst infra state
                if (stateRank(worstInfraState) > stateRank(campaignState)) {
                    campaignState = worstInfraState === 'paused' ? 'paused' : 'warning';
                }
            }

            // Update campaign
            if (campaignState !== campaign.status) {
                await prisma.campaign.update({
                    where: { id: campaign.id },
                    data: {
                        status: campaignState,
                        ...(campaignState === 'paused' ? {
                            paused_reason: 'Infrastructure assessment: health issues detected',
                            paused_at: new Date(),
                        } : {}),
                    },
                });
            }

            if (campaignState === 'active') campaignSummary.active++;
            else if (campaignState === 'warning') campaignSummary.warning++;
            else if (campaignState === 'paused') campaignSummary.paused++;
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
                findings: findings as any,
                recommendations: recommendations as any,
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
            const notifType = criticalCount > 0 ? 'WARNING' as const : 'SUCCESS' as const;
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

        // IMPORTANT: Do NOT unlock the gate on failure.
        // The gate stays locked — manual intervention required.
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
 * Get all infrastructure reports for an organization.
 */
export async function getReports(organizationId: string) {
    return prisma.infrastructureReport.findMany({
        where: { organization_id: organizationId },
        orderBy: { created_at: 'desc' },
        take: 10,
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
