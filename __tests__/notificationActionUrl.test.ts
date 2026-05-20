/**
 * Notification action_url validator tests - the defense-in-depth gate
 * for the deep-link the dashboard renders inside <a href>. A regression
 * here is the N7 attack surface coming back: a future writer wires the
 * column to user input and a malicious actor stores `javascript:...`.
 */

import { validateNotificationActionUrl } from '../src/services/notificationService';

describe('validateNotificationActionUrl - accepts', () => {
    it('accepts a relative dashboard path', () => {
        const r = validateNotificationActionUrl('/dashboard/sequencer/unibox?thread=abc');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.url).toBe('/dashboard/sequencer/unibox?thread=abc');
    });
    it('accepts empty / undefined as "no link"', () => {
        expect(validateNotificationActionUrl(undefined).ok).toBe(true);
        expect(validateNotificationActionUrl(null).ok).toBe(true);
        expect(validateNotificationActionUrl('').ok).toBe(true);
        expect(validateNotificationActionUrl('   ').ok).toBe(true);
    });
});

describe('validateNotificationActionUrl - rejects', () => {
    it('rejects javascript:', () => {
        const r = validateNotificationActionUrl('javascript:fetch("/api/me").then(r=>r.text())');
        expect(r.ok).toBe(false);
    });
    it('rejects data:', () => {
        expect(validateNotificationActionUrl('data:text/html,<script>alert(1)</script>').ok).toBe(false);
    });
    it('rejects vbscript:', () => {
        expect(validateNotificationActionUrl('vbscript:msgbox(1)').ok).toBe(false);
    });
    it('rejects protocol-relative URLs', () => {
        expect(validateNotificationActionUrl('//evil.example/path').ok).toBe(false);
    });
    it('rejects absolute http (not https)', () => {
        expect(validateNotificationActionUrl('http://example.com/x').ok).toBe(false);
    });
    it('rejects an https URL whose host is NOT in the FRONTEND_URL allowlist', () => {
        expect(validateNotificationActionUrl('https://attacker.example.com/x').ok).toBe(false);
    });
    it('rejects values longer than 512 chars', () => {
        expect(validateNotificationActionUrl('/' + 'a'.repeat(600)).ok).toBe(false);
    });
    it('rejects non-strings', () => {
        expect(validateNotificationActionUrl(42 as any).ok).toBe(false);
        expect(validateNotificationActionUrl({} as any).ok).toBe(false);
    });
});
