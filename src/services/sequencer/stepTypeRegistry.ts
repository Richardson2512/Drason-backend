/**
 * Step type registry - single source of truth for the multi-channel
 * sequence step vocabulary (Phase 3).
 *
 * Every step in a SequenceStep / SequenceTemplateStep row has a `step_type`
 * value that maps to one entry here. The registry codifies:
 *
 *   - channel: 'email' | 'linkedin' (drives sender pool selection)
 *   - required_sender: which sender table the dispatcher pulls from
 *   - preconditions: implicit "this step is only executable when…" rules
 *     (the dispatcher writes SequenceStepExecution rows with status='SKIPPED'
 *     and skip_reason=<precondition key> when these fail)
 *   - config_schema: allowed step_config keys + their types, validated on
 *     CRUD writes
 *
 * Wiring the actual executor functions for each type lives in later phases
 * (Phase 4 for find_email / Phase 5 for the LinkedIn dispatcher).
 */

export type StepChannel = 'email' | 'linkedin' | 'utility';
export type SenderKind = 'mailbox' | 'linkedin_account' | 'none';

/**
 * Precondition keys evaluated at dispatch time. The values double as the
 * skip_reason string on SequenceStepExecution rows so analytics can group
 * skips by reason without further translation.
 */
export type PreconditionKey =
    | 'lead_has_email'
    | 'lead_has_linkedin_profile'
    | 'sender_is_first_degree'
    | 'sender_is_not_first_degree'
    | 'sender_supports_inmail'
    | 'sender_has_inmail_credits_or_open_profile'
    | 'lead_has_recent_post';

export interface StepTypeDef {
    key: string;
    channel: StepChannel;
    label: string;
    description: string;
    required_sender: SenderKind;
    /** Preconditions checked at dispatch - ALL must hold or the step is SKIPPED. */
    preconditions: PreconditionKey[];
    /** Allowed step_config keys; values are TypeScript-narrow type hints used
     *  by the runtime validator. Unknown keys are rejected on write. */
    config_schema: Record<string, 'string' | 'number' | 'boolean' | 'enum' | 'string[]'>;
    /** Enum-typed config values: keyed by config key, value is the allowed set. */
    config_enums?: Record<string, string[]>;
}

