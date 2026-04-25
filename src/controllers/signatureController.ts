/**
 * Email Signature Controller
 *
 * CRUD for email signatures. Signatures are HTML content with embedded
 * base64 images (so no file storage is needed).
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';

/**
 * GET /api/sequencer/signatures
 * List all signatures for the org.
 */
export const listSignatures = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const signatures = await prisma.emailSignature.findMany({
            where: { organization_id: orgId },
            orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
        });
        return res.json({ success: true, signatures });
    } catch (error: any) {
        logger.error('[SIGNATURES] List failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list signatures' });
    }
};

/**
 * POST /api/sequencer/signatures
 * Create a new signature.
 */
export const createSignature = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { name, html_content, is_default } = req.body;

        if (!name || !html_content) {
            return res.status(400).json({ success: false, error: 'Name and HTML content are required' });
        }

        // If this signature is being set as default, unset all others
        if (is_default) {
            await prisma.emailSignature.updateMany({
                where: { organization_id: orgId },
                data: { is_default: false },
            });
        }

        const signature = await prisma.emailSignature.create({
            data: {
                organization_id: orgId,
                name: name.trim(),
                html_content,
                is_default: !!is_default,
            },
        });

        return res.status(201).json({ success: true, signature });
    } catch (error: any) {
        logger.error('[SIGNATURES] Create failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create signature' });
    }
};

/**
 * PATCH /api/sequencer/signatures/:id
 */
export const updateSignature = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = req.params.id as string;
        const { name, html_content, is_default } = req.body;

        const existing = await prisma.emailSignature.findFirst({
            where: { id, organization_id: orgId },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Signature not found' });

        // If promoting to default, unset other defaults first
        if (is_default && !existing.is_default) {
            await prisma.emailSignature.updateMany({
                where: { organization_id: orgId, id: { not: id } },
                data: { is_default: false },
            });
        }

        const updated = await prisma.emailSignature.update({
            where: { id },
            data: {
                ...(name !== undefined && { name: name.trim() }),
                ...(html_content !== undefined && { html_content }),
                ...(is_default !== undefined && { is_default: !!is_default }),
            },
        });

        return res.json({ success: true, signature: updated });
    } catch (error: any) {
        logger.error('[SIGNATURES] Update failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update signature' });
    }
};

/**
 * DELETE /api/sequencer/signatures/:id
 */
export const deleteSignature = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = req.params.id as string;

        const existing = await prisma.emailSignature.findFirst({
            where: { id, organization_id: orgId },
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Signature not found' });

        await prisma.emailSignature.delete({ where: { id } });
        return res.json({ success: true });
    } catch (error: any) {
        logger.error('[SIGNATURES] Delete failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to delete signature' });
    }
};
