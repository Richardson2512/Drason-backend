/**
 * Apollo URL parser.
 *
 * Apollo's people-search URLs put filters in the *hash fragment* after
 * `#/people?…`, not the query string. URLs typically look like:
 *
 *   https://app.apollo.io/#/people?finderViewId=...&personLocations[]=United+States
 *     &personTitles[]=CEO&personTitles[]=Founder&personSeniorities[]=founder
 *
 * Saved-list URLs hit a different path and use a list_id param:
 *
 *   https://app.apollo.io/#/people-search/lists/show/<listId>
 *
 * Saved-search URLs encode an internal search id:
 *
 *   https://app.apollo.io/#/people?searchId=...
 *
 * This parser detects which kind of URL we're looking at and converts
 * the front-end's bracket-array params into the snake_case body shape
 * Apollo's /v1/mixed_people/search REST API expects.
 */

import type { LeadSourceFilter } from '../types';

/**
 * Subset of Apollo URL params we know how to forward to the search API.
 * Anything not in this map is logged but ignored — keeps us from
 * silently mis-interpreting future filters Apollo adds.
 */
const ARRAY_PARAM_MAP: Record<string, string> = {
    'personLocations': 'person_locations',
    'personTitles': 'person_titles',
    'personSeniorities': 'person_seniorities',
    'personDepartments': 'person_department_or_subdepartments',
    'organizationLocations': 'organization_locations',
    'organizationDepartmentOrSubdepartmentCounts': 'organization_department_or_subdepartment_counts',
    'organizationIndustryTagIds': 'organization_industry_tag_ids',
    'organizationNumEmployeesRanges': 'organization_num_employees_ranges',
    'organizationFundingStageCds': 'organization_funding_stage_cds',
    'organizationLatestFundingAmountRanges': 'organization_latest_funding_amount_ranges',
    'organizationFoundedYearRanges': 'organization_founded_year_ranges',
    'currentlyUsingTechnologyUids': 'currently_using_technology_uids',
    'currentlyUsingAnyOfTechnologyUids': 'currently_using_any_of_technology_uids',
    'organizationKeywordTags': 'q_organization_keyword_tags',
    'personEmailStatusV2': 'contact_email_status',
};

const SCALAR_PARAM_MAP: Record<string, string> = {
    'qKeywords': 'q_keywords',
    'q_keywords': 'q_keywords', // some URL forms use snake-case already
    'qOrganizationDomains': 'q_organization_domains_list',
    'sortAscending': 'sort_ascending',
    'sortByField': 'sort_by_field',
};

/**
 * Extract the params section after `#/people?`. Apollo URLs are
 * single-page-app routes — the hash carries the route AND the query.
 */
function extractHashParams(url: string): URLSearchParams | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.hostname !== 'app.apollo.io') return null;

    // Hash is "#/people?personTitles[]=CEO&…"
    let hash = parsed.hash;
    if (!hash.startsWith('#')) return null;
    hash = hash.slice(1);

    const qIdx = hash.indexOf('?');
    if (qIdx === -1) return new URLSearchParams();
    return new URLSearchParams(hash.slice(qIdx + 1));
}

/**
 * Detect whether the URL's hash route points at a saved-list show page.
 * Format: `#/people-search/lists/show/<listId>` — the last segment is
 * the listId.
 */
function extractSavedListId(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.hostname !== 'app.apollo.io') return null;
    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    const route = hash.split('?')[0];
    const m = route.match(/^\/people-search\/lists\/show\/([A-Za-z0-9_-]+)\/?$/);
    return m ? m[1] : null;
}

/**
 * Parse an Apollo URL into a LeadSourceFilter. Returns null if the URL
 * doesn't match any recognized Apollo URL shape.
 */
export function parseApolloUrl(input: string): LeadSourceFilter | null {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();

    // 1. Saved list URL → use the list endpoint
    const listId = extractSavedListId(trimmed);
    if (listId) {
        return { kind: 'saved_list', listId };
    }

    // 2. People search URL with filter params
    const hashParams = extractHashParams(trimmed);
    if (!hashParams) return null;

    // 3. Saved search ID (live filter)
    const searchId = hashParams.get('searchId');
    if (searchId) {
        return { kind: 'saved_search', searchId };
    }

    // 4. Build a search-params body from the recognized filter keys
    const params: Record<string, unknown> = {};
    let recognizedAny = false;

    for (const key of Array.from(hashParams.keys())) {
        const baseKey = key.endsWith('[]') ? key.slice(0, -2) : key;

        if (ARRAY_PARAM_MAP[baseKey]) {
            const target = ARRAY_PARAM_MAP[baseKey];
            const values = hashParams.getAll(key);
            if (values.length > 0) {
                params[target] = values;
                recognizedAny = true;
            }
        } else if (SCALAR_PARAM_MAP[baseKey]) {
            const target = SCALAR_PARAM_MAP[baseKey];
            const value = hashParams.get(key);
            if (value) {
                params[target] = value;
                recognizedAny = true;
            }
        }
    }

    if (!recognizedAny) return null;

    return { kind: 'people_search', params };
}

/**
 * Generate a human-readable summary of parsed filters — drives the
 * dashboard's "we'll search for…" preview before the user hits Import.
 */
export function summarizeFilter(filter: LeadSourceFilter): string[] {
    if (filter.kind === 'saved_list') {
        return [`Saved list (id: ${filter.listId})`];
    }
    if (filter.kind === 'saved_search') {
        return [`Saved search (id: ${filter.searchId})`];
    }

    const out: string[] = [];
    const p = filter.params as Record<string, unknown>;
    const fmtArr = (k: string, label: string) => {
        const v = p[k];
        if (Array.isArray(v) && v.length > 0) {
            out.push(`${label}: ${v.slice(0, 5).join(', ')}${v.length > 5 ? ` (+${v.length - 5} more)` : ''}`);
        }
    };

    fmtArr('person_titles', 'Title');
    fmtArr('person_seniorities', 'Seniority');
    fmtArr('person_locations', 'Person location');
    fmtArr('person_department_or_subdepartments', 'Department');
    fmtArr('organization_locations', 'Company location');
    fmtArr('organization_industry_tag_ids', 'Industry');
    fmtArr('organization_num_employees_ranges', 'Company size');
    fmtArr('organization_funding_stage_cds', 'Funding stage');
    fmtArr('currently_using_technology_uids', 'Uses technology');

    if (typeof p.q_keywords === 'string' && p.q_keywords.length) {
        out.push(`Keyword: "${p.q_keywords}"`);
    }

    if (out.length === 0) {
        out.push('No structured filters detected — Apollo will return broad results.');
    }
    return out;
}
