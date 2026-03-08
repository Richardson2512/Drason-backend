import { Router } from 'express';
import { Request, Response } from 'express';
import { getActiveAdaptersForOrg } from '../adapters/platformRegistry';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../utils/logger';
import { syncProgressService } from '../services/syncProgressService';
import { smartleadBreaker, emailbisonBreaker, instantlyBreaker } from '../utils/circuitBreaker';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const sessionId = req.query.session as string | undefined;

        // Reset circuit breakers on manual sync — auto-sync failures can leave
        // breakers stuck OPEN, blocking all API calls for the manual trigger
        smartleadBreaker.reset();
        emailbisonBreaker.reset();
        instantlyBreaker.reset();

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

        let criticalFindings: Record<string, unknown>[] = [];
        if (report && report.findings) {
            const allFindings = report.findings as Record<string, unknown>[];
            criticalFindings = allFindings.filter(f => f.severity === 'critical');
        }

        const healthCheck = {
            has_critical_issues: criticalFindings.length > 0,
            critical_count: criticalFindings.length,
            overall_score: report?.overall_score || null,
            findings: criticalFindings.slice(0, 5)
        };

        // Gather post-sync entity status breakdown so the frontend can show
        // what the assessment/scoring found (paused mailboxes, unhealthy domains, etc.)
        const [mailboxStatuses, domainStatuses, leadStatuses] = await Promise.all([
            prisma.mailbox.groupBy({ by: ['status'], where: { organization_id: orgId }, _count: true }),
            prisma.domain.groupBy({ by: ['status'], where: { organization_id: orgId }, _count: true }),
            prisma.lead.groupBy({ by: ['status'], where: { organization_id: orgId }, _count: true }),
        ]);

        const toStatusMap = (groups: { status: string; _count: number }[], keys: string[]) => {
            const map: Record<string, number> = {};
            for (const k of keys) map[k] = 0;
            for (const g of groups) map[g.status] = (map[g.status] || 0) + g._count;
            return map;
        };

        const postSyncSummary = {
            mailboxes: toStatusMap(mailboxStatuses as any, ['healthy', 'warning', 'paused']),
            domains: toStatusMap(domainStatuses as any, ['healthy', 'warning', 'paused']),
            leads: toStatusMap(leadStatuses as any, ['active', 'held', 'blocked']),
        };

        // Emit SSE completion event so the frontend modal knows sync is done
        if (sessionId) {
            syncProgressService.emitComplete(sessionId, {
                campaigns_synced: totalCampaigns,
                mailboxes_synced: totalMailboxes,
                leads_synced: totalLeads,
                health_check: healthCheck,
                post_sync_summary: postSyncSummary
            });
        }

        // Return field names that match frontend expectations
        res.json({
            success: true,
            campaigns_synced: totalCampaigns,
            mailboxes_synced: totalMailboxes,
            leads_synced: totalLeads,
            platforms: platformResults,
            health_check: healthCheck,
            post_sync_summary: postSyncSummary
        });
    } catch (e: any) {
        logger.error('[SYNC ERROR]', e, { stack: e.stack });

        // Emit SSE error event so the frontend modal shows the failure
        const sessionId = req.query.session as string | undefined;
        if (sessionId) {
            syncProgressService.emitError(sessionId, e.message || 'Sync failed');
        }

        res.status(500).json({ success: false, error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
    }
});

export default router;
