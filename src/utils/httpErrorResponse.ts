/**
 * Shared error -> HTTP response classifier.
 *
 * Problem this solves: the platform surfaced almost every failure as a bare
 * 500 "Internal server error", because (a) the global error handler only
 * understood ZodError + AppError, and (b) controller catch blocks hardcode a
 * generic 500. Users hitting well-understood, self-fixable conditions (upload
 * too large, duplicate record, batch too big for the transaction window) got
 * a message that told them nothing.
 *
 * Policy: map KNOWN, SAFE-TO-EXPOSE error categories to a proper status code
 * and an actionable message. Anything unrecognized stays a generic 500 -
 * internals are never leaked in production.
 */
import { Response } from 'express';
import { AppError } from './appError';

export interface ClassifiedError {
    status: number;
    message: string;
    /** Stable machine-readable tag for support tickets and frontend branching. */
    code: string;
}

export function classifyError(err: any): ClassifiedError | null {
    if (!err) return null;

    // Operational errors thrown intentionally by our own code.
    if (err instanceof AppError) {
        return { status: err.statusCode, message: err.message, code: 'app_error' };
    }

    // Body-parser (http-errors): payload over the JSON limit.
    if (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413) {
        return {
            status: 413,
            message: 'Upload too large. Split your lead list into smaller batches and try again.',
            code: 'payload_too_large',
        };
    }
    // Body-parser: malformed JSON body.
    if (err.type === 'entity.parse.failed') {
        return { status: 400, message: 'Request body is not valid JSON.', code: 'invalid_json' };
    }

    // Prisma known request errors - user-actionable subset only.
    switch (err.code) {
        case 'P2002':
            return { status: 409, message: 'A record with these details already exists.', code: 'duplicate' };
        case 'P2025':
            return { status: 404, message: 'The requested record was not found.', code: 'not_found' };
        case 'P2028': // interactive transaction timed out
            return {
                status: 503,
                message: 'The operation took too long - likely a very large batch. Try again with a smaller list.',
                code: 'operation_timeout',
            };
        default:
            break;
    }

    return null; // unrecognized - caller falls back to a generic 500
}

/**
 * Standard controller catch-block responder. Classifies known errors to a
 * proper status + actionable message; falls back to the caller's generic
 * message (500) for anything unrecognized.
 */
export function respondWithError(res: Response, err: any, fallbackMessage: string): Response {
    const classified = classifyError(err);
    if (classified) {
        return res.status(classified.status).json({ success: false, error: classified.message, code: classified.code });
    }
    return res.status(500).json({ success: false, error: fallbackMessage });
}
