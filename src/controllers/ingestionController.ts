/**
 * Ingestion Controller
 *
 * Handles lead ingestion from direct API calls and Clay webhooks.
 * All leads are created with organization context for multi-tenancy.
 *
 * ARCHITECTURE: Both endpoints delegate to processLead() — a single shared
 * pipeline for health gate → upsert → routing → assignment → platform push.
 * Bug fixes apply once. Source is just a parameter.
 */

import { Request, Response } from 'express';
import { prisma } from '../index';
import * as routingService from '../services/routingService';
import * as auditLogService from '../services/auditLogService';
import * as eventService from '../services/eventService';
import * as leadHealthService from '../services/leadHealthService';
import * as leadAssignmentService from '../services/leadAssignmentService';
import * as entityStateService from '../services/entityStateService';
import * as emailValidationService from '../services/emailValidationService';
import { enrollLeadInSequencerCampaign } from '../services/sequencerEnrollmentService';
import * as redisUtils from '../utils/redis';
import { getOrgId } from '../middleware/orgContext';
import { EventType, LeadState, TriggerType, ValidationStatus } from '../types';
import { logger } from '../services/observabilityService';

// ============================================================================
// SHARED LEAD PROCESSING PIPELINE
// ============================================================================

interface LeadInput {
    email: string;
    persona: string;
    lead_score: number;
    source: string;
    first_name?: string;
    last_name?: string;
    company?: string;
    idempotencyKey?: string;
    extraPayload?: Record<string, any>;
}

interface ProcessResult {
    success: boolean;
    leadId: string;
    healthClassification: string;
    healthScore: number;
    validationStatus?: string;
    validationScore?: number;
    blockReasons?: string[];
    assignedCampaignId: string | null;
    pushedToPlatform: boolean;
    capacityReason?: string;
    message: string;
}

/**
 * Single pipeline for all lead ingestion — health gate → upsert → route → assign → push.
 * Both API and Clay endpoints call this. Bug fixes apply once.
 */
