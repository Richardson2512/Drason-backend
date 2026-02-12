/**
 * Async Handler Middleware
 * 
 * Wraps async route handlers so that rejected promises are automatically
 * forwarded to the Express error handler. Eliminates the need for
 * try/catch in every controller function.
 */

import { Request, Response, NextFunction } from 'express';

type AsyncRequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction
) => Promise<any>;

export function asyncHandler(fn: AsyncRequestHandler) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
