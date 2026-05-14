/**
 * Unipile Users API — relations + invitations for one LinkedIn account.
 *
 * Endpoint paths derived from the Unipile docs reference slugs:
 *   - userscontroller_getrelations              → /users/{account_id}/relations
 *   - userscontroller_listalluserinvitationssent → /users/{account_id}/invitations/sent
 *
 * Used by the acceptance-watcher worker (Phase 4) as the backstop poll
 * for Unipile's invitation_accepted webhook, which can lag up to 8 hours
 * per their own documentation.
 *
 * The exact path shape (whether the account_id is in the path or a query
 * param) is not pinned down in Unipile's marketing docs — both variants
 * are exposed by the SDK. We start with path-param form, which matches
 * Unipile's REST conventions for other per-account resources, and will
 * swap to query-param form on the first 404 observed in live traffic.
 */

import { unipileRequest } from './client';

// ────────────────────────────────────────────────────────────────────
// Response shapes — fields confirmed by Unipile's "Detecting Accepted
// Invitations" doc + the new_relation webhook payload reference.
// ────────────────────────────────────────────────────────────────────

export interface UnipileRelation {
    /** LinkedIn URN of the related user (e.g. "urn:li:fsd_profile:...") */
    member_urn?: string;
    /** Public LinkedIn slug ("/in/<slug>"). */
    public_identifier?: string;
    /** Display name. */
    full_name?: string;
    headline?: string;
    company?: string;
    /** Current job title — returned by getProfile, not by listRelations. */
    position?: string;
    /** Free-text location string from the profile header. */
    location?: string;
    /** LinkedIn industry classification. */
    industry?: string;
    profile_url?: string;
    picture_url?: string;
    /** When the user accepted the invitation (Unipile's relation timestamp). */
    created_at?: string;
}

export interface ListRelationsResponse {
    object: 'RelationList';
    items: UnipileRelation[];
    cursor?: string;
}

export interface UnipileInvitation {
    invitation_id: string;
    recipient_member_urn?: string;
    recipient_public_identifier?: string;
    recipient_full_name?: string;
    message?: string;
    sent_at?: string;
    /** 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' */
    status?: string;
}

export interface ListInvitationsResponse {
    object: 'InvitationList';
    items: UnipileInvitation[];
    cursor?: string;
}

// ────────────────────────────────────────────────────────────────────
// API calls
// ────────────────────────────────────────────────────────────────────

export async function listRelations(accountId: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListRelationsResponse> {
    return unipileRequest<ListRelationsResponse>({
        method: 'GET',
        path: `/users/${encodeURIComponent(accountId)}/relations`,
        query: {
            cursor: opts.cursor,
            limit: opts.limit ?? 100,
        },
        tag: 'unipile.listRelations',
    });
}

export async function listSentInvitations(accountId: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListInvitationsResponse> {
    return unipileRequest<ListInvitationsResponse>({
        method: 'GET',
        path: `/users/${encodeURIComponent(accountId)}/invitations/sent`,
        query: {
            cursor: opts.cursor,
            limit: opts.limit ?? 100,
        },
        tag: 'unipile.listSentInvitations',
    });
}

/**
 * Fetch a single profile by LinkedIn URL/slug. Used by the signal-
 * monitoring agent to hydrate cached profile rows.
 */
export async function getProfile(accountId: string, profileIdentifier: string): Promise<UnipileRelation> {
    return unipileRequest<UnipileRelation>({
        method: 'GET',
        path: `/users/${encodeURIComponent(accountId)}/profile/${encodeURIComponent(profileIdentifier)}`,
        tag: 'unipile.getProfile',
    });
}
