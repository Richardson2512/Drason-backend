/**
 * LinkedIn send service - domain layer that wraps the Unipile invitation
 * + messaging surfaces and enforces our local invariants (per-account
 * daily/weekly caps, edge-state transitions, audit writes).
 *
 * The campaign dispatcher (linkedinDispatcherWorker, Phase 5.1) calls
 * these functions for each scheduled step execution. Returns a status
 * the caller folds into the SequenceStepExecution audit row.
 */

import { prisma } from '../../prisma';
import { logger } from '../observabilityService';
import { invitations as unipileInvites, isUnipileConfigured } from '../unipile';

export interface SendOutcome {
    status: 'SENT' | 'FAILED' | 'SKIPPED_CAPACITY' | 'SKIPPED_NOT_CONFIGURED';
    provider_id?: string;
    error_message?: string;
}

interface SendBase {
    organization_id: string;
    linkedin_account_id: string;
    linkedin_profile_id: string;
}

// ────────────────────────────────────────────────────────────────────
// Capacity gate - checks per-account daily/weekly caps before any send.
// Returns null when capacity is fine; otherwise an outcome to short-circuit.
// ────────────────────────────────────────────────────────────────────

async function gateCapacity(accountId: string, type: 'invite' | 'message' | 'inmail'): Promise<SendOutcome | null> {
    const acct = await prisma.linkedInAccount.findUnique({ where: { id: accountId } });
    if (!acct) return { status: 'FAILED', error_message: 'Account not found' };

    switch (type) {
        case 'invite': {
            if (acct.invites_today >= acct.max_invites_per_day) {
                return { status: 'SKIPPED_CAPACITY', error_message: `Daily invite cap reached (${acct.invites_today}/${acct.max_invites_per_day})` };
            }
            if (acct.invites_this_week >= acct.max_invites_per_week) {
                return { status: 'SKIPPED_CAPACITY', error_message: `Weekly invite cap reached (${acct.invites_this_week}/${acct.max_invites_per_week})` };
            }
            break;
        }
        case 'message': {
            if (acct.messages_today >= acct.max_messages_per_day) {
                return { status: 'SKIPPED_CAPACITY', error_message: `Daily message cap reached (${acct.messages_today}/${acct.max_messages_per_day})` };
            }
            break;
        }
        case 'inmail': {
            if (acct.inmails_today >= acct.max_inmails_per_day) {
                return { status: 'SKIPPED_CAPACITY', error_message: `Daily InMail cap reached (${acct.inmails_today}/${acct.max_inmails_per_day})` };
            }
            break;
        }
    }
    return null;
}

// ────────────────────────────────────────────────────────────────────
// Send connection request
// ────────────────────────────────────────────────────────────────────

export interface SendCrInput extends SendBase {
    /** Personalized note. Empty / undefined = blank CR. */
    note?: string;
}

export async function sendConnectionRequest(input: SendCrInput): Promise<SendOutcome> {
    if (!isUnipileConfigured()) {
        return { status: 'SKIPPED_NOT_CONFIGURED', error_message: 'Unipile not configured' };
    }

    const cap = await gateCapacity(input.linkedin_account_id, 'invite');
    if (cap) return cap;

    const acct = await prisma.linkedInAccount.findUnique({ where: { id: input.linkedin_account_id } });
    const profile = await prisma.linkedInProfile.findUnique({ where: { id: input.linkedin_profile_id } });
    if (!acct || !profile) return { status: 'FAILED', error_message: 'Account or profile not found' };

    try {
        const res = await unipileInvites.sendConnectionRequest({
            account_id: acct.unipile_account_id,
            recipient_public_identifier: profile.public_identifier,
            recipient_member_urn: profile.member_urn ?? undefined,
            message: input.note,
        });

        // Persist the edge in INVITE_SENT + bump the counter.
        await prisma.$transaction([
            prisma.linkedInConnectionEdge.upsert({
                where: {
                    linkedin_account_id_linkedin_profile_id: {
                        linkedin_account_id: acct.id, linkedin_profile_id: profile.id,
                    },
                },
                create: {
                    linkedin_account_id: acct.id,
                    linkedin_profile_id: profile.id,
                    status: 'INVITE_SENT',
                    invite_has_note: Boolean(input.note?.trim()),
                    invited_at: new Date(),
                },
                update: {
                    status: 'INVITE_SENT',
                    invite_has_note: Boolean(input.note?.trim()),
                    invited_at: new Date(),
                },
            }),
            prisma.linkedInAccount.update({
                where: { id: acct.id },
                data: {
                    invites_today: { increment: 1 },
                    invites_this_week: { increment: 1 },
                },
            }),
        ]);

        return { status: 'SENT', provider_id: res.invitation_id };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[LINKEDIN-SEND] CR failed', { account_id: acct.id, profile_id: profile.id, err: msg.slice(0, 200) });
        return { status: 'FAILED', error_message: msg.slice(0, 500) };
    }
}

