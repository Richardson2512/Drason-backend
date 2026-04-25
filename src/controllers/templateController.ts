/**
 * Template Controller
 *
 * CRUD for EmailTemplates used in the Sequencer.
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../index';
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

        const where: any = { organization_id: orgId };
        if (category && category !== 'all') where.category = category;
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { subject: { contains: search, mode: 'insensitive' } },
            ];
        }

        const templates = await prisma.emailTemplate.findMany({
            where,
            orderBy: { created_at: 'desc' },
        });

        return res.json({ success: true, data: templates });
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
export const createTemplate = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const { name, subject, bodyHtml, bodyText, category } = req.body;

        if (!name || !subject || !bodyHtml) {
            return res.status(400).json({ success: false, error: 'name, subject, and bodyHtml are required' });
        }

        const template = await prisma.emailTemplate.create({
            data: {
                organization_id: orgId,
                name,
                subject,
                body_html: bodyHtml,
                body_text: bodyText || null,
                category: category || 'general',
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
        const { name, subject, bodyHtml, bodyText, category } = req.body;

        const template = await prisma.emailTemplate.findFirst({
            where: { id: templateId, organization_id: orgId },
        });

        if (!template) return res.status(404).json({ success: false, error: 'Template not found' });

        const updateData: any = {};
        if (name !== undefined) updateData.name = name;
        if (subject !== undefined) updateData.subject = subject;
        if (bodyHtml !== undefined) updateData.body_html = bodyHtml;
        if (bodyText !== undefined) updateData.body_text = bodyText;
        if (category !== undefined) updateData.category = category;

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
            },
        });

        return res.status(201).json({ success: true, data: duplicate });
    } catch (error: any) {
        logger.error('[TEMPLATES] Failed to duplicate template', error instanceof Error ? error : new Error(String(error)));
        return res.status(500).json({ success: false, error: 'Failed to duplicate template' });
    }
};