export async function processLead(
    organizationId: string,
    input: LeadInput
): Promise<ProcessResult> {
    const { persona, lead_score, source, first_name, last_name, company } = input;
    const email = input.email.toLowerCase().trim();
    const logTag = source === 'clay' ? 'INGEST CLAY' : 'INGEST';

    // === 0. EMAIL VALIDATION (before health gate) ===
    // Fetch org tier to gate MillionVerifier API usage
    const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { subscription_tier: true },
    });
    const validationResult = await emailValidationService.validateLeadEmail(
        organizationId,
        email,
        org?.subscription_tier || 'starter'
    );
    logger.info(`[VALIDATION] Lead: ${email} | Status: ${validationResult.status} | Score: ${validationResult.score} | Source: ${validationResult.source} | Tier: ${org?.subscription_tier || 'starter'}`);

    // === 1. HEALTH GATE (enhanced with validation context) ===
    const healthResult = await leadHealthService.classifyLeadHealth(email, {
        validationScore: validationResult.score,
        isDisposable: validationResult.is_disposable,
        isCatchAll: validationResult.is_catch_all,
    });
    logger.info(`[HEALTH GATE] Lead: ${email} | Classification: ${healthResult.classification} | Score: ${healthResult.score}`);

    // Store raw event (Section 5.1 — store before processing)
    const idempotencyKey = input.idempotencyKey || `${organizationId}:${source}:${email}`;
    await eventService.storeEvent({
        organizationId,
        eventType: EventType.LEAD_INGESTED,
        entityType: 'lead',
        payload: {
            email, persona, lead_score, source,
            health_classification: healthResult.classification,
            health_score: healthResult.score,
            health_checks: healthResult.checks,
            ...input.extraPayload,
        },
        idempotencyKey
    });

    // === 2. UPSERT LEAD ===
    // Determine initial status: invalid validation → BLOCKED, red health → BLOCKED, else HELD
    const initialStatus = validationResult.status === ValidationStatus.INVALID
        ? LeadState.BLOCKED
        : healthResult.classification === 'red'
            ? LeadState.BLOCKED
            : LeadState.HELD;

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
            source,
            health_classification: healthResult.classification,
            health_score_calc: healthResult.score,
            health_checks: healthResult.checks,
            // Validation fields (single writer: emailValidationService populated these,
            // ingestion controller persists them alongside the upsert)
            validation_status: validationResult.status,
            validation_score: validationResult.score,
            validation_source: validationResult.source,
            validated_at: new Date(),
            is_catch_all: validationResult.is_catch_all,
            is_disposable: validationResult.is_disposable,
        },
        create: {
            email,
            persona,
            lead_score,
            source,
            status: initialStatus,
            health_state: 'healthy',
            health_classification: healthResult.classification,
            health_score_calc: healthResult.score,
            health_checks: healthResult.checks,
            validation_status: validationResult.status,
            validation_score: validationResult.score,
            validation_source: validationResult.source,
            validated_at: new Date(),
            is_catch_all: validationResult.is_catch_all,
            is_disposable: validationResult.is_disposable,
            organization_id: organizationId
        }
    });

    // Record validation attempt now that the lead exists
    if (validationResult.attempt) {
        try {
            await prisma.validationAttempt.create({
                data: {
                    lead_id: createdLead.id,
                    organization_id: organizationId,
                    source: validationResult.attempt.source,
                    result_status: validationResult.attempt.result_status,
                    result_score: validationResult.attempt.result_score,
                    result_details: validationResult.attempt.result_details,
                    duration_ms: validationResult.attempt.duration_ms,
                },
            });
        } catch (err) {
            logger.warn('[VALIDATION] Failed to record attempt post-upsert', { error: String(err) });
        }
    }

    // === 3. VALIDATION + HEALTH GATE DECISION ===
    // Block if validation says invalid OR health gate says red
    if (validationResult.status === ValidationStatus.INVALID) {
        const blockReason = validationResult.is_disposable
            ? 'Disposable email domain detected'
            : validationResult.score <= 0
                ? 'Invalid email syntax'
                : 'Email address is invalid (no MX records or failed verification)';

        logger.info(`[VALIDATION] BLOCKED lead ${createdLead.id}: ${blockReason}`);
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: createdLead.id,
            trigger: 'email_validation',
            action: 'blocked',
            details: `Lead blocked by email validation (${source}): ${blockReason}. Score: ${validationResult.score}/100`
        });

        return {
            success: true,
            leadId: createdLead.id,
            healthClassification: healthResult.classification,
            healthScore: healthResult.score,
            validationStatus: validationResult.status,
            validationScore: validationResult.score,
            blockReasons: [blockReason],
            assignedCampaignId: null,
            pushedToPlatform: false,
            message: 'Lead blocked by email validation',
        };
    }

    if (healthResult.classification === 'red') {
        logger.info(`[HEALTH GATE] BLOCKED lead ${createdLead.id}: ${healthResult.reasons.join(', ')}`);
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: createdLead.id,
            trigger: 'health_gate',
            action: 'blocked',
            details: `Lead blocked by health gate (${source}): ${healthResult.reasons.join(', ')}`
        });

        return {
            success: true,
            leadId: createdLead.id,
            healthClassification: healthResult.classification,
            healthScore: healthResult.score,
            validationStatus: validationResult.status,
            validationScore: validationResult.score,
            blockReasons: healthResult.reasons,
            assignedCampaignId: null,
            pushedToPlatform: false,
            message: 'Lead blocked by health gate',
        };
    }

    // === 4. DEDUPLICATION CHECK ===
    if (createdLead.assigned_campaign_id) {
        logger.info(`[${logTag}] Lead ${email} already assigned to campaign ${createdLead.assigned_campaign_id}. Skipping routing.`);
        return {
            success: true,
            leadId: createdLead.id,
            healthClassification: healthResult.classification,
            healthScore: healthResult.score,
            assignedCampaignId: createdLead.assigned_campaign_id,
            pushedToPlatform: false,
            message: 'Lead already exists and is active in a campaign',
        };
    }

    // === 5. ROUTING ===
    const campaignId = await routingService.resolveCampaignForLead(organizationId, createdLead);

    if (!campaignId) {
        logger.info(`[${logTag}] No campaign matched for lead ${createdLead.id}`);
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: createdLead.id,
            trigger: 'ingestion',
            action: 'unassigned',
            details: `No routing rule matched (${source}). Health: ${healthResult.classification}`
        });

        return {
            success: true,
            leadId: createdLead.id,
            healthClassification: healthResult.classification,
            healthScore: healthResult.score,
            assignedCampaignId: null,
            pushedToPlatform: false,
            message: 'Lead ingested, no campaign matched',
        };
    }

    // === 6. ASSIGNMENT ===
    const assignmentResult = await leadAssignmentService.assignLeadToCampaignWithCapacityCheck(
        organizationId,
        createdLead.id,
        campaignId,
        { allowOverCapacity: false }
    );

    if (!assignmentResult.assigned) {
        logger.warn(`[${logTag}] Failed to assign lead ${createdLead.id} to campaign ${campaignId}: ${assignmentResult.reason}`);
        await auditLogService.logAction({
            organizationId,
            entity: 'lead',
            entityId: createdLead.id,
            trigger: 'ingestion',
            action: 'assignment_failed',
            details: `Routing suggested campaign ${campaignId} but assignment failed (${source}): ${assignmentResult.reason}.`
        });

        return {
            success: true,
            leadId: createdLead.id,
            healthClassification: healthResult.classification,
            healthScore: healthResult.score,
            assignedCampaignId: null,
            pushedToPlatform: false,
            capacityReason: assignmentResult.reason,
            message: 'Lead ingested but assignment failed due to capacity',
        };
    }

    logger.info(`[${logTag}] Assigned lead ${createdLead.id} to campaign ${campaignId} (${assignmentResult.currentLoad}/${assignmentResult.capacity})`);
    await auditLogService.logAction({
        organizationId,
        entity: 'lead',
        entityId: createdLead.id,
        trigger: 'ingestion',
        action: 'assigned',
        details: `Routed to campaign ${campaignId} via ${source} (load: ${assignmentResult.currentLoad}/${assignmentResult.capacity}).`
    });

    // === 7. SEQUENCER ENROLLMENT ===
    // Native sending — every campaign is a sequencer campaign. We create a
    // CampaignLead row idempotently; the dispatcher picks it up on its next tick.
    // ESP-aware mailbox routing happens at dispatch time inside sendQueueService.
    let pushedToPlatform = false;
    try {
        const result = await enrollLeadInSequencerCampaign(organizationId, campaignId, {
            email,
            first_name,
            last_name,
            company,
        });

        if (result.success) {
            await entityStateService.transitionLead(
                organizationId,
                createdLead.id,
                LeadState.ACTIVE,
                `Enrolled in sequencer campaign ${campaignId} via ${source}`,
                TriggerType.SYSTEM
            );
            try { await redisUtils.clearPushRetry(createdLead.id); } catch (_) { /* non-critical */ }
            pushedToPlatform = true;
            logger.info(`[${logTag}] Successfully enrolled lead ${email} in sequencer campaign ${campaignId}`);
        } else {
            // Enrollment failed. Keep the lead HELD with its campaign assignment so the
            // Lead Processor (processor.ts, runs every 10s) can retry.
            const attempts = await redisUtils.incrementPushRetry(createdLead.id).catch(() => 1);
            logger.warn(`[${logTag}] Failed to enroll lead ${email} — leaving HELD for retry (attempt ${attempts}): ${result.error}`);
            await auditLogService.logAction({
                organizationId,
                entity: 'lead',
                entityId: createdLead.id,
                trigger: 'ingestion',
                action: 'enrollment_failed',
                details: `Failed to enroll in sequencer campaign ${campaignId}. Scheduled for retry via processor (attempt ${attempts}). Source: ${source}.`
            });
        }
    } catch (enrollError: any) {
        const attempts = await redisUtils.incrementPushRetry(createdLead.id).catch(() => 1);
        logger.error(`[${logTag}] Error enrolling lead in campaign — leaving HELD for retry (attempt ${attempts})`, enrollError, { campaignId });
    }

    return {
        success: true,
        leadId: createdLead.id,
        healthClassification: healthResult.classification,
        healthScore: healthResult.score,
        assignedCampaignId: pushedToPlatform ? campaignId : null,
        pushedToPlatform,
        message: pushedToPlatform ? 'Lead ingested and pushed to campaign' : 'Lead ingested successfully',
    };
}

