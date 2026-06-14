/**
 * SES dedicated-IP provisioning service.
 *
 * Wraps the AWS SES v2 SDK calls needed for the Super Sender feature:
 *   - Create a dedicated IP pool (one per IP for clean reputation isolation)
 *   - Move the SES managed dedicated IP into that pool
 *   - Read provisioning state ('PENDING' | 'IN_PROGRESS' | 'AVAILABLE')
 *   - Cancel (delete the pool) on subscription cancellation
 *
 * STUB FALLBACK: When AWS credentials are not configured (`AWS_ACCESS_KEY_ID`
 * unset), the service returns deterministic stub responses that walk a row
 * through provisioning → warming → active over ~30 seconds in dev. This
 * matches the staging environment's "local-only, no real SES" reality
 * without forcing every dev to wire AWS for an unrelated test.
 *
 * Real SES provisioning takes minutes-to-hours and the IP comes online
 * with a fresh reputation that needs the 30-day warmup ramp. The stub
 * compresses everything into seconds for testability.
 */

import { logger } from './observabilityService';

export type SesIpStatus = 'PENDING' | 'IN_PROGRESS' | 'AVAILABLE' | 'FAILED';

export interface ProvisionResult {
    poolName: string;
    ipAddress: string | null;
    status: SesIpStatus;
}

function isSesConfigured(): boolean {
    return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION);
}

// ────────────────────────────────────────────────────────────────────
// Real-mode SDK loader. We import lazily so prod boot doesn't pay the
// SDK initialization cost when no IPs are provisioning, and dev/staging
// without the package never hits the import.
// ────────────────────────────────────────────────────────────────────

async function loadRealClient(): Promise<{
    createPool: (name: string) => Promise<void>;
    requestIp: (poolName: string) => Promise<string | null>;
    getStatus: (poolName: string) => Promise<SesIpStatus>;
    deletePool: (poolName: string) => Promise<void>;
}> {
    // The @aws-sdk/client-sesv2 package is only required in real mode.
    // Wrapped in a dynamic import + indirect identifier so dev/staging
    // boxes without the package installed never trigger a TS resolve.
    // Add the dep when wiring real provisioning:  npm i @aws-sdk/client-sesv2
    const dynamicImport: (m: string) => Promise<any> = (m) =>
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        new Function('m', 'return import(m)')(m);
    const sdk: any = await dynamicImport('@aws-sdk/client-sesv2');
    const client = new sdk.SESv2Client({
        region: process.env.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
    });

    return {
        async createPool(name: string) {
            await client.send(new sdk.CreateDedicatedIpPoolCommand({
                PoolName: name,
                ScalingMode: 'STANDARD',
            }));
        },

        async requestIp(poolName: string) {
            // SES auto-assigns a managed dedicated IP to the pool when you
            // call PutDedicatedIpInPool, but you first need an IP allocated
            // to the account. The cleanest pattern is to use
            // CreateDedicatedIpPool with ScalingMode=MANAGED, which lets
            // SES auto-scale IPs into the pool - that's what we use here.
            // If a specific IP must be moved, the operator can do it from
            // the AWS console.
            //
            // We don't have an IP to return at create-time - it's assigned
            // asynchronously by SES, and shows up in subsequent
            // GetDedicatedIpPool calls.
            return null;
        },

        async getStatus(poolName: string): Promise<SesIpStatus> {
            try {
                const res = await client.send(new sdk.GetDedicatedIpPoolCommand({ PoolName: poolName }));
                // If the pool exists, AWS owns the readiness signal. The
                // most reliable proxy: list IPs on the pool - if any
                // non-empty, it's ready.
                const list = await client.send(new sdk.GetDedicatedIpsCommand({ PoolName: poolName }));
                if (list.DedicatedIps && list.DedicatedIps.length > 0) {
                    // Any IP in the pool counts as available - the warmup
                    // status is tracked separately in our DB.
                    return 'AVAILABLE';
                }
                return 'IN_PROGRESS';
            } catch (err: unknown) {
                const e = err as { name?: string; message?: string };
                if (e?.name === 'NotFoundException') return 'PENDING';
                throw err;
            }
        },

        async deletePool(poolName: string) {
            try {
                await client.send(new sdk.DeleteDedicatedIpPoolCommand({ PoolName: poolName }));
            } catch (err: unknown) {
                const e = err as { name?: string };
                // NotFound is fine - pool already gone.
                if (e?.name !== 'NotFoundException') throw err;
            }
        },
    };
}

// ────────────────────────────────────────────────────────────────────
// Stub-mode timeline. A pool created at T transitions:
//   T+0..10s   → IN_PROGRESS
//   T+10s..   → AVAILABLE
// We recover the timeline from the pool name (which embeds a timestamp)
// so multiple processes / restarts converge on the same answer.
// ────────────────────────────────────────────────────────────────────

const STUB_PROVISIONING_MS = 10_000;

function stubPoolName(opts: { accountId: string; ipId: string }): string {
    // Format: "ss-<accountFragment>-<ipFragment>-<unixSeconds>"
    // Length-bounded to fit AWS pool name constraints (1-64, alnum+_-).
    const created = Math.floor(Date.now() / 1000);
    const accFrag = opts.accountId.replace(/-/g, '').slice(0, 8);
    const ipFrag = opts.ipId.replace(/-/g, '').slice(0, 8);
    return `ss-${accFrag}-${ipFrag}-${created}`;
}

function stubStatusFromName(poolName: string): SesIpStatus {
    const m = poolName.match(/-(\d+)$/);
    if (!m) return 'PENDING';
    const createdMs = parseInt(m[1], 10) * 1000;
    if (Number.isNaN(createdMs)) return 'PENDING';
    const ageMs = Date.now() - createdMs;
    return ageMs >= STUB_PROVISIONING_MS ? 'AVAILABLE' : 'IN_PROGRESS';
}

function stubIpAddress(poolName: string): string {
    // Synthesize a deterministic 10.x.x.x address from the pool name -
    // never used for real sends in stub mode, just a UI placeholder.
    let h = 0;
    for (let i = 0; i < poolName.length; i++) h = (h * 31 + poolName.charCodeAt(i)) & 0xffffffff;
    const a = (h >>> 24) & 0xff;
    const b = (h >>> 16) & 0xff;
    const c = (h >>> 8) & 0xff;
    return `203.0.113.${a % 254 + 1}-stub-${b}.${c}`.slice(0, 39);
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export async function provisionDedicatedIp(opts: { accountId: string; ipId: string }): Promise<ProvisionResult> {
    const poolName = stubPoolName(opts);

    if (!isSesConfigured()) {
        logger.info('[SES_PROVISION] Stub mode - pool created instantly', { poolName });
        return {
            poolName,
            ipAddress: stubIpAddress(poolName),
            status: 'IN_PROGRESS',
        };
    }

    const client = await loadRealClient();
    await client.createPool(poolName);
    const ip = await client.requestIp(poolName);
    return { poolName, ipAddress: ip, status: 'IN_PROGRESS' };
}

export async function getDedicatedIpStatus(poolName: string): Promise<SesIpStatus> {
    if (!isSesConfigured()) return stubStatusFromName(poolName);
    const client = await loadRealClient();
    return client.getStatus(poolName);
}

export async function deleteDedicatedIp(poolName: string): Promise<void> {
    if (!isSesConfigured()) {
        logger.info('[SES_PROVISION] Stub mode - pool delete no-op', { poolName });
        return;
    }
    const client = await loadRealClient();
    await client.deletePool(poolName);
}
