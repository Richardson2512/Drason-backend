/**
 * LinkedIn lead-detail endpoints - narrow surface focused on the
 * signal-context icebreaker.
 *
 *   GET  /api/linkedin/leads/:id/icebreaker     - read stored text + meta
 *   POST /api/linkedin/leads/:id/icebreaker/regenerate
 *                                              - re-run the generator
 *                                                against the most recent
 *                                                engagement event for
 *                                                this lead's profile
 *
 * The icebreaker is generated automatically by supervisor.ts on the
 * signal-promotion path. These routes exist so the operator can (a) see
 * what was generated and (b) regenerate after editing prompt/template
 * config or when the original signal got better post text via a later
 * poller cycle.
 */

import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { getOrgId } from '../middleware/orgContext';
import { generateIcebreakerFromSignal } from '../services/signalIcebreakerService';

export const getIcebreaker = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);
        const lead = await prisma.lead.findFirst({
            where: { id, organization_id: orgId },
            select: {
                id: true,
                full_name: true,
                signal_icebreaker: true,
                signal_icebreaker_generated_at: true,
                signal_icebreaker_event_id: true,
                signal_icebreaker_skip_reason: true,
            },
        });
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
        return res.json({ success: true, data: lead });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};

/**
 * Re-runs the icebreaker generator. Selection rule: when the lead already
 * has a signal_icebreaker_event_id we re-generate against that same event
 * (so the operator can iterate without changing grounding context); when
 * it doesn't, we pick the most recent EngagementEvent for the lead's
 * linked LinkedInProfile.
 */
export const regenerateIcebreaker = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const id = String(req.params.id);

        const lead = await prisma.lead.findFirst({
            where: { id, organization_id: orgId },
            select: { id: true, signal_icebreaker_event_id: true },
        });
        if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

        let eventId = lead.signal_icebreaker_event_id || null;
        if (!eventId) {
            // Most recent engagement on this lead's profile.
            const profile = await prisma.linkedInProfile.findFirst({
                where: { organization_id: orgId, lead_id: id },
                select: { id: true },
            });
            if (!profile) {
                return res.status(400).json({
                    success: false,
                    error: 'No LinkedIn profile linked to this lead - nothing to ground the opener on.',
                });
            }
            const event = await prisma.engagementEvent.findFirst({
                where: { organization_id: orgId, actor_profile_id: profile.id },
                orderBy: { occurred_at: 'desc' },
                select: { id: true },
            });
            if (!event) {
                return res.status(400).json({
                    success: false,
                    error: 'No engagement events for this lead - generator has nothing to reference.',
                });
            }
            eventId = event.id;
        }

        const result = await generateIcebreakerFromSignal({
            organizationId: orgId,
            leadId: id,
            engagementEventId: eventId,
        });

        if (!result.text) {
            return res.status(200).json({
                success: false,
                skipped: true,
                skip_reason: result.skip_reason ?? 'unknown',
            });
        }

        // Persist on the Lead row so the sequencer's {{signal_icebreaker}}
        // renderer picks it up next send.
        const updated = await prisma.lead.update({
            where: { id },
            data: {
                signal_icebreaker: result.text,
                signal_icebreaker_generated_at: new Date(),
                signal_icebreaker_event_id: eventId,
            },
            select: {
                signal_icebreaker: true,
                signal_icebreaker_generated_at: true,
                signal_icebreaker_event_id: true,
            },
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
};