// ────────────────────────────────────────────────────────────────────
// Send DM (1st-degree only - caller should have evaluated the
// sender_is_first_degree precondition before calling this).
// ────────────────────────────────────────────────────────────────────

export interface SendDmInput extends SendBase {
    text: string;
    thread_id?: string;
}

export async function sendDirectMessage(input: SendDmInput): Promise<SendOutcome> {
    if (!isUnipileConfigured()) {
        return { status: 'SKIPPED_NOT_CONFIGURED', error_message: 'Unipile not configured' };
    }

    const cap = await gateCapacity(input.linkedin_account_id, 'message');
    if (cap) return cap;

    const acct = await prisma.linkedInAccount.findUnique({ where: { id: input.linkedin_account_id } });
    const profile = await prisma.linkedInProfile.findUnique({ where: { id: input.linkedin_profile_id } });
    if (!acct || !profile) return { status: 'FAILED', error_message: 'Account or profile not found' };

    try {
        const res = await unipileInvites.sendMessage({
            account_id: acct.unipile_account_id,
            recipient_public_identifier: profile.public_identifier,
            recipient_member_urn: profile.member_urn ?? undefined,
            thread_id: input.thread_id,
            text: input.text,
        });
        await prisma.linkedInAccount.update({
            where: { id: acct.id },
            data: { messages_today: { increment: 1 } },
        });
        return { status: 'SENT', provider_id: res.message_id };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'FAILED', error_message: msg.slice(0, 500) };
    }
}

// ────────────────────────────────────────────────────────────────────
// Send InMail (Sales Nav / Recruiter only - caller should have
// evaluated the sender_supports_inmail precondition).
// ────────────────────────────────────────────────────────────────────

export interface SendInMailInput extends SendBase {
    subject: string;
    body: string;
}

export async function sendInMail(input: SendInMailInput): Promise<SendOutcome> {
    if (!isUnipileConfigured()) {
        return { status: 'SKIPPED_NOT_CONFIGURED', error_message: 'Unipile not configured' };
    }

    const cap = await gateCapacity(input.linkedin_account_id, 'inmail');
    if (cap) return cap;

    const acct = await prisma.linkedInAccount.findUnique({ where: { id: input.linkedin_account_id } });
    const profile = await prisma.linkedInProfile.findUnique({ where: { id: input.linkedin_profile_id } });
    if (!acct || !profile) return { status: 'FAILED', error_message: 'Account or profile not found' };

    try {
        const res = await unipileInvites.sendInMail({
            account_id: acct.unipile_account_id,
            recipient_public_identifier: profile.public_identifier,
            recipient_member_urn: profile.member_urn ?? undefined,
            subject: input.subject,
            body: input.body,
        });
        await prisma.linkedInAccount.update({
            where: { id: acct.id },
            data: { inmails_today: { increment: 1 } },
        });
        return { status: 'SENT', provider_id: res.message_id };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'FAILED', error_message: msg.slice(0, 500) };
    }
}
