import { Router } from 'express';
import { Request, Response } from 'express';
import { getActiveAdaptersForOrg } from '../adapters/platformRegistry';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../utils/logger';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const sessionId = req.query.session as string | undefined;

        // Discover and sync all configured platforms for this org
        const adapters = await getActiveAdaptersForOrg(orgId);

        if (adapters.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No platforms configured. Add an API key in Settings.'
            });
        }

        let totalCampaigns = 0;
        let totalMailboxes = 0;
        let totalLeads = 0;
        const platformResults: Array<{ platform: string; campaigns: number; mailboxes: number; leads: number }> = [];

        for (const { adapter } of adapters) {
            try {
                const result = await adapter.sync(orgId, sessionId);
                totalCampaigns += result.campaigns;
                totalMailboxes += result.mailboxes;
                totalLeads += result.leads;
                platformResults.push({
                    platform: adapter.platform,
                    campaigns: result.campaigns,
                    mailboxes: result.mailboxes,
                    leads: result.leads
                });
            } catch (platformError: any) {
                logger.error(`[SYNC] Failed to sync ${adapter.platform}`, platformError, { orgId });
                platformResults.push({
                    platform: adapter.platform,
                    campaigns: 0,
                    mailboxes: 0,
                    leads: 0
                });
            }
        }

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
            campaigns_synced: totalCampaigns,
            mailboxes_synced: totalMailboxes,
            leads_synced: totalLeads,
            platforms: platformResults,
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
