/**
 * Sync Progress Service
 *
 * Manages Server-Sent Events (SSE) for real-time sync progress updates
 */

import { Response } from 'express';
import { EventEmitter } from 'events';

interface SyncProgressEvent {
    sessionId: string;
    type: 'progress' | 'complete' | 'error';
    step?: 'campaigns' | 'mailboxes' | 'leads' | 'health_check';
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    current?: number;
    total?: number;
    count?: number;
    result?: any;
    error?: string;
}

class SyncProgressService extends EventEmitter {
    private activeConnections: Map<string, Response[]> = new Map();

    /**
     * Register an SSE connection for a sync session
     */
    registerConnection(sessionId: string, res: Response) {
        const connections = this.activeConnections.get(sessionId) || [];
        connections.push(res);
        this.activeConnections.set(sessionId, connections);

        // Remove connection when client disconnects
        res.on('close', () => {
            this.removeConnection(sessionId, res);
        });
    }

    /**
     * Remove a connection when client disconnects
     */
    private removeConnection(sessionId: string, res: Response) {
        const connections = this.activeConnections.get(sessionId) || [];
        const filtered = connections.filter(conn => conn !== res);

        if (filtered.length === 0) {
            this.activeConnections.delete(sessionId);
        } else {
            this.activeConnections.set(sessionId, filtered);
        }
    }

    /**
     * Emit progress update to all connected clients for a session
     */
    emitProgress(sessionId: string, step: string, status: string, data?: any) {
        const event: SyncProgressEvent = {
            sessionId,
            type: 'progress',
            step: step as any,
            status: status as any,
            ...data
        };

        this.sendToSession(sessionId, event);
    }

    /**
     * Emit completion event
     */
    emitComplete(sessionId: string, result: any) {
        const event: SyncProgressEvent = {
            sessionId,
            type: 'complete',
            result
        };

        this.sendToSession(sessionId, event);

        // Clean up connections after a delay
        setTimeout(() => {
            this.activeConnections.delete(sessionId);
        }, 5000);
    }

    /**
     * Emit error event
     */
    emitError(sessionId: string, error: string) {
        const event: SyncProgressEvent = {
            sessionId,
            type: 'error',
            error
        };

        this.sendToSession(sessionId, event);

        // Clean up connections after a delay
        setTimeout(() => {
            this.activeConnections.delete(sessionId);
        }, 5000);
    }

    /**
     * Send event to all connections for a session
     */
    private sendToSession(sessionId: string, event: SyncProgressEvent) {
        const connections = this.activeConnections.get(sessionId) || [];
        const eventData = JSON.stringify(event);

        connections.forEach(res => {
            try {
                res.write(`data: ${eventData}\n\n`);
            } catch (error) {
                // Connection might be closed, will be cleaned up on next operation
            }
        });
    }

    /**
     * Get number of active connections for debugging
     */
    getActiveConnectionCount(): number {
        let count = 0;
        this.activeConnections.forEach(connections => {
            count += connections.length;
        });
        return count;
    }
}

export const syncProgressService = new SyncProgressService();
