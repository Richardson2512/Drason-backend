/**
 * Demo Account Seed - populates demo@superkabe.com / Demo Agency with
 * realistic-looking placeholder content so screenshots show populated pages.
 *
 * STAGING DATABASE ONLY. Will not run if DATABASE_URL points to a host that
 * looks production-y (heuristic check). Idempotent: each run wipes the demo
 * org's seedable rows and reseeds, so screenshots stay consistent.
 *
 * Usage:
 *   npx tsx scripts/seed_demo_content.ts
 *   npx tsx scripts/seed_demo_content.ts --force      # skip prod-host check
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const DEMO_USER_EMAIL = 'demo@superkabe.com';
const FORCE = process.argv.includes('--force');

const prisma = new PrismaClient();

// ============================================================================
// FAKE DATA POOLS - generic-but-believable B2B SaaS targets
// ============================================================================

const FIRST_NAMES = [
    'James', 'Sarah', 'Michael', 'Emily', 'David', 'Jessica', 'Robert', 'Ashley',
    'William', 'Amanda', 'Daniel', 'Jennifer', 'Matthew', 'Lisa', 'Christopher',
    'Nicole', 'Andrew', 'Rachel', 'Joshua', 'Megan', 'Ryan', 'Stephanie', 'Brandon',
    'Lauren', 'Justin', 'Brittany', 'Tyler', 'Samantha', 'Kevin', 'Heather',
    'Marcus', 'Priya', 'Hiroshi', 'Anika', 'Diego', 'Yuki', 'Olivia', 'Ethan',
    'Sophia', 'Liam', 'Mia', 'Noah', 'Ava', 'Oliver', 'Isabella', 'Lucas',
    'Charlotte', 'Mason', 'Amelia', 'Logan', 'Harper', 'Elijah', 'Evelyn',
];

const LAST_NAMES = [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
    'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
    'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
    'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
    'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen',
    'Hill', 'Flores', 'Green', 'Adams', 'Nakamura', 'Patel', 'Kim', 'Chen',
    'Rivera', 'Cooper', 'Bell', 'Reed', 'Collins',
];

const COMPANIES = [
    { name: 'Northwind Analytics',     domain: 'northwind-analytics.com',  industry: 'Analytics SaaS' },
    { name: 'Helix Robotics',          domain: 'helixrobotics.io',          industry: 'Industrial Tech' },
    { name: 'Lumen Health',            domain: 'lumenhealth.com',           industry: 'Healthtech' },
    { name: 'Nimbus Cloud',            domain: 'nimbuscloud.dev',           industry: 'DevTools' },
    { name: 'Kestrel Ventures',        domain: 'kestrelvc.com',             industry: 'Venture Capital' },
    { name: 'Atlas Logistics',         domain: 'atlas-logistics.co',        industry: 'Supply Chain' },
    { name: 'Quartz HR',               domain: 'quartzhr.com',              industry: 'HR Tech' },
    { name: 'Bramble Studios',         domain: 'bramblestudios.io',         industry: 'Design Agency' },
    { name: 'Vector Insurance',        domain: 'vectorinsure.com',          industry: 'Insurtech' },
    { name: 'Fern + Oak Real Estate',  domain: 'fernandoak.com',            industry: 'PropTech' },
    { name: 'Ironclad Security',       domain: 'ironcladsec.io',            industry: 'Cybersecurity' },
    { name: 'Beacon Education',        domain: 'beaconedu.org',             industry: 'EdTech' },
    { name: 'Ridgeway Manufacturing',  domain: 'ridgeway-mfg.com',          industry: 'Manufacturing' },
    { name: 'Solstice Renewables',     domain: 'solsticerenew.com',         industry: 'Climate Tech' },
    { name: 'Mariner Maritime',        domain: 'marinermaritime.com',       industry: 'Logistics' },
    { name: 'Pinecrest Capital',       domain: 'pinecrestcap.com',          industry: 'Private Equity' },
    { name: 'Cobblestone Coffee',      domain: 'cobblestone.coffee',        industry: 'CPG' },
    { name: 'Driftwood Hospitality',   domain: 'driftwoodhotels.com',       industry: 'Hospitality' },
    { name: 'Granite Legal',           domain: 'granite-legal.com',         industry: 'Legal Tech' },
    { name: 'Voyage Travel Group',     domain: 'voyagetravel.io',           industry: 'Travel' },
    { name: 'Linden Pharmaceuticals',  domain: 'lindenpharma.com',          industry: 'Biotech' },
    { name: 'Saffron Marketing',       domain: 'saffronmarketing.co',       industry: 'Agency' },
    { name: 'Hawthorne Foods',         domain: 'hawthornefoods.com',        industry: 'CPG' },
    { name: 'Cypress Construction',    domain: 'cypressbuild.com',          industry: 'Construction' },
    { name: 'Tidepool Media',          domain: 'tidepool.media',            industry: 'Media' },
    { name: 'Polaris Energy',          domain: 'polaris-energy.com',        industry: 'Energy' },
    { name: 'Maple Leaf Robotics',     domain: 'mapleleafrobotics.ca',      industry: 'Robotics' },
    { name: 'Olive Branch Nonprofit',  domain: 'olivebranch.org',           industry: 'Nonprofit' },
    { name: 'Riverstone Banking',      domain: 'riverstonebank.com',        industry: 'Banking' },
    { name: 'Acacia Wellness',         domain: 'acaciawellness.io',         industry: 'Wellness' },
];

const TITLES = [
    'CEO', 'COO', 'CTO', 'CFO', 'CMO', 'VP of Sales', 'VP of Marketing',
    'VP of Engineering', 'VP of Operations', 'VP of Product', 'VP of Customer Success',
    'Head of Growth', 'Head of People', 'Head of Revenue', 'Head of Demand Gen',
    'Director of Sales', 'Director of Marketing', 'Director of Engineering',
    'Director of Operations', 'Director of Product', 'Director of Finance',
    'Senior Sales Manager', 'Senior Product Manager', 'Senior Marketing Manager',
    'Founder', 'Co-Founder', 'Managing Partner', 'General Manager',
    'Account Executive', 'Business Development Manager', 'Sales Operations Lead',
];

const TEMPLATE_BANK = [
    {
        name: 'Pain-First Cold Open',
        category: 'introduction',
        subject: 'Quick question about {{company}}\'s outbound',
        body_html: '<p>Hi {{first_name}},</p><p>Noticed {{company}} is hiring SDRs aggressively - usually that means current outbound isn\'t pulling its weight. Curious: what\'s your bounce rate looking like across your sequencer?</p><p>Most ops teams I talk to are quietly burning through domain reputation without realizing it. Worth a 15-min look?</p><p>- James</p>',
    },
    {
        name: 'Followup #1 - Soft Bump',
        category: 'follow-up',
        subject: 'Re: Quick question about {{company}}\'s outbound',
        body_html: '<p>Hi {{first_name}},</p><p>Bumping this up. Even if it\'s not the right time, would love to hear what platform you\'re running. Quick gut-check: do you know your last-30-day complaint rate?</p><p>- James</p>',
    },
    {
        name: 'Followup #2 - Case Study',
        category: 'follow-up',
        subject: 'How {{company}} could cut bounces by 60%',
        body_html: '<p>Hi {{first_name}},</p><p>Last customer: B2B SaaS, ~50K sends/month. Bounce rate was 8.2% before they switched. After 30 days: 1.1%. The unlock was a real recovery pipeline instead of a daily-cap "deliverability shield."</p><p>Worth a 15-min walkthrough?</p>',
    },
    {
        name: 'Breakup - Final Touch',
        category: 'breakup',
        subject: 'Closing the loop, {{first_name}}',
        body_html: '<p>{{first_name}},</p><p>Going to stop following up - clearly not the right time. If outbound deliverability ever creeps up the priority list, my calendar is here: superkabe.com/demo</p><p>- James</p>',
    },
    {
        name: 'Referral Ask',
        category: 'referral',
        subject: 'Wrong person at {{company}}?',
        body_html: '<p>Hi {{first_name}},</p><p>I might be off-base reaching out to you about cold-email infrastructure - apologies if so. Mind pointing me at whoever owns sender reputation / outbound tooling at {{company}}?</p><p>Appreciate it, James</p>',
    },
    {
        name: 'Meeting Confirm',
        category: 'meeting',
        subject: 'Confirmed: {{first_name}} × Superkabe - Tuesday 2pm',
        body_html: '<p>Hi {{first_name}},</p><p>Confirmed for Tuesday 2pm ET. I\'ll send a calendar hold separately. Will walk through the recovery pipeline, dual-enrollment detection, and the live deliverability dashboard.</p><p>If anything comes up, just hit reply.</p><p>- James</p>',
    },
];

const CAMPAIGN_NAMES = [
    'Q2 - SaaS Founders, North America',
    'VP Sales - Series A to C',
    'Marketing Directors - DACH region',
    'Outbound Tooling - Renewals',
    'Reactivation - Cold Q4 leads',
];

// ============================================================================
// HELPERS
// ============================================================================

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN<T>(arr: T[], n: number): T[] {
    const copy = [...arr];
    const out: T[] = [];
    for (let i = 0; i < n && copy.length > 0; i++) {
        out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
}
function rand(min: number, max: number): number { return Math.floor(Math.random() * (max - min + 1)) + min; }
function chance(pct: number): boolean { return Math.random() < pct; }

/** Random timestamp in the last `days` days, biased toward business hours UTC. */
function randomRecentDate(days: number): Date {
    const ms = days * 24 * 60 * 60 * 1000;
    const d = new Date(Date.now() - Math.random() * ms);
    // Snap to a business-ish hour (8am–6pm UTC) so analytics charts look natural
    d.setUTCHours(rand(8, 18), rand(0, 59), rand(0, 59), 0);
    return d;
}

