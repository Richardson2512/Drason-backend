/**
 * MCP transport handler — mounted on POST /mcp.
 *
 * Stateless Streamable HTTP transport: every request gets its own
 * server + transport pair, scoped to the authenticated org context
 * already populated by extractOrgContext middleware. Closes both
 * when the response finishes so no resources outlive the request.
 *
 * Authentication: handled upstream by extractOrgContext, which reads
 * Authorization: Bearer <api-key> and sets req.orgContext. By the
 * time we run, req.orgContext is guaranteed populated (otherwise
 * extractOrgContext would have already returned 401).
 */

import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../services/observabilityService';
import { createMcpServer } from './tools';

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    if (!req.orgContext) {
        res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Authentication required' },
            id: null,
        });
        return;
    }

    try {
        const server = createMcpServer(req.orgContext);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

        res.on('close', () => {
            transport.close().catch(() => undefined);
            server.close().catch(() => undefined);
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        logger.error('[MCP] handler error', err instanceof Error ? err : new Error(String(err)));
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    }
}

/** GET/DELETE on /mcp aren't used in stateless mode. */
export function handleMcpMethodNotAllowed(_req: Request, res: Response): void {
    res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed in stateless MCP mode.' },
        id: null,
    });
}
