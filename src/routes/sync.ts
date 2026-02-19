import { Router } from 'express';
import { Request, Response } from 'express';
import * as smartleadClient from '../services/smartleadClient';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../utils/logger';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const sessionId = req.query.session as string | undefined;
        const result = await smartleadClient.syncSmartlead(orgId, sessionId);

        // Check for critical infrastructure findings after sync
        const report = await prisma.infrastructureReport.findFirst({
            where: { organization_id: orgId },
            orderBy: { created_at: 'desc' },
            select: {
                findings: true,
                overall_score: true
            }
        });

        let criticalFindings: any[] = [];
        if (report && report.findings) {
            const allFindings = report.findings as any[];
            criticalFindings = allFindings.filter((f: any) => f.severity === 'critical');
        }

        // Return field names that match frontend expectations
        res.json({
            success: true,
            campaigns_synced: result.campaigns,
            mailboxes_synced: result.mailboxes,
            leads_synced: result.leads,
            health_check: {
                has_critical_issues: criticalFindings.length > 0,
                critical_count: criticalFindings.length,
                overall_score: report?.overall_score || null,
                findings: criticalFindings.slice(0, 5) // Return top 5 critical issues
            }
        });
    } catch (e: any) {
        logger.error('[SYNC ERROR]', e, { stack: e.stack });
        res.status(500).json({ success: false, error: e.message });
    }
});

export default router;
