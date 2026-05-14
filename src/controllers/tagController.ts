/**
 * Tag Controller — operator-defined contact tags.
 *
 * Endpoints (all under /api/sequencer/tags):
 *   GET  /            — list tags + count of leads carrying each
 *   POST /            — create a tag (name + optional color)
 *   PATCH /:id        — rename / recolor a tag
 *   DELETE /:id       — delete a tag (cascade-clears it from all leads)
 *
 * Lead tagging endpoints live on contactController to keep lead-mutation
 * surface area in one place:
 *   PUT  /api/sequencer/contacts/:id/tags    — replace a lead's tags
 *   POST /api/sequencer/contacts/bulk-tag    — add/remove a tag from many leads
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import { prisma } from '../prisma';
import { logger } from '../services/observabilityService';

const NAME_MAX = 40;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function validName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > NAME_MAX) return null;
    return trimmed;
}

function validColor(raw: unknown): string | null | undefined {
    if (raw === undefined) return undefined;       // not provided — leave alone
    if (raw === null || raw === '') return null;   // explicit clear
    if (typeof raw !== 'string') return undefined; // ignore non-strings
    return HEX_RE.test(raw) ? raw : undefined;
}

export const listTags = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const tags = await prisma.tag.findMany({
            where: { organization_id: orgId },
            orderBy: { name: 'asc' },
            include: {
                _count: { select: { leadTags: true, campaignTags: true } },
            },
        });
        return res.json({
            success: true,
            tags: tags.map(t => ({
                id: t.id,
                name: t.name,
                color: t.color,
                // Per-surface counts so the Manage modal can show
                // "N contacts · M campaigns" and per-surface filter
                // dropdowns can show only the count relevant to their page.
                contact_count: t._count.leadTags,
                campaign_count: t._count.campaignTags,
                // `count` kept as a backward-compat alias = total surfaces
                // a tag is applied to. Existing callers that read `t.count`
                // continue to work; new callers should use the explicit fields.
                count: t._count.leadTags + t._count.campaignTags,
                created_at: t.created_at,
            })),
        });
    } catch (err) {
        logger.error('[TAGS] list failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to list tags' });
    }
};

export const createTag = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const name = validName(req.body?.name);
        const color = validColor(req.body?.color);
        if (!name) return res.status(400).json({ success: false, error: `Tag name is required (max ${NAME_MAX} chars)` });

        const existing = await prisma.tag.findFirst({ where: { organization_id: orgId, name } });
        if (existing) return res.status(409).json({ success: false, error: 'A tag with that name already exists' });

        const tag = await prisma.tag.create({
            data: {
                organization_id: orgId,
                name,
                color: color ?? null,
            },
        });
        return res.status(201).json({ success: true, tag: { id: tag.id, name: tag.name, color: tag.color, count: 0 } });
    } catch (err) {
        logger.error('[TAGS] create failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to create tag' });
    }
};

export const updateTag = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);

        const tag = await prisma.tag.findFirst({ where: { id, organization_id: orgId } });
        if (!tag) return res.status(404).json({ success: false, error: 'Tag not found' });

        const updates: { name?: string; color?: string | null } = {};
        if (req.body?.name !== undefined) {
            const name = validName(req.body.name);
            if (!name) return res.status(400).json({ success: false, error: `Tag name is required (max ${NAME_MAX} chars)` });
            // Collision check across other rows in the same org
            const collision = await prisma.tag.findFirst({
                where: { organization_id: orgId, name, id: { not: id } },
            });
            if (collision) return res.status(409).json({ success: false, error: 'A tag with that name already exists' });
            updates.name = name;
        }
        const colorParsed = validColor(req.body?.color);
        if (colorParsed !== undefined) updates.color = colorParsed;

        await prisma.tag.update({ where: { id }, data: updates });
        return res.json({ success: true });
    } catch (err) {
        logger.error('[TAGS] update failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to update tag' });
    }
};

export const deleteTag = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);

        const tag = await prisma.tag.findFirst({ where: { id, organization_id: orgId } });
        if (!tag) return res.status(404).json({ success: false, error: 'Tag not found' });

        // LeadTag cascades on Tag delete (schema-level), so this single
        // delete clears the tag from every lead in the org atomically.
        await prisma.tag.delete({ where: { id } });
        return res.json({ success: true });
    } catch (err) {
        logger.error('[TAGS] delete failed', err instanceof Error ? err : new Error(String(err)));
        return res.status(500).json({ success: false, error: 'Failed to delete tag' });
    }
};
