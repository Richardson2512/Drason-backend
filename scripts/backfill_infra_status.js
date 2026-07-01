/**
 * Backfill: move Door-B (import-time blacklist) victims OUT of the healing pipeline
 * (status/recovery_phase) into the new infra_status advisory - across ALL orgs.
 *
 * WHY: before the infra_status change, a blacklisted domain/IP pushed never-sent
 * imported mailboxes into recovery_phase='quarantine'/'paused', trapping them (no
 * clean sends to graduate on) and hiding them from the campaign picker. New code no
 * longer does this, but existing rows keep the stale state until this backfill runs.
 *
 * SAFETY: only touches Door-B rows:
 *   - Mailboxes: recovery_phase != 'healthy' AND total_sent_count = 0 AND paused_reason
 *     matches an infrastructure reason ('IP blacklist' | 'Cascaded from domain pause' |
 *     'Infrastructure assessment'). The total_sent_count=0 guard guarantees we never
 *     touch a Door-A mailbox that degraded from real sending (that has sends), and the
 *     reason filter excludes connection-failure pauses.
 *   - Domains: status='paused' AND paused_reason = 'Infrastructure assessment: domain
 *     health issues detected' (the exact string only the Door-B domain path writes).
 *
 * infra_status assignment:
 *   - Mailbox with a DIRECT 'IP blacklist' reason -> action_required (its own IP is listed).
 *   - Mailbox cascaded from a domain pause -> ready (the domain gate blocks it via
 *     Domain.infra_status; the 6h IP worker will re-verify the mailbox IP anyway).
 *   - Door-B domain -> action_required (it was on a blocking blacklist). The next
 *     assessment / on-demand re-check re-verifies and clears it if delisted.
 *
 * Run read-only first:  DRY_RUN=1 node scripts/backfill_infra_status.js
 * Apply (post-migration): DRY_RUN=0 node scripts/backfill_infra_status.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.PROD_DB_URL } } });

const DRY_RUN = process.env.DRY_RUN !== '0';
const HEALING_PHASES = ['paused', 'quarantine', 'restricted_send', 'warm_recovery'];
const DOMAIN_DOORB_REASON = 'Infrastructure assessment: domain health issues detected';

(async () => {
  try {
    console.log(`=== Door-B backfill (${DRY_RUN ? 'DRY RUN - read only' : 'APPLY'}) ===\n`);

    // ---- MAILBOXES ----
    const mbWhere = {
      recovery_phase: { in: HEALING_PHASES },
      total_sent_count: 0,
      OR: [
        { paused_reason: { contains: 'IP blacklist' } },
        { paused_reason: { contains: 'Cascaded from domain pause' } },
        { paused_reason: { contains: 'Infrastructure assessment' } },
      ],
    };
    const candidates = await prisma.mailbox.findMany({
      where: mbWhere,
      select: { id: true, email: true, organization_id: true, recovery_phase: true, paused_reason: true },
    });
    const ipBlocked = candidates.filter(m => /IP blacklist/i.test(m.paused_reason || ''));
    const cascadeOnly = candidates.filter(m => !/IP blacklist/i.test(m.paused_reason || ''));
    const mbOrgs = new Set(candidates.map(m => m.organization_id));
    console.log(`MAILBOXES matched: ${candidates.length} across ${mbOrgs.size} org(s)`);
    console.log(`  -> direct IP-blacklist (infra_status=action_required): ${ipBlocked.length}`);
    console.log(`  -> cascade/domain-driven (infra_status=ready, domain gate blocks): ${cascadeOnly.length}`);

    // ---- DOMAINS ----
    // Door-B discriminator (mirrors mailboxes): never sent + in a non-healthy state. A
    // domain that has never sent cannot have bounced, so any paused/quarantine state on it
    // is infrastructure-driven (blacklist / DNS / IP-cascade), never Door A.
    const domWhere = {
      total_sent_lifetime: 0,
      OR: [
        { status: { in: HEALING_PHASES } },
        { recovery_phase: { in: HEALING_PHASES } },
      ],
    };
    const domCandidates = await prisma.domain.findMany({
      where: domWhere,
      select: { id: true, domain: true, organization_id: true, status: true, recovery_phase: true, paused_reason: true },
    });
    const domOrgs = new Set(domCandidates.map(d => d.organization_id));
    console.log(`\nDOMAINS matched (never-sent + non-healthy -> infra_status=action_required): ${domCandidates.length} across ${domOrgs.size} org(s)`);
    // Reason breakdown - confirm every matched domain is genuinely Door B before writing.
    const domReasons = {};
    for (const d of domCandidates) {
      const key = `status=${d.status} phase=${d.recovery_phase} | ${(d.paused_reason || '(none)').slice(0, 60)}`;
      domReasons[key] = (domReasons[key] || 0) + 1;
    }
    console.log('  reason breakdown:');
    for (const [k, v] of Object.entries(domReasons)) console.log(`    [${v}] ${k}`);

    // Focus report for the ticket org
    const TICKET_ORG = '96f9cf87-8402-4eb8-a100-2d54285af3cf';
    console.log(`\nTicket org (Authority) ${TICKET_ORG}:`);
    console.log(`  mailboxes: ${candidates.filter(m => m.organization_id === TICKET_ORG).length}, domains: ${domCandidates.filter(d => d.organization_id === TICKET_ORG).length}`);

    if (DRY_RUN) {
      console.log('\nDRY RUN - no writes performed. Re-run with DRY_RUN=0 after the migration is applied.');
      return;
    }

    // ---- APPLY ----
    let mbUpdated = 0;
    for (const m of candidates) {
      const isIp = /IP blacklist/i.test(m.paused_reason || '');
      await prisma.mailbox.update({
        where: { id: m.id },
        data: {
          status: 'healthy',
          recovery_phase: 'healthy',
          healing_origin: null,
          phase_entered_at: null,
          clean_sends_since_phase: 0,
          cooldown_until: null,
          paused_reason: null,
          paused_at: null,
          infra_status: isIp ? 'action_required' : 'ready',
          infra_reason: isIp
            ? 'Sending IP on a blocking blacklist. Delist the IP, then re-check to resume sending.'
            : null,
        },
      });
      mbUpdated++;
    }

    let domUpdated = 0;
    for (const d of domCandidates) {
      await prisma.domain.update({
        where: { id: d.id },
        data: {
          status: 'healthy',
          recovery_phase: 'healthy',
          paused_reason: null,
          paused_at: null,
          cooldown_until: null,
          infra_status: 'action_required',
          infra_reason: 'Domain on a blocking blacklist. Delist the domain, then re-check to resume sending.',
        },
      });
      domUpdated++;
    }

    console.log(`\nAPPLIED: ${mbUpdated} mailboxes, ${domUpdated} domains updated.`);
    console.log('Next assessment (24h) / on-demand re-check will re-verify and auto-clear any that are already delisted.');
  } catch (e) {
    console.error('ERROR', e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
