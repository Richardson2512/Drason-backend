/**
 * In-process invocation shim for v1 controllers.
 *
 * The 17 MCP tools wrap exactly the same logic as the /api/v1 REST
 * endpoints. Rather than have Claude → HTTP → MCP transport →
 * fetch('http://localhost/api/v1/...') → REST controller (an internal
 * loopback round-trip), the MCP layer calls the controllers directly
 * with a synthetic Express req/res pair and captures the response
 * payload.
 *
 * This keeps the controllers as the single source of truth — no
 * duplicated business logic, no service-layer refactor — while
 * eliminating the in-process HTTP hop.
 */

import type { Request, Response } from 'express';

export interface InvocationInput {
    /** Authenticated org context — must be populated by caller. */
    orgContext: NonNullable<Request['orgContext']>;
    /** Request body (for POST/PATCH). */
    body?: unknown;
    /** Path params (e.g. { id: 'campaign_123' }). */
    params?: Record<string, string>;
    /** Query string params. */
    query?: Record<string, string>;
}

export interface InvocationOutput {
    status: number;
    body: any;
}

type ControllerFn = (req: Request, res: Response) => Promise<Response | void> | Response | void;

/**
 * Invoke a v1 controller function as if it were called via Express,
 * but synchronously capture status + JSON response.
 */
export async function invokeController(
    controller: ControllerFn,
    input: InvocationInput
): Promise<InvocationOutput> {
    let captured: InvocationOutput = { status: 200, body: undefined };

    const req = {
        body: input.body ?? {},
        params: input.params ?? {},
        query: input.query ?? {},
        headers: {},
        method: 'INTERNAL',
        path: '/mcp-internal',
        orgContext: input.orgContext,
        // Keep the same shape the v1Controller scope helper looks at.
        get(_name: string) { return undefined; },
    } as unknown as Request;

    const res = {
        status(code: number) {
            captured.status = code;
            return this;
        },
        json(payload: any) {
            captured.body = payload;
            return this;
        },
        send(payload: any) {
            captured.body = payload;
            return this;
        },
    } as unknown as Response;

    await controller(req, res);
    return captured;
}

/**
 * Convenience wrapper — invokes a controller and returns the data
 * payload directly, throwing if the controller responded with an
 * error status.
 */
export async function invokeAndUnwrap(
    controller: ControllerFn,
    input: InvocationInput
): Promise<any> {
    const result = await invokeController(controller, input);

    if (result.status >= 400) {
        const message = result.body?.error || `Controller returned ${result.status}`;
        const err = new Error(message);
        (err as any).status = result.status;
        throw err;
    }

    // Unwrap the standard { success, data, meta? } envelope.
    if (result.body && typeof result.body === 'object' && 'data' in result.body) {
        if ('meta' in result.body) {
            return { data: result.body.data, meta: result.body.meta };
        }
        return result.body.data;
    }
    return result.body;
}
