/**
 * Operational Error Class
 * 
 * Used to distinguish between operational errors (invalid input, auth failure)
 * and programming errors (bugs). Always use this for expected failures.
 */
export class AppError extends Error {
    public readonly statusCode: number;
    public readonly isOperational: boolean;

    constructor(message: string, statusCode: number) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }
}
