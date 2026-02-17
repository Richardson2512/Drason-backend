import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { getOrgId } from '../middleware/orgContext';

const router = Router();

/**
 * Diagnostic endpoint to check campaign-mailbox relationships
 */
router.get('/campaign-mailboxes', async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);

        // Get campaigns with their mailboxes
        const campaigns = await prisma.campaign.findMany({
            where: { organization_id: orgId },
            include: {
                mailboxes: true
            }
        });

        // Get mailboxes with their campaigns
        const mailboxes = await prisma.mailbox.findMany({
            where: { organization_id: orgId },
            include: {
                campaigns: true
            }
        });

        // Check the join table directly via raw query
        const joinTableData = await prisma.$queryRaw`
            SELECT * FROM "_CampaignToMailbox"
            WHERE "A" IN (SELECT id FROM "Campaign" WHERE organization_id = ${orgId})
        `;

        res.json({
            success: true,
            data: {
                campaigns: campaigns.map(c => ({
                    id: c.id,
                    name: c.name,
                    mailbox_count: c.mailboxes.length,
                    mailbox_ids: c.mailboxes.map(m => m.id)
                })),
                mailboxes: mailboxes.map(m => ({
                    id: m.id,
                    email: m.email,
                    campaign_count: m.campaigns.length,
                    campaign_ids: m.campaigns.map(c => c.id)
                })),
                join_table_rows: joinTableData,
                summary: {
                    total_campaigns: campaigns.length,
                    campaigns_with_mailboxes: campaigns.filter(c => c.mailboxes.length > 0).length,
                    total_mailboxes: mailboxes.length,
                    mailboxes_with_campaigns: mailboxes.filter(m => m.campaigns.length > 0).length,
                    join_table_row_count: Array.isArray(joinTableData) ? joinTableData.length : 0
                }
            }
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;
