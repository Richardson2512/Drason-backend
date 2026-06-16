/**
 * Safe outbound URL validator tests.
 *
 * This is the load-bearing gate for "is this destination safe to hit?".
 * Notifications audit N1 (CRITICAL SSRF) lives or dies on the accept/
 * reject contract below; the test set covers every IP family + every
 * documented forbidden range + the cloud-metadata IPs by name + the
 * DNS-points-at-internal attack.
 */

import { validateSafeOutboundUrl, isForbiddenIp } from '../src/utils/safeOutboundUrl';

// Inject a stub DNS resolver so the tests don't hit the real network.
const stubResolver = (mapping: Record<string, string[]>) => async (host: string): Promise<string[]> => {
    const ips = mapping[host];
    if (!ips) throw new Error(`stub: unknown host ${host}`);
    return ips;
};

describe('validateSafeOutboundUrl - accept list', () => {
    it('accepts an https URL pointing at a public IP', async () => {
        const r = await validateSafeOutboundUrl('https://hooks.example.com/webhook', {
            resolveAddrs: stubResolver({ 'hooks.example.com': ['203.0.113.99'] /* documentation range, treated as forbidden in real life - use a real public IP */ }),
        });
        // 203.0.113/24 is documentation - intentionally forbidden so this test
        // verifies the contract. Adjust the IP to a true public address:
        const r2 = await validateSafeOutboundUrl('https://hooks.example.com/webhook', {
            resolveAddrs: stubResolver({ 'hooks.example.com': ['8.8.8.8'] }),
        });
        expect(r.ok).toBe(false);  // documentation range correctly rejected
        expect(r2.ok).toBe(true);
        if (r2.ok) expect(r2.resolvedIps).toEqual(['8.8.8.8']);
    });
    it('accepts an https URL with IPv6 public address', async () => {
        const r = await validateSafeOutboundUrl('https://example.com/cb', {
            resolveAddrs: stubResolver({ 'example.com': ['2606:4700:4700::1111'] }), // Cloudflare DNS
        });
        expect(r.ok).toBe(true);
    });
});

describe('validateSafeOutboundUrl - SSRF reject list', () => {
    it('rejects AWS metadata IP 169.254.169.254', async () => {
        const r = await validateSafeOutboundUrl('http://169.254.169.254/latest/meta-data/');
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.code).toBe('resolves_to_forbidden_ip');
            expect(r.offendingIp).toBe('169.254.169.254');
        }
    });
    it('rejects ECS metadata IP 169.254.170.2', async () => {
        const r = await validateSafeOutboundUrl('http://169.254.170.2/v2/credentials/');
        expect(r.ok).toBe(false);
    });
    it('rejects RFC 1918 10.0.0.0/8', async () => {
        const r = await validateSafeOutboundUrl('http://10.5.6.7/internal');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('resolves_to_forbidden_ip');
    });
    it('rejects RFC 1918 192.168.x.x', async () => {
        expect((await validateSafeOutboundUrl('http://192.168.1.1/')).ok).toBe(false);
    });
    it('rejects RFC 1918 172.16-31', async () => {
        expect((await validateSafeOutboundUrl('http://172.20.0.1/')).ok).toBe(false);
        expect((await validateSafeOutboundUrl('http://172.31.255.255/')).ok).toBe(false);
        // 172.15 and 172.32 are PUBLIC ranges - must NOT be blocked here
        const ok = await validateSafeOutboundUrl('http://172.15.0.1/', {
            resolveAddrs: stubResolver({}),
        });
        expect(ok.ok).toBe(true); // IP literal, no DNS needed
    });
    it('rejects 127.0.0.0/8 loopback', async () => {
        expect((await validateSafeOutboundUrl('http://127.0.0.1:8080/')).ok).toBe(false);
        expect((await validateSafeOutboundUrl('http://127.255.255.255/')).ok).toBe(false);
    });
    it('rejects IPv6 loopback ::1', async () => {
        const r = await validateSafeOutboundUrl('http://[::1]/');
        expect(r.ok).toBe(false);
    });
    it('rejects IPv6 link-local fe80::', async () => {
        expect((await validateSafeOutboundUrl('http://[fe80::1]/')).ok).toBe(false);
    });
    it('rejects IPv6 ULA fc00::/7', async () => {
        expect((await validateSafeOutboundUrl('http://[fc00::1]/')).ok).toBe(false);
        expect((await validateSafeOutboundUrl('http://[fd00::1]/')).ok).toBe(false);
    });
    it('rejects IPv4-mapped IPv6 (::ffff:10.0.0.1)', async () => {
        expect((await validateSafeOutboundUrl('http://[::ffff:10.0.0.1]/')).ok).toBe(false);
    });
    it('rejects multicast 224.0.0.0/4', async () => {
        expect((await validateSafeOutboundUrl('http://239.255.255.255/')).ok).toBe(false);
    });
    it('rejects hostname that DNS-resolves to a private IP (DNS-rebind attack)', async () => {
        // The hostname looks public, but it resolves to a private range.
        // This is the test that catches "I registered evil.example which
        // points at 10.0.0.1" - the load-bearing scenario.
        const r = await validateSafeOutboundUrl('http://evil.example.com/', {
            resolveAddrs: stubResolver({ 'evil.example.com': ['10.0.0.1'] }),
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('resolves_to_forbidden_ip');
    });
    it('rejects hostname that resolves to MULTIPLE IPs where any one is private', async () => {
        const r = await validateSafeOutboundUrl('http://multi.example.com/', {
            resolveAddrs: stubResolver({ 'multi.example.com': ['8.8.8.8', '10.0.0.1'] }),
        });
        expect(r.ok).toBe(false);
    });
});

