/**
 * Apollo provider — normalizeLinkedInUrl unit tests.
 *
 * Apollo emits LinkedIn URLs in inconsistent shapes (bare paths, http://,
 * trailing slashes, locale subdomains, mixed casing). The normalizer
 * funnels them into the canonical https://www.linkedin.com/in/<slug>
 * form so we never write garbage to Lead.linkedin_url and so the LinkedIn
 * dispatcher's slug-extracting regex always finds a hit.
 */

import { normalizeLinkedInUrl } from '../src/services/enrichment/providers/apollo';

describe('normalizeLinkedInUrl', () => {
    it('passes a canonical URL through', () => {
        expect(normalizeLinkedInUrl('https://www.linkedin.com/in/elonmusk'))
            .toBe('https://www.linkedin.com/in/elonmusk');
    });

    it('prepends https:// when the scheme is missing', () => {
        expect(normalizeLinkedInUrl('linkedin.com/in/abc'))
            .toBe('https://www.linkedin.com/in/abc');
    });

    it('upgrades http:// to https://', () => {
        expect(normalizeLinkedInUrl('http://linkedin.com/in/xyz'))
            .toBe('https://www.linkedin.com/in/xyz');
    });

    it('strips trailing slashes from the slug', () => {
        expect(normalizeLinkedInUrl('https://www.linkedin.com/in/abc/'))
            .toBe('https://www.linkedin.com/in/abc');
        expect(normalizeLinkedInUrl('https://www.linkedin.com/in/abc//'))
            .toBe('https://www.linkedin.com/in/abc');
    });

    it('strips query params and fragments', () => {
        expect(normalizeLinkedInUrl('https://www.linkedin.com/in/abc?utm_source=foo'))
            .toBe('https://www.linkedin.com/in/abc');
        expect(normalizeLinkedInUrl('https://www.linkedin.com/in/abc#about'))
            .toBe('https://www.linkedin.com/in/abc');
    });

    it('handles locale subdomains (uk.linkedin.com, de.linkedin.com)', () => {
        expect(normalizeLinkedInUrl('https://uk.linkedin.com/in/abc'))
            .toBe('https://www.linkedin.com/in/abc');
        expect(normalizeLinkedInUrl('https://de.linkedin.com/in/xyz'))
            .toBe('https://www.linkedin.com/in/xyz');
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeLinkedInUrl('  https://www.linkedin.com/in/abc  '))
            .toBe('https://www.linkedin.com/in/abc');
    });

    it('returns null for non-LinkedIn URLs', () => {
        expect(normalizeLinkedInUrl('https://twitter.com/elonmusk')).toBeNull();
        expect(normalizeLinkedInUrl('https://example.com/in/abc')).toBeNull();
    });

    it('returns null for LinkedIn URLs that aren\'t profile pages', () => {
        // Company pages, posts, etc. — not /in/<slug>
        expect(normalizeLinkedInUrl('https://www.linkedin.com/company/openai')).toBeNull();
        expect(normalizeLinkedInUrl('https://www.linkedin.com/feed')).toBeNull();
        expect(normalizeLinkedInUrl('https://www.linkedin.com/jobs/123')).toBeNull();
    });

    it('returns null for empty / null / undefined / whitespace-only inputs', () => {
        expect(normalizeLinkedInUrl(null)).toBeNull();
        expect(normalizeLinkedInUrl(undefined)).toBeNull();
        expect(normalizeLinkedInUrl('')).toBeNull();
        expect(normalizeLinkedInUrl('   ')).toBeNull();
    });

    it('returns null for malformed URLs that don\'t parse', () => {
        expect(normalizeLinkedInUrl('not a url')).toBeNull();
        // ':::' produces a URL parser error.
        expect(normalizeLinkedInUrl(':::')).toBeNull();
    });

    it('preserves slug characters that LinkedIn allows (dots, hyphens, digits)', () => {
        expect(normalizeLinkedInUrl('https://www.linkedin.com/in/john-doe-12345'))
            .toBe('https://www.linkedin.com/in/john-doe-12345');
        expect(normalizeLinkedInUrl('https://www.linkedin.com/in/sarah.j.smith'))
            .toBe('https://www.linkedin.com/in/sarah.j.smith');
    });
});