function emailFor(first: string, last: string, domain: string): string {
    const r = Math.random();
    if (r < 0.6) return `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`;
    if (r < 0.85) return `${first.toLowerCase()[0]}${last.toLowerCase()}@${domain}`;
    return `${first.toLowerCase()}@${domain}`;
}

function espFor(domain: string): string {
    if (domain.endsWith('@gmail.com') || domain === 'gmail.com') return 'gmail';
    if (domain.includes('outlook') || domain.includes('hotmail')) return 'microsoft';
    if (domain.includes('yahoo')) return 'yahoo';
    return 'other';
}

// ============================================================================
// SAFETY GUARD
// ============================================================================

function assertStagingDb() {
    const url = process.env.DATABASE_URL || '';
    const looksProd = /railway|prod|production|amazonaws|supabase\.co/i.test(url);
    if (looksProd && !FORCE) {
        console.error('❌ DATABASE_URL looks production-y. Refusing to run.');
        console.error('   If this is wrong, re-run with --force.');
        console.error('   URL host:', url.replace(/:[^:@/]+@/, ':***@'));
        process.exit(1);
    }
    if (looksProd && FORCE) {
        console.warn('⚠️  --force passed; proceeding against production-looking host.');
    }
}

// ============================================================================
// WIPE
// ============================================================================

