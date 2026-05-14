/**
 * Free / consumer email-provider denylist used at signup to enforce
 * "business email required". Superkabe is a B2B platform; an organisation
 * registered against a personal Gmail account muddies tenant identity,
 * complicates legal-doc consent records, and (most practically) makes the
 * organisation hard to identify when a sales/support conversation happens.
 *
 * Lower-cased — callers must lowercase the candidate domain before lookup.
 * Curated to cover the providers that account for the vast majority of
 * consumer email; not exhaustive. Extend as needed; the registration
 * endpoint returns a clear error pointing to the user's IT / admin so a
 * mistakenly-typed consumer email can be quickly corrected.
 */
export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
    // Google
    'gmail.com',
    'googlemail.com',
    // Microsoft / Outlook
    'outlook.com',
    'hotmail.com',
    'live.com',
    'msn.com',
    'hotmail.co.uk',
    'outlook.co.uk',
    'hotmail.fr',
    'live.fr',
    'hotmail.de',
    'live.de',
    'hotmail.it',
    'hotmail.es',
    'live.com.au',
    // Yahoo
    'yahoo.com',
    'yahoo.co.uk',
    'yahoo.fr',
    'yahoo.de',
    'yahoo.it',
    'yahoo.es',
    'yahoo.ca',
    'yahoo.com.au',
    'yahoo.co.in',
    'yahoo.co.jp',
    'ymail.com',
    'rocketmail.com',
    // Apple
    'icloud.com',
    'me.com',
    'mac.com',
    // AOL
    'aol.com',
    'aim.com',
    // Other major consumer providers
    'protonmail.com',
    'proton.me',
    'pm.me',
    'tutanota.com',
    'tutanota.de',
    'gmx.com',
    'gmx.de',
    'gmx.net',
    'gmx.at',
    'gmx.ch',
    'web.de',
    't-online.de',
    'mail.ru',
    'yandex.com',
    'yandex.ru',
    'rambler.ru',
    'qq.com',
    '163.com',
    '126.com',
    'sina.com',
    'naver.com',
    'daum.net',
    'hanmail.net',
    'zoho.com',
    'fastmail.com',
    'fastmail.fm',
    'inbox.com',
]);

/**
 * Returns true when the given email's domain is in the consumer-provider
 * denylist. Defensive against malformed input — anything without an `@`
 * or with an empty local-part / empty domain returns false (the regular
 * validation path will reject those separately).
 */
export function isFreeEmailDomain(email: string): boolean {
    if (typeof email !== 'string') return false;
    const trimmed = email.trim().toLowerCase();
    const at = trimmed.lastIndexOf('@');
    if (at <= 0 || at === trimmed.length - 1) return false;
    const domain = trimmed.slice(at + 1);
    return FREE_EMAIL_DOMAINS.has(domain);
}
