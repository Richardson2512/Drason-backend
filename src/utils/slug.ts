/**
 * URL-safe Organization slug generation.
 *
 * Slug uniqueness is global at the DB level (`Organization.slug @unique`).
 * Callers MUST use this helper rather than rolling their own — a per-account
 * check would happily return a candidate that the subsequent INSERT then
 * 500s on.
 *
 * Behavior:
 *   - Lowercase, [a-z0-9-] only, dashes collapsed, trimmed to 60 chars.
 *   - Empty/punctuation-only input falls back to "workspace".
 *   - On collision, appends "-2", "-3", … up to "-50".
 *   - Last-resort fallback appends a base36 timestamp.
 */

import { prisma } from '../index';

export async function uniqueSlug(name: string): Promise<string> {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'workspace';

    for (let i = 0; i < 50; i++) {
        const candidate = i === 0 ? base : `${base}-${i + 1}`;
        const existing = await prisma.organization.findFirst({
            where: { slug: candidate },
            select: { id: true },
        });
        if (!existing) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
}