async function wipeDemoContent(orgId: string): Promise<void> {
    console.log('Wiping existing demo content…');

    // FK-cascade-aware order. Cascade deletes handle most of this from
    // Organization deletion, but we keep the org and only clear content rows.
    await prisma.emailMessage.deleteMany({
        where: { thread: { organization_id: orgId } },
    });
    await prisma.emailThread.deleteMany({ where: { organization_id: orgId } });

    await prisma.emailClickEvent.deleteMany({ where: { organization_id: orgId } });
    await prisma.emailOpenEvent.deleteMany({ where: { organization_id: orgId } });
    await prisma.replyEvent.deleteMany({ where: { organization_id: orgId } });
    await prisma.bounceEvent.deleteMany({ where: { organization_id: orgId } });
    await prisma.sendEvent.deleteMany({ where: { organization_id: orgId } });

    await prisma.campaignLead.deleteMany({
        where: { campaign: { organization_id: orgId } },
    });
    await prisma.sequenceStep.deleteMany({
        where: { campaign: { organization_id: orgId } },
    });
    await prisma.campaignAccount.deleteMany({
        where: { campaign: { organization_id: orgId } },
    });
    await prisma.campaign.deleteMany({ where: { organization_id: orgId } });

    await prisma.domainReputation.deleteMany({ where: { organization_id: orgId } });
    await prisma.mailbox.deleteMany({ where: { organization_id: orgId } });
    await prisma.connectedAccount.deleteMany({ where: { organization_id: orgId } });
    await prisma.domain.deleteMany({ where: { organization_id: orgId } });

    await prisma.lead.deleteMany({ where: { organization_id: orgId } });

    await prisma.emailTemplate.deleteMany({ where: { organization_id: orgId } });
    await prisma.emailSignature.deleteMany({ where: { organization_id: orgId } });

    console.log('  Wipe complete.\n');
}

// ============================================================================
// SEED - DOMAINS + MAILBOXES + ACCOUNTS
// ============================================================================

interface SeededMailbox {
    accountId: string;
    mailboxId: string;
    email: string;
    provider: string;
}

