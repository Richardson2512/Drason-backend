/**
 * Ingestion Controller
 * 
 * Handles lead ingestion from direct API calls and Clay webhooks.
 * All leads are created with organization context for multi-tenancy.
 * 
 * Section 6 of Audit: Lead Ingestion Flow
 * NOW WITH: Lead Health Gate - classifies leads as GREEN/YELLOW/RED before routing
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import * as routingService from '../services/routingService';
import * as auditLogService from '../services/auditLogService';
import * as eventService from '../services/eventService';
import * as leadHealthService from '../services/leadHealthService';
import { getOrgId } from '../middleware/orgContext';
import { EventType, LeadState } from '../types';
import { logger } from '../services/observabilityService';

/**
 * Direct API lead ingestion.
 * POST /api/ingest
 */
export const ingestLead = async (req: Request, res: Response) => {
    const { email, persona, lead_score, source } = req.body;

    if (!email || !persona || lead_score === undefined) {
        return res.status(400).json({ error: 'Missing required fields: email, persona, lead_score' });
    }

    // Get organization context
    let organizationId: string;
    try {
        organizationId = getOrgId(req);
    } catch (error) {
        return res.status(401).json({ error: 'Organization context required' });
    }

    logger.info(`[INGEST] Org: ${organizationId} | Lead: ${email} (${persona}, ${lead_score})`);

    try {
        // === LEAD HEALTH GATE ===
        // Classify lead health BEFORE storing/routing
        const healthResult = await leadHealthService.classifyLeadHealth(email);
        logger.info(`[HEALTH GATE] Lead: ${email} | Classification: ${healthResult.classification} | Score: ${healthResult.score}`);

        // Generate idempotency key for event storage
        const idempotencyKey = `${organizationId}:lead:${email}`;

        // Store raw event first (Section 5.1 - store before processing)
        await eventService.storeEvent({
            organizationId,
            eventType: EventType.LEAD_INGESTED,
            entityType: 'lead',
            payload: {
                email,
                persona,
                lead_score,
                source: source || 'api',
                health_classification: healthResult.classification,
                health_score: healthResult.score,
                health_checks: healthResult.checks
            },
            idempotencyKey
        });

        // Create the lead with organization scope AND health classification
        const createdLead = await prisma.lead.upsert({
            where: {
                organization_id_email: {
                    organization_id: organizationId,
                    email
                }
            },
            update: {
                persona,
                lead_score,
                source: source || 'api',
                health_classification: healthResult.classification,
                health_score_calc: healthResult.score,
                health_checks: healthResult.checks
            },
            create: {
                email,
                persona,
                lead_score,
                source: source || 'api',
                status: healthResult.classification === 'red' ? LeadState.BLOCKED : LeadState.HELD,
                health_state: 'healthy',
                health_classification: healthResult.classification,
                health_score_calc: healthResult.score,
                health_checks: healthResult.checks,
                organization_id: organizationId
            }
        });

        // === HEALTH GATE DECISION ===
        // RED leads are blocked - don't route them
        if (healthResult.classification === 'red') {
            logger.info(`[HEALTH GATE] BLOCKED lead ${createdLead.id}: ${healthResult.reasons.join(', ')}`);
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'health_gate',
                action: 'blocked',
                details: `Lead blocked by health gate: ${healthResult.reasons.join(', ')}`
            });

            return res.json({
                success: true,
                data: {
                    message: 'Lead blocked by health gate',
                    leadId: createdLead.id,
                    healthClassification: healthResult.classification,
                    healthScore: healthResult.score,
                    blockReasons: healthResult.reasons,
                    assignedCampaignId: null
                }
            });
        }

        // Resolve routing with org context
        const campaignId = await routingService.resolveCampaignForLead(organizationId, createdLead);

        // Update lead with assigned campaign
        if (campaignId) {
            await prisma.lead.update({
                where: { id: createdLead.id },
                data: { assigned_campaign_id: campaignId }
            });
            logger.info(`[INGEST] Assigned lead ${createdLead.id} to campaign ${campaignId}`);

            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'ingestion',
                action: 'assigned',
                details: `Routed to campaign ${campaignId} based on rules.`
            });
        } else {
            logger.info(`[INGEST] No campaign matched for lead ${createdLead.id}`);
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'ingestion',
                action: 'unassigned',
                details: `No routing rule matched. Lead remains in holding pool.`
            });
        }

        res.json({
            success: true,
            data: {
                message: 'Lead ingested successfully',
                leadId: createdLead.id,
                assignedCampaignId: campaignId
            }
        });

    } catch (error) {
        logger.error('[INGEST] Error:', error as Error);
        res.status(500).json({ error: 'Internal server error during ingestion' });
    }
};

/**
 * Clay webhook lead ingestion.
 * POST /api/ingest/clay
 * 
 * Handles flexible Clay payload format with case-insensitive field lookup.
 * NOW WITH: Lead Health Gate - classifies leads before routing
 */
