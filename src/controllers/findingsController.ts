/**
 * Findings Controller
 *
 * Provides infrastructure health findings for specific entities (mailboxes, domains)
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';

/**
 * Get infrastructure health findings for a specific entity.
 *
 * Query params:
 * - entity_type: 'mailbox' | 'domain' | 'campaign'
 * - entity_id: UUID of the entity
 */
export const getEntityFindings = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const { entity_type, entity_id } = req.query;

        if (!entity_type || !entity_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: entity_type and entity_id'
            });
        }

        // Get the latest infrastructure report for the organization
        const report = await prisma.infrastructureReport.findFirst({
            where: { organization_id: orgId },
            orderBy: { created_at: 'desc' },
            select: {
                id: true,
                findings: true,
                created_at: true
            }
        });

        if (!report) {
            return res.json({
                success: true,
                data: {
                    findings: [],
                    reportAge: null,
                    message: 'No infrastructure assessment available yet'
                }
            });
        }

        // Filter findings for this specific entity
        const allFindings = report.findings as any[];
        const entityFindings = allFindings.filter((finding: any) => {
            // Match both entity_type and entity_id
            // Check both possible field name formats (entity_type/entity and entity_id/entityId)
            const findingEntityType = finding.entity_type || finding.entity;
            const findingEntityId = finding.entity_id || finding.entityId;
            return findingEntityType === entity_type && findingEntityId === entity_id;
        });

        // Calculate report age
        const reportAgeMinutes = Math.floor((Date.now() - new Date(report.created_at).getTime()) / (1000 * 60)); // minutes
        const reportAge = reportAgeMinutes < 60
            ? `${reportAgeMinutes} minutes ago`
            : reportAgeMinutes < 1440
                ? `${Math.floor(reportAgeMinutes / 60)} hours ago`
                : `${Math.floor(reportAgeMinutes / 1440)} days ago`;

        logger.info('[FINDINGS] Entity findings retrieved', {
            organizationId: orgId,
            entityType: entity_type,
            entityId: entity_id,
            findingsCount: entityFindings.length,
            reportAge
        });

        // Transform findings to match frontend expectations
        const transformedFindings = entityFindings.map((finding: any) => ({
            id: finding.id || `${finding.category}-${finding.entityId}`,
            title: finding.title,
            severity: finding.severity,
            description: finding.details || finding.message,
            entity_type: finding.entity,
            entity_id: finding.entityId,
            entity_name: finding.entityName,
            recommendation: finding.remediation,
            category: finding.category
        }));

        res.json({
            success: true,
            data: {
                findings: transformedFindings,
                reportAge,
                reportCreatedAt: report.created_at,
                totalFindings: allFindings.length
            }
        });

    } catch (error: any) {
        logger.error('[FINDINGS] Error fetching entity findings', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch findings'
        });
    }
};

/**
 * Get all findings for the organization (infrastructure health page)
 */
export const getAllFindings = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        const report = await prisma.infrastructureReport.findFirst({
            where: { organization_id: orgId },
            orderBy: { created_at: 'desc' }
        });

        if (!report) {
            return res.json({
                success: true,
                data: {
                    findings: [],
                    summary: null,
                    recommendations: [],
                    overallScore: null
                }
            });
        }

        res.json({
            success: true,
            data: {
                findings: report.findings,
                summary: report.summary,
                recommendations: report.recommendations,
                overallScore: report.overall_score,
                createdAt: report.created_at
            }
        });

    } catch (error: any) {
        logger.error('[FINDINGS] Error fetching all findings', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch findings'
        });
    }
};