export const STEP_TYPES: Record<string, StepTypeDef> = {
    email: {
        key: 'email',
        channel: 'email',
        label: 'Email',
        description: 'Send an email using the campaign\'s mailbox pool. Uses the row\'s subject / preheader / body_html fields directly.',
        required_sender: 'mailbox',
        preconditions: ['lead_has_email'],
        config_schema: {},
    },
    linkedin_message: {
        key: 'linkedin_message',
        channel: 'linkedin',
        label: 'LinkedIn DM',
        description: 'Send a direct message via Unipile. Requires the lead to be a 1st-degree connection of the sending account.',
        required_sender: 'linkedin_account',
        preconditions: ['lead_has_linkedin_profile', 'sender_is_first_degree'],
        config_schema: {
            body_template: 'string',
            fallback_message: 'string',
            sender_pool_id: 'string',
        },
    },
    linkedin_connection_request: {
        key: 'linkedin_connection_request',
        channel: 'linkedin',
        label: 'LinkedIn Connection Request',
        description: 'Send a connection request (with optional note). Only fires when the lead is NOT already connected - paired with linkedin_message via the connection precondition.',
        required_sender: 'linkedin_account',
        preconditions: ['lead_has_linkedin_profile', 'sender_is_not_first_degree'],
        config_schema: {
            note_template: 'string',
            use_workspace_default_note_fallback: 'boolean',
            fallback_message: 'string',
        },
    },
    linkedin_inmail: {
        key: 'linkedin_inmail',
        channel: 'linkedin',
        label: 'LinkedIn InMail',
        description: 'Send an InMail. Requires a paid LinkedIn tier on the sender side - Premium (5-15/mo), Sales Navigator (~50/mo), or Recruiter (30-150+/mo). Classic / free accounts have no InMail capability. Credits are consumed only on closed profiles; Open-Profile recipients are free.',
        required_sender: 'linkedin_account',
        preconditions: ['lead_has_linkedin_profile', 'sender_supports_inmail', 'sender_has_inmail_credits_or_open_profile'],
        config_schema: {
            subject: 'string',
            body: 'string',
            fallback_message: 'string',
        },
    },
    linkedin_view_profile: {
        key: 'linkedin_view_profile',
        channel: 'linkedin',
        label: 'View Profile',
        description: 'Visit the lead\'s profile (lead receives a "viewed your profile" notification). A warm-up tactic before a CR.',
        required_sender: 'linkedin_account',
        preconditions: ['lead_has_linkedin_profile'],
        config_schema: {},
    },
    linkedin_follow: {
        key: 'linkedin_follow',
        channel: 'linkedin',
        label: 'Follow',
        description: 'Follow the lead. Must come BEFORE any connection_request in the same sequence - enforce in the validator.',
        required_sender: 'linkedin_account',
        preconditions: ['lead_has_linkedin_profile'],
        config_schema: {},
    },
    linkedin_like_post: {
        key: 'linkedin_like_post',
        channel: 'linkedin',
        label: 'Like a recent post',
        description: 'React to one of the lead\'s recent posts. Reaction type and search timespan configurable; skip-if-no-post toggle controls scheduling when nothing matches.',
        required_sender: 'linkedin_account',
        preconditions: ['lead_has_linkedin_profile', 'lead_has_recent_post'],
        config_schema: {
            reaction_type: 'enum',
            post_selection_timespan_days: 'number',
            skip_if_no_post: 'boolean',
        },
        config_enums: {
            reaction_type: ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'MAYBE', 'FUNNY'],
        },
    },
    find_email: {
        key: 'find_email',
        channel: 'utility',
        label: 'Find Email',
        description: 'Enrich the lead\'s email via the workspace\'s waterfall providers. One use per campaign per lead. Branches to step on Email Found / Not Found.',
        required_sender: 'none',
        // The precondition is implicit: if lead.email is already set we
        // SKIP - Find Email runs at most once per lead.
        // Encoded as `lead_has_email` inverted in the evaluator.
        preconditions: [],
        config_schema: {
            providers_override: 'string[]',
        },
    },
    find_linkedin_url: {
        key: 'find_linkedin_url',
        channel: 'utility',
        label: 'Find LinkedIn URL',
        description: 'Discover the lead\'s LinkedIn profile URL via the workspace\'s enrichment waterfall. Skipped (no action burned) when the lead already has a URL on file, or when zero enrichment providers are connected. Place BEFORE any linkedin_* step so downstream LinkedIn touch points have a profile to act on.',
        required_sender: 'none',
        // Skip if the lead already has a linkedin_url - mirrors the
        // find_email precondition pattern (inverted lead_has_email).
        preconditions: [],
        config_schema: {
            providers_override: 'string[]',
        },
    },
    end: {
        key: 'end',
        channel: 'utility',
        label: 'End',
        description: 'Terminal node - leads reaching here are marked Finished and stop receiving steps.',
        required_sender: 'none',
        preconditions: [],
        config_schema: {},
    },
};

export function getStepType(key: string): StepTypeDef | undefined {
    return STEP_TYPES[key];
}

export function isLinkedInStepType(key: string): boolean {
    return STEP_TYPES[key]?.channel === 'linkedin';
}

export function listStepTypes(): StepTypeDef[] {
    return Object.values(STEP_TYPES);
}

/**
 * Step types the LinkedIn dispatcher worker is responsible for: every
 * `linkedin_*` touch point plus any channel-agnostic utility step that
 * doesn't need a sending mailbox (`find_email`, `find_linkedin_url`).
 *
 * Derived from STEP_TYPES so adding a new utility/LinkedIn step type
 * automatically lights up the dispatcher's eligibility filter - no
 * separate hard-coded list to keep in sync.
 *
 * The email dispatcher (sendQueueService) owns the inverse: every
 * `email` step + the `end` terminal.
 */
