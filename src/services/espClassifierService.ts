/**
 * ESP Classifier Service
 *
 * Classifies a domain's email service provider from its MX records.
 * Reads from the existing DomainInsight cache — zero additional DNS lookups.
 */

import { prisma } from '../index';

interface MxRecord {
    exchange: string;
    priority?: number;
}

/**
 * Classify ESP from MX records using host pattern matching.
 */
export function classifyEspFromMx(mxRecords: MxRecord[]): string {
    if (!mxRecords || mxRecords.length === 0) return 'other';

    for (const record of mxRecords) {
        const host = record.exchange.toLowerCase();
        if (host.includes('google') || host.includes('gmail')) return 'gmail';
        if (host.includes('outlook') || host.includes('microsoft') || host.includes('protection.outlook')) return 'microsoft';
        if (host.includes('yahoo') || host.includes('yahoodns')) return 'yahoo';
    }

    return 'other';
}

/**
 * Get the cached ESP bucket for a domain, classifying from MX records if not yet cached.
 * Requires that getDomainInsight() has already been called (which happens during validation).
 */
export async function getEspBucket(organizationId: string, domain: string): Promise<string> {
    const insight = await prisma.domainInsight.findUnique({
        where: { organization_id_domain: { organization_id: organizationId, domain } }
    });

    if (!insight) return 'other';

    // Return cached bucket if available
    if (insight.esp_bucket) return insight.esp_bucket;

    // Classify from stored MX records and cache the result
    const mxRecords = (insight.mx_records as unknown as MxRecord[]) || [];
    const bucket = classifyEspFromMx(mxRecords);

    await prisma.domainInsight.update({
        where: { id: insight.id },
        data: { esp_bucket: bucket }
    });

    return bucket;
}