// ============================================================================
// ENDPOINTS
// ============================================================================

/**
 * Direct API lead ingestion.
 * POST /api/ingest
 */
export const ingestLead = async (req: Request, res: Response) => {
    const { email, persona, lead_score, source } = req.body;

    if (!email || !persona || lead_score === undefined) {
        return res.status(400).json({ success: false, error: 'Missing required fields: email, persona, lead_score' });
    }

    let organizationId: string;
    try {
        organizationId = getOrgId(req);
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Organization context required' });
    }

    logger.info(`[INGEST] Org: ${organizationId} | Lead: ${email} (${persona}, ${lead_score})`);

    try {
        const result = await processLead(organizationId, {
            email,
            persona,
            lead_score,
            source: source || 'api',
            first_name: req.body.first_name,
            last_name: req.body.last_name,
            company: req.body.company,
        });

        res.json({ success: true, data: result });
    } catch (error) {
        logger.error('[INGEST] Error:', error as Error);
        res.status(500).json({ success: false, error: 'Internal server error during ingestion' });
    }
};

/**
 * Clay webhook lead ingestion.
 * POST /api/ingest/clay
 *
 * Handles flexible Clay payload format with case-insensitive field lookup.
 * HMAC-SHA256 signature validation for security.
 */
export const ingestClayWebhook = async (req: Request, res: Response) => {
    logger.info('[INGEST CLAY] Received payload', { preview: JSON.stringify(req.body).substring(0, 200) });

    const payload = req.body;

    // Get organization context (manual extraction — middleware skips public routes)
    let organizationId = req.headers['x-organization-id'] as string || req.query.orgId as string;

    if (!organizationId) {
        organizationId = payload.orgId || payload.organizationId || payload.organization_id;
    }

    if (!organizationId) {
        return res.status(400).json({ success: false, error: 'Organization ID required in header (X-Organization-ID) or query param (?orgId)' });
    }

    // Fetch organization and webhook secret
    const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, clay_webhook_secret: true }
    });

    if (!org) {
        return res.status(404).json({ success: false, error: 'Invalid Organization ID' });
    }

    // === SECURITY: Validate HMAC-SHA256 Signature ===
    const signature = req.headers['x-clay-signature'] as string;

    if (!signature && process.env.NODE_ENV === 'production') {
        logger.warn('[INGEST CLAY] Missing signature in production - rejecting', { organizationId });
        return res.status(401).json({
            success: false,
            error: 'Missing webhook signature',
            message: 'Clay webhooks must include X-Clay-Signature header. Configure this in your Clay webhook settings.'
        });
    }

    if (!org.clay_webhook_secret) {
        logger.warn('[INGEST CLAY] No webhook secret configured for org', { organizationId });
        if (process.env.NODE_ENV === 'production') {
            return res.status(500).json({
                success: false,
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
                success: false,
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
        return res.status(400).json({ success: false, error: 'Missing email field in Clay payload' });
    }

    try {
        const externalId = findVal(['id', 'external_id', 'row_id']) || email;

        const result = await processLead(organizationId, {
            email,
            persona,
            lead_score,
            source: 'clay',
            first_name: findVal(['first_name', 'firstname', 'first name', 'fname']),
            last_name: findVal(['last_name', 'lastname', 'last name', 'lname']),
            company: findVal(['company', 'company_name', 'company name', 'organization']),
            idempotencyKey: `${organizationId}:clay:${externalId}`,
            extraPayload: payload,
        });

        res.json(result);
    } catch (e) {
        logger.error('[INGEST CLAY] Error processing webhook:', e as Error);
        res.status(500).json({ success: false, error: 'Internal error processing Clay webhook' });
    }
};