export function isLinkedInDispatcherStep(key: string): boolean {
    const def = STEP_TYPES[key];
    if (!def) return false;
    if (def.channel === 'linkedin') return true;
    // Utility steps with no sender requirement are dispatched by the
    // LinkedIn worker (it ticks more frequently and handles enrichment
    // side-effects). The `end` terminal stays out of dispatch entirely.
    if (def.channel === 'utility' && def.required_sender === 'none' && key !== 'end') return true;
    return false;
}

// ────────────────────────────────────────────────────────────────────
// Config validator
//
// Returns a list of validation issues. Empty array = valid.
// Called from sequence CRUD before persisting step_config.
// ────────────────────────────────────────────────────────────────────

export interface ConfigValidationIssue {
    key: string;
    message: string;
}

export function validateStepConfig(stepType: string, config: unknown): ConfigValidationIssue[] {
    const def = STEP_TYPES[stepType];
    const issues: ConfigValidationIssue[] = [];
    if (!def) {
        issues.push({ key: 'step_type', message: `Unknown step_type "${stepType}"` });
        return issues;
    }
    if (config === null || typeof config !== 'object') {
        issues.push({ key: 'step_config', message: 'step_config must be an object' });
        return issues;
    }
    const cfg = config as Record<string, unknown>;
    for (const [key, value] of Object.entries(cfg)) {
        const expected = def.config_schema[key];
        if (!expected) {
            issues.push({ key, message: `Unknown config key "${key}" for step_type ${stepType}` });
            continue;
        }
        if (value === null || value === undefined) continue; // optional
        switch (expected) {
            case 'string':
                if (typeof value !== 'string') issues.push({ key, message: `"${key}" must be a string` });
                break;
            case 'number':
                if (typeof value !== 'number') issues.push({ key, message: `"${key}" must be a number` });
                break;
            case 'boolean':
                if (typeof value !== 'boolean') issues.push({ key, message: `"${key}" must be a boolean` });
                break;
            case 'enum': {
                const allowed = def.config_enums?.[key] || [];
                if (typeof value !== 'string' || !allowed.includes(value)) {
                    issues.push({ key, message: `"${key}" must be one of: ${allowed.join(', ')}` });
                }
                break;
            }
            case 'string[]':
                if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
                    issues.push({ key, message: `"${key}" must be an array of strings` });
                }
                break;
        }
    }
    return issues;
}

// ────────────────────────────────────────────────────────────────────
// Cross-step validation
//
// Some step types have positional constraints. `linkedin_follow` must come
// BEFORE any `linkedin_connection_request` in the same sequence (the Follow
// action is intended as a pre-CR warmup). Surfaced as a sequence-level
// validator the writer calls before persisting.
// ────────────────────────────────────────────────────────────────────

export interface StepLite {
    step_number: number;
    step_type: string;
}

export interface FullStepLite extends StepLite {
    delay_days?: number;
    delay_hours?: number;
    step_config?: Record<string, unknown>;
    /** Email-specific column - present only for step_type='email'. */
    body_html?: string;
}

