/**
 * Customer registry controller - org-scoped customer list + CSV import.
 *
 *   GET  /api/linkedin/customers          - count + sample
 *   POST /api/linkedin/customers/import   - CSV upload (JSON-encoded rows)
 *
 * The engager-relationship resolver consults the same table; this
 * controller is just the human-facing CRUD surface so an operator can
 * upload a customer list when they don't have a CRM connected.
 *
 * Parsing the CSV file itself happens client-side (we already use
 * papaparse in the Sequencer lead-import flow); the upload endpoint
 * accepts a JSON body of `{ rows: [{ email, linkedin_url, display_name }] }`.
 */

import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { getOrgId } from '../middleware/orgContext';
import { importCustomers, type CustomerImportRow } from '../services/linkedin/customerRegistryService';

export const list = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const limit = Math.min(parseInt(String(req.query.limit ?? '50')) || 50, 200);

        const [total, bySource, sample, crmConnections] = await Promise.all([
            prisma.customer.count({ where: { organization_id: orgId } }),
            prisma.customer.groupBy({
                by: ['source'],
                where: { organization_id: orgId },
                _count: true,
            }),
            prisma.customer.findMany({
                where: { organization_id: orgId },
                orderBy: { imported_at: 'desc' },
                take: limit,
                select: {
                    id: true,
                    company_name: true,
                    company_linkedin_public_identifier: true,
                    domain: true,
                    source: true,
                    lifecycle_stage: true,
                    imported_at: true,
                },
            }) as Promise<Array<{
                id: string; company_name: string; company_linkedin_public_identifier: string | null;
                domain: string | null; source: string; lifecycle_stage: string | null;
                imported_at: Date;
            }>>,
            // CRM connection state - drives the ICP-page banner copy. If a
            // CRM is connected we tell the operator we'll auto-sync customer
            // accounts so they don't have to upload a CSV.
            prisma.crmConnection.findMany({
                where: { organization_id: orgId, status: 'active' },
                select: { provider: true, external_account_name: true, last_sync_at: true },
            }),
        ]);

        const crm = crmConnections.length > 0
            ? {
                connected: true as const,
                provider: crmConnections[0].provider,
                account_name: crmConnections[0].external_account_name,
                last_sync_at: crmConnections[0].last_sync_at?.toISOString() ?? null,
            }
            : { connected: false as const, provider: null, account_name: null, last_sync_at: null };

        return res.json({
            success: true,
            data: {
                total,
                by_source: bySource.reduce((acc, b) => { acc[b.source] = b._count; return acc; }, {} as Record<string, number>),
                sample: sample.map(s => ({
                    id: s.id,
                    company_name: s.company_name,
                    company_linkedin_public_identifier: s.company_linkedin_public_identifier,
                    domain: s.domain,
                    source: s.source,
                    lifecycle_stage: s.lifecycle_stage,
                    imported_at: s.imported_at.toISOString(),
                })),
                crm,
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const importFromCsv = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const body = (req.body ?? {}) as { rows?: CustomerImportRow[] };
        const rows = Array.isArray(body.rows) ? body.rows : [];

        if (rows.length === 0) {
            return res.status(400).json({ success: false, error: 'No rows in upload - every row needs a company_name' });
        }
        if (rows.length > 50000) {
            return res.status(400).json({ success: false, error: 'Upload too large - max 50,000 rows per request. Split the file and re-upload.' });
        }

        const result = await importCustomers(orgId, rows, 'csv');
        return res.status(201).json({ success: true, data: result });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const remove = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const row = await prisma.customer.findFirst({
            where: { id, organization_id: orgId },
            select: { id: true },
        });
        if (!row) return res.status(404).json({ success: false, error: 'Customer not found' });
        await prisma.customer.delete({ where: { id: row.id } });
        return res.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};
