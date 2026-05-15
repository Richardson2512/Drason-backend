/**
 * Demo Account - Sequence Diagram Showcase Campaigns
 *
 * Adds 4 deliberately-designed campaigns to the demo org so the new
 * /campaigns/[id]/sequence page has variety to render. Does NOT touch
 * existing demo content - purely additive.
 *
 * Campaigns added:
 *   1. "Diagram - Simple 3-step Linear" (no branches, stop on reply)
 *   2. "Diagram - Branching with Conditions" (if_no_reply chain + if_replied re-engage)
 *   3. "Diagram - Engagement-Conditional" (mixed if_opened, if_clicked, if_not_opened)
 *   4. "Diagram - A/B Variant Heavy" (3 variants on step 1, 2 on step 2)
 *
 * STAGING DATABASE ONLY. Refuses to run against production-y URLs.
 *
 * Usage:
 *   npx tsx scripts/seed_demo_diagram_campaigns.ts
 *   npx tsx scripts/seed_demo_diagram_campaigns.ts --reset    # delete + reseed
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const DEMO_USER_EMAIL = 'demo@superkabe.com';
const RESET = process.argv.includes('--reset');

const prisma = new PrismaClient();

function assertStagingDb() {
    const url = process.env.DATABASE_URL || '';
    const looksProd = /railway|prod|production|amazonaws|supabase\.co/i.test(url);
    if (looksProd) {
        console.error('❌ DATABASE_URL looks production-y. Refusing.');
        process.exit(1);
    }
}

function rand(min: number, max: number): number { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// ============================================================================
// CAMPAIGN DEFINITIONS
// ============================================================================

interface VariantSpec {
    label: string;
    subject: string;
    body_html: string;
    weight: number;
}

interface StepSpec {
    delay_days: number;
    delay_hours: number;
    subject: string;
    body_html: string;
    condition?: string | null;          // e.g. 'if_no_reply'
    branch_to_step_number?: number | null;
    variants?: VariantSpec[];           // when present, replaces the single subject/body
}

interface CampaignSpec {
    slug: string;
    name: string;
    status: 'active' | 'paused' | 'completed';
    stop_on_reply: boolean;
    stop_on_bounce: boolean;
    leadCount: number;
    importSources: Array<{ source: string; label?: string; count: number }>;
    steps: StepSpec[];
}

const CAMPAIGNS: CampaignSpec[] = [
    // ─────────────────────────────────────────────────────────────────────
    // 1. SIMPLE LINEAR - no conditions, classic 3-touch
    // ─────────────────────────────────────────────────────────────────────
    {
        slug: 'diagram-simple-linear',
        name: 'Diagram - Simple 3-step Linear',
        status: 'active',
        stop_on_reply: true,
        stop_on_bounce: true,
        leadCount: 42,
        importSources: [
            { source: 'csv', label: 'q2-saas-founders.csv', count: 28 },
            { source: 'apollo', label: 'Apollo - VP Sales SaaS', count: 14 },
        ],
        steps: [
            {
                delay_days: 0, delay_hours: 0,
                subject: 'Quick question about {{company}}\'s outbound',
                body_html: '<p>Hi {{first_name}},</p><p>Most B2B founders running cold email don\'t know their bounce rate across mailboxes until something paused. Worth 15 min to walk through what we\'re seeing in the {{custom.industry}} space?</p><p>- James</p>',
            },
            {
                delay_days: 3, delay_hours: 0,
                subject: 'Re: Quick question about {{company}}\'s outbound',
                body_html: '<p>{{first_name}},</p><p>Bumping this up. Even if it\'s not the right time, would love to hear what platform you\'re running today.</p><p>- James</p>',
            },
            {
                delay_days: 5, delay_hours: 0,
                subject: 'Closing the loop, {{first_name}}',
                body_html: '<p>{{first_name}},</p><p>Going to stop following up - clearly not the right time. If outbound deliverability ever creeps up the priority list, my calendar is here: {{custom.calendar_link}}</p><p>- James</p>',
            },
        ],
    },

    // ─────────────────────────────────────────────────────────────────────
    // 2. BRANCHING WITH CONDITIONS - if_no_reply chain + if_replied re-engage
    // ─────────────────────────────────────────────────────────────────────
    {
        slug: 'diagram-branching-conditions',
        name: 'Diagram - Branching with Conditions',
        status: 'active',
        stop_on_reply: false,
        stop_on_bounce: true,
        leadCount: 64,
        importSources: [
            { source: 'clay', label: 'Clay - Series A CTOs (cleaned)', count: 38 },
            { source: 'salesforce', label: 'Salesforce - Q2 inbound MQLs', count: 18 },
            { source: 'manual', count: 8 },
        ],
        steps: [
            {
                delay_days: 0, delay_hours: 0,
                subject: 'Bounce rate at {{company}}',
                body_html: '<p>Hi {{first_name}},</p><p>Most CTOs don\'t track outbound bounce rate. By the time it shows up in the platform, the domain\'s already cooked. Curious what {{company}} is using today.</p><p>- Priya</p>',
            },
            {
                delay_days: 2, delay_hours: 0,
                subject: 'Re: Bounce rate at {{company}}',
                body_html: '<p>{{first_name}}, bumping this up. One-line reply: what platform are you on?</p>',
                condition: 'if_no_reply',
            },
            {
                delay_days: 3, delay_hours: 0,
                subject: 'Specific data for {{company}}',
                body_html: '<p>{{first_name}},</p><p>Quick data point: B2B SaaS at {{company}}\'s scale typically bleeds 2-3% bounce rate to soft signals nobody is monitoring. We catch those before they pause a mailbox.</p><p>15-min walkthrough?</p>',
                condition: 'if_no_reply',
            },
            {
                delay_days: 4, delay_hours: 0,
                subject: 'Closing the loop',
                body_html: '<p>{{first_name}},</p><p>Stepping back from this. If outbound deliverability ever moves up your list, our calendar is open.</p><p>- Priya</p>',
                condition: 'if_no_reply',
            },
            {
                delay_days: 7, delay_hours: 0,
                subject: 'Saw your reply earlier - picking back up',
                body_html: '<p>{{first_name}},</p><p>Coming back to this. You mentioned interest earlier - want to set up a 20-min walkthrough this week or next?</p><p>- Priya</p>',
                condition: 'if_replied',
            },
        ],
    },

    // ─────────────────────────────────────────────────────────────────────
    // 3. ENGAGEMENT-CONDITIONAL - mixed if_opened, if_clicked, if_not_opened
    // ─────────────────────────────────────────────────────────────────────
    {
        slug: 'diagram-engagement-conditional',
        name: 'Diagram - Engagement-Conditional',
        status: 'active',
        stop_on_reply: true,
        stop_on_bounce: true,
        leadCount: 50,
        importSources: [
            { source: 'hubspot', label: 'HubSpot - webinar attendees Q2', count: 35 },
            { source: 'csv', label: 'targeted-icp.csv', count: 15 },
        ],
        steps: [
            {
                delay_days: 0, delay_hours: 0,
                subject: 'New report: deliverability benchmarks 2026',
                body_html: '<p>Hi {{first_name}},</p><p>We just published the 2026 deliverability benchmark report - covers 50K B2B senders, full breakdown of inbox placement rates by industry. Free download here: {{custom.report_link}}</p><p>- Marcus</p>',
            },
            {
                delay_days: 2, delay_hours: 0,
                subject: 'Saw you opened the report - quick follow-up',
                body_html: '<p>{{first_name}},</p><p>Saw you opened the benchmarks report. The most-asked question we get after people read it: "what should I actually do about my bounce rate?". Happy to walk through that for {{company}}\'s specific setup. 15 min this week?</p>',
                condition: 'if_opened',
            },
            {
                delay_days: 3, delay_hours: 0,
                subject: 'Saw you clicked through - book a demo?',
                body_html: '<p>{{first_name}},</p><p>You clicked through to our deliverability dashboard demo from the report. Want to book 20 min to see it with your real numbers?</p><p>- Marcus</p>',
                condition: 'if_clicked',
            },
            {
                delay_days: 7, delay_hours: 0,
                subject: 'Different angle for {{company}}',
                body_html: '<p>{{first_name}},</p><p>Sent you our benchmark report a week ago - looks like it didn\'t land. Different angle: what\'s {{company}}\'s biggest cold email pain point right now? Even one line is useful for me.</p>',
                condition: 'if_not_opened',
            },
        ],
    },

    // ─────────────────────────────────────────────────────────────────────
    // 4. A/B VARIANT HEAVY - multiple variants per step
    // ─────────────────────────────────────────────────────────────────────
    {
        slug: 'diagram-ab-variants',
        name: 'Diagram - A/B Variant Heavy',
        status: 'active',
        stop_on_reply: true,
        stop_on_bounce: false,
        leadCount: 75,
        importSources: [
            { source: 'apollo', label: 'Apollo - Marketing Directors NA', count: 50 },
            { source: 'zoominfo', label: 'ZoomInfo - Series B+ marketing leaders', count: 25 },
        ],
        steps: [
            {
                delay_days: 0, delay_hours: 0,
                subject: '',  // ignored - variants take over
                body_html: '',
                variants: [
                    {
                        label: 'A',
                        subject: 'Quick {{company}} question',
                        body_html: '<p>Hi {{first_name}},</p><p>What does your team use for cold email today?</p><p>- Olivia</p>',
                        weight: 33,
                    },
                    {
                        label: 'B',
                        subject: 'Bounce rate at {{company}}',
                        body_html: '<p>Hi {{first_name}},</p><p>Most marketing teams don\'t measure outbound bounce rate. Worth a quick check?</p><p>- Olivia</p>',
                        weight: 33,
                    },
                    {
                        label: 'C',
                        subject: '{{first_name}} - saw your post on demand gen',
                        body_html: '<p>Hi {{first_name}},</p><p>Read your post on demand gen attribution - strong take. Curious how {{company}} handles cold email reputation alongside the rest of the channel mix.</p><p>- Olivia</p>',
                        weight: 34,
                    },
                ],
            },
            {
                delay_days: 3, delay_hours: 0,
                subject: '',
                body_html: '',
                variants: [
                    {
                        label: 'A',
                        subject: 'Re: Quick {{company}} question',
                        body_html: '<p>{{first_name}}, bumping this. One-line reply: what platform?</p>',
                        weight: 50,
                    },
                    {
                        label: 'B',
                        subject: '15 min for {{company}}?',
                        body_html: '<p>{{first_name}},</p><p>Tuesday 2pm or Thursday 10am ET? 15 min walkthrough using your numbers.</p>',
                        weight: 50,
                    },
                ],
            },
            {
                delay_days: 5, delay_hours: 0,
                subject: 'Final touch, {{first_name}}',
                body_html: '<p>{{first_name}},</p><p>Last note from me on this. If outbound deliverability ever moves up your list, calendar is open.</p><p>- Olivia</p>',
            },
        ],
    },
];

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    assertStagingDb();
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Demo - Sequence Diagram Showcase Campaigns');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const user = await prisma.user.findUnique({
        where: { email: DEMO_USER_EMAIL },
        select: { organization_id: true },
    });
    if (!user) {
        console.error(`❌ Demo user ${DEMO_USER_EMAIL} not found.`);
        process.exit(1);
    }
    const orgId = user.organization_id;
    console.log(`Demo org: ${orgId}\n`);

    // ─── Reset (only the campaigns we own here, by slug prefix) ──────
    if (RESET) {
        console.log('Resetting prior diagram-showcase campaigns…');
        const oldCampaigns = await prisma.campaign.findMany({
            where: { organization_id: orgId, name: { startsWith: 'Diagram - ' } },
            select: { id: true },
        });
        const ids = oldCampaigns.map((c) => c.id);
        if (ids.length > 0) {
            await prisma.sendEvent.deleteMany({ where: { campaign_id: { in: ids } } });
            await prisma.campaignLead.deleteMany({ where: { campaign_id: { in: ids } } });
            await prisma.campaignLeadImport.deleteMany({ where: { campaign_id: { in: ids } } });
            await prisma.stepVariant.deleteMany({ where: { step: { campaign_id: { in: ids } } } });
            await prisma.sequenceStep.deleteMany({ where: { campaign_id: { in: ids } } });
            await prisma.campaignAccount.deleteMany({ where: { campaign_id: { in: ids } } });
            await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
            console.log(`  Removed ${ids.length} campaigns.\n`);
        } else {
            console.log('  Nothing to remove.\n');
        }
    }

    // ─── Reuse existing demo leads + connected accounts ──────────────
    const existingLeads = await prisma.lead.findMany({
        where: { organization_id: orgId, status: { in: ['active', 'held'] } },
        select: {
            id: true, email: true, first_name: true, last_name: true,
            company: true, title: true, validation_status: true, validation_score: true,
        },
        take: 250,
    });
    if (existingLeads.length === 0) {
        console.error('❌ No demo leads found. Run seed_demo_content.ts first.');
        process.exit(1);
    }
    console.log(`Reusing ${existingLeads.length} existing demo leads.`);

    const accounts = await prisma.connectedAccount.findMany({
        where: { organization_id: orgId },
        select: { id: true, email: true, provider: true },
    });
    console.log(`Reusing ${accounts.length} existing demo mailboxes.\n`);

    // ─── Create each campaign ────────────────────────────────────────
    for (const spec of CAMPAIGNS) {
        // Skip if a non-reset run finds the same slug already
        const existing = await prisma.campaign.findFirst({
            where: { organization_id: orgId, name: spec.name },
            select: { id: true },
        });
        if (existing) {
            console.log(`↻ "${spec.name}" already exists - skipping (use --reset to recreate)`);
            continue;
        }

        const campaignId = crypto.randomUUID();
        await prisma.campaign.create({
            data: {
                id: campaignId,
                name: spec.name,
                organization_id: orgId,
                status: spec.status,
                stop_on_reply: spec.stop_on_reply,
                stop_on_bounce: spec.stop_on_bounce,
                tags: ['Diagram demo'],
                schedule_timezone: 'America/New_York',
                schedule_start_time: '08:30',
                schedule_end_time: '17:30',
                schedule_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
                daily_limit: 80,
                send_gap_minutes: 3,
                start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                track_opens: true,
                track_clicks: true,
                include_unsubscribe: true,
                tracking_domain: 'click.demoagency.io',
                total_leads: spec.leadCount,
            },
        });

        // ─── Steps + variants ────────────────────────────────────────
        for (let i = 0; i < spec.steps.length; i++) {
            const stepSpec = spec.steps[i];
            const step = await prisma.sequenceStep.create({
                data: {
                    campaign_id: campaignId,
                    step_number: i + 1,
                    delay_days: stepSpec.delay_days,
                    delay_hours: stepSpec.delay_hours,
                    subject: stepSpec.subject,
                    body_html: stepSpec.body_html,
                    condition: stepSpec.condition || null,
                    branch_to_step_number: stepSpec.branch_to_step_number || null,
                },
            });

            if (stepSpec.variants && stepSpec.variants.length > 0) {
                for (const v of stepSpec.variants) {
                    await prisma.stepVariant.create({
                        data: {
                            step_id: step.id,
                            variant_label: v.label,
                            subject: v.subject,
                            body_html: v.body_html,
                            weight: v.weight,
                            sends: rand(20, 80),
                            opens: rand(10, 40),
                            replies: rand(0, 4),
                        },
                    });
                }
            }
        }

        // ─── Connect campaign to all healthy mailboxes (round-robin) ─
        for (const acct of accounts.slice(0, 4)) {
            await prisma.campaignAccount.create({
                data: {
                    campaign_id: campaignId,
                    account_id: acct.id,
                },
            });
        }

        // ─── Lead imports (for the lead-source strip) ───────────────
        for (const src of spec.importSources) {
            await prisma.campaignLeadImport.create({
                data: {
                    campaign_id: campaignId,
                    organization_id: orgId,
                    source: src.source,
                    source_label: src.label || null,
                    source_file: src.source === 'csv' ? src.label || null : null,
                    total_submitted: src.count,
                    added_count: src.count,
                    blocked_count: 0,
                    duplicate_count: 0,
                },
            });
        }

        // ─── Enroll a slice of leads ────────────────────────────────
        const enrolees = existingLeads
            .slice()
            .sort(() => Math.random() - 0.5)
            .slice(0, spec.leadCount);

        for (const lead of enrolees) {
            const stickyAccount = pick(accounts);
            const r = Math.random();
            const status =
                r < 0.05 ? 'replied' :
                r < 0.10 ? 'bounced' :
                r < 0.15 ? 'unsubscribed' :
                'active';
            const stepCount = spec.steps.length;
            const currentStep = status === 'replied' ? rand(1, 2)
                : status === 'bounced' ? 1
                : rand(0, stepCount);

            await prisma.campaignLead.create({
                data: {
                    campaign_id: campaignId,
                    email: lead.email,
                    first_name: lead.first_name,
                    last_name: lead.last_name,
                    company: lead.company,
                    title: lead.title,
                    status,
                    current_step: currentStep,
                    validation_status: lead.validation_status,
                    validation_score: lead.validation_score,
                    last_sent_at: currentStep > 0 ? new Date(Date.now() - rand(1, 7) * 24 * 60 * 60 * 1000) : null,
                    next_send_at: status === 'active' && currentStep < stepCount
                        ? new Date(Date.now() + rand(1, 48) * 60 * 60 * 1000)
                        : null,
                    opened_count: status !== 'bounced' ? rand(0, 3) : 0,
                    clicked_count: status === 'replied' ? rand(0, 1) : 0,
                    replied_at: status === 'replied' ? new Date(Date.now() - rand(1, 5) * 24 * 60 * 60 * 1000) : null,
                    bounced_at: status === 'bounced' ? new Date(Date.now() - rand(1, 5) * 24 * 60 * 60 * 1000) : null,
                    unsubscribed_at: status === 'unsubscribed' ? new Date(Date.now() - rand(1, 5) * 24 * 60 * 60 * 1000) : null,
                    assigned_account_id: stickyAccount?.id || null,
                    created_at: new Date(Date.now() - rand(7, 21) * 24 * 60 * 60 * 1000),
                },
            });
        }

        console.log(`✓ "${spec.name}" - ${spec.steps.length} steps, ${enrolees.length} leads, ${spec.importSources.length} sources`);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Done.');
    console.log('  Login as demo@superkabe.com / Demo2026!');
    console.log('  Then visit any of these campaigns and click "View sequence".');
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