async function seedInfra(orgId: string): Promise<{ domains: { id: string; name: string }[]; mailboxes: SeededMailbox[] }> {
    console.log('Seeding domains + mailboxes…');

    // Two sending domains: one healthy, one in warm_recovery (so the Healing /
    // Domains pages have something interesting to show).
    const primaryDomain = await prisma.domain.create({
        data: {
            domain: 'outreach.demoagency.io',
            organization_id: orgId,
            status: 'healthy',
            recovery_phase: 'healthy',
            spf_valid: true,
            dkim_valid: true,
            dmarc_policy: 'quarantine',
            mx_records: [{ priority: 10, exchange: 'aspmx.l.google.com' }],
            mx_valid: true,
            blacklist_score: 0,
            last_full_blacklist_check: new Date(Date.now() - 6 * 60 * 60 * 1000),
            dns_checked_at: new Date(Date.now() - 12 * 60 * 60 * 1000),
            initial_assessment_score: 92,
        },
    });

    const recoveringDomain = await prisma.domain.create({
        data: {
            domain: 'mail.demoagency-news.com',
            organization_id: orgId,
            status: 'warning',
            recovery_phase: 'warm_recovery',
            healing_origin: 'recovery',
            phase_entered_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
            clean_sends_since_phase: 31,
            resilience_score: 68,
            relapse_count: 1,
            trend_state: 'recovering',
            spf_valid: true,
            dkim_valid: true,
            dmarc_policy: 'none',
            mx_records: [{ priority: 10, exchange: 'aspmx.l.google.com' }],
            mx_valid: true,
            blacklist_score: 12,
            last_full_blacklist_check: new Date(Date.now() - 6 * 60 * 60 * 1000),
            dns_checked_at: new Date(Date.now() - 12 * 60 * 60 * 1000),
            warning_count: 2,
            aggregated_bounce_rate_trend: 0.024,
        },
    });

    // Postmaster reputation snapshots - one per domain per recent day.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
        const date = new Date(today.getTime() - dayOffset * 24 * 60 * 60 * 1000);
        await prisma.domainReputation.create({
            data: {
                organization_id: orgId,
                domain_id: primaryDomain.id,
                source: 'postmaster_tools',
                fetched_at: new Date(),
                date,
                reputation: 'HIGH',
                spam_rate: 0.0006 + Math.random() * 0.0004,
                authentication_dkim_pass_rate: 0.99,
                authentication_spf_pass_rate: 0.98,
                authentication_dmarc_pass_rate: 0.98,
                encryption_outbound_rate: 1.0,
                raw_payload: {},
            },
        });
        await prisma.domainReputation.create({
            data: {
                organization_id: orgId,
                domain_id: recoveringDomain.id,
                source: 'postmaster_tools',
                fetched_at: new Date(),
                date,
                reputation: dayOffset > 7 ? 'LOW' : 'MEDIUM',
                spam_rate: dayOffset > 7
                    ? 0.0035 + Math.random() * 0.0015
                    : 0.0014 + Math.random() * 0.0008,
                authentication_dkim_pass_rate: 0.96,
                authentication_spf_pass_rate: 0.94,
                authentication_dmarc_pass_rate: 0.91,
                encryption_outbound_rate: 0.99,
                raw_payload: {},
            },
        });
    }

    // 6 mailboxes: 4 healthy on primary domain, 1 healthy on recovering domain,
    // 1 in warm_recovery on recovering domain.
    const mailboxConfigs = [
        { email: 'james@outreach.demoagency.io',     name: 'James Mercer',      provider: 'google',    phase: 'healthy', limit: 200 },
        { email: 'priya@outreach.demoagency.io',     name: 'Priya Nakamura',    provider: 'google',    phase: 'healthy', limit: 200 },
        { email: 'marcus@outreach.demoagency.io',    name: 'Marcus Lee',        provider: 'microsoft', phase: 'healthy', limit: 180 },
        { email: 'olivia@outreach.demoagency.io',    name: 'Olivia Bennett',    provider: 'microsoft', phase: 'healthy', limit: 180 },
        { email: 'kenji@mail.demoagency-news.com',   name: 'Kenji Watanabe',    provider: 'smtp',      phase: 'healthy', limit: 150 },
        { email: 'amelia@mail.demoagency-news.com',  name: 'Amelia Foster',     provider: 'smtp',      phase: 'warm_recovery', limit: 50 },
    ];

    const mailboxes: SeededMailbox[] = [];
    for (const cfg of mailboxConfigs) {
        const id = crypto.randomUUID();
        const account = await prisma.connectedAccount.create({
            data: {
                id,
                organization_id: orgId,
                email: cfg.email,
                display_name: cfg.name,
                provider: cfg.provider,
                connection_status: 'active',
                daily_send_limit: cfg.limit,
                sends_today: cfg.phase === 'warm_recovery' ? rand(8, 35) : rand(40, 140),
                warmup_complete: cfg.phase === 'healthy',
                tracking_domain: cfg.email.split('@')[1],
                tracking_domain_verified: true,
                tracking_domain_verified_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                ...(cfg.provider === 'smtp' ? {
                    smtp_host: 'smtp.demoagency.io',
                    smtp_port: 587,
                    smtp_username: cfg.email,
                    imap_host: 'imap.demoagency.io',
                    imap_port: 993,
                } : {}),
            },
        });

        // Shadow Mailbox row (Protection layer)
        const isRecovering = cfg.phase === 'warm_recovery';
        await prisma.mailbox.create({
            data: {
                id,  // 1:1 with ConnectedAccount.id
                email: cfg.email,
                organization_id: orgId,
                domain_id: cfg.email.includes('mail.demoagency-news') ? recoveringDomain.id : primaryDomain.id,
                status: isRecovering ? 'warning' : 'healthy',
                recovery_phase: cfg.phase,
                healing_origin: isRecovering ? 'recovery' : null,
                phase_entered_at: isRecovering ? new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) : null,
                clean_sends_since_phase: isRecovering ? 27 : 0,
                resilience_score: isRecovering ? 62 : 78,
                relapse_count: isRecovering ? 1 : 0,
                trend_state: isRecovering ? 'recovering' : 'stable',
                hard_bounce_count: isRecovering ? 4 : rand(0, 2),
                total_sent_count: isRecovering ? 142 : rand(800, 3500),
                window_sent_count: isRecovering ? 27 : rand(40, 95),
                window_bounce_count: isRecovering ? 0 : 0,
                last_activity_at: new Date(Date.now() - rand(5, 120) * 60 * 1000),
                phase_clean_sends: isRecovering ? 27 : 0,
                phase_bounces: 0,
                smtp_status: true,
                imap_status: true,
            },
        });

        mailboxes.push({ accountId: account.id, mailboxId: id, email: cfg.email, provider: cfg.provider });
    }

    console.log(`  Created 2 domains, 6 mailboxes, ${14 * 2} reputation snapshots.\n`);
    return {
        domains: [
            { id: primaryDomain.id, name: primaryDomain.domain },
            { id: recoveringDomain.id, name: recoveringDomain.domain },
        ],
        mailboxes,
    };
}

