/**
 * Unipile Posts API - list a user's posts + retrieve reactions/comments
 * on each. Powers the signal-monitoring poller (Phase 4).
 *
 * Engagement on the user's posts is poll-only per Unipile docs (no
 * webhook for likes/reactions/comments/shares), so this surface is
 * exercised on the jittered cron schedule.
 */

import { unipileRequest } from './client';

export interface UnipilePost {
    /** Unipile's internal post id (used to fetch reactions/comments). */
    id: string;
    /** LinkedIn-side post URN. */
    post_urn?: string;
    posted_at: string;
    text?: string;
    reaction_count?: number;
    comment_count?: number;
    share_count?: number;
}

export interface ListPostsResponse {
    object: 'PostList';
    items: UnipilePost[];
    cursor?: string;
}

export interface UnipileReaction {
    /** Reaction type - LinkedIn taxonomy: LIKE | PRAISE | EMPATHY | INTEREST | APPRECIATION | MAYBE | FUNNY. */
    type: string;
    actor_full_name?: string;
    actor_public_identifier?: string;
    actor_member_urn?: string;
    actor_headline?: string;
    actor_picture_url?: string;
    reacted_at?: string;
}

export interface ListReactionsResponse {
    object: 'ReactionList';
    items: UnipileReaction[];
    cursor?: string;
}

export interface UnipileComment {
    id: string;
    text?: string;
    actor_full_name?: string;
    actor_public_identifier?: string;
    actor_member_urn?: string;
    commented_at?: string;
}

export interface ListCommentsResponse {
    object: 'CommentList';
    items: UnipileComment[];
    cursor?: string;
}

/** List recent posts authored by the connected LinkedIn account.
 *  `localAccountId` (optional) is the LinkedInAccount.id, threaded
 *  through so 429s from this call land on the right account in the
 *  rate-limit tracker. The first positional `accountId` is the Unipile
 *  account id (different value). */
export async function listAccountPosts(
    accountId: string,
    opts: { cursor?: string; limit?: number; localAccountId?: string } = {},
): Promise<ListPostsResponse> {
    return unipileRequest<ListPostsResponse>({
        method: 'GET',
        path: `/users/${encodeURIComponent(accountId)}/posts`,
        query: { cursor: opts.cursor, limit: opts.limit ?? 50 },
        tag: 'unipile.listAccountPosts',
        accountId: opts.localAccountId,
    });
}

/** List reactions on a single post (paginated). */
export async function listPostReactions(postId: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListReactionsResponse> {
    return unipileRequest<ListReactionsResponse>({
        method: 'GET',
        path: `/posts/${encodeURIComponent(postId)}/reactions`,
        query: { cursor: opts.cursor, limit: opts.limit ?? 100 },
        tag: 'unipile.listPostReactions',
    });
}

/** List comments on a single post (paginated). */
export async function listPostComments(postId: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListCommentsResponse> {
    return unipileRequest<ListCommentsResponse>({
        method: 'GET',
        path: `/posts/${encodeURIComponent(postId)}/comments`,
        query: { cursor: opts.cursor, limit: opts.limit ?? 100 },
        tag: 'unipile.listPostComments',
    });
}

/**
 * LinkedIn classic post search - keyword discovery for topics watchlists.
 * Returns posts matching the keyword; engagers are NOT included, callers
 * need to follow up per post with listPostReactions / listPostComments
 * to hydrate the actual people.
 *
 * Unipile enforces LinkedIn's UI limits. For Classic accounts, each
 * search call should keep limit ≤ 50; per-day per-account search calls
 * should stay well under the ~100/day route ceiling.
 */
export interface UnipileSearchedPost {
    id: string;
    type: string;
    social_id?: string;
    share_url?: string;
    text?: string;
    parsed_datetime?: string;
    reaction_counter?: number;
    comment_counter?: number;
    repost_counter?: number;
    author?: {
        name?: string;
        public_identifier?: string;
        headline?: string;
    };
}

export interface SearchPostsResponse {
    items: UnipileSearchedPost[];
    cursor?: string;
}

export async function searchClassicPosts(
    unipileAccountId: string,
    body: {
        keywords: string;
        sort_by?: 'date' | 'relevance';
        date_posted?: 'past_24h' | 'past_week' | 'past_month';
        content_type?: 'images' | 'videos';
        author?: { keywords?: string };
    },
    opts: { cursor?: string; limit?: number } = {},
): Promise<SearchPostsResponse> {
    return unipileRequest<SearchPostsResponse>({
        method: 'POST',
        path: `/linkedin/search`,
        query: { account_id: unipileAccountId, cursor: opts.cursor, limit: Math.min(50, opts.limit ?? 50) },
        body: { api: 'classic', category: 'posts', ...body },
        tag: 'unipile.searchClassicPosts',
    });
}
