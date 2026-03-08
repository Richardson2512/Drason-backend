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

        if (!report) {
            res.status(404).json({
                success: false,
                error: 'No infrastructure assessment report found',
                hint: 'Run a Smartlead sync to trigger the initial assessment, or trigger a manual assessment via POST /api/assessment/run'
            });
            return;
        }

        res.json({ success: true, data: report });
    } catch (e: any) {
        logger.error('Failed to fetch assessment report', e);
        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
    }
};

/**
 * GET /api/assessment/reports
 * Fetch all infrastructure health reports (up to 10 most recent).
 */
export const getReports = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);
        const reports = await assessmentService.getReports(orgId);
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
export const runAssessment = async (req: Request, res: Response): Promise<void> => {
    try {
        const orgId = getOrgId(req);

        logger.info('Manual infrastructure re-assessment triggered', { orgId });

        const result = await assessmentService.assessInfrastructure(orgId, 'manual_reassessment');

        res.json({
            success: true,
            message: 'Infrastructure re-assessment completed',
            result
        });
    } catch (e: any) {
        logger.error('Manual assessment failed', e);
        res.status(500).json({
            success: false,
            error: 'Assessment failed',
            message: e.message,
            hint: 'The execution gate may remain locked. Check logs and retry.'
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
            select: { assessment_completed: true }
        });

        res.json({
            success: true,
            data: {
                inProgress: org ? !org.assessment_completed : false
            }
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
