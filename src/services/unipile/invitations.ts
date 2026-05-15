/**
 * Unipile invitations + messaging API wrappers.
 *
 * Three send surfaces:
 *   1. sendConnectionRequest - POST a CR with optional note.
 *   2. sendMessage           - DM to an existing 1st-degree connection.
 *   3. sendInMail            - Sales Nav / Recruiter InMail.
 *
 * Endpoint paths derived from Unipile's docs reference slug naming
 * (`usercontroller_sendinvitation`, etc.). Path-param shape mirrors the
 * conventions used by other per-account endpoints (`/users/{account_id}/...`).
 * If the live API uses query-param form, this is a one-line swap in
 * `unipileRequest({ path })`.
 *
 * Each call returns a thin success/error response - the dispatcher is
 * responsible for translating these into SequenceStepExecution rows.
 */

import { unipileRequest } from './client';

export interface SendInvitationInput {
    account_id: string;
    /** Recipient - accept either the LinkedIn slug or the full URN. */
    recipient_public_identifier?: string;
    recipient_member_urn?: string;
    /** Optional note; max 200 chars (Free) / 300 chars (Premium+). */
    message?: string;
}

export interface SendInvitationResult {
    invitation_id?: string;
    /** Provider may return additional fields; surface as needed. */
}

export async function sendConnectionRequest(input: SendInvitationInput): Promise<SendInvitationResult> {
    return unipileRequest<SendInvitationResult>({
        method: 'POST',
        path: `/users/${encodeURIComponent(input.account_id)}/invite`,
        body: {
            recipient_public_identifier: input.recipient_public_identifier,
            recipient_member_urn: input.recipient_member_urn,
            message: input.message,
        },
        tag: 'unipile.sendConnectionRequest',
    });
}

export interface SendMessageInput {
    account_id: string;
    recipient_public_identifier?: string;
    recipient_member_urn?: string;
    /** Existing chat/thread id when continuing a thread. */
    thread_id?: string;
    text: string;
    attachments?: Array<{ url: string; filename?: string }>;
}

export interface SendMessageResult {
    message_id?: string;
    thread_id?: string;
}

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    // Path branches on whether we're starting a new chat or continuing one.
    if (input.thread_id) {
        return unipileRequest<SendMessageResult>({
            method: 'POST',
            path: `/chats/${encodeURIComponent(input.thread_id)}/messages`,
            body: { text: input.text, attachments: input.attachments },
            tag: 'unipile.sendMessage',
        });
    }
    return unipileRequest<SendMessageResult>({
        method: 'POST',
        path: `/chats`,
        body: {
            account_id: input.account_id,
            recipient_public_identifier: input.recipient_public_identifier,
            recipient_member_urn: input.recipient_member_urn,
            text: input.text,
            attachments: input.attachments,
        },
        tag: 'unipile.sendMessage.new',
    });
}

export interface SendInMailInput {
    account_id: string;
    recipient_public_identifier?: string;
    recipient_member_urn?: string;
    subject: string;
    body: string;
}

export async function sendInMail(input: SendInMailInput): Promise<SendMessageResult> {
    return unipileRequest<SendMessageResult>({
        method: 'POST',
        path: `/users/${encodeURIComponent(input.account_id)}/inmail`,
        body: {
            recipient_public_identifier: input.recipient_public_identifier,
            recipient_member_urn: input.recipient_member_urn,
            subject: input.subject,
            body: input.body,
        },
        tag: 'unipile.sendInMail',
    });
}
