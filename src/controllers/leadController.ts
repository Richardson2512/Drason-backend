/**
 * Lead Controller
 * 
 * Alternative lead ingestion endpoint.
 * Delegates to lead service for processing.
 */

import { Request, Response } from 'express';
import * as leadService from '../services/leadService';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';

export const ingestLead = async (req: Request, res: Response): Promise<void> => {
    try {
        const { email, persona, lead_score, workable } = req.body;
        const orgId = getOrgId(req);

        // 1. Validate Payload
        if (!email || !persona || lead_score === undefined || workable !== true) {
            res.status(400).json({ error: 'Invalid payload: Missing required fields or not workable' });
            return;
        }

        // 2. Create Lead (Held)
        const lead = await leadService.createLead(orgId, {
            email,
            persona,
            lead_score,
        });

        res.status(201).json({ success: true, data: { message: 'Lead ingested successfully', lead } });
    } catch (error) {
        logger.error('Error ingesting lead:', error as Error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