describe('validateSafeOutboundUrl - hostname blocklist (no DNS needed)', () => {
    it('rejects localhost', async () => {
        expect((await validateSafeOutboundUrl('http://localhost:5432/')).ok).toBe(false);
    });
    it('rejects *.local', async () => {
        expect((await validateSafeOutboundUrl('http://server.local/')).ok).toBe(false);
    });
    it('rejects *.internal', async () => {
        expect((await validateSafeOutboundUrl('http://api.internal/')).ok).toBe(false);
    });
    it('rejects *.railway.internal (Railway internal DNS)', async () => {
        expect((await validateSafeOutboundUrl('http://app.railway.internal/')).ok).toBe(false);
    });
    it('rejects metadata.google.internal by exact name', async () => {
        expect((await validateSafeOutboundUrl('http://metadata.google.internal/computeMetadata/v1/')).ok).toBe(false);
    });
});

describe('validateSafeOutboundUrl - scheme + userinfo rejects', () => {
    it('rejects javascript:', async () => {
        expect((await validateSafeOutboundUrl('javascript:fetch("/x")')).ok).toBe(false);
    });
    it('rejects file:', async () => {
        expect((await validateSafeOutboundUrl('file:///etc/passwd')).ok).toBe(false);
    });
    it('rejects ftp:', async () => {
        expect((await validateSafeOutboundUrl('ftp://example.com/x')).ok).toBe(false);
    });
    it('rejects userinfo segment', async () => {
        const r = await validateSafeOutboundUrl('http://attacker:password@127.0.0.1/');
        expect(r.ok).toBe(false);
        // The userinfo check must fire BEFORE the IP check so the error
        // surface is the most specific:
        if (!r.ok) expect(r.code).toBe('userinfo_not_allowed');
    });
});

describe('isForbiddenIp - direct IPv4 range coverage', () => {
    it.each([
        ['0.0.0.0', true],
        ['10.0.0.1', true],
        ['100.64.0.1', true],     // CGNAT
        ['127.0.0.1', true],
        ['169.254.169.254', true], // AWS metadata
        ['172.16.0.1', true],
        ['172.31.0.1', true],
        ['172.32.0.1', false],    // outside RFC 1918
        ['192.0.2.1', true],      // documentation
        ['192.168.1.1', true],
        ['198.18.0.1', true],     // benchmarking
        ['203.0.113.1', true],    // documentation
        ['224.0.0.1', true],      // multicast
        ['255.255.255.255', true],
        ['8.8.8.8', false],
        ['1.1.1.1', false],
    ])('isForbiddenIp(%s) === %s', (ip, expected) => {
        expect(isForbiddenIp(ip)).toBe(expected);
    });
});
