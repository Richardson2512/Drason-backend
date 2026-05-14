/**
 * Lead health service unit tests.
 *
 * classifyLeadHealth is the GREEN/YELLOW/RED gate that decides whether a
 * lead can enter a campaign at all. It's pure (no DB) but its scoring
 * model directly controls how many leads get blocked at import — small
 * threshold changes cascade. These tests pin the contract.
 */

import {
    classifyLeadHealth,
    isDisposableDomain,
    isRoleBasedEmail,
    hasSuspiciousTLD,
} from '../src/services/leadHealthService';

describe('classifyLeadHealth — disposable domains are instant RED', () => {
    it('blocks mailinator', async () => {
        const result = await classifyLeadHealth('test@mailinator.com');
        expect(result.classification).toBe('red');
        expect(result.checks.isDisposable).toBe(true);
        expect(result.reasons.some(r => r.toLowerCase().includes('disposable'))).toBe(true);
    });

    it('blocks subdomains of disposable providers', async () => {
        const result = await classifyLeadHealth('test@sub.mailinator.com');
        expect(result.classification).toBe('red');
    });
});

describe('classifyLeadHealth — role-based emails take a major penalty', () => {
    it('flags info@ as role-based', async () => {
        const result = await classifyLeadHealth('info@acme.io');
        expect(result.checks.isRoleEmail).toBe(true);
    });

    it('flags support@', async () => {
        const result = await classifyLeadHealth('support@acme.io');
        expect(result.checks.isRoleEmail).toBe(true);
    });

    it('does not flag a normal personal address', async () => {
        const result = await classifyLeadHealth('jane.doe@acme.io');
        expect(result.checks.isRoleEmail).toBe(false);
    });
});

describe('classifyLeadHealth — invalid format', () => {
    it('returns RED for missing @', async () => {
        const result = await classifyLeadHealth('not-an-email');
        expect(result.classification).toBe('red');
        expect(result.score).toBe(0);
    });
});

describe('classifyLeadHealth — validation context narrows the score', () => {
    it('applies validation penalty when score is low', async () => {
        const result = await classifyLeadHealth('jane@acme.io', {
            validationScore: 30,
            isDisposable: false,
            isCatchAll: false,
        });
        // 30/2 -> 15; penalty = 50 - 15 = 35. With no other penalties,
        // 100 - 35 = 65 → yellow.
        expect(result.score).toBeLessThan(80);
        expect(result.score).toBeGreaterThanOrEqual(50);
        expect(result.classification).toBe('yellow');
    });

    it('does not penalize a high validation score', async () => {
        const result = await classifyLeadHealth('jane@acme.io', {
            validationScore: 100,
            isDisposable: false,
            isCatchAll: false,
        });
        expect(result.classification).toBe('green');
    });
});

describe('isDisposableDomain', () => {
    it('matches direct disposable domains', () => {
        expect(isDisposableDomain('mailinator.com')).toBe(true);
        expect(isDisposableDomain('tempmail.com')).toBe(true);
    });

    it('matches subdomains of disposable providers', () => {
        expect(isDisposableDomain('sub.mailinator.com')).toBe(true);
    });

    it('does not match legitimate domains', () => {
        expect(isDisposableDomain('gmail.com')).toBe(false);
        expect(isDisposableDomain('acme.io')).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(isDisposableDomain('MAILINATOR.COM')).toBe(true);
    });
});

describe('isRoleBasedEmail', () => {
    it('matches exact role prefixes', () => {
        expect(isRoleBasedEmail('info')).toBe(true);
        expect(isRoleBasedEmail('support')).toBe(true);
        expect(isRoleBasedEmail('sales')).toBe(true);
        expect(isRoleBasedEmail('hr')).toBe(true);
    });

    it('matches role.* and role-* variants (info.team, sales-uk)', () => {
        expect(isRoleBasedEmail('info.team')).toBe(true);
        expect(isRoleBasedEmail('sales-uk')).toBe(true);
    });

    it('does not match personal names that contain a role substring', () => {
        // "information" starts with "info" but isn't role-based — guard
        // ensures we only match exact prefix or prefix + delimiter.
        expect(isRoleBasedEmail('information')).toBe(false);
        expect(isRoleBasedEmail('infomania')).toBe(false);
    });

    it('does not match normal personal handles', () => {
        expect(isRoleBasedEmail('jane.doe')).toBe(false);
        expect(isRoleBasedEmail('john')).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(isRoleBasedEmail('SUPPORT')).toBe(true);
    });
});

describe('hasSuspiciousTLD', () => {
    it('flags .xyz / .tk style TLDs', () => {
        expect(hasSuspiciousTLD('foo.xyz')).toBe(true);
        expect(hasSuspiciousTLD('foo.tk')).toBe(true);
    });

    it('does not flag mainstream TLDs', () => {
        expect(hasSuspiciousTLD('acme.io')).toBe(false);
        expect(hasSuspiciousTLD('example.io')).toBe(false);
        expect(hasSuspiciousTLD('example.org')).toBe(false);
    });
});
