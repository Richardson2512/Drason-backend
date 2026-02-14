import { Router } from 'express';
import { Request, Response } from 'express';
import * as smartleadClient from '../services/smartleadClient';
import { getOrgId } from '../middleware/orgContext';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req);
        const result = await smartleadClient.syncSmartlead(orgId);
        res.json({ success: true, data: result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

export default router;
