/**
 * LinkedIn Unibox controller - REST surface for the Unibox page.
 *
 *   GET    /api/linkedin/unibox/threads           - list threads across accounts
 *   GET    /api/linkedin/unibox/threads/:id       - get messages in a thread
 *   POST   /api/linkedin/unibox/threads/:id/reply - send a DM
 *   POST   /api/linkedin/unibox/threads/:id/read  - mark thread read
 */

import { Request, Response } from 'express';
import { getOrgId } from '../middleware/orgContext';
import * as uniboxService from '../services/linkedin/uniboxService';

type AutoTag = 'Interested' | 'Not Interested' | 'Generic';
const VALID_AUTO_TAGS: ReadonlySet<AutoTag> = new Set(['Interested', 'Not Interested', 'Generic']);

function parseAutoTags(raw: unknown): AutoTag[] {
    if (typeof raw !== 'string' || raw.trim().length === 0) return [];
    return raw.split(',')
        .map(s => s.trim())
        .filter((s): s is AutoTag => VALID_AUTO_TAGS.has(s as AutoTag));
}

export const listThreads = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const unreadOnly = req.query.unread_only === '1' || req.query.unread_only === 'true';
        const autoTags = parseAutoTags(req.query.auto_tags);
        // Response shape preserves the legacy `data` array (threads) so
        // existing clients keep working, and adds `account_errors` so the
        // UI can surface a banner when one of the org's accounts had a
        // Unipile failure during the merge.
        const result = await uniboxService.listThreadsForOrg(orgId, {
            unread_only: unreadOnly,
            auto_tags: autoTags.length > 0 ? autoTags : undefined,
        });
        return res.json({
            success: true,
            data: result.threads,
            account_errors: result.account_errors,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const getThread = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const messages = await uniboxService.getThreadMessages(orgId, String(req.params.id));
        return res.json({ success: true, data: { messages } });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const sendReply = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ success: false, error: 'text is required' });
        // Optional UI hint - the thread list already carries the
        // counterparty's public identifier, so the frontend passes it on
        // reply so the service can resolve LinkedInProfile → lead_id
        // for cross-channel suppression without an extra round-trip.
        const counterpartyPublicIdentifier = typeof req.body?.counterparty_public_identifier === 'string'
            ? req.body.counterparty_public_identifier
            : null;
        const result = await uniboxService.sendReply(
            orgId,
            String(req.params.id),
            text,
            counterpartyPublicIdentifier,
        );
        return res.json({ success: true, data: result });
    } catch (err) {
        // Map typed service errors to proper HTTP codes - the UI surfaces
        // 'cap_reached' as a "daily cap reached" banner separate from
        // generic send failures.
        if (err instanceof uniboxService.SendReplyError) {
            const code = err.code === 'invalid' ? 400
                : err.code === 'cap_reached' ? 429
                : 500;
            return res.status(code).json({ success: false, error: err.message, code: err.code });
        }
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};

export const markRead = async (req: Request, res: Response): Promise<Response> => {
    try {
        const orgId = getOrgId(req);
        const result = await uniboxService.markRead(orgId, String(req.params.id));
        if (!result.success) {
            // Mark-as-read failing isn't a critical operational error -
            // the message is still readable, just the read flag won't
            // sync. Return 200 with success:false so the UI can ignore
            // it or show a subtle indicator without an alarming red bar.
            return res.json({ success: false, error: result.error });
        }
        return res.json({ success: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ success: false, error: msg });
    }
};
