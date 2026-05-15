/**
 * IMAP "APPEND to Sent" service.
 *
 * When we send via SMTP, the message goes out fine - but it does NOT
 * appear in the operator's own Gmail/Outlook Sent folder. The mail
 * client (web Gmail, Outlook web, etc.) only shows messages that the
 * server placed there directly.
 *
 * Without this, an operator opens their Gmail Sent folder and sees
 * none of the campaign emails Superkabe sent on their behalf - alarming,
 * looks like the platform isn't working.
 *
 * The fix is RFC 3501's APPEND command: connect to the mailbox via IMAP,
 * upload the same RFC 822 message we just sent into the Sent folder, with
 * the \Seen flag and the current timestamp. Recipients are not affected
 * - APPEND is sender-side bookkeeping only.
 *
 * Best-effort: a failed APPEND must NEVER block the actual send. We log
 * and move on. Worst case is the operator doesn't see one outbound in
 * their Sent folder - annoying but not damaging.
 *
 * Folder name varies by provider:
 *   - Gmail        → "[Gmail]/Sent Mail"
 *   - Office 365   → "Sent Items"
 *   - Generic IMAP → "Sent" (most common; some servers use "INBOX.Sent")
 *
 * We try the provider-canonical name first. If that fails (rare - server
 * uses a non-standard label), we fall through to LIST and look for a
 * folder with the \Sent special-use attribute (RFC 6154). If that also
 * fails, we silently give up - placement is a polish feature, not core.
 */

import { ImapFlow } from 'imapflow';
import { logger } from './observabilityService';

const APPEND_TIMEOUT_MS = 15_000;

interface AppendArgs {
    /** Mailbox owner's email - used as IMAP username if smtp_username is null. */
    email: string;
    imapHost: string;
    imapPort: number;
    /** Decrypted SMTP/IMAP credentials. Caller must NOT pass encrypted ciphertext. */
    username: string;
    password: string;
    /** Provider tag - used to pick the canonical Sent folder name. */
    provider: 'google' | 'microsoft' | 'smtp' | string;
    /** The full RFC 822 message bytes (headers + body). The same bytes
     *  nodemailer just transmitted via SMTP. */
    rfc822: Buffer | string;
}

function defaultSentFolderForProvider(provider: string): string {
    if (provider === 'google') return '[Gmail]/Sent Mail';
    if (provider === 'microsoft') return 'Sent Items';
    return 'Sent';
}

/**
 * Append a sent message to the operator's Sent folder.
 * Returns true on success, false on any failure (logged).
 *
 * Designed to be called fire-and-forget from the send pipeline:
 *   appendToSentFolder({ ... }).catch(() => undefined);
 */
export async function appendToSentFolder(args: AppendArgs): Promise<boolean> {
    const client = new ImapFlow({
        host: args.imapHost,
        port: args.imapPort,
        secure: true,
        auth: { user: args.username, pass: args.password },
        logger: false,
        tls: { rejectUnauthorized: false },
    });

    const start = Date.now();
    let connected = false;
    try {
        await Promise.race([
            client.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('IMAP connect timeout')), APPEND_TIMEOUT_MS)),
        ]);
        connected = true;

        const candidateFolders = [defaultSentFolderForProvider(args.provider)];

        let appended = false;
        for (const folder of candidateFolders) {
            try {
                await client.append(folder, args.rfc822, ['\\Seen'], new Date());
                appended = true;
                break;
            } catch {
                // Try the next candidate. Some servers won't have the
                // exact name we expect.
                continue;
            }
        }

        // Last resort: discover via LIST + special-use \Sent flag (RFC 6154).
        // This handles non-standard servers without us hardcoding every name.
        if (!appended) {
            try {
                const mailboxes = await client.list();
                const sentBox = mailboxes.find(m =>
                    Array.isArray(m.specialUse) ? m.specialUse.includes('\\Sent') : m.specialUse === '\\Sent',
                );
                if (sentBox) {
                    await client.append(sentBox.path, args.rfc822, ['\\Seen'], new Date());
                    appended = true;
                }
            } catch {
                // Fall through - appended stays false.
            }
        }

        if (appended) {
            logger.info('[IMAP_APPEND] Appended to Sent folder', {
                email: args.email,
                durationMs: Date.now() - start,
            });
            return true;
        }

        logger.warn('[IMAP_APPEND] No Sent folder found for append', {
            email: args.email,
            provider: args.provider,
        });
        return false;
    } catch (err) {
        logger.warn('[IMAP_APPEND] Append failed (non-fatal)', {
            email: args.email,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
        });
        return false;
    } finally {
        if (connected) {
            try { await client.logout(); } catch { /* */ }
        }
    }
}
