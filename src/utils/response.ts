/**
 * API Response Helpers
 * 
 * Enforces the standardized response contract:
 * Success: { success: true, data: ... }
 * Error:   { success: false, error: ... }
 */

import { Response } from 'express';

interface SuccessResponse<T> {
    success: true;
    data: T;
}

export function successResponse<T>(res: Response, data: T, statusCode = 200): Response<SuccessResponse<T>> {
    return res.status(statusCode).json({
        success: true,
        data
    });
}
