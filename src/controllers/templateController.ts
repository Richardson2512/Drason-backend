/**
 * Template Controller
 *
 * CRUD for EmailTemplates used in the Sequencer.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';

/**
 * GET /api/sequencer/templates
 * List EmailTemplates for org, filter by category, search by name/subject.
 */
/**
 * GET /api/sequencer/templates/categories
 * Returns the canonical list of template categories.
 * Includes built-in categories + any custom categories the org has used.
 */
export const listCategories = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const builtIn = ['general', 'introduction', 'follow-up', 'breakup', 'meeting', 'referral'];

        // Find any custom categories already in use
        const existing = await prisma.emailTemplate.findMany({
            where: { organization_id: orgId },
            select: { category: true },
            distinct: ['category'],
        });
        const custom = existing
            .map(e => e.category)
            .filter(c => c && !builtIn.includes(c));

        return res.json({
            success: true,
            categories: [...builtIn, ...custom],
        });
    } catch (error: any) {
        logger.error('[TEMPLATES] Failed to list categories', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list categories' });
    }
};

export const listTemplates = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const category = (req.query.category as string) || undefined;
        const search = (req.query.search as string) || undefined;
        // Folder filter: 'all' (default) → no filter; 'uncategorized' → folder_id is null;
        // any other string → folder_id matches.
        const folder = (req.query.folder as string) || undefined;
        // Pagination - list payload includes the full body_html column,
        // which for image-rich templates can be hundreds of KB per row. An
        // org with 10k templates and no `take` cap would pull tens of MB
        // into memory and time out the request. 200 is the practical UI
        // cap; callers requesting more get clamped.
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
        const skip = Math.max(0, parseInt(req.query.skip as string) || 0);

        const where: any = { organization_id: orgId };
        if (category && category !== 'all') where.category = category;
        if (folder && folder !== 'all') {
            where.folder_id = folder === 'uncategorized' ? null : folder;
        }
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { subject: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [templates, total] = await Promise.all([
            prisma.emailTemplate.findMany({
                where,
                orderBy: { created_at: 'desc' },
                take: limit,
                skip,
            }),
            prisma.emailTemplate.count({ where }),
        ]);

        return res.json({ success: true, data: templates, meta: { total, limit, skip } });
    } catch (error: any) {
        logger.error('[TEMPLATES] Failed to list templates', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to list templates' });
    }
};

/**
 * GET /api/sequencer/templates/:id
 * Get a single template.
 */
export const getTemplate = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const templateId = String(req.params.id);

        const template = await prisma.emailTemplate.findFirst({
            where: { id: templateId, organization_id: orgId },
        });

        if (!template) return res.status(404).json({ success: false, error: 'Template not found' });

        return res.json({ success: true, data: template });
    } catch (error: any) {
        logger.error('[TEMPLATES] Failed to get template', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to get template' });
    }
};

/**
 * POST /api/sequencer/templates
 * Create a new template.
 */
// Hard cap on template body size - Postgres TEXT has no inherent limit,
// but loading a 50 MB body into the editor every time the operator opens
// the template would brick the UI and tank the dispatcher (templates are
// loaded per-send for variable substitution). 1 MB is generous for any
// real email template; bigger almost always means embedded base64 images
// (and those should be hosted, not inlined).
const TEMPLATE_BODY_HTML_MAX_BYTES = 1_000_000;

export const createTemplate = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { name, subject, preheader, bodyHtml, bodyText, category, folder_id } = req.body;

        if (!name || !subject || !bodyHtml) {
            return res.status(400).json({ success: false, error: 'name, subject, and bodyHtml are required' });
        }
        if (typeof bodyHtml === 'string' && bodyHtml.length > TEMPLATE_BODY_HTML_MAX_BYTES) {
            return res.status(413).json({
                success: false,
                error: `Template body exceeds ${TEMPLATE_BODY_HTML_MAX_BYTES} byte limit. Inline images? Host them externally and reference by URL instead.`,
            });
        }

        const template = await prisma.emailTemplate.create({
            data: {
                organization_id: orgId,
                name,
                subject,
                preheader: typeof preheader === 'string' ? preheader : '',
                body_html: bodyHtml,
                body_text: bodyText || null,
                category: category || 'general',
                folder_id: folder_id || null,
            },
        });

        return res.status(201).json({ success: true, data: template });
    } catch (error: any) {
        logger.error('[TEMPLATES] Failed to create template', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to create template' });
    }
};

/**
 * PATCH /api/sequencer/templates/:id
 * Update a template.
 */
export const updateTemplate = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const templateId = String(req.params.id);
        const { name, subject, preheader, bodyHtml, bodyText, category, folder_id } = req.body;

        const template = await prisma.emailTemplate.findFirst({
            where: { id: templateId, organization_id: orgId },
        });

        if (!template) return res.status(404).json({ success: false, error: 'Template not found' });
        if (typeof bodyHtml === 'string' && bodyHtml.length > TEMPLATE_BODY_HTML_MAX_BYTES) {
            return res.status(413).json({
                success: false,
                error: `Template body exceeds ${TEMPLATE_BODY_HTML_MAX_BYTES} byte limit. Inline images? Host them externally and reference by URL instead.`,
            });
        }

        const updateData: any = {};
        if (name !== undefined) updateData.name = name;
        if (subject !== undefined) updateData.subject = subject;
        if (preheader !== undefined) updateData.preheader = typeof preheader === 'string' ? preheader : '';
        if (bodyHtml !== undefined) updateData.body_html = bodyHtml;
        if (bodyText !== undefined) updateData.body_text = bodyText;
        if (category !== undefined) updateData.category = category;
        // folder_id can be null (move to Uncategorized) or a string id (move to folder).
        if (folder_id !== undefined) updateData.folder_id = folder_id || null;

        const updated = await prisma.emailTemplate.update({
            where: { id: templateId },
            data: updateData,
        });

        return res.json({ success: true, data: updated });
    } catch (error: any) {
        logger.error('[TEMPLATES] Failed to update template', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to update template' });
    }
};

/**
 * DELETE /api/sequencer/templates/:id
 * Delete a template.
 */
export const deleteTemplate = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const templateId = String(req.params.id);

        const template = await prisma.emailTemplate.findFirst({
            where: { id: templateId, organization_id: orgId },
        });

        if (!template) return res.status(404).json({ success: false, error: 'Template not found' });

        await prisma.emailTemplate.delete({ where: { id: templateId } });

        return res.json({ success: true, message: 'Template deleted' });
    } catch (error: any) {
        logger.error('[TEMPLATES] Failed to delete template', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to delete template' });
    }
};

/**
 * POST /api/sequencer/templates/:id/duplicate
 * Copy a template with " (Copy)" suffix.
 */
export const duplicateTemplate = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const templateId = String(req.params.id);

        const template = await prisma.emailTemplate.findFirst({
            where: { id: templateId, organization_id: orgId },
        });

        if (!template) return res.status(404).json({ success: false, error: 'Template not found' });

        const duplicate = await prisma.emailTemplate.create({
            data: {
                organization_id: orgId,
                name: `${template.name} (Copy)`,
                subject: template.subject,
                body_html: template.body_html,
                body_text: template.body_text,
                category: template.category,
                // Preserve folder so operators don't lose organizational
                // structure when duplicating - the original behaviour was
                // to drop everything into Uncategorized.
                folder_id: template.folder_id,
            },
        });

        return res.status(201).json({ success: true, data: duplicate });
    } catch (error: any) {
        logger.error('[TEMPLATES] Failed to duplicate template', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to duplicate template' });
    }
};
