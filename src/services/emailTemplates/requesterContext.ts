/**
 * Lightweight User-Agent + IP summariser used by security-class emails
 * (password reset, account locked, password changed) so the recipient can
 * confirm "yes that was me" or spot a phishing-adjacent attempt.
 *
 * Coarse on purpose: "Chrome on macOS · 1.2.3.4" is more useful in an
 * email than the full UA string. Degrades to null when neither browser
 * nor OS could be identified — caller decides whether to surface "from
 * unknown device" or skip the line entirely.
 */

import type { Request } from 'express';

export function summariseRequester(req: Request): string | null {
    const ua = (req.headers['user-agent'] as string | undefined) || '';
    const ip = ((req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim())
        || req.socket?.remoteAddress
        || '';

    const browser =
        /Edg\//.test(ua) ? 'Edge' :
        /Chrome\//.test(ua) && !/Chromium\//.test(ua) ? 'Chrome' :
        /Firefox\//.test(ua) ? 'Firefox' :
        /Safari\//.test(ua) ? 'Safari' :
        ua ? 'Browser' : null;

    const os =
        /Windows NT/.test(ua) ? 'Windows' :
        /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
        /iPhone|iPad/.test(ua) ? 'iOS' :
        /Android/.test(ua) ? 'Android' :
        /Linux/.test(ua) ? 'Linux' :
        null;

    const ipLabel = ip && ip !== '::1' && ip !== '127.0.0.1' ? ip : null;
    const parts = [browser && os ? `${browser} on ${os}` : (browser || os), ipLabel].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
}

export function buildFrontendUrl(path: string): string {
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    return new URL(path, base).toString();
}
