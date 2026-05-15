/**
 * Public entry point for the Unipile service layer.
 *
 * The directory is split by resource (accounts / profiles / posts /
 * invitations / messaging / search) - those files import from ./client
 * for the underlying HTTP primitive. Callers should import the named
 * function from this barrel, not the per-resource files directly.
 */

export {
    isUnipileConfigured,
    getUnipileStats,
    unipileRequest,
    verifyUnipileWebhook,
    UnipileHttpError,
} from './client';
export type { UnipileRequest } from './client';

export * as accounts from './accounts';
export type {
    UnipileAccount,
    ListAccountsResponse,
    HostedAuthLinkRequest,
    HostedAuthLinkResponse,
} from './accounts';

export * as users from './users';
export type {
    UnipileRelation,
    ListRelationsResponse,
    UnipileInvitation,
    ListInvitationsResponse,
} from './users';

export * as posts from './posts';
export type {
    UnipilePost,
    ListPostsResponse,
    UnipileReaction,
    ListReactionsResponse,
    UnipileComment,
    ListCommentsResponse,
} from './posts';

export * as invitations from './invitations';
export type {
    SendInvitationInput,
    SendInvitationResult,
    SendMessageInput,
    SendMessageResult,
    SendInMailInput,
} from './invitations';

export * as chats from './chats';
export type {
    UnipileChat,
    ListChatsResponse,
    UnipileMessage,
    ListMessagesResponse,
    ReactionType,
} from './chats';
