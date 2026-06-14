/**
 * Work-email gate for signup.
 *
 * We only allow business / work email addresses to create accounts. Free
 * consumer mailboxes (gmail, yahoo, outlook, ...) and disposable/throwaway
 * domains are rejected, because the overwhelming majority of signup spam and
 * bot registrations come through them, and because a work email is a far
 * stronger signal of a real prospect.
 *
 * This is intentionally a denylist of known free/disposable providers rather
 * than an allowlist - we cannot enumerate every legitimate company domain, but
 * we can enumerate the handful of consumer providers that matter.
 */

/**
 * Free / personal consumer email providers. Curated, lower-cased, no leading
 * dot. Kept deliberately broad so a bot blocked on gmail.com cannot simply
 * pivot to a sibling consumer provider.
 */
const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
    // Google
    'gmail.com', 'googlemail.com',
    // Microsoft
    'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr',
    'live.com', 'live.co.uk', 'msn.com', 'windowslive.com', 'passport.com',
    // Yahoo / AOL (Verizon Media)
    'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.in', 'yahoo.fr',
    'yahoo.de', 'yahoo.es', 'yahoo.it', 'ymail.com', 'rocketmail.com',
    'aol.com', 'aim.com',
    // Apple
    'icloud.com', 'me.com', 'mac.com',
    // Proton
    'proton.me', 'protonmail.com', 'pm.me',
    // Other large consumer providers
    'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'email.com', 'usa.com',
    'yandex.com', 'yandex.ru', 'zoho.com', 'zohomail.com', 'tutanota.com',
    'tuta.io', 'fastmail.com', 'hey.com', 'inbox.com', 'mail.ru',
    'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'daum.net',
    'rediffmail.com',
]);

/**
 * Disposable / throwaway email providers. A representative set of the most
 * common ones - exhaustive coverage is impossible, so this is best-effort on
 * top of the free-provider list above.
 */
const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com',
    '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
    'throwawaymail.com', 'getnada.com', 'nada.email', 'maildrop.cc',
    'yopmail.com', 'mailnesia.com', 'trashmail.com', 'dispostable.com',
    'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'spamgourmet.com',
    'mailcatch.com', 'tempinbox.com', 'emailondeck.com', 'moakt.com',
    'mailsac.com', 'inboxbear.com', 'tempr.email', 'discard.email',
    'burnermail.io', 'temp-mail.io', 'tmpmail.org', 'mailpoof.com',
]);

/**
 * Extract the lower-cased domain from an email address. Returns null when the
 * input is not a parseable single-`@` address.
 */
export function emailDomain(email: string): string | null {
    if (typeof email !== 'string') return null;
    const at = email.lastIndexOf('@');
    if (at <= 0 || at === email.length - 1) return null;
    const domain = email.slice(at + 1).trim().toLowerCase();
    if (!domain || domain.includes('@') || !domain.includes('.')) return null;
    return domain;
}

/**
 * True when the email belongs to a known free/consumer or disposable provider.
 * Used to reject non-work signups.
 */
export function isFreeEmailDomain(email: string): boolean {
    const domain = emailDomain(email);
    if (!domain) return false; // shape errors are caught by schema validation, not here
    return FREE_EMAIL_DOMAINS.has(domain) || DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/**
 * The user-facing reason returned when a signup is rejected for using a
 * non-work email. Kept as a single source so the message stays consistent
 * across the email/password and Google paths.
 */
export const WORK_EMAIL_REQUIRED_MESSAGE =
    'Please sign up with your work email. Free and personal email providers (Gmail, Outlook, Yahoo, etc.) are not supported.';
