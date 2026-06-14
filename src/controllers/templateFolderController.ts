/**
 * Template Folder Controller
 *
 * Flat (non-nested) organizational folders for EmailTemplate rows.
 * Templates with folder_id=null are "Uncategorized" - never auto-moved.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
import { logger } from '../services/observabilityService';

/**
 * GET /api/sequencer/template-folders
 * Lists folders for the org with a count of templates in each + an
 * "uncategorized" pseudo-bucket count for the sidebar.
 */
export const listFolders = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const [folders, uncategorizedCount, totalCount] = await Promise.all([
            prisma.templateFolder.findMany({
                where: { organization_id: orgId },
                orderBy: { name: 'asc' },
                include: { _count: { select: { templates: true } } },
            }),
            prisma.emailTemplate.count({ where: { organization_id: orgId, folder_id: null } }),
            prisma.emailTemplate.count({ where: { organization_id: orgId } }),
        ]);
        return res.json({
            success: true,
            folders: folders.map(f => ({
                id: f.id,
                name: f.name,
                count: f._count.templates,
                created_at: f.created_at,
            })),
            uncategorized_count: uncategorizedCount,
            total_count: totalCount,
        });
    } catch (error) {
        logger.error('[TEMPLATE_FOLDERS] list failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list folders' });
    }
};

export const createFolder = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name) return res.status(400).json({ success: false, error: 'Folder name is required' });
        if (name.length > 60) return res.status(400).json({ success: false, error: 'Folder name too long (max 60)' });

        const existing = await prisma.templateFolder.findFirst({
            where: { organization_id: orgId, name },
        });
        if (existing) return res.status(409).json({ success: false, error: 'A folder with that name already exists' });

        const folder = await prisma.templateFolder.create({
            data: { organization_id: orgId, name },
        });
        return res.status(201).json({ success: true, folder: { id: folder.id, name: folder.name, count: 0 } });
    } catch (error) {
        logger.error('[TEMPLATE_FOLDERS] create failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create folder' });
    }
};

export const renameFolder = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name) return res.status(400).json({ success: false, error: 'Folder name is required' });

        const folder = await prisma.templateFolder.findFirst({ where: { id, organization_id: orgId } });
        if (!folder) return res.status(404).json({ success: false, error: 'Folder not found' });

        const collision = await prisma.templateFolder.findFirst({
            where: { organization_id: orgId, name, id: { not: id } },
        });
        if (collision) return res.status(409).json({ success: false, error: 'A folder with that name already exists' });

        await prisma.templateFolder.update({ where: { id }, data: { name } });
        return res.json({ success: true });
    } catch (error) {
        logger.error('[TEMPLATE_FOLDERS] rename failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to rename folder' });
    }
};

/**
 * DELETE /api/sequencer/template-folders/:id
 * Deletes the folder. Templates inside are NOT deleted - schema is SetNull,
 * so they fall back to "Uncategorized." Operator never loses content.
 */
export const deleteFolder = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const folder = await prisma.templateFolder.findFirst({ where: { id, organization_id: orgId } });
        if (!folder) return res.status(404).json({ success: false, error: 'Folder not found' });
        await prisma.templateFolder.delete({ where: { id } });
        return res.json({ success: true });
    } catch (error) {
        logger.error('[TEMPLATE_FOLDERS] delete failed', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to delete folder' });
    }
};
