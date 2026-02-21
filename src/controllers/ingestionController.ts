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
import * as smartleadClient from '../services/smartleadClient';
import * as leadAssignmentService from '../services/leadAssignmentService';
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

        // Atomically assign lead to campaign with capacity checking
        if (campaignId) {
            // Use atomic assignment to prevent capacity violations
            const assignmentResult = await leadAssignmentService.assignLeadToCampaignWithCapacityCheck(
                organizationId,
                createdLead.id,
                campaignId,
                { allowOverCapacity: false }
            );

            if (!assignmentResult.assigned) {
                // Assignment failed due to capacity or other issue
                logger.warn(`[INGEST] Failed to assign lead ${createdLead.id} to campaign ${campaignId}: ${assignmentResult.reason}`);
                await auditLogService.logAction({
                    organizationId,
                    entity: 'lead',
                    entityId: createdLead.id,
                    trigger: 'ingestion',
                    action: 'assignment_failed',
                    details: `Routing suggested campaign ${campaignId} but assignment failed: ${assignmentResult.reason}. Lead remains in holding pool.`
                });

                // Return success but indicate lead is in holding pool
                return res.json({
                    success: true,
                    data: {
                        message: 'Lead ingested but assignment failed due to capacity',
                        leadId: createdLead.id,
                        assignedCampaignId: null,
                        pushedToSmartlead: false,
                        capacityReason: assignmentResult.reason
                    }
                });
            }

            logger.info(`[INGEST] Assigned lead ${createdLead.id} to campaign ${campaignId} (${assignmentResult.currentLoad}/${assignmentResult.capacity})`);

            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'ingestion',
                action: 'assigned',
                details: `Routed to campaign ${campaignId} based on rules (load: ${assignmentResult.currentLoad}/${assignmentResult.capacity}).`
            });

            // Push lead to Smartlead campaign
            logger.info(`[INGEST] Pushing lead ${email} to Smartlead campaign ${campaignId}`);
            const pushSuccess = await smartleadClient.pushLeadToCampaign(
                organizationId,
                campaignId,
                {
                    email,
                    first_name: req.body.first_name,
                    last_name: req.body.last_name,
                    company: req.body.company
                }
            );

            if (pushSuccess) {
                // Mark lead as active since it's now in Smartlead
                await prisma.lead.update({
                    where: { id: createdLead.id },
                    data: { status: LeadState.ACTIVE }
                });
                logger.info(`[INGEST] Successfully pushed lead ${email} to Smartlead campaign ${campaignId}`);
            } else {
                // Push failed - lead stays in HELD status
                logger.error(`[INGEST] Failed to push lead ${email} to Smartlead campaign ${campaignId}`);
                await auditLogService.logAction({
                    organizationId,
                    entity: 'lead',
                    entityId: createdLead.id,
                    trigger: 'ingestion',
                    action: 'push_failed',
                    details: `Failed to push lead to Smartlead campaign ${campaignId}. Lead remains in HELD status.`
                });
            }
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
                assignedCampaignId: campaignId,
                pushedToSmartlead: campaignId ? true : false
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
 * NOW WITH:
 * - HMAC-SHA256 signature validation for security
 * - Lead Health Gate - classifies leads before routing
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

    // Fetch organization and webhook secret
    const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, clay_webhook_secret: true }
    });

    if (!org) {
        return res.status(404).json({ error: 'Invalid Organization ID' });
    }

    // === SECURITY: Validate HMAC-SHA256 Signature ===
    const signature = req.headers['x-clay-signature'] as string;

    if (!signature && process.env.NODE_ENV === 'production') {
        logger.warn('[INGEST CLAY] Missing signature in production - rejecting', { organizationId });
        return res.status(401).json({
            error: 'Missing webhook signature',
            message: 'Clay webhooks must include X-Clay-Signature header. Configure this in your Clay webhook settings.'
        });
    }

    if (!org.clay_webhook_secret) {
        logger.warn('[INGEST CLAY] No webhook secret configured for org', { organizationId });
        if (process.env.NODE_ENV === 'production') {
            return res.status(500).json({
                error: 'Webhook not configured',
                message: 'Contact support - webhook secret is missing for your organization'
            });
        }
        logger.info('[INGEST CLAY] Allowing in development without secret');
    }

    // Validate signature if secret exists
    if (signature && org.clay_webhook_secret) {
        const crypto = await import('crypto');
        const expectedSignature = crypto
            .createHmac('sha256', org.clay_webhook_secret)
            .update(JSON.stringify(req.body))
            .digest('hex');

        const isValid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );

        if (!isValid) {
            logger.warn('[INGEST CLAY] Invalid signature', { organizationId });
            return res.status(401).json({
                error: 'Invalid webhook signature',
                message: 'Signature validation failed. Ensure Clay is configured with the correct webhook secret.'
            });
        }

        logger.info('[INGEST CLAY] Signature validated successfully', { organizationId });
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
            // Atomically assign lead to campaign with capacity checking
            const assignmentResult = await leadAssignmentService.assignLeadToCampaignWithCapacityCheck(
                organizationId,
                createdLead.id,
                campaignId,
                { allowOverCapacity: false }
            );

            if (!assignmentResult.assigned) {
                // Assignment failed due to capacity or other issue
                logger.warn(`[INGEST CLAY] Failed to assign lead ${createdLead.id} to campaign ${campaignId}: ${assignmentResult.reason}`);
                await auditLogService.logAction({
                    organizationId,
                    entity: 'lead',
                    entityId: createdLead.id,
                    trigger: 'ingestion',
                    action: 'assignment_failed',
                    details: `Clay webhook routing suggested campaign ${campaignId} but assignment failed: ${assignmentResult.reason}. Lead remains in holding pool.`
                });

                // Return success but indicate lead is in holding pool
                return res.json({
                    message: 'Lead ingested but assignment failed due to capacity',
                    leadId: createdLead.id,
                    success: true,
                    capacityReason: assignmentResult.reason
                });
            }

            logger.info(`[INGEST CLAY] Assigned lead ${createdLead.id} to campaign ${campaignId} (${assignmentResult.currentLoad}/${assignmentResult.capacity})`);
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'ingestion',
                action: 'assigned',
                details: `Routed to campaign ${campaignId} via Clay webhook. Health: ${healthResult.classification} (load: ${assignmentResult.currentLoad}/${assignmentResult.capacity})`
            });

            // Push lead to Smartlead campaign
            logger.info(`[INGEST CLAY] Pushing lead ${email} to Smartlead campaign ${campaignId}`);
            const firstName = findVal(['first_name', 'firstname', 'first name', 'fname']);
            const lastName = findVal(['last_name', 'lastname', 'last name', 'lname']);
            const company = findVal(['company', 'company_name', 'company name', 'organization']);

            const pushSuccess = await smartleadClient.pushLeadToCampaign(
                organizationId,
                campaignId,
                {
                    email,
                    first_name: firstName,
                    last_name: lastName,
                    company
                }
            );

            if (pushSuccess) {
                // Mark lead as active since it's now in Smartlead
                await prisma.lead.update({
                    where: { id: createdLead.id },
                    data: { status: LeadState.ACTIVE }
                });
                logger.info(`[INGEST CLAY] Successfully pushed lead ${email} to Smartlead campaign ${campaignId}`);
            } else {
                // Push failed - lead stays in HELD status
                logger.error(`[INGEST CLAY] Failed to push lead ${email} to Smartlead campaign ${campaignId}`);
                await auditLogService.logAction({
                    organizationId,
                    entity: 'lead',
                    entityId: createdLead.id,
                    trigger: 'ingestion',
                    action: 'push_failed',
                    details: `Failed to push Clay lead to Smartlead campaign ${campaignId}. Lead remains in HELD status.`
                });
            }
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
            pushedToSmartlead: campaignId ? true : false,
            success: true
        });

    } catch (e) {
        logger.error('[INGEST CLAY] Error processing webhook:', e as Error);
        res.status(500).json({ error: 'Internal error processing Clay webhook' });
    }
};