// ============================================================================
// SEED - TEMPLATES + SIGNATURES + SETTINGS
// ============================================================================

async function seedTemplatesAndSettings(orgId: string): Promise<void> {
    console.log('Seeding templates, signature, settings…');

    for (const t of TEMPLATE_BANK) {
        await prisma.emailTemplate.create({
            data: {
                organization_id: orgId,
                name: t.name,
                subject: t.subject,
                body_html: t.body_html,
                category: t.category,
            },
        });
    }

    await prisma.emailSignature.create({
        data: {
            organization_id: orgId,
            name: 'Default - James Mercer',
            html_content: '<p style="font-size:14px;color:#333;margin:0;"><strong>James Mercer</strong><br/>Founder, Demo Agency<br/><a href="https://demoagency.io">demoagency.io</a> · <a href="https://calendly.com/demoagency">Book 15 min</a></p>',
            is_default: true,
        },
    });

    await prisma.sequencerSettings.upsert({
        where: { organization_id: orgId },
        update: {},
        create: {
            organization_id: orgId,
            default_daily_limit: 150,
            default_timezone: 'America/New_York',
            default_start_time: '08:30',
            default_end_time: '17:30',
            default_active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
            delay_between_emails: 2,
            global_daily_max: 1000,
            tracking_domain: 'click.demoagency.io',
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

    console.log(`  Created ${TEMPLATE_BANK.length} templates, 1 signature, sequencer settings.\n`);
}

// ============================================================================
// SEED - LEADS
// ============================================================================

interface SeededLead {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    full_name: string;
    company: string;
    title: string;
}

async function seedLeads(orgId: string, count: number): Promise<SeededLead[]> {
    console.log(`Seeding ${count} leads…`);
    const seen = new Set<string>();
    const leads: SeededLead[] = [];

    while (leads.length < count) {
        const company = pick(COMPANIES);
        const first = pick(FIRST_NAMES);
        const last = pick(LAST_NAMES);
        const email = emailFor(first, last, company.domain);
        if (seen.has(email)) continue;
        seen.add(email);

        const fullName = `${first} ${last}`;
        const title = pick(TITLES);

        // Realistic distribution: 75% green, 18% yellow, 7% red (validation-blocked
        // so they stay visible in Contacts but don't enrol).
        const r = Math.random();
        const classification = r < 0.75 ? 'green' : r < 0.93 ? 'yellow' : 'red';
        const validation_status = classification === 'red' ? 'invalid'
            : classification === 'yellow' ? 'risky' : 'valid';
        const validation_score = classification === 'red' ? rand(5, 35)
            : classification === 'yellow' ? rand(50, 78)
            : rand(82, 99);

        const status = classification === 'red' ? 'blocked'
            : chance(0.3) ? 'active'
            : 'held';

        const lead = await prisma.lead.create({
            data: {
                organization_id: orgId,
                email,
                first_name: first,
                last_name: last,
                full_name: fullName,
                company: company.name,
                website: `https://www.${company.domain}`,
                title,
                persona: title.includes('VP') || title.includes('CEO') || title.includes('Director') || title.includes('Head') ? 'decision_maker' : 'influencer',
                source: pick(['csv', 'csv', 'csv', 'manual', 'api']),
                status,
                health_state: classification === 'red' ? 'unhealthy' : 'healthy',
                health_classification: classification,
                health_score_calc: classification === 'red' ? rand(20, 49)
                    : classification === 'yellow' ? rand(50, 79)
                    : rand(80, 100),
                validation_status,
                validation_score,
                validated_at: new Date(Date.now() - rand(1, 30) * 24 * 60 * 60 * 1000),
                lead_score: rand(40, 95),
                last_activity_at: new Date(Date.now() - rand(1, 14) * 24 * 60 * 60 * 1000),
                created_at: new Date(Date.now() - rand(2, 45) * 24 * 60 * 60 * 1000),
            },
        });

        leads.push({
            id: lead.id,
            email,
            first_name: first,
            last_name: last,
            full_name: fullName,
            company: company.name,
            title,
        });
    }

    console.log(`  Created ${leads.length} leads.\n`);
    return leads;
}

// ============================================================================
// SEED - CAMPAIGNS + STEPS + LEADS
// ============================================================================

interface SeededCampaign {
    id: string;
    name: string;
    status: string;
    leadIds: string[];
    leadEmails: string[];
}

async function seedCampaigns(
    orgId: string,
    leads: SeededLead[],
    mailboxes: SeededMailbox[]
): Promise<SeededCampaign[]> {
    console.log('Seeding campaigns + steps + enrolments…');

    // Only enroll leads that aren't blocked
    const enrollableLeads = leads.filter(l => l.email);

    const campaigns: SeededCampaign[] = [];
    const statuses = ['active', 'active', 'active', 'paused', 'completed'];

    for (let i = 0; i < CAMPAIGN_NAMES.length; i++) {
        const campaignId = crypto.randomUUID();
        const name = CAMPAIGN_NAMES[i];
        const status = statuses[i];
        const stepCount = rand(3, 5);

        const campaign = await prisma.campaign.create({
            data: {
                id: campaignId,
                name,
                organization_id: orgId,
                status,
                paused_reason: status === 'paused' ? 'Manual pause - reviewing reply-rate data' : null,
                paused_at: status === 'paused' ? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) : null,
                tags: pickN(['Q2', 'outbound', 'enterprise', 'mid-market', 'reactivation'], rand(1, 3)),
                schedule_timezone: 'America/New_York',
                schedule_start_time: '08:30',
                schedule_end_time: '17:30',
                schedule_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
                daily_limit: rand(50, 150),
                send_gap_minutes: rand(2, 6),
                start_date: new Date(Date.now() - rand(10, 35) * 24 * 60 * 60 * 1000),
                track_opens: true,
                track_clicks: true,
                include_unsubscribe: true,
                stop_on_reply: true,
                stop_on_bounce: false,
                tracking_domain: 'click.demoagency.io',
            },
        });

        // Sequence steps
        for (let s = 1; s <= stepCount; s++) {
            const t = TEMPLATE_BANK[Math.min(s - 1, TEMPLATE_BANK.length - 1)];
            await prisma.sequenceStep.create({
                data: {
                    campaign_id: campaignId,
                    step_number: s,
                    delay_days: s === 1 ? 0 : rand(2, 5),
                    delay_hours: 0,
                    subject: t.subject,
                    body_html: t.body_html,
                    condition: s > 1 ? 'if_no_reply' : null,
                },
            });
        }

        // Enrol 30-60 leads per campaign (some leads will be in multiple campaigns
        // - that's the dual-enrolment scenario)
        const enrolCount = rand(30, 60);
        const enrolees = pickN(enrollableLeads, enrolCount);

        const campaignLeadIds: string[] = [];
        const campaignLeadEmails: string[] = [];
        for (const lead of enrolees) {
            let leadStatus = 'active';
            let opened = 0;
            let clicked = 0;
            let repliedAt: Date | null = null;
            let bouncedAt: Date | null = null;
            let unsubscribedAt: Date | null = null;
            let currentStep = rand(0, stepCount);

            const r = Math.random();
            if (status === 'completed') {
                leadStatus = chance(0.85) ? 'completed' : chance(0.5) ? 'replied' : 'bounced';
                currentStep = stepCount;
                opened = rand(1, 6);
                clicked = chance(0.4) ? rand(1, 2) : 0;
                if (leadStatus === 'replied') repliedAt = randomRecentDate(20);
                if (leadStatus === 'bounced') bouncedAt = randomRecentDate(20);
            } else if (r < 0.05) {
                leadStatus = 'replied'; repliedAt = randomRecentDate(7);
                opened = rand(1, 4); clicked = chance(0.3) ? 1 : 0;
            } else if (r < 0.08) {
                leadStatus = 'bounced'; bouncedAt = randomRecentDate(20);
            } else if (r < 0.10) {
                leadStatus = 'unsubscribed'; unsubscribedAt = randomRecentDate(10);
            } else if (r < 0.20) {
                leadStatus = 'paused';
            } else {
                opened = rand(0, 3);
                clicked = chance(0.2) ? 1 : 0;
            }

            const sticky = pick(mailboxes);
            const cl = await prisma.campaignLead.create({
                data: {
                    campaign_id: campaignId,
                    email: lead.email,
                    first_name: lead.first_name,
                    last_name: lead.last_name,
                    company: lead.company,
                    title: lead.title,
                    status: leadStatus,
                    current_step: currentStep,
                    validation_status: 'valid',
                    validation_score: rand(82, 99),
                    last_sent_at: currentStep > 0 ? randomRecentDate(15) : null,
                    next_send_at: leadStatus === 'active' && currentStep < stepCount
                        ? new Date(Date.now() + rand(1, 72) * 60 * 60 * 1000)
                        : null,
                    opened_count: opened,
                    clicked_count: clicked,
                    replied_at: repliedAt,
                    bounced_at: bouncedAt,
                    unsubscribed_at: unsubscribedAt,
                    assigned_account_id: sticky.accountId,
                    created_at: new Date(Date.now() - rand(5, 30) * 24 * 60 * 60 * 1000),
                },
            });
            campaignLeadIds.push(cl.id);
            campaignLeadEmails.push(lead.email);
        }

        // Update Campaign aggregate counts based on what we just inserted.
        // Done in a follow-up groupBy so the numbers always match what the UI
        // would compute.
        const sentSoFar = await prisma.campaignLead.count({
            where: { campaign_id: campaignId, current_step: { gt: 0 } },
        });
        await prisma.campaign.update({
            where: { id: campaignId },
            data: {
                total_leads: enrolees.length,
                total_sent: sentSoFar * rand(1, 3), // approximate - real numbers come from SendEvents below
            },
        });

        campaigns.push({ id: campaignId, name, status, leadIds: campaignLeadIds, leadEmails: campaignLeadEmails });
        console.log(`  Campaign "${name}" (${status}): ${stepCount} steps, ${enrolees.length} leads`);
    }

    console.log('');
    return campaigns;
}

// ============================================================================
// SEED - EVENTS (sends / opens / clicks / replies / bounces)
// ============================================================================

async function seedEvents(
    orgId: string,
    campaigns: SeededCampaign[],
    mailboxes: SeededMailbox[]
): Promise<{ sends: number; opens: number; clicks: number; replies: number; bounces: number }> {
    console.log('Seeding send/open/click/reply/bounce events…');

    let sends = 0, opens = 0, clicks = 0, replies = 0, bounces = 0;

    for (const c of campaigns) {
        // Sends per campaign - enough to make analytics charts look full
        const sendCount = c.status === 'completed' ? rand(120, 280) : rand(60, 200);
        for (let i = 0; i < sendCount; i++) {
            const idx = Math.floor(Math.random() * c.leadEmails.length);
            const recipientEmail = c.leadEmails[idx];
            const mailbox = pick(mailboxes);
            const sentAt = randomRecentDate(c.status === 'completed' ? 25 : 14);

            await prisma.sendEvent.create({
                data: {
                    organization_id: orgId,
                    mailbox_id: mailbox.mailboxId,
                    campaign_id: c.id,
                    recipient_email: recipientEmail,
                    recipient_esp: pick(['gmail', 'gmail', 'gmail', 'microsoft', 'microsoft', 'other']),
                    sent_at: sentAt,
                },
            });
            sends++;

            // ~50% open rate
            if (chance(0.5)) {
                const openMs = sentAt.getTime() + rand(60_000, 24 * 60 * 60 * 1000);
                await prisma.emailOpenEvent.create({
                    data: {
                        organization_id: orgId,
                        campaign_id: c.id,
                        campaign_lead_id: c.leadIds[idx],
                        recipient_email: recipientEmail,
                        opened_at: new Date(openMs),
                    },
                });
                opens++;

                // ~10% of opens result in a click
                if (chance(0.1)) {
                    await prisma.emailClickEvent.create({
                        data: {
                            organization_id: orgId,
                            campaign_id: c.id,
                            campaign_lead_id: c.leadIds[idx],
                            recipient_email: recipientEmail,
                            url: 'https://www.demoagency.io/demo',
                            clicked_at: new Date(openMs + rand(5_000, 600_000)),
                        },
                    });
                    clicks++;
                }
            }

            // ~3% reply rate
            if (chance(0.03)) {
                await prisma.replyEvent.create({
                    data: {
                        organization_id: orgId,
                        mailbox_id: mailbox.mailboxId,
                        campaign_id: c.id,
                        recipient_email: recipientEmail,
                        recipient_esp: 'gmail',
                        replied_at: new Date(sentAt.getTime() + rand(3_600_000, 5 * 24 * 60 * 60 * 1000)),
                    },
                });
                replies++;
            }

            // ~1.5% bounce rate
            if (chance(0.015)) {
                await prisma.bounceEvent.create({
                    data: {
                        organization_id: orgId,
                        mailbox_id: mailbox.mailboxId,
                        campaign_id: c.id,
                        bounce_type: 'hard_bounce',
                        bounce_reason: pick(['User unknown', 'Mailbox does not exist', 'Domain not found']),
                        email_address: recipientEmail,
                        sent_at: sentAt,
                        bounced_at: new Date(sentAt.getTime() + rand(60_000, 600_000)),
                        smtp_code: '550',
                        bounce_source: 'smtp',
                    },
                });
                bounces++;
            }
        }
    }

    console.log(`  Sends: ${sends} · Opens: ${opens} · Clicks: ${clicks} · Replies: ${replies} · Bounces: ${bounces}\n`);
    return { sends, opens, clicks, replies, bounces };
}

// ============================================================================
// SEED - UNIBOX THREADS
// ============================================================================

async function seedUniboxThreads(
    orgId: string,
    campaigns: SeededCampaign[],
    mailboxes: SeededMailbox[]
): Promise<void> {
    console.log('Seeding unibox threads…');

    const sampleReplies = [
        { class: 'qualified', text: 'Interesting timing - we just had a domain pause incident last week. Can you send over a quick deck?' },
        { class: 'positive', text: 'Yes please, send the demo link. Tuesday 2pm ET works.' },
        { class: 'objection', text: 'We just signed with Smartlead 3 months ago. Maybe revisit next year?' },
        { class: 'soft_no', text: 'Not a priority for us this quarter, but feel free to follow up Q4.' },
        { class: 'referral', text: 'You\'ll want to talk to our Head of Demand Gen - adding Sasha to this thread.' },
        { class: 'qualified', text: 'What\'s the pricing for 5 mailboxes?' },
        { class: 'angry', text: 'Take me off your list. This is the third email this month.' },
        { class: 'positive', text: 'Booked - see calendar invite. Looking forward to it.' },
    ];

    let count = 0;
    for (const reply of sampleReplies) {
        const c = pick(campaigns.filter(c => c.status !== 'completed'));
        if (!c || c.leadEmails.length === 0) continue;
        const idx = Math.floor(Math.random() * c.leadEmails.length);
        const email = c.leadEmails[idx];
        const mailbox = pick(mailboxes);

        const thread = await prisma.emailThread.create({
            data: {
                organization_id: orgId,
                account_id: mailbox.accountId,
                contact_email: email,
                contact_name: email.split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '),
                subject: 'Re: Quick question about ' + email.split('@')[1].split('.')[0] + '\'s outbound',
                campaign_id: c.id,
                campaign_name: c.name,
                lead_id: c.leadIds[idx],
                status: 'replied',
                is_read: chance(0.4),
                is_starred: chance(0.25),
                last_message_at: randomRecentDate(7),
                message_count: 2,
                snippet: reply.text.slice(0, 120),
            },
        });

        // Outbound message (our send)
        await prisma.emailMessage.create({
            data: {
                thread_id: thread.id,
                direction: 'outbound',
                from_email: mailbox.email,
                from_name: 'James Mercer',
                to_email: email,
                subject: thread.subject.replace(/^Re: /, ''),
                body_html: '<p>Hi,</p><p>Quick question about your outbound setup. Got 15 minutes this week?</p>',
                sent_at: new Date(thread.last_message_at.getTime() - 2 * 24 * 60 * 60 * 1000),
                is_read: true,
            },
        });

        // Inbound reply
        await prisma.emailMessage.create({
            data: {
                thread_id: thread.id,
                direction: 'inbound',
                from_email: email,
                to_email: mailbox.email,
                subject: thread.subject,
                body_html: `<p>${reply.text}</p>`,
                body_text: reply.text,
                sent_at: thread.last_message_at,
                is_read: thread.is_read,
                quality_class: reply.class,
                quality_confidence: 'high',
                quality_signals: ['rule:keyword'],
                quality_classified_at: thread.last_message_at,
            },
        });
        count++;
    }

    console.log(`  Created ${count} unibox threads.\n`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Superkabe - Demo Account Content Seeder');
    console.log('═══════════════════════════════════════════════════════════════\n');

    assertStagingDb();

    const user = await prisma.user.findUnique({
        where: { email: DEMO_USER_EMAIL },
        select: { id: true, email: true, organization_id: true },
    });
    if (!user) {
        console.error(`❌ Demo user ${DEMO_USER_EMAIL} not found.`);
        process.exit(1);
    }
    const org = await prisma.organization.findUnique({
        where: { id: user.organization_id },
        select: { id: true, name: true, slug: true },
    });
    console.log(`Demo org: ${org?.name} (${org?.slug}) - ${org?.id}\n`);
    const orgId = user.organization_id;

    await wipeDemoContent(orgId);

    await seedTemplatesAndSettings(orgId);
    const { mailboxes } = await seedInfra(orgId);
    const leads = await seedLeads(orgId, 180);
    const campaigns = await seedCampaigns(orgId, leads, mailboxes);
    await seedEvents(orgId, campaigns, mailboxes);
    await seedUniboxThreads(orgId, campaigns, mailboxes);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Done. Login as demo@superkabe.com / Demo2026!');
    console.log('═══════════════════════════════════════════════════════════════');
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
