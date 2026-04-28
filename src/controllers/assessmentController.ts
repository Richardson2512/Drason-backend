/**
 * Assessment Controller
 * 
 * Handles API endpoints for infrastructure health assessment.
 * Provides report retrieval, manual re-assessment trigger, and
 * per-domain DNS detail lookup.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import * as assessmentService from '../services/infrastructureAssessmentService';
import { logger } from '../services/observabilityService';

/**
 * GET /api/assessment/report
 * Fetch the most recent infrastructure health report.
 */
export const getReport = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const report = await assessmentService.getLatestReport(orgId);

        // No report yet is an empty state, not an error — return 200 with
        // null data so the frontend can render an "assessment hasn't run
        // yet" empty card instead of a "Failed to load" toast.
        res.json({ success: true, data: report || null });
    } catch (e: any) {
        logger.error('Failed to fetch assessment report', e);
        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
    }
};

/**
 * GET /api/assessment/reports?days=30
 * Fetch infrastructure health reports for the given time range.
 */
export const getReports = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
        const reports = await assessmentService.getReports(orgId, days);
        res.json({ success: true, data: reports });
    } catch (e: any) {
        logger.error('Failed to fetch assessment reports', e);
        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
    }
};

/**
 * POST /api/assessment/run
 * Trigger a manual re-assessment.
 * Used after DNS fixes to verify recovery — DNS-based recovery requires
 * manual re-assessment trigger, no auto-resume.
 */
// A run is considered stale (likely crashed) after this many ms — the start
// endpoint will accept a fresh trigger past this threshold even if
// assessment_running is still true.
const STALE_RUN_MS = 10 * 60 * 1000;

export const runAssessment = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);

        // Reject duplicate starts. Frontend polls /status to discover
        // completion — there's no value in queueing a second run while one
        // is in flight, and the DNSBL probes are expensive.
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: { assessment_running: true, assessment_started_at: true },
        });
        const startedMs = org?.assessment_started_at ? Date.now() - org.assessment_started_at.getTime() : Infinity;
        const isStale = startedMs > STALE_RUN_MS;
        if (org?.assessment_running && !isStale) {
            res.status(409).json({
                success: false,
                error: 'Assessment is already running',
                startedAt: org.assessment_started_at,
            });
            return;
        }

        logger.info('Manual infrastructure re-assessment triggered', { orgId, recoveredFromStale: isStale });

        // Fire and forget. The service writes its own start/success/fail
        // state to the Organization row; the frontend polls /status.
        // We deliberately do NOT await — POST returns 202 immediately.
        assessmentService
            .assessInfrastructure(orgId, 'manual_reassessment')
            .catch((err) => {
                // Errors are already persisted to assessment_last_error by
                // the service's catch block; this handler is a safety net
                // for unhandled rejections so they don't crash the worker.
                logger.error('Background assessment failed', err instanceof Error ? err : new Error(String(err)));
            });

        res.status(202).json({
            success: true,
            status: 'started',
            message: 'Infrastructure assessment started — poll /api/assessment/status for completion',
        });
    } catch (e: any) {
        logger.error('Failed to start assessment', e);
        res.status(500).json({
            success: false,
            error: 'Failed to start assessment',
            message: e.message,
        });
    }
};

/**
 * GET /api/assessment/status
 * Check whether an infrastructure assessment is currently in progress.
 */
export const getAssessmentStatus = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const org = await prisma.organization.findUnique({
            where: { id: orgId },
            select: {
                assessment_running: true,
                assessment_started_at: true,
                assessment_finished_at: true,
                assessment_last_error: true,
                _count: { select: { domains: true, infraReports: true } },
            },
        });

        if (!org) {
            res.status(404).json({ success: false, error: 'Organization not found' });
            return;
        }

        const hasReport = org._count.infraReports > 0;
        const hasDomains = org._count.domains > 0;

        // Stale-lock recovery: if the running flag is set but it's been
        // longer than STALE_RUN_MS, treat as crashed and report idle.
        const startedMs = org.assessment_started_at ? Date.now() - org.assessment_started_at.getTime() : Infinity;
        const isStale = startedMs > STALE_RUN_MS;
        const running = Boolean(org.assessment_running) && !isStale && hasDomains;

        // Status semantics:
        //   running   → a run is in flight
        //   failed    → last attempt errored (last_error set, not running)
        //   completed → at least one report exists, no error
        //   idle      → nothing has ever run, or no domains to assess
        let status: 'running' | 'completed' | 'failed' | 'idle';
        if (running) status = 'running';
        else if (org.assessment_last_error) status = 'failed';
        else if (hasReport) status = 'completed';
        else status = 'idle';

        res.json({
            success: true,
            data: {
                status,
                startedAt: org.assessment_started_at,
                finishedAt: org.assessment_finished_at,
                lastError: org.assessment_last_error,
                hasReport,
                // Legacy field — kept for any caller still reading it, but
                // status above is the durable signal.
                inProgress: running,
            },
        });
    } catch (e: any) {
        logger.error('Failed to check assessment status', e);
        res.status(500).json({ success: false, error: 'Failed to check assessment status' });
    }
};

