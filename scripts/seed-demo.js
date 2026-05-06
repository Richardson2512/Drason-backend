/* eslint-disable */
/**
 * Seeds a fully-populated demo organization for the staging environment.
 * Idempotent — re-running deletes the previous demo org and reseeds.
 *
 * Run: node scripts/seed-demo.js   (from Drason-backend-staging)
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const prisma = new PrismaClient();

const DEMO_EMAIL = 'demo@superkabe.com';
const DEMO_PASSWORD = 'Demo2026!';
const DEMO_ORG_SLUG = 'demo-agency';

// Stable UUIDs — re-seeds keep the same User and Organization id, so live
// JWT cookies stay valid (no "User not found" / "Organization not found"
// after a re-seed). Other IDs (campaigns, mailboxes, leads, etc.) still
// rotate on each run; only these two need stability for auth.
const DEMO_ORG_ID = '04ed75bc-2d32-4639-af4f-7428ce9cc435';
const DEMO_USER_ID = '319a7aca-6aa2-4606-a22e-817bd4ff5226';

const uuid = () => crypto.randomUUID();
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const hoursAgo = (n) => new Date(Date.now() - n * 60 * 60 * 1000);
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function wipePreviousDemo() {
  const existing = await prisma.organization.findUnique({ where: { slug: DEMO_ORG_SLUG } });
  if (!existing) return;
  const orgId = existing.id;
  console.log(`Existing demo org found (${orgId}) — wiping...`);

  // Wipe orphan tables (no Organization FK) by org id first
  await prisma.sendEvent.deleteMany({ where: { organization_id: orgId } });
  await prisma.replyEvent.deleteMany({ where: { organization_id: orgId } });
  await prisma.emailOpenEvent.deleteMany({ where: { organization_id: orgId } });
  await prisma.emailClickEvent.deleteMany({ where: { organization_id: orgId } });
  await prisma.coldCallDailySnapshot.deleteMany({ where: { organization_id: orgId } });
  await prisma.coldCallCustomSnapshot.deleteMany({ where: { organization_id: orgId } });
  await prisma.coldCallListSettings.deleteMany({ where: { organization_id: orgId } });
  await prisma.mailboxEspPerformance.deleteMany({ where: { organization_id: orgId } });
  // CampaignAccountUsage has no org FK; delete via campaign_id
  const camps = await prisma.campaign.findMany({ where: { organization_id: orgId }, select: { id: true } });
  await prisma.campaignAccountUsage.deleteMany({ where: { campaign_id: { in: camps.map(c => c.id) } } });

  // Cascade delete via org
  await prisma.organization.delete({ where: { id: orgId } });
  console.log('Wiped.');
}

async function main() {
  console.log('Seeding demo organization...');
  await wipePreviousDemo();

  // ── Organization ──
  const orgId = DEMO_ORG_ID;
  const org = await prisma.organization.create({
    data: {
      id: orgId,
      name: 'Demo Agency',
      slug: DEMO_ORG_SLUG,
      system_mode: 'enforce',
      assessment_completed: true,
      subscription_tier: 'scale',
      subscription_status: 'active',
      trial_started_at: daysAgo(60),
      trial_ends_at: daysAgo(46),
      subscription_started_at: daysAgo(45),
      next_billing_date: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      mailing_address: '500 Mission Street, Suite 800, San Francisco, CA 94105, USA',
      mailing_address_updated_at: daysAgo(40),
      usage_last_updated_at: minutesAgo(15),
    },
  });

  // ── User ──
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      id: DEMO_USER_ID,
      email: DEMO_EMAIL,
      password_hash: passwordHash,
      name: 'Demo User',
      role: 'admin',
      organization_id: orgId,
      last_login_at: hoursAgo(2),
      password_changed_at: daysAgo(40),
    },
  });
  console.log(`Created user ${user.email} (id: ${user.id})`);

  // ── Sequencer settings ──
  await prisma.sequencerSettings.create({
    data: {
      organization_id: orgId,
      default_daily_limit: 50,
      default_timezone: 'America/New_York',
      default_start_time: '09:00',
      default_end_time: '17:00',
      default_active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      delay_between_emails: 2,
      global_daily_max: 600,
      default_track_opens: true,
      default_track_clicks: true,
      default_unsubscribe: true,
      auto_pause_on_bounce: true,
      bounce_threshold: 3.0,
      stop_on_reply_default: true,
      notify_on_reply: true,
      notify_on_bounce: true,
      notify_on_complete: true,
    },
  });

  // ── Cold call list settings ──
  await prisma.coldCallListSettings.create({
    data: {
      organization_id: orgId,
      min_opens: 3,
      time_window_days: 7,
      require_click: false,
      require_no_reply: true,
      exclude_recent_days: 7,
      max_list_size: 200,
    },
  });

  // ── Email signature ──
  await prisma.emailSignature.create({
    data: {
      organization_id: orgId,
      name: 'Default',
      html_content: '<p>Best,<br/><strong>Demo User</strong><br/>Demo Agency<br/><a href="https://demo-agency.com">demo-agency.com</a></p>',
      is_default: true,
    },
  });

  // ── Template folders ──
  const folderProspecting = await prisma.templateFolder.create({
    data: { organization_id: orgId, name: 'Prospecting' },
  });
  const folderFollowup = await prisma.templateFolder.create({
    data: { organization_id: orgId, name: 'Follow-ups' },
  });

  // ── Email templates ──
  const templates = await Promise.all([
    prisma.emailTemplate.create({
      data: {
        organization_id: orgId,
        name: 'Cold intro — SaaS founders',
        subject: 'Quick question, {{first_name}}',
        body_html: '<p>Hi {{first_name}},</p><p>Saw your work at {{company}} and wanted to reach out.</p><p>We help SaaS teams scale outbound without burning their domain reputation. Would a 15-min chat next week make sense?</p><p>{{signature}}</p>',
        category: 'introduction',
        folder_id: folderProspecting.id,
      },
    }),
    prisma.emailTemplate.create({
      data: {
        organization_id: orgId,
        name: 'Follow-up #1',
        subject: 're: Quick question',
        body_html: '<p>Hi {{first_name}},</p><p>Bumping this up — any thoughts?</p><p>{{signature}}</p>',
        category: 'follow-up',
        folder_id: folderFollowup.id,
      },
    }),
    prisma.emailTemplate.create({
      data: {
        organization_id: orgId,
        name: 'Breakup',
        subject: 'Should I close the loop?',
        body_html: '<p>Hi {{first_name}},</p><p>Closing the loop on this — happy to circle back another time if the timing is off.</p><p>{{signature}}</p>',
        category: 'breakup',
      },
    }),
  ]);

  // ── Tags ──
  const tagHot = await prisma.tag.create({ data: { organization_id: orgId, name: 'Hot Lead', color: '#EF4444' } });
  const tagWarm = await prisma.tag.create({ data: { organization_id: orgId, name: 'Warm', color: '#F59E0B' } });
  const tagDecision = await prisma.tag.create({ data: { organization_id: orgId, name: 'Decision Maker', color: '#3B82F6' } });
  const tagSaaS = await prisma.tag.create({ data: { organization_id: orgId, name: 'SaaS', color: '#10B981' } });

  // ── Domains ──
  const domainAcme = await prisma.domain.create({
    data: {
      domain: 'acme-demo.com',
      organization_id: orgId,
      status: 'healthy',
      recovery_phase: 'healthy',
      resilience_score: 85,
      trend_state: 'stable',
      spf_valid: true,
      dkim_valid: true,
      dmarc_policy: 'quarantine',
      mx_records: [{ priority: 1, exchange: 'aspmx.l.google.com' }, { priority: 5, exchange: 'alt1.aspmx.l.google.com' }],
      mx_valid: true,
      blacklist_results: { critical_listed: 0, major_listed: 0, minor_listed: 1, total_checked: 28 },
      blacklist_score: 5,
      last_full_blacklist_check: hoursAgo(3),
      dns_checked_at: hoursAgo(3),
      initial_assessment_score: 92,
      last_sent_at: minutesAgo(20),
      total_sent_lifetime: 1840,
      total_opens: 612,
      total_clicks: 138,
      total_replies: 47,
      total_bounces: 31,
      engagement_rate: 0.43,
      bounce_rate: 1.68,
    },
  });

  const domainBeta = await prisma.domain.create({
    data: {
      domain: 'beta-outreach.io',
      organization_id: orgId,
      status: 'healthy',
      recovery_phase: 'healthy',
      resilience_score: 72,
      trend_state: 'recovering',
      spf_valid: true,
      dkim_valid: true,
      dmarc_policy: 'none',
      mx_records: [{ priority: 1, exchange: 'aspmx.l.google.com' }],
      mx_valid: true,
      blacklist_results: { critical_listed: 0, major_listed: 0, minor_listed: 2, total_checked: 28 },
      blacklist_score: 10,
      last_full_blacklist_check: hoursAgo(5),
      dns_checked_at: hoursAgo(5),
      initial_assessment_score: 78,
      last_sent_at: hoursAgo(1),
      total_sent_lifetime: 920,
      total_opens: 287,
      total_clicks: 54,
      total_replies: 19,
      total_bounces: 22,
      engagement_rate: 0.39,
      bounce_rate: 2.39,
    },
  });

  // ── Domain reputation snapshots (last 7 days) ──
  for (const domain of [domainAcme, domainBeta]) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(daysAgo(d));
      date.setUTCHours(0, 0, 0, 0);
      await prisma.domainReputation.create({
        data: {
          organization_id: orgId,
          domain_id: domain.id,
          source: 'postmaster_tools',
          fetched_at: date,
          date,
          reputation: d < 2 ? 'HIGH' : 'MEDIUM',
          spam_rate: 0.001 + Math.random() * 0.002,
          authentication_dkim_pass_rate: 0.98 + Math.random() * 0.02,
          authentication_spf_pass_rate: 0.97 + Math.random() * 0.03,
          authentication_dmarc_pass_rate: 0.95 + Math.random() * 0.05,
          encryption_outbound_rate: 1.0,
          delivery_errors_jsonb: {},
          raw_payload: { domain: domain.domain, date: date.toISOString().slice(0, 10) },
        },
      });
    }
  }

  // ── Connected accounts + mailboxes (2 per domain) ──
  const accountsAndMailboxes = [
    { email: 'alex@acme-demo.com', name: 'Alex Reed', domain: domainAcme, provider: 'google', dailyLimit: 60 },
    { email: 'jordan@acme-demo.com', name: 'Jordan Lee', domain: domainAcme, provider: 'google', dailyLimit: 50 },
    { email: 'sam@beta-outreach.io', name: 'Sam Patel', domain: domainBeta, provider: 'microsoft', dailyLimit: 40 },
    { email: 'taylor@beta-outreach.io', name: 'Taylor Brooks', domain: domainBeta, provider: 'smtp', dailyLimit: 30 },
  ];

  const mailboxes = [];
  for (const m of accountsAndMailboxes) {
    const account = await prisma.connectedAccount.create({
      data: {
        organization_id: orgId,
        email: m.email,
        display_name: m.name,
        provider: m.provider,
        connection_status: 'active',
        daily_send_limit: m.dailyLimit,
        sends_today: Math.floor(Math.random() * (m.dailyLimit - 10)),
        sends_reset_at: new Date(),
        warmup_complete: true,
        signature_html: '<p>Best,<br/>' + m.name + '<br/>Demo Agency</p>',
        source: m.provider === 'smtp' ? 'manual' : 'oauth',
        smtp_host: m.provider === 'smtp' ? 'smtp.zapmail.io' : null,
        smtp_port: m.provider === 'smtp' ? 587 : null,
        smtp_username: m.provider === 'smtp' ? m.email : null,
      },
    });

    const mailboxId = uuid();
    const mailbox = await prisma.mailbox.create({
      data: {
        id: mailboxId,
        email: m.email,
        domain_id: m.domain.id,
        organization_id: orgId,
        connected_account_id: account.id,
        status: 'healthy',
        recovery_phase: 'healthy',
        resilience_score: 70 + Math.floor(Math.random() * 25),
        trend_state: 'stable',
        smtp_status: true,
        imap_status: true,
        total_sent_count: 200 + Math.floor(Math.random() * 800),
        window_sent_count: 30 + Math.floor(Math.random() * 60),
        window_bounce_count: Math.floor(Math.random() * 3),
        window_start_at: daysAgo(7),
        last_activity_at: minutesAgo(Math.floor(Math.random() * 120)),
        open_count_lifetime: 80 + Math.floor(Math.random() * 200),
        click_count_lifetime: 20 + Math.floor(Math.random() * 60),
        reply_count_lifetime: 5 + Math.floor(Math.random() * 20),
        engagement_rate: 0.35 + Math.random() * 0.2,
        warmup_reputation: 'good',
        warmup_status: 'completed',
        warmup_limit: m.dailyLimit,
        sending_ip_source: m.provider === 'smtp' ? 'smtp_host_dns' : 'oauth_shared',
        sending_ip: m.provider === 'smtp' ? '199.59.243.220' : null,
        ip_blacklist_results: m.provider === 'smtp' ? { critical_listed: 0, major_listed: 0, minor_listed: 1, total_checked: 28 } : null,
        ip_blacklist_score: 0,
      },
    });
    mailboxes.push({ mailbox, account, ...m });

    // MailboxMetrics
    await prisma.mailboxMetrics.create({
      data: {
        mailbox_id: mailboxId,
        window_1h_sent: Math.floor(Math.random() * 8),
        window_1h_bounce: 0,
        window_24h_sent: 30 + Math.floor(Math.random() * 30),
        window_24h_bounce: Math.floor(Math.random() * 2),
        window_7d_sent: 200 + Math.floor(Math.random() * 200),
        window_7d_bounce: Math.floor(Math.random() * 5),
        window_1h_start: hoursAgo(1),
        window_24h_start: hoursAgo(24),
        window_7d_start: daysAgo(7),
        risk_score: Math.random() * 25,
        velocity: 0.5 + Math.random() * 0.4,
      },
    });

    // ESP performance
    for (const esp of ['gmail', 'microsoft', 'yahoo', 'other']) {
      const sends = 50 + Math.floor(Math.random() * 200);
      const bounces = Math.floor(sends * (Math.random() * 0.03));
      await prisma.mailboxEspPerformance.create({
        data: {
          organization_id: orgId,
          mailbox_id: mailboxId,
          esp_bucket: esp,
          send_count_30d: sends,
          bounce_count_30d: bounces,
          reply_count_30d: Math.floor(sends * 0.04),
          bounce_rate_30d: bounces / sends,
        },
      });
    }
  }

  // ── Campaigns ──
  const campaignDefs = [
    { name: 'Q2 SaaS Founders Outbound', status: 'active', daily: 50, days_active: 14, total_leads: 150 },
    { name: 'VP Marketing — Mid-Market', status: 'active', daily: 40, days_active: 9, total_leads: 100 },
    { name: 'Enterprise Champions (paused)', status: 'paused', daily: 30, days_active: 22, total_leads: 80, paused_reason: 'Awaiting new copy review' },
  ];

  const campaigns = [];
  for (const c of campaignDefs) {
    const campaignId = uuid();
    const totalSent = Math.floor(c.total_leads * 0.7 * (c.days_active / 30) * 10) / 10;
    const sent = Math.floor(c.total_leads * 0.85);
    const opens = Math.floor(sent * 0.42);
    const clicks = Math.floor(opens * 0.18);
    const replies = Math.floor(sent * 0.06);
    const bounces = Math.floor(sent * 0.02);

    const campaign = await prisma.campaign.create({
      data: {
        id: campaignId,
        name: c.name,
        channel: 'email',
        status: c.status,
        paused_reason: c.paused_reason || null,
        paused_at: c.status === 'paused' ? hoursAgo(8) : null,
        paused_by: c.status === 'paused' ? 'user' : 'system',
        organization_id: orgId,
        total_leads: c.total_leads,
        total_sent: sent,
        total_bounced: bounces,
        open_count: opens,
        click_count: clicks,
        reply_count: replies,
        unsubscribed_count: Math.floor(sent * 0.005),
        bounce_rate: (bounces / Math.max(sent, 1)) * 100,
        open_rate: opens / Math.max(sent, 1),
        click_rate: clicks / Math.max(sent, 1),
        reply_rate: replies / Math.max(sent, 1),
        analytics_updated_at: minutesAgo(10),
        tags: ['saas', 'outbound'],
        schedule_timezone: 'America/New_York',
        schedule_start_time: '09:00',
        schedule_end_time: '17:00',
        schedule_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        daily_limit: c.daily,
        send_gap_minutes: 3,
        start_date: daysAgo(c.days_active),
        esp_routing: true,
        stop_on_reply: true,
        stop_on_bounce: true,
        track_opens: true,
        track_clicks: true,
        include_unsubscribe: true,
        eu_compliance_mode: false,
        launched_at: daysAgo(c.days_active),
      },
    });
    campaigns.push({ campaign, ...c, sent, opens, clicks, replies, bounces });

    // 3 sequence steps per campaign
    const stepBodies = [
      { subject: 'Quick question, {{first_name}}', body: '<p>Hi {{first_name}},</p><p>Noticed {{company}} is scaling outbound — a few teams in your space have hit deliverability walls around 50k sends/mo.</p><p>Worth a 15-min chat next week?</p>' },
      { subject: 're: Quick question', body: '<p>Hi {{first_name}},</p><p>Following up — does this fit your priorities right now?</p>' },
      { subject: 'Should I close the loop?', body: '<p>Hi {{first_name}},</p><p>Closing the loop. If timing is off, happy to circle back next quarter.</p>' },
    ];
    for (let s = 0; s < stepBodies.length; s++) {
      const step = await prisma.sequenceStep.create({
        data: {
          campaign_id: campaignId,
          step_number: s + 1,
          delay_days: s === 0 ? 0 : 3,
          delay_hours: 0,
          subject: stepBodies[s].subject,
          body_html: stepBodies[s].body,
          condition: s === 0 ? null : 'if_no_reply',
        },
      });
      // 1 variant per step (variant A)
      await prisma.stepVariant.create({
        data: {
          step_id: step.id,
          variant_label: 'A',
          subject: stepBodies[s].subject,
          body_html: stepBodies[s].body,
          weight: 100,
          sends: Math.floor(sent / 3),
          opens: Math.floor(opens / 3),
          clicks: Math.floor(clicks / 3),
          replies: Math.floor(replies / 3),
        },
      });
    }
  }

  // ── Wire campaigns to mailboxes (CampaignAccount + Campaign-Mailbox m2m) ──
  for (const c of campaigns) {
    const campAccs = mailboxes.slice(0, 2 + Math.floor(Math.random() * 2));
    for (const m of campAccs) {
      await prisma.campaignAccount.create({
        data: { campaign_id: c.campaign.id, account_id: m.account.id },
      });
    }
    await prisma.campaign.update({
      where: { id: c.campaign.id },
      data: { mailboxes: { connect: campAccs.map(m => ({ id: m.mailbox.id })) } },
    });
  }

  // ── Leads (~30) ──
  const personas = ['Founder', 'VP Marketing', 'Head of Sales', 'CEO', 'Director Growth', 'CMO'];
  const companies = ['Northwind Labs', 'Initech', 'Hooli', 'Pied Piper', 'Stark Industries', 'Acme Co', 'Wonka Inc', 'Wayne Enterprises', 'Cyberdyne', 'Soylent Corp', 'Globex', 'Massive Dynamic', 'Tyrell Corp', 'Aperture Science', 'Vehement Capital'];
  const firstNames = ['Avery', 'Casey', 'Devon', 'Emery', 'Finley', 'Harper', 'Indigo', 'Jamie', 'Kendall', 'Logan', 'Morgan', 'Nico', 'Quinn', 'River', 'Sage', 'Skyler', 'Reese', 'Parker'];
  const lastNames = ['Bennett', 'Castillo', 'Diaz', 'Elliot', 'Foster', 'Gray', 'Holt', 'Ingram', 'James', 'Kirby', 'Lowe', 'Murphy', 'Novak', 'Owens', 'Park', 'Quinn'];

  const leadCount = 30;
  const leads = [];
  const usedEmails = new Set();
  // Reserved E.164 phone block for documentation/test use (FCC-assigned 555-01XX),
  // safe to embed in seed data — these numbers are not assignable to real subscribers.
  const phoneFor = (i) => `+1 555 0100${String(i).padStart(2, '0').slice(-2)}`;
  for (let i = 0; i < leadCount; i++) {
    const fn = pick(firstNames);
    const ln = pick(lastNames);
    const co = pick(companies);
    let email;
    do {
      email = `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@${co.toLowerCase().replace(/\W/g, '')}.com`;
    } while (usedEmails.has(email));
    usedEmails.add(email);

    const validationScore = 60 + Math.floor(Math.random() * 40);
    const validationStatus = validationScore >= 80 ? 'valid' : validationScore >= 60 ? 'risky' : 'invalid';
    const healthClass = validationScore >= 80 ? 'green' : validationScore >= 65 ? 'yellow' : 'red';
    const status = healthClass === 'red' ? 'blocked' : (Math.random() > 0.4 ? 'active' : 'held');
    const sent = status === 'active' ? Math.floor(Math.random() * 4) : 0;
    const opens = Math.floor(sent * Math.random() * 1.5);
    const replies = sent > 0 && Math.random() < 0.1 ? 1 : 0;

    const lead = await prisma.lead.create({
      data: {
        email,
        first_name: fn,
        last_name: ln,
        full_name: `${fn} ${ln}`,
        company: co,
        title: pick(personas),
        persona: pick(['founder', 'marketing', 'sales']),
        lead_score: 30 + Math.floor(Math.random() * 70),
        source: pick(['clay', 'csv', 'manual']),
        phone: phoneFor(i),
        linkedin_url: `https://www.linkedin.com/in/${fn.toLowerCase()}-${ln.toLowerCase()}-${i}/`,
        organization_id: orgId,
        status,
        health_state: healthClass === 'red' ? 'unhealthy' : 'healthy',
        health_classification: healthClass,
        health_score_calc: validationScore,
        health_checked_at: hoursAgo(Math.floor(Math.random() * 48)),
        validation_status: validationStatus,
        validation_score: validationScore,
        validation_source: 'internal',
        validated_at: daysAgo(Math.floor(Math.random() * 14)),
        is_catch_all: Math.random() < 0.1,
        is_disposable: false,
        emails_sent: sent,
        emails_opened: opens,
        emails_clicked: Math.floor(opens * 0.3),
        emails_replied: replies,
        last_activity_at: sent > 0 ? hoursAgo(Math.floor(Math.random() * 96)) : null,
        bounced: false,
      },
    });
    leads.push(lead);
  }
  console.log(`Created ${leads.length} leads`);

  // ── LeadTags (sample) ──
  for (let i = 0; i < 8; i++) {
    const lead = pick(leads);
    const tag = pick([tagHot, tagWarm, tagDecision, tagSaaS]);
    try {
      await prisma.leadTag.create({ data: { lead_id: lead.id, tag_id: tag.id } });
    } catch { /* ignore dupes */ }
  }

  // ── CampaignLeads + send/open/click/reply events ──
  for (const c of campaigns) {
    const campLeads = leads.slice(0, Math.min(c.total_leads, leads.length));
    for (const lead of campLeads) {
      const cl = await prisma.campaignLead.create({
        data: {
          campaign_id: c.campaign.id,
          email: lead.email,
          first_name: lead.first_name,
          last_name: lead.last_name,
          company: lead.company,
          title: lead.title,
          status: c.status === 'paused' ? 'paused' : (lead.status === 'blocked' ? 'paused' : 'active'),
          current_step: c.status === 'paused' ? 1 : Math.floor(Math.random() * 3),
          esp_bucket: pick(['gmail', 'microsoft', 'yahoo', 'other']),
          validation_status: lead.validation_status,
          validation_score: lead.validation_score,
          last_sent_at: lead.emails_sent > 0 ? hoursAgo(Math.floor(Math.random() * 96)) : null,
          opened_count: lead.emails_opened,
          clicked_count: lead.emails_clicked,
          replied_at: lead.emails_replied > 0 ? hoursAgo(Math.floor(Math.random() * 48)) : null,
          assigned_account_id: pick(mailboxes).account.id,
        },
      });

      // SendEvents (one per send)
      const mb = pick(mailboxes);
      for (let s = 0; s < lead.emails_sent; s++) {
        await prisma.sendEvent.create({
          data: {
            organization_id: orgId,
            mailbox_id: mb.mailbox.id,
            campaign_id: c.campaign.id,
            recipient_email: lead.email,
            recipient_esp: cl.esp_bucket,
            sent_at: hoursAgo(Math.floor(Math.random() * 168)),
          },
        });
      }
      // Open events
      for (let o = 0; o < lead.emails_opened; o++) {
        await prisma.emailOpenEvent.create({
          data: {
            organization_id: orgId,
            campaign_id: c.campaign.id,
            campaign_lead_id: cl.id,
            lead_id: lead.id,
            recipient_email: lead.email,
            ms_since_send: 60_000 + Math.floor(Math.random() * 86_400_000),
            opened_at: hoursAgo(Math.floor(Math.random() * 96)),
          },
        });
      }
      // Click events
      for (let cc = 0; cc < lead.emails_clicked; cc++) {
        await prisma.emailClickEvent.create({
          data: {
            organization_id: orgId,
            campaign_id: c.campaign.id,
            campaign_lead_id: cl.id,
            lead_id: lead.id,
            recipient_email: lead.email,
            url: 'https://demo-agency.com/case-study',
            ms_since_send: 5 * 60_000 + Math.floor(Math.random() * 3_600_000),
            clicked_at: hoursAgo(Math.floor(Math.random() * 96)),
          },
        });
      }
      // Reply events
      if (lead.emails_replied > 0) {
        await prisma.replyEvent.create({
          data: {
            organization_id: orgId,
            mailbox_id: mb.mailbox.id,
            campaign_id: c.campaign.id,
            recipient_email: lead.email,
            recipient_esp: cl.esp_bucket,
            replied_at: hoursAgo(Math.floor(Math.random() * 48)),
          },
        });
      }
    }
  }

  // ── Daily analytics (last 14 days per active campaign) ──
  for (const c of campaigns) {
    if (c.status !== 'active') continue;
    for (let d = 0; d < 14; d++) {
      const date = new Date(daysAgo(d));
      date.setUTCHours(0, 0, 0, 0);
      const dailySent = Math.floor(c.daily * (0.7 + Math.random() * 0.3));
      await prisma.campaignDailyAnalytics.create({
        data: {
          campaign_id: c.campaign.id,
          organization_id: orgId,
          date,
          sent_count: dailySent,
          open_count: Math.floor(dailySent * (0.35 + Math.random() * 0.15)),
          click_count: Math.floor(dailySent * (0.05 + Math.random() * 0.08)),
          reply_count: Math.floor(dailySent * (0.04 + Math.random() * 0.04)),
          bounce_count: Math.floor(dailySent * Math.random() * 0.02),
          unsubscribe_count: Math.floor(dailySent * Math.random() * 0.005),
        },
      });
    }
  }

  // ── Validation batches ──
  const batch1 = await prisma.validationBatch.create({
    data: {
      organization_id: orgId,
      source: 'csv',
      status: 'completed',
      file_name: 'q2_prospects.csv',
      total_count: 250,
      valid_count: 198,
      risky_count: 27,
      invalid_count: 18,
      duplicate_count: 7,
      routed_count: 198,
      created_at: daysAgo(5),
      completed_at: daysAgo(5),
    },
  });
  for (let i = 0; i < 12; i++) {
    const status = i < 8 ? 'valid' : i < 10 ? 'risky' : 'invalid';
    await prisma.validationBatchLead.create({
      data: {
        batch_id: batch1.id,
        email: `validation${i}@${pick(companies).toLowerCase().replace(/\W/g, '')}.com`,
        first_name: pick(firstNames),
        last_name: pick(lastNames),
        company: pick(companies),
        validation_status: status,
        validation_score: status === 'valid' ? 90 : status === 'risky' ? 70 : 30,
        rejection_reason: status === 'invalid' ? pick(['no_mx', 'syntax', 'disposable']) : null,
        is_catch_all: status === 'risky',
        esp_bucket: pick(['gmail', 'microsoft', 'yahoo', 'other']),
      },
    });
  }
  await prisma.validationBatch.create({
    data: {
      organization_id: orgId,
      source: 'clay',
      status: 'processing',
      file_name: null,
      total_count: 80,
      valid_count: 35,
      risky_count: 4,
      invalid_count: 2,
      duplicate_count: 1,
      routed_count: 0,
      created_at: minutesAgo(20),
    },
  });

  // ── AuditLogs ──
  const auditEntries = [
    { entity: 'mailbox', trigger: 'bounce_threshold', action: 'pause', details: 'Mailbox alex@acme-demo.com paused — 1h bounce rate 4.2% > 3.0%' },
    { entity: 'mailbox', trigger: 'recovery_window_complete', action: 'unpause', details: 'Mailbox alex@acme-demo.com resumed after 100 clean sends' },
    { entity: 'campaign', trigger: 'user_action', action: 'launch', details: 'Campaign "Q2 SaaS Founders Outbound" launched by demo@superkabe.com' },
    { entity: 'campaign', trigger: 'user_action', action: 'pause', details: 'Campaign "Enterprise Champions" paused for copy review' },
    { entity: 'lead', trigger: 'validation', action: 'block', details: '3 leads blocked: validation_status=invalid' },
    { entity: 'domain', trigger: 'reputation_check', action: 'no_op', details: 'Daily Postmaster Tools fetch completed for acme-demo.com — reputation: HIGH' },
    { entity: 'mailbox', trigger: 'ip_blacklist_check', action: 'no_op', details: '4 mailboxes scanned, 1 minor listing on taylor@beta-outreach.io' },
    { entity: 'campaign', trigger: 'analytics_worker', action: 'no_op', details: 'Daily metrics rolled up across 2 active campaigns' },
  ];
  for (let i = 0; i < auditEntries.length; i++) {
    const a = auditEntries[i];
    await prisma.auditLog.create({
      data: {
        organization_id: orgId,
        entity: a.entity,
        trigger: a.trigger,
        action: a.action,
        details: a.details,
        user_id: i % 3 === 0 ? user.id : null,
        timestamp: hoursAgo(i * 6 + Math.random() * 4),
      },
    });
  }

  // ── State transitions (visible in some entity history views) ──
  for (const m of mailboxes.slice(0, 2)) {
    await prisma.stateTransition.create({
      data: {
        entity_type: 'mailbox',
        entity_id: m.mailbox.id,
        from_state: 'paused',
        to_state: 'healthy',
        reason: '100 clean sends since pause',
        triggered_by: 'system',
        organization_id: orgId,
        created_at: daysAgo(3),
      },
    });
  }

  // ── Unibox: EmailThreads + EmailMessages ──
  // Seed realistic conversations across the connected mailboxes so the
  // Unibox has data to render. Pick leads who have replies, anchor each
  // thread to a campaign, mix unread/starred/replied states, and tag
  // some inbound messages with quality_class for the reply-quality UI.
  const repliedLeads = leads.filter(l => l.emails_replied > 0).slice(0, 6);
  // If random seeding produced too few replied leads, top up from any
  // active leads so the Unibox isn't empty.
  while (repliedLeads.length < 6 && repliedLeads.length < leads.length) {
    const candidate = leads[repliedLeads.length + 5];
    if (candidate && !repliedLeads.includes(candidate)) repliedLeads.push(candidate);
  }

  const conversationTemplates = [
    {
      // Positive reply
      outboundSubject: 'Quick question, {{first_name}}',
      outboundBody: '<p>Hi {{first_name}},</p><p>Saw {{company}} on the inbound side and wanted to reach out — we help SaaS teams scale outbound without burning their domain reputation.</p><p>Worth a 15-min chat next week?</p><p>Best,<br/>Demo User</p>',
      inboundSubject: 're: Quick question, {{first_name}}',
      inboundBody: '<p>Hi Demo,</p><p>Yes — we&rsquo;re ramping outbound and bounce rates are starting to creep up. Could we do Tuesday at 11am ET?</p><p>{{first_name}}</p>',
      qualityClass: 'positive',
      qualityConfidence: 'high',
      qualitySignals: ['agreed_meeting', 'shared_pain'],
      followUpBody: '<p>Tuesday 11am ET works — sending the calendar invite now.</p>',
      starred: true,
      isRead: false,
    },
    {
      // Qualified — needs more info
      outboundSubject: 'Worth a chat?',
      outboundBody: '<p>Hi {{first_name}},</p><p>Curious how {{company}} is handling deliverability these days. We saw a 3x reply lift for an agency customer last quarter — happy to share the playbook.</p>',
      inboundSubject: 're: Worth a chat?',
      inboundBody: '<p>Could you send a one-pager first? Want to see if it&rsquo;s relevant before scheduling.</p>',
      qualityClass: 'qualified',
      qualityConfidence: 'medium',
      qualitySignals: ['requested_info'],
      followUpBody: null,
      starred: false,
      isRead: false,
    },
    {
      // Soft no — not now
      outboundSubject: 'Bumping this up',
      outboundBody: '<p>Hi {{first_name}}, did you have a chance to look?</p>',
      inboundSubject: 're: Bumping this up',
      inboundBody: '<p>Not the right time — we&rsquo;re focused on a product launch this quarter. Try me in Q3?</p>',
      qualityClass: 'soft_no',
      qualityConfidence: 'high',
      qualitySignals: ['timing_objection'],
      followUpBody: null,
      starred: false,
      isRead: true,
    },
    {
      // Objection
      outboundSubject: 'Quick question, {{first_name}}',
      outboundBody: '<p>Hi {{first_name}},</p><p>Cold-email reputation is a quiet killer. We&rsquo;d love to share what worked for {{company}}-sized teams.</p>',
      inboundSubject: 're: Quick question, {{first_name}}',
      inboundBody: '<p>We tried something similar last year and it didn&rsquo;t move the needle. What&rsquo;s different here?</p>',
      qualityClass: 'objection',
      qualityConfidence: 'medium',
      qualitySignals: ['prior_attempt'],
      followUpBody: '<p>Fair pushback — the difference is we control the send pipeline, so when bounces spike we pause before damage. Mind if I send a 2-min Loom?</p>',
      starred: true,
      isRead: false,
    },
    {
      // Referral
      outboundSubject: 'Worth a chat?',
      outboundBody: '<p>Hi {{first_name}}, exploring whether deliverability is on your radar at {{company}}.</p>',
      inboundSubject: 're: Worth a chat?',
      inboundBody: '<p>Not me — but our growth lead, Priya, owns this. I&rsquo;ll loop her in.</p>',
      qualityClass: 'referral',
      qualityConfidence: 'high',
      qualitySignals: ['internal_handoff'],
      followUpBody: '<p>Appreciate the intro — happy to wait for Priya to ping me directly.</p>',
      starred: false,
      isRead: true,
    },
    {
      // Hard no
      outboundSubject: 'Bumping this up',
      outboundBody: '<p>Hi {{first_name}}, circling back on this — any thoughts?</p>',
      inboundSubject: 're: Bumping this up',
      inboundBody: '<p>Please remove me from this list. Not interested.</p>',
      qualityClass: 'hard_no',
      qualityConfidence: 'high',
      qualitySignals: ['removal_request'],
      followUpBody: null,
      starred: false,
      isRead: true,
    },
  ];

  const fillTokens = (s, lead) => s
    .replace(/\{\{first_name\}\}/g, lead.first_name || 'there')
    .replace(/\{\{company\}\}/g, lead.company || 'your team');

  for (let i = 0; i < repliedLeads.length; i++) {
    const lead = repliedLeads[i];
    const tmpl = conversationTemplates[i % conversationTemplates.length];
    const account = mailboxes[i % mailboxes.length].account;
    const campaign = pick(campaigns).campaign;

    const outboundAt = hoursAgo(48 + i * 6);
    const inboundAt = hoursAgo(40 + i * 6);
    const followUpAt = tmpl.followUpBody ? hoursAgo(24 + i * 6) : null;

    const messages = [
      {
        direction: 'outbound',
        from_email: account.email,
        from_name: account.display_name,
        to_email: lead.email,
        to_name: lead.full_name,
        subject: fillTokens(tmpl.outboundSubject, lead),
        body_html: fillTokens(tmpl.outboundBody, lead),
        sent_at: outboundAt,
      },
      {
        direction: 'inbound',
        from_email: lead.email,
        from_name: lead.full_name,
        to_email: account.email,
        to_name: account.display_name,
        subject: fillTokens(tmpl.inboundSubject, lead),
        body_html: fillTokens(tmpl.inboundBody, lead),
        sent_at: inboundAt,
        quality_class: tmpl.qualityClass,
        quality_confidence: tmpl.qualityConfidence,
        quality_signals: tmpl.qualitySignals,
        quality_classified_at: inboundAt,
      },
    ];
    if (followUpAt) {
      messages.push({
        direction: 'outbound',
        from_email: account.email,
        from_name: account.display_name,
        to_email: lead.email,
        to_name: lead.full_name,
        subject: fillTokens(tmpl.inboundSubject, lead), // reply-style subject
        body_html: fillTokens(tmpl.followUpBody, lead),
        sent_at: followUpAt,
      });
    }

    const lastMessage = messages[messages.length - 1];
    const inboundSnippet = messages.find(m => m.direction === 'inbound');
    const snippetSource = (inboundSnippet || lastMessage).body_html;
    const snippet = snippetSource.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

    const thread = await prisma.emailThread.create({
      data: {
        organization_id: orgId,
        account_id: account.id,
        contact_email: lead.email,
        contact_name: lead.full_name,
        subject: fillTokens(tmpl.outboundSubject, lead),
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        lead_id: lead.id,
        status: 'replied',
        is_read: tmpl.isRead,
        is_starred: tmpl.starred,
        last_message_at: lastMessage.sent_at,
        message_count: messages.length,
        snippet,
        created_at: outboundAt,
      },
    });

    for (const m of messages) {
      await prisma.emailMessage.create({
        data: {
          thread_id: thread.id,
          direction: m.direction,
          from_email: m.from_email,
          from_name: m.from_name,
          to_email: m.to_email,
          to_name: m.to_name,
          subject: m.subject,
          body_html: m.body_html,
          body_text: m.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          is_read: m.direction === 'outbound' ? true : tmpl.isRead,
          sent_at: m.sent_at,
          quality_class: m.quality_class,
          quality_confidence: m.quality_confidence,
          quality_signals: m.quality_signals || [],
          quality_classified_at: m.quality_classified_at,
        },
      });
    }
  }

  // ── Cold-call snapshot ──
  const eligibleCampaignLeads = await prisma.campaignLead.findMany({
    where: { campaign_id: { in: campaigns.filter(c => c.status === 'active').map(c => c.campaign.id) } },
    select: { id: true },
    take: 25,
  });
  await prisma.coldCallDailySnapshot.create({
    data: {
      organization_id: orgId,
      snapshot_date: daysAgo(0),
      prospect_ids: eligibleCampaignLeads.map(l => l.id),
      prospect_count: eligibleCampaignLeads.length,
      status: 'success',
    },
  });

  // ── Infrastructure report (onboarding snapshot) ──
  await prisma.infrastructureReport.create({
    data: {
      organization_id: orgId,
      report_type: 'onboarding',
      assessment_version: '1.0',
      overall_score: 88,
      summary: {
        domains: 2,
        mailboxes: 4,
        campaigns: 3,
        totals: {
          spf_passing: 2,
          dkim_passing: 2,
          dmarc_passing: 1,
          dmarc_neutral: 1,
          blacklists_minor: 1,
        },
      },
      findings: [
        { severity: 'info', entity: 'domain', entity_id: domainBeta.id, message: 'beta-outreach.io DMARC policy is "none" — consider strengthening to "quarantine".', remediation: 'Update DMARC TXT record to p=quarantine.' },
        { severity: 'low', entity: 'mailbox', entity_id: mailboxes[3].mailbox.id, message: 'Sending IP appears on 1 minor blacklist (UCEPROTECT-3) — typically auto-clears in 7 days.', remediation: 'No action needed; reassess in 7 days.' },
      ],
      recommendations: [
        { priority: 'medium', action: 'tighten_dmarc', details: 'Move beta-outreach.io DMARC from p=none to p=quarantine after monitoring reports for 14 days.' },
        { priority: 'low', action: 'monitor_blacklist', details: 'Re-check UCEPROTECT-3 listing for taylor@beta-outreach.io in 7 days.' },
      ],
      created_at: hoursAgo(6),
    },
  });

  // ── Notifications ──
  await prisma.notification.createMany({
    data: [
      { organization_id: orgId, type: 'WARNING', title: 'Campaign paused', message: 'Campaign "Enterprise Champions" was paused for copy review.', is_read: false, created_at: hoursAgo(8) },
      { organization_id: orgId, type: 'SUCCESS', title: 'Mailbox recovered', message: 'Mailbox alex@acme-demo.com is back to healthy.', is_read: true, created_at: daysAgo(1) },
      { organization_id: orgId, type: 'INFO', title: 'New replies', message: '3 new replies in the last 24h.', is_read: false, user_id: user.id, created_at: hoursAgo(2) },
    ],
  });

  // ── Consent records (ToS + Privacy acceptance) ──
  await prisma.consent.createMany({
    data: [
      {
        organization_id: orgId,
        user_id: user.id,
        user_email_snapshot: DEMO_EMAIL,
        user_name_snapshot: 'Demo User',
        consent_type: 'tos',
        document_version: '2026-04-28',
        channel: 'signup',
        ip_address: '127.0.0.1',
        user_agent: 'staging-seed',
        accepted_at: daysAgo(40),
      },
      {
        organization_id: orgId,
        user_id: user.id,
        user_email_snapshot: DEMO_EMAIL,
        user_name_snapshot: 'Demo User',
        consent_type: 'privacy',
        document_version: '2026-04-28',
        channel: 'signup',
        ip_address: '127.0.0.1',
        user_agent: 'staging-seed',
        accepted_at: daysAgo(40),
      },
    ],
  });

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Demo seed complete.');
  console.log('  Login:    ' + DEMO_EMAIL);
  console.log('  Password: ' + DEMO_PASSWORD);
  console.log('  Org:      ' + org.name + ' (' + org.id + ')');
  console.log('═══════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error('SEED FAILED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
