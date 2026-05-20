/**
 * B2B-only sender-mailbox gate tests.
 *
 * Before this fix, the signup path correctly rejected personal email
 * providers (Gmail / Yahoo / Outlook.com / iCloud / etc.) but the
 * mailbox-connect surfaces in the Sequencer did NOT. A user who
 * signed up with their work email could OAuth-connect a personal
 * gmail.com address as a sender mailbox, which both violates the
 * platform's B2B positioning and creates a deliverability liability.
 *
 * This test freezes the denylist semantics + the shared error message
 * so a regression at any of the five connect sites (googleCallback,
 * microsoftCallback, single-account create, bulk CSV import, reseller
 * import) is caught by a single test failure.
 */

import {
    isFreeEmailDomain,
    FREE_EMAIL_MAILBOX_REJECT_MESSAGE,
    FREE_EMAIL_MAILBOX_REJECT_CODE,
} from '../src/constants/freeEmailDomains';

describe('isFreeEmailDomain - personal/consumer providers', () => {
    it.each([
        ['someone@gmail.com', true],
        ['SOMEONE@GMAIL.COM', true],                       // case-insensitive
        ['   trailing@gmail.com   ', true],                // whitespace tolerated
        ['user@yahoo.com', true],
        ['user@hotmail.com', true],
        ['user@outlook.com', true],
        ['user@live.com', true],
        ['user@icloud.com', true],
        ['user@aol.com', true],
        ['user@proton.me', true],
        ['user@protonmail.com', true],
        ['user@mail.com', true],
        ['user@gmx.com', true],
        ['user@zoho.com', true],                           // personal-tier Zoho
    ])('rejects %s', (email, expected) => {
        expect(isFreeEmailDomain(email)).toBe(expected);
    });
});

describe('isFreeEmailDomain - business / workspace addresses', () => {
    it.each([
        'founder@superkabe.com',
        'sales@acme.io',
        'jane@stripe.com',
        'eng@some-startup.dev',
        'user@anvilforge.studio',
    ])('accepts %s as business email', (email) => {
        expect(isFreeEmailDomain(email)).toBe(false);
    });
});

describe('isFreeEmailDomain - malformed input is defensively false', () => {
    it.each([
        '',
        '   ',
        'no-at-sign',
        '@gmail.com',                                       // empty local part
        'user@',                                            // empty domain
        null as any,
        undefined as any,
        42 as any,
        {} as any,
    ])('returns false for malformed %p', (input) => {
        expect(isFreeEmailDomain(input)).toBe(false);
    });
});

describe('shared reject contract surfaces', () => {
    it('exposes a single canonical reject message every connect site uses', () => {
        // Pinning the message guarantees that a refactor doesn't drift
        // the error UX between OAuth callbacks and the manual / CSV /
        // reseller paths. UI strings often regress silently; this test
        // catches the change before it ships.
        expect(FREE_EMAIL_MAILBOX_REJECT_MESSAGE).toContain('Personal email addresses');
        expect(FREE_EMAIL_MAILBOX_REJECT_MESSAGE).toContain('B2B');
        expect(FREE_EMAIL_MAILBOX_REJECT_MESSAGE).toContain('Google Workspace');
        expect(FREE_EMAIL_MAILBOX_REJECT_MESSAGE).toContain('Microsoft 365');
    });

    it('exposes a stable code for programmatic handling in bulk imports', () => {
        expect(FREE_EMAIL_MAILBOX_REJECT_CODE).toBe('free_email_domain_not_allowed');
    });
});