/**
 * GET /api/assessment/domain/:domainId/dns
 * Fetch DNS details for a specific domain (performs a live check).
 */
export const getDomainDNS = async (req: Request, res: Response): Promise<void> => {
    try {
        const domainId = req.params.domainId as string;
        const orgId = getOrgId(req);

        const domain = await prisma.domain.findFirst({
            where: { id: domainId, organization_id: orgId }
        });

        if (!domain) {
            res.status(404).json({ success: false, error: 'Domain not found' });
            return;
        }

        // Run live DNS check
        const dnsResult = await assessmentService.assessDomainDNS(domain.domain);

        res.json({
            success: true,
            data: {
                domain: domain.domain,
                domainId: domain.id,
                currentStatus: domain.status,
                dns: dnsResult
            }
        });
    } catch (e: any) {
        logger.error('DNS check failed', e);
        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
    }
};

/**
 * POST /api/assessment/domain/:domainId/dns/recheck
 *
 * Live re-check + persist. Distinct from getDomainDNS, which is a non-persisting
 * preview. This endpoint runs the same DNS sweep the periodic worker runs and
 * writes the result back to the Domain row, so the Domains UI reflects fresh
 * state immediately after the user clicks "Check now". Findings are NOT
 * regenerated here — that's owned by the assessment worker's full sweep — but
 * the per-record badges on the DNS Authentication card flip the moment this
 * call returns.
 *
 * Soft-rate-limited at the application layer: re-checks for the same domain
 * within 30s reuse the cached row and skip the network calls. This protects
 * against accidental double-clicks turning into a DNS storm without forcing
 * a hard 429.
 */
const RECHECK_COOLDOWN_MS = 30_000;
export const recheckDomainDNS = async (req: Request, res: Response): Promise<void> => {
    try {
        const domainId = req.params.domainId as string;
        const orgId = getOrgId(req);

        const domain = await prisma.domain.findFirst({
            where: { id: domainId, organization_id: orgId },
        });
        if (!domain) {
            res.status(404).json({ success: false, error: 'Domain not found' });
            return;
        }

        if (domain.dns_checked_at && Date.now() - domain.dns_checked_at.getTime() < RECHECK_COOLDOWN_MS) {
            res.json({
                success: true,
                cached: true,
                cooldown_seconds_remaining: Math.ceil(
                    (RECHECK_COOLDOWN_MS - (Date.now() - domain.dns_checked_at.getTime())) / 1000,
                ),
                domain: {
                    id: domain.id,
                    spf_valid: domain.spf_valid,
                    dkim_valid: domain.dkim_valid,
                    dmarc_policy: domain.dmarc_policy,
                    mx_records: domain.mx_records,
                    mx_valid: domain.mx_valid,
                    dns_checked_at: domain.dns_checked_at,
                },
            });
            return;
        }

        const dnsResult = await assessmentService.assessDomainDNS(domain.domain, domain.id);
        const updated = await prisma.domain.update({
            where: { id: domain.id },
            data: {
                spf_valid: dnsResult.spfValid,
                dkim_valid: dnsResult.dkimValid,
                dmarc_policy: dnsResult.dmarcPolicy,
                mx_records: dnsResult.mxRecords,
                mx_valid: dnsResult.mxValid,
                dns_checked_at: new Date(),
            },
            select: {
                id: true,
                spf_valid: true,
                dkim_valid: true,
                dmarc_policy: true,
                mx_records: true,
                mx_valid: true,
                dns_checked_at: true,
            },
        });

        res.json({ success: true, cached: false, domain: updated });
    } catch (e: any) {
        logger.error('DNS recheck failed', e);
        res.status(500).json({
            success: false,
            error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message,
        });
    }
};
