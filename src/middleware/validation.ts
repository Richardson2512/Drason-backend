/**
 * Request Validation Middleware
 * 
 * Uses Zod schemas to validate request bodies, query parameters, and route params.
 * Returns structured 400 errors with field-level details on validation failure.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// ============================================================================
// VALIDATION MIDDLEWARE
// ============================================================================

/**
 * Validate request body against a Zod schema.
 */
export function validateBody(schema: z.ZodType) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: result.error.issues.map((e: any) => ({
                    field: e.path.join('.'),
                    message: e.message
                }))
            });
            return;
        }
        req.body = result.data;
        next();
    };
}

/**
 * Validate query parameters against a Zod schema.
 */
export function validateQuery(schema: z.ZodType) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            res.status(400).json({
                success: false,
                error: 'Invalid query parameters',
                details: result.error.issues.map((e: any) => ({
                    field: e.path.join('.'),
                    message: e.message
                }))
            });
            return;
        }
        req.query = result.data as any;
        next();
    };
}

// ============================================================================
// SCHEMAS — Authentication
// ============================================================================

export const loginSchema = z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(1, 'Password is required')
});

export const registerSchema = z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    name: z.string().min(1, 'Name is required'),
    organizationName: z.string().min(1, 'Organization name is required')
});

// ============================================================================
// SCHEMAS — Settings
// ============================================================================

export const updateSettingsSchema = z.object({}).passthrough();

export const updateOrganizationSchema = z.object({
    name: z.string().min(1).optional(),
    system_mode: z.enum(['observe', 'suggest', 'enforce']).optional()
});

// ============================================================================
// SCHEMAS — Routing Rules
// ============================================================================

export const routingRuleSchema = z.object({
    persona: z.string().min(1, 'Persona is required'),
    min_score: z.number().min(0).default(0),
    target_campaign_id: z.string().min(1, 'Target campaign ID is required'),
    priority: z.number().int().min(0).default(0)
});

// ============================================================================
// SCHEMAS — Monitoring
// ============================================================================

export const monitorEventSchema = z.object({
    event_type: z.string().min(1, 'Event type is required'),
    entity_type: z.enum(['mailbox', 'domain', 'campaign', 'lead']),
    entity_id: z.string().min(1, 'Entity ID is required'),
    data: z.record(z.string(), z.any()).default({})
});

// ============================================================================
// SCHEMAS — Ingestion
// ============================================================================

export const ingestLeadSchema = z.object({
    email: z.string().email('Invalid lead email'),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company: z.string().optional(),
    campaign_id: z.string().optional(),
    source: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional()
});

// ============================================================================
// SCHEMAS — Campaigns
// ============================================================================

export const campaignActionSchema = z.object({
    campaignId: z.string().min(1, 'Campaign ID is required'),
    reason: z.string().optional()
});

// ============================================================================
// SCHEMAS — Query Params (pagination)
// ============================================================================

export const paginationSchema = z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional(),
    limit: z.string().regex(/^\d+$/).transform(Number).optional(),
}).passthrough();

export const auditLogQuerySchema = z.object({
    page: z.string().regex(/^\d+$/).transform(Number).optional(),
    limit: z.string().regex(/^\d+$/).transform(Number).optional(),
    entity: z.string().optional(),
    entity_id: z.string().optional(),
    action: z.string().optional()
}).passthrough();
