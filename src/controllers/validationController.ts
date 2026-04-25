/**
 * Validation Controller
 *
 * HTTP endpoints for bulk email validation: CSV upload, batch management,
 * routing to campaigns, CSV export, and analytics.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { logger } from '../services/observabilityService';
import * as csvParserService from '../services/csvParserService';
import * as validationBatchService from '../services/validationBatchService';

// ============================================================================
// UPLOAD
// ============================================================================

/**
 * POST /api/validation/upload
 * Accept parsed leads (JSON) + mapping → create batch → start processing.
 * The client handles CSV parsing via Papa Parse; we receive clean JSON.
 */
export const uploadLeads = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { leads, fileName, targetCampaignId, source = 'csv' } = req.body;

        if (!leads || !Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ success: false, error: 'No leads provided' });
        }

        // Validate that every lead has an email
        const invalidRows = leads.filter((l: any, i: number) => !l.email);
        if (invalidRows.length > 0) {
            return res.status(400).json({ success: false, error: `${invalidRows.length} leads missing email field` });
        }

        // Create batch and start processing
        const { batchId, totalCount } = await validationBatchService.createBatch(
            orgId,
            source,
            leads,
            { fileName, targetCampaignId }
        );

        // Kick off processing asynchronously — don't block the response
        setImmediate(() => {
            validationBatchService.processBatch(orgId, batchId).catch(err => {
                logger.error('[VALIDATION] Background processing failed', err, { batchId });
            });
        });

        return res.status(202).json({
            success: true,
            batchId,
            totalCount,
            message: 'Batch created. Validation in progress.',
        });
    } catch (error: any) {
        logger.error('[VALIDATION] Upload failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Upload failed' });
    }
};

/**
 * POST /api/validation/upload/csv-raw
 * Accept raw CSV content + mapping → parse server-side → create batch → start processing.
 * Fallback for clients that can't parse CSV locally.
 */
export const uploadCSVRaw = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { csvContent, mapping, fileName, targetCampaignId } = req.body;

        if (!csvContent) {
            return res.status(400).json({ success: false, error: 'No CSV content provided' });
        }

        // Auto-detect mapping if not provided
        let columnMapping = mapping;
        if (!columnMapping) {
            const headers = csvParserService.extractHeaders(csvContent);
            columnMapping = csvParserService.autoDetectMapping(headers);
        }

        if (!columnMapping.email) {
            return res.status(400).json({ success: false, error: 'Could not detect email column' });
        }

        const { leads, errors } = csvParserService.parseCSV(csvContent, columnMapping);

        if (leads.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid leads found', parseErrors: errors });
        }

        const { batchId, totalCount } = await validationBatchService.createBatch(
            orgId,
            'csv',
            leads,
            { fileName, targetCampaignId }
        );

        setImmediate(() => {
            validationBatchService.processBatch(orgId, batchId).catch(err => {
                logger.error('[VALIDATION] Background processing failed', err, { batchId });
            });
        });

        return res.status(202).json({
            success: true,
            batchId,
            totalCount,
            parseErrors: errors.length > 0 ? errors : undefined,
            message: 'Batch created. Validation in progress.',
        });
    } catch (error: any) {
        logger.error('[VALIDATION] CSV upload failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'CSV upload failed' });
    }
};

/**
 * POST /api/validation/detect-columns
 * Accept CSV headers and return auto-detected column mapping.
 */
export const detectColumns = async (req: Request, res: Response): Promise<Response> => {
    try {
        const { headers } = req.body;
        if (!headers || !Array.isArray(headers)) {
            return res.status(400).json({ success: false, error: 'Headers array required' });
        }
        const mapping = csvParserService.autoDetectMapping(headers);
        return res.json({ success: true, mapping });
    } catch (error: any) {
        return res.status(500).json({ success: false, error: 'Detection failed' });
    }
};

// ============================================================================
// BATCHES
// ============================================================================

/**
 * GET /api/validation/batches
 */