export const ingestClayWebhook = async (req: Request, res: Response) => {
    logger.info('[INGEST CLAY] Received payload', { preview: JSON.stringify(req.body).substring(0, 200) });

    const payload = req.body;

    // Get organization context
    // Get organization context manual extraction (since middleware skips public routes)
    let organizationId = req.headers['x-organization-id'] as string || req.query.orgId as string;

    if (!organizationId) {
        // Fallback: Try to find orgId in the payload itself
        organizationId = payload.orgId || payload.organizationId || payload.organization_id;
    }

    if (!organizationId) {
        return res.status(400).json({ error: 'Organization ID required in header (X-Organization-ID) or query param (?orgId)' });
    }

    // specific validation to ensure org exists
    const orgExists = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!orgExists) {
        return res.status(404).json({ error: 'Invalid Organization ID' });
    }

    // Helper to find value case-insensitively
    const findVal = (keys: string[]): any => {
        for (const k of keys) {
            if (payload[k] !== undefined) return payload[k];
            const lowerKey = Object.keys(payload).find(pk => pk.toLowerCase() === k.toLowerCase());
            if (lowerKey) return payload[lowerKey];
        }
        return undefined;
    };

    const email = findVal(['email', 'e-mail', 'work email']);
    const persona = findVal(['persona', 'job title', 'title', 'role']) || 'General';
    const lead_score = parseInt(findVal(['lead score', 'score', 'lead_score']) || '50', 10);

    if (!email) {
        logger.error('[INGEST CLAY] Missing email in payload');
        return res.status(400).json({ error: 'Missing email field in Clay payload' });
    }

    try {
        // === LEAD HEALTH GATE ===
        const healthResult = await leadHealthService.classifyLeadHealth(email);
        logger.info(`[HEALTH GATE CLAY] Lead: ${email} | Classification: ${healthResult.classification} | Score: ${healthResult.score}`);

        // Generate idempotency key
        const externalId = findVal(['id', 'external_id', 'row_id']) || email;
        const idempotencyKey = `${organizationId}:clay:${externalId}`;

        // Store raw event with health data
        await eventService.storeEvent({
            organizationId,
            eventType: EventType.LEAD_INGESTED,
            entityType: 'lead',
            payload: {
                ...payload,
                health_classification: healthResult.classification,
                health_score: healthResult.score,
                health_checks: healthResult.checks
            },
            idempotencyKey
        });

        // Create/update lead with health classification
        const createdLead = await prisma.lead.upsert({
            where: {
                organization_id_email: {
                    organization_id: organizationId,
                    email
                }
            },
            update: {
                persona,
                lead_score,
                source: 'clay',
                health_classification: healthResult.classification,
                health_score_calc: healthResult.score,
                health_checks: healthResult.checks
            },
            create: {
                email,
                persona,
                lead_score,
                source: 'clay',
                status: healthResult.classification === 'red' ? LeadState.BLOCKED : LeadState.HELD,
                health_state: 'healthy',
                health_classification: healthResult.classification,
                health_score_calc: healthResult.score,
                health_checks: healthResult.checks,
                organization_id: organizationId
            }
        });

        // === HEALTH GATE DECISION ===
        // RED leads are blocked - don't route them
        if (healthResult.classification === 'red') {
            logger.info(`[HEALTH GATE CLAY] BLOCKED lead ${createdLead.id}: ${healthResult.reasons.join(', ')}`);
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'health_gate',
                action: 'blocked',
                details: `Clay lead blocked by health gate: ${healthResult.reasons.join(', ')}`
            });

            return res.json({
                message: 'Lead blocked by health gate',
                leadId: createdLead.id,
                healthClassification: healthResult.classification,
                healthScore: healthResult.score,
                blockReasons: healthResult.reasons,
                success: true
            });
        }

        // Resolve routing for GREEN/YELLOW leads
        const campaignId = await routingService.resolveCampaignForLead(organizationId, createdLead);

        if (campaignId) {
            await prisma.lead.update({
                where: { id: createdLead.id },
                data: { assigned_campaign_id: campaignId }
            });
            logger.info(`[INGEST CLAY] Assigned lead ${createdLead.id} to campaign ${campaignId}`);
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'ingestion',
                action: 'assigned',
                details: `Routed to campaign ${campaignId} via Clay webhook. Health: ${healthResult.classification}`
            });
        } else {
            logger.info(`[INGEST CLAY] No campaign matched for lead ${createdLead.id}`);
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'ingestion',
                action: 'unassigned',
                details: `No routing rule matched for Clay lead. Health: ${healthResult.classification}`
            });
        }

        res.json({
            message: 'Clay lead processed',
            leadId: createdLead.id,
            healthClassification: healthResult.classification,
            healthScore: healthResult.score,
            success: true
        });

    } catch (e) {
        logger.error('[INGEST CLAY] Error processing webhook:', e as Error);
        res.status(500).json({ error: 'Internal error processing Clay webhook' });
    }
};

