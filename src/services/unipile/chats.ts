/**
 * Unipile chats API - list LinkedIn threads + messages.
 *
 * Endpoint paths inferred from Unipile docs (`chats`, `chats/{id}/messages`)
 * and the messaging API page. Used by the Unibox service (Phase 6) to
 * power the inbox UI without us maintaining a separate thread store -
 * Unipile already syncs every thread server-side, we just paginate.
 */

import { unipileRequest } from './client';

export interface UnipileChat {
    id: string;
    /** Unipile-side account that owns this chat. */
    account_id: string;
    /** Counterparty profile. */
    attendees?: Array<{
        id?: string;
        public_identifier?: string;
        member_urn?: string;
        full_name?: string;
        headline?: string;
        picture_url?: string;
    }>;
    /** Truncated preview of the most recent message. */
    last_message_preview?: string;
    last_message_at?: string;
    /** Direction of the most recent message. Unipile emits this on
     *  newer API revisions; falls back to null on older ones. The
     *  Unibox UI uses it for the "Inbox / Sent / Replied" tab logic. */
    last_message_direction?: 'INBOUND' | 'OUTBOUND';
    /** Some Unipile payloads emit `direction` instead of
     *  `last_message_direction`. We normalize in the consumer. */
    direction?: 'INBOUND' | 'OUTBOUND';
    unread_count?: number;
}

export interface ListChatsResponse {
    object: 'ChatList';
    items: UnipileChat[];
    cursor?: string;
}

export interface UnipileMessage {
    id: string;
    thread_id: string;
    /** 'INBOUND' = from counterparty; 'OUTBOUND' = from connected account. */
    direction: 'INBOUND' | 'OUTBOUND';
    text?: string;
    sent_at: string;
    sender_full_name?: string;
}

export interface ListMessagesResponse {
    object: 'MessageList';
    items: UnipileMessage[];
    cursor?: string;
}

export async function listChats(accountId: string, opts: { cursor?: string; limit?: number; unread_only?: boolean } = {}): Promise<ListChatsResponse> {
    return unipileRequest<ListChatsResponse>({
        method: 'GET',
        path: `/chats`,
        query: {
            account_id: accountId,
            cursor: opts.cursor,
            limit: opts.limit ?? 50,
            unread_only: opts.unread_only,
        },
        tag: 'unipile.listChats',
    });
}

export async function listChatMessages(threadId: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListMessagesResponse> {
    return unipileRequest<ListMessagesResponse>({
        method: 'GET',
        path: `/chats/${encodeURIComponent(threadId)}/messages`,
        query: { cursor: opts.cursor, limit: opts.limit ?? 100 },
        tag: 'unipile.listChatMessages',
    });
}

export async function markChatRead(threadId: string): Promise<void> {
    await unipileRequest({
        method: 'PATCH',
        path: `/chats/${encodeURIComponent(threadId)}`,
        body: { unread: false },
        tag: 'unipile.markChatRead',
    });
}

// ────────────────────────────────────────────────────────────────────
// Phase 5.2 step send surfaces - view_profile / follow / like_post.
// These don't belong in `chats` semantically but they share the same
// "no result body needed" return shape so they're grouped here for now.
// Will split out when each gets richer config.
// ────────────────────────────────────────────────────────────────────

export async function viewProfile(accountId: string, profileIdentifier: string): Promise<void> {
    await unipileRequest({
        method: 'POST',
        path: `/users/${encodeURIComponent(accountId)}/view`,
        body: { recipient_public_identifier: profileIdentifier },
        tag: 'unipile.viewProfile',
    });
}

export async function followProfile(accountId: string, profileIdentifier: string): Promise<void> {
    await unipileRequest({
        method: 'POST',
        path: `/users/${encodeURIComponent(accountId)}/follow`,
        body: { recipient_public_identifier: profileIdentifier },
        tag: 'unipile.followProfile',
    });
}

export type ReactionType = 'LIKE' | 'PRAISE' | 'EMPATHY' | 'INTEREST' | 'APPRECIATION' | 'MAYBE' | 'FUNNY';

/**
 * React to one of the lead's recent posts. The caller MUST pick the
 * post; the worker fetches the lead's most recent post within the
 * configured timespan before calling this.
 */
export async function reactToPost(accountId: string, postId: string, reactionType: ReactionType): Promise<void> {
    await unipileRequest({
        method: 'POST',
        path: `/posts/${encodeURIComponent(postId)}/reactions`,
        body: { account_id: accountId, type: reactionType },
        tag: 'unipile.reactToPost',
    });
}

/** Fetch the lead's most recent posts within a timespan. Used by like_post. */
export async function listLeadRecentPosts(accountId: string, profileIdentifier: string, sinceTimestamp: string): Promise<Array<{ id: string; posted_at: string }>> {
    const resp = await unipileRequest<{ items?: Array<{ id: string; posted_at: string }> }>({
        method: 'GET',
        path: `/users/${encodeURIComponent(accountId)}/profile/${encodeURIComponent(profileIdentifier)}/posts`,
        query: { since: sinceTimestamp, limit: 20 },
        tag: 'unipile.listLeadRecentPosts',
    });
    return resp.items || [];
}