export const listBatches = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const { from, to } = parseRangeFromQuery(req);

        const result = await validationBatchService.listBatches(orgId, { page, limit, from, to });
        return res.json({ success: true, ...result });
    } catch (error: any) {
        logger.error('[VALIDATION] List batches failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list batches' });
    }
};

/**
 * GET /api/validation/batches/:id
 */
export const getBatchDetail = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const batchId = String(req.params.id);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const statusFilter = (req.query.status as string) || undefined;
        const espFilter = (req.query.esp as string) || undefined;
        const search = (req.query.search as string) || undefined;

        const result = await validationBatchService.getBatchResults(orgId, batchId, {
            page, limit, statusFilter, espFilter, search
        });
        // Nest batch + meta INSIDE data so apiClient's auto-unwrap preserves them.
        // Previously the spread put them at the top level, where the frontend's
        // unwrapped response lost them.
        return res.json({
            success: true,
            data: { batch: result.batch, leads: result.data, meta: result.meta },
        });
    } catch (error: any) {
        logger.error('[VALIDATION] Get batch detail failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get batch detail' });
    }
};

// ============================================================================
// ROUTING
// ============================================================================

/**
 * POST /api/validation/batches/:id/route
 */
export const routeLeadsToCampaign = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const batchId = String(req.params.id);
        const { leadIds, campaignId } = req.body;

        if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
            return res.status(400).json({ success: false, error: 'leadIds array required' });
        }
        if (!campaignId) {
            return res.status(400).json({ success: false, error: 'campaignId required' });
        }

        const result = await validationBatchService.routeLeads(orgId, batchId, leadIds, campaignId);
        return res.json({ success: true, ...result });
    } catch (error: any) {
        logger.error('[VALIDATION] Route leads failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to route leads' });
    }
};

// ============================================================================
// EXPORT
// ============================================================================

/**
 * POST /api/validation/batches/:id/export
 */
export const exportCSV = async (req: Request, res: Response): Promise<Response | void> => {
    try {
        const orgId = getOrgId(req);
        const batchId = String(req.params.id);
        const { statusFilter } = req.body || {};

        const csvContent = await validationBatchService.exportCleanCSV(orgId, batchId, statusFilter);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="validation-${batchId}.csv"`);
        return res.send(csvContent);
    } catch (error: any) {
        logger.error('[VALIDATION] Export failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Export failed' });
    }
};

// ============================================================================
// ANALYTICS
// ============================================================================

/**
 * GET /api/validation/analytics
 */
export const getAnalytics = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { from, to } = parseRangeFromQuery(req);
        const analytics = await validationBatchService.getAnalytics(orgId, { from, to });
        return res.json({ success: true, ...analytics });
    } catch (error: any) {
        logger.error('[VALIDATION] Analytics failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get analytics' });
    }
};

/**
 * Parse `timeRange` (7d / 30d / 90d / all) and optional `from`/`to` (YYYY-MM-DD)
 * query params. Explicit from/to wins over timeRange.
 */
function parseRangeFromQuery(req: Request): { from: Date | null; to: Date | null } {
    const fromStr = (req.query.from as string) || '';
    const toStr = (req.query.to as string) || '';
    const timeRange = (req.query.timeRange as string) || '';

    const parseYmd = (s: string): Date | null => {
        if (!s) return null;
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    };

    const from = parseYmd(fromStr);
    const to = parseYmd(toStr);
    if (from || to) {
        // For `to`, include the entire day
        const endOfDay = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999) : null;
        return { from, to: endOfDay };
    }

    if (timeRange === '7d') {
        const f = new Date(); f.setDate(f.getDate() - 7); return { from: f, to: null };
    }
    if (timeRange === '30d') {
        const f = new Date(); f.setDate(f.getDate() - 30); return { from: f, to: null };
    }
    if (timeRange === '90d') {
        const f = new Date(); f.setDate(f.getDate() - 90); return { from: f, to: null };
    }
    return { from: null, to: null };
}