export function validateSequenceShape(steps: FullStepLite[]): ConfigValidationIssue[] {
    const issues: ConfigValidationIssue[] = [];
    const sorted = [...steps].sort((a, b) => a.step_number - b.step_number);

    // 1. follow-before-connection-request constraint.
    let crIndex = -1;
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        if (s.step_type === 'linkedin_connection_request' && crIndex < 0) crIndex = i;
        if (s.step_type === 'linkedin_follow' && crIndex >= 0 && i > crIndex) {
            issues.push({
                key: `step_${s.step_number}`,
                message: 'linkedin_follow steps must appear BEFORE any linkedin_connection_request in the sequence.',
            });
        }
    }

    // 2. find_email is one-shot per sequence.
    const findEmailCount = sorted.filter(s => s.step_type === 'find_email').length;
    if (findEmailCount > 1) {
        issues.push({ key: 'find_email', message: 'Only one find_email step is allowed per sequence (one use per campaign per lead).' });
    }

    // 3. Minimum 3-hour delay between any two action steps.
    //    Exception: the very first step may have delay 0 ("send immediately").
    for (let i = 1; i < sorted.length; i++) {
        const s = sorted[i];
        const days = s.delay_days ?? 0;
        const hours = s.delay_hours ?? 0;
        const totalHours = days * 24 + hours;
        if (totalHours < 3) {
            issues.push({
                key: `step_${s.step_number}.delay`,
                message: `Step ${s.step_number} delay is ${totalHours}h - a minimum 3-hour gap between consecutive steps is required.`,
            });
        }
    }

    // 4. Fallback message required for non-blank CRs and DMs.
    //    A non-blank step is one whose primary message content uses a
    //    template variable. The fallback prevents broken sends when a
    //    variable can't render.
    for (const s of sorted) {
        const cfg = s.step_config || {};
        if (s.step_type === 'linkedin_connection_request') {
            const note = (cfg.note_template as string | undefined) || '';
            const hasVar = /\{\{[\w_\-]+\}\}/.test(note);
            const hasFallback = Boolean((cfg.fallback_message as string | undefined) || cfg.use_workspace_default_note_fallback);
            if (note && hasVar && !hasFallback) {
                issues.push({
                    key: `step_${s.step_number}.fallback_message`,
                    message: `Step ${s.step_number} (Connection Request) uses template variables but has no fallback_message. A fallback is required to prevent broken sends when a variable can’t render.`,
                });
            }
        }
        if (s.step_type === 'linkedin_message' || s.step_type === 'linkedin_inmail') {
            const body = (cfg.body_template as string | undefined) || (cfg.body as string | undefined) || '';
            const hasVar = /\{\{[\w_\-]+\}\}/.test(body);
            const hasFallback = Boolean(cfg.fallback_message);
            if (body && hasVar && !hasFallback) {
                issues.push({
                    key: `step_${s.step_number}.fallback_message`,
                    message: `Step ${s.step_number} (${s.step_type === 'linkedin_inmail' ? 'InMail' : 'DM'}) uses template variables but has no fallback_message.`,
                });
            }
        }
        if (s.step_type === 'email') {
            const body = s.body_html || '';
            const hasVar = /\{\{[\w_\-]+\}\}/.test(body);
            const hasFallback = Boolean((s.step_config?.fallback_html as string | undefined) || (s.step_config?.fallback_text as string | undefined));
            if (body && hasVar && !hasFallback) {
                issues.push({
                    key: `step_${s.step_number}.fallback_message`,
                    message: `Step ${s.step_number} (Email) uses template variables but has no fallback. Add fallback_html or fallback_text to step_config.`,
                });
            }
        }
    }

    // 5. Don't repeat identical action steps in a sequence - two
    //    consecutive steps of the same type with the same body are almost
    //    always a copy-paste mistake.
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].step_type !== sorted[i - 1].step_type) continue;
        const cur = sorted[i].step_config || {};
        const prv = sorted[i - 1].step_config || {};
        // Compare the primary content field per step type.
        const curContent = (cur.body_template || cur.note_template || cur.body || sorted[i].body_html || '') as string;
        const prvContent = (prv.body_template || prv.note_template || prv.body || sorted[i - 1].body_html || '') as string;
        if (curContent && curContent === prvContent) {
            issues.push({
                key: `step_${sorted[i].step_number}.duplicate`,
                message: `Step ${sorted[i].step_number} has the same content as step ${sorted[i - 1].step_number}. This is a common mistake - vary the message.`,
            });
        }
    }

    return issues;
}
