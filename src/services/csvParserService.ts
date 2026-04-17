/**
 * CSV Parser Service
 *
 * Parses CSV files and auto-detects column mappings for lead import.
 * Uses csv-parse (already installed) for parsing.
 */

import { parse } from 'csv-parse/sync';

export interface ColumnMapping {
    email: string;
    first_name?: string;
    last_name?: string;
    company?: string;
    persona?: string;
    lead_score?: string;
}

export interface ParsedLead {
    email: string;
    first_name?: string;
    last_name?: string;
    company?: string;
    persona?: string;
    lead_score?: number;
}

// Dictionary of common header name variants per field
const HEADER_VARIANTS: Record<keyof ColumnMapping, string[]> = {
    email: ['email', 'e-mail', 'email_address', 'emailaddress', 'work email', 'work_email', 'contact email', 'mail'],
    first_name: ['first_name', 'firstname', 'first name', 'fname', 'given_name', 'given name', 'first'],
    last_name: ['last_name', 'lastname', 'last name', 'lname', 'surname', 'family_name', 'family name', 'last'],
    company: ['company', 'company_name', 'companyname', 'company name', 'organization', 'org', 'employer', 'account', 'account_name'],
    persona: ['persona', 'title', 'job_title', 'jobtitle', 'job title', 'role', 'position', 'job role', 'designation'],
    lead_score: ['lead_score', 'leadscore', 'lead score', 'score', 'rating', 'quality_score', 'quality score'],
};

/**
 * Auto-detect column mapping from CSV headers using a dictionary of common variants.
 * Case-insensitive matching. Returns the detected mapping with header names as values.
 */
export function autoDetectMapping(headers: string[]): ColumnMapping {
    const mapping: Partial<ColumnMapping> = {};
    const normalizedHeaders = headers.map(h => h.trim().toLowerCase());

    for (const [field, variants] of Object.entries(HEADER_VARIANTS)) {
        for (const variant of variants) {
            const idx = normalizedHeaders.indexOf(variant);
            if (idx !== -1) {
                (mapping as Record<string, string>)[field] = headers[idx]; // preserve original case
                break;
            }
        }
    }

    if (!mapping.email) {
        // Last-resort: find any header containing "email" or "mail"
        const emailIdx = normalizedHeaders.findIndex(h => h.includes('email') || h === 'mail');
        if (emailIdx !== -1) mapping.email = headers[emailIdx];
    }

    return mapping as ColumnMapping;
}

/**
 * Parse a CSV string into an array of leads using the provided column mapping.
 * Only `email` is required. Other fields are optional with sensible defaults.
 */
export function parseCSV(csvContent: string, mapping: ColumnMapping): { leads: ParsedLead[]; errors: string[] } {
    const leads: ParsedLead[] = [];
    const errors: string[] = [];

    let records: Record<string, string>[];
    try {
        records = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            relax_column_count: true,
        });
    } catch (err: any) {
        return { leads: [], errors: [`CSV parsing failed: ${err.message}`] };
    }

    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const email = (row[mapping.email] || '').trim().toLowerCase();

        if (!email) {
            errors.push(`Row ${i + 2}: missing email`);
            continue;
        }

        // Basic email format check
        if (!email.includes('@') || !email.includes('.')) {
            errors.push(`Row ${i + 2}: invalid email format "${email}"`);
            continue;
        }

        const lead: ParsedLead = { email };

        if (mapping.first_name && row[mapping.first_name]) lead.first_name = row[mapping.first_name].trim();
        if (mapping.last_name && row[mapping.last_name]) lead.last_name = row[mapping.last_name].trim();
        if (mapping.company && row[mapping.company]) lead.company = row[mapping.company].trim();
        if (mapping.persona && row[mapping.persona]) lead.persona = row[mapping.persona].trim();

        if (mapping.lead_score && row[mapping.lead_score]) {
            const score = parseInt(row[mapping.lead_score], 10);
            lead.lead_score = isNaN(score) ? 50 : Math.min(100, Math.max(0, score));
        } else {
            lead.lead_score = 50; // default
        }

        leads.push(lead);
    }

    return { leads, errors };
}

/**
 * Extract headers from CSV content without parsing all rows.
 */
export function extractHeaders(csvContent: string): string[] {
    const firstNewline = csvContent.indexOf('\n');
    const headerLine = firstNewline > 0 ? csvContent.slice(0, firstNewline) : csvContent;
    return headerLine.split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
}
