/**
 * Recipient preview controller
 *
 * Exposes the recipient preview service: given a subject + body HTML +
 * sender, returns per-client inbox-list previews, normalized opened HTML,
 * predicted AI summaries, and issue detection.
 */

import { Request, Response } from 'express';
import { logger } from '../services/observabilityService';
import { buildRecipientPreview, ClientKey, CLIENT_PROFILES } from '../services/recipientPreviewService';

/**
 * POST /api/sequencer/recipient-preview
 * Body: { subject, bodyHtml, senderName, senderEmail, clients?, includeAiSummary? }
 */
export const generatePreview = async (req: Request, res: Response): Promise<Response> => {
    try {
        const {
            subject = '',
            bodyHtml = '',
            senderName = '',
            senderEmail = '',
            clients,
            includeAiSummary = false,
        } = req.body || {};

        if (typeof subject !== 'string' || typeof bodyHtml !== 'string') {
            return res.status(400).json({ success: false, error: 'subject and bodyHtml are required strings' });
        }

        const validKeys = new Set(Object.keys(CLIENT_PROFILES));
        const clientKeys: ClientKey[] | undefined = Array.isArray(clients)
            ? (clients.filter((k: unknown) => typeof k === 'string' && validKeys.has(k as string)) as ClientKey[])
            : undefined;

        const result = await buildRecipientPreview({
            subject,
            bodyHtml,
            senderName,
            senderEmail,
            clients: clientKeys,
            includeAiSummary: Boolean(includeAiSummary),
        });

        return res.json({ success: true, ...result });
    } catch (error) {
        logger.error(
            '[RECIPIENT_PREVIEW] generate failed',
            error instanceof Error ? error : new Error(String(error)),
        );
        return res.status(500).json({ success: false, error: 'Failed to generate recipient preview' });
    }
};

/**
 * GET /api/sequencer/recipient-preview/clients
 * Returns the static client catalog so the frontend can render the
 * correct chrome and width hints without duplicating the constants.
 */
export const listClients = async (_req: Request, res: Response): Promise<Response> => {
    return res.json({ success: true, clients: Object.values(CLIENT_PROFILES) });
};
