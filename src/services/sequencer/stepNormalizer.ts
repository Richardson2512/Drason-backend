/**
 * Canonical sequence-step normalizer — the single source of truth for the
 * shape a sequence is persisted in, used by EVERY save path (campaign
 * create + update).
 *
 * Why this exists: the resolver (stepResolver) addresses steps strictly
 * by `step_number`. If `step_number` is ever non-contiguous (a middle
 * step deleted on edit → gap 1,2,4) or 0-based, "resolve by number" and
 * any "index by position" reader disagree → leads stall or skip at the
 * boundary. Normalizing on save makes step_number ALWAYS a contiguous
 * 1..N in intended order, so that ambiguity is structurally impossible
 * rather than guarded at runtime.
 *
 * It also remaps `branch_to_step_number` through the old→new numbering so
 * branches keep pointing at the right step after renumbering, and
 * preserves the FULL step shape (step_type / condition / step_config /
 * body_text) — the update path previously dropped these, silently turning
 * every LinkedIn/branched step back into a plain email step on edit.
 *
 * Pure (no IO), unit-tested.
 */

export interface NormalizedSequenceStep {
    step_number: number;
    step_type: string;
    delay_days: number;
    delay_hours: number;
    subject: string;
    preheader: string;
    body_html: string;
    body_text: string | null;
    condition: string | null;
    branch_to_step_number: number | null;
    step_config: Record<string, unknown>;
    variants: unknown[];
}

function toFiniteNumber(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Map raw frontend step payloads (snake/camel keys, optional fields) into
 * the canonical persisted shape with contiguous 1..N step_number in
 * intended order and branch targets remapped accordingly.
 *
 * Intended order = ascending by the caller-supplied effective step_number,
 * input array order as a stable tiebreaker. Renumbering is applied in that
 * order so a campaign authored as 10,20,30 or 1,2,4 (post-delete gap)
 * collapses deterministically to 1,2,3.
 */
export function normalizeSequenceSteps(rawSteps: unknown): NormalizedSequenceStep[] {
    const arr: any[] = Array.isArray(rawSteps) ? rawSteps : [];

    const mapped = arr.map((s: any, idx: number) => {
        const origNumber = toFiniteNumber(s?.step_number ?? s?.stepNumber, idx + 1);
        const rawBranch = s?.branch_to_step_number ?? s?.branchToStepNumber ?? null;
        const origBranch =
            rawBranch == null ? null : toFiniteNumber(rawBranch, NaN);
        return {
            _origNumber: origNumber,
            _inputIndex: idx,
            _origBranch: origBranch != null && Number.isFinite(origBranch) ? origBranch : null,
            step_type: String(s?.step_type ?? s?.stepType ?? 'email'),
            delay_days: toFiniteNumber(s?.delay_days ?? s?.delayDays, idx === 0 ? 0 : 1),
            delay_hours: toFiniteNumber(s?.delay_hours ?? s?.delayHours, 0),
            subject: s?.subject ?? '',
            preheader: s?.preheader ?? '',
            body_html: s?.body_html ?? s?.bodyHtml ?? '',
            body_text: s?.body_text ?? s?.bodyText ?? null,
            condition: (s?.condition ?? null) as string | null,
            step_config: (s?.step_config ?? s?.stepConfig ?? {}) as Record<string, unknown>,
            variants: Array.isArray(s?.variants) ? s.variants : [],
        };
    });

    // Stable sort by intended order.
    const sorted = mapped
        .map((m, i) => ({ m, i }))
        .sort((a, b) => (a.m._origNumber - b.m._origNumber) || (a.i - b.i))
        .map(x => x.m);

    // old step_number → new contiguous step_number. First occurrence wins
    // so a malformed duplicate number maps deterministically.
    const oldToNew = new Map<number, number>();
    sorted.forEach((m, idx) => {
        if (!oldToNew.has(m._origNumber)) oldToNew.set(m._origNumber, idx + 1);
    });

    return sorted.map((m, idx) => ({
        step_number: idx + 1,
        step_type: m.step_type,
        delay_days: m.delay_days,
        delay_hours: m.delay_hours,
        subject: m.subject,
        preheader: m.preheader,
        body_html: m.body_html,
        body_text: m.body_text,
        condition: m.condition,
        // Branch points at a step by its OLD number; remap to the new
        // number. A branch to a step that no longer exists (its target was
        // deleted) becomes null = "sequence ends here", which the resolver
        // already treats correctly.
        branch_to_step_number:
            m._origBranch == null ? null : (oldToNew.get(m._origBranch) ?? null),
        step_config: m.step_config,
        variants: m.variants,
    }));
}
