/**
 * Sync Progress Routes
 *
 * Server-Sent Events (SSE) endpoint for real-time sync progress
 */

import { Router, Request, Response } from 'express';
import { syncProgressService } from '../services/syncProgressService';
import { logger } from '../services/observabilityService';

const router = Router();

/**
 * SSE endpoint for sync progress updates
 * Clients connect to this endpoint to receive real-time sync progress
 *
 * @route GET /api/sync-progress/:sessionId
 */
router.get('/:sessionId', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;

    logger.info('[SyncProgress] Client connected', { sessionId });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Enable CORS for SSE
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send initial connection confirmation
    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

    // Heartbeat to keep connection alive through proxies
    const heartbeat = setInterval(() => {
        try {
            res.write(`: heartbeat\n\n`);
        } catch {
            clearInterval(heartbeat);
        }
    }, 15000);

    // Register this connection with the progress service
    syncProgressService.registerConnection(sessionId, res);

    // Handle client disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        logger.info('[SyncProgress] Client disconnected', { sessionId });
    });
});

export default router;
