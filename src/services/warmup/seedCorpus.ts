/**
 * Warmup Seed Corpus — the spintax templates that produce 3B+ unique
 * email permutations.
 *
 * Combinatorial math:
 *   30 SUBJECT_TEMPLATES   × spintax internals (~5K each)  ≈ 150K subjects
 *   50 BODY_TEMPLATES      × spintax internals (~20K each) ≈ 1M bodies
 *   20 SIGNOFF_TEMPLATES   × spintax internals (~50 each)  ≈ 1K signoffs
 *   = 30 × 50 × 20 × ~5000 = 3B+ raw initial-message permutations
 *
 * Layered runtime jitter (HTML/plaintext, emoji, P.S., signature
 * inclusion) multiplies further. Reply skeletons add reply-of-reply
 * variance.
 *
 * Authoring rules:
 *   - Conversational, plausible business chat. No marketing copy.
 *   - No company/role/product specifics — content must be tenant-agnostic.
 *   - Vary opening pleasantry, body shape, sign-off style.
 *   - Include {{sender_name}} placeholder in signoffs only — the content
 *     service substitutes the sender's display name at render time.
 *   - {a||c} (empty option) is allowed — empty branches are deliberate
 *     pattern-disruptors.
 *
 * Seeded via the seedWarmupCorpus() function below — run once per env.
 * Subsequent runs are idempotent (upserts on a stable hash key).
 */

import * as crypto from 'crypto';
import { prisma } from '../../index';
import { logger } from '../observabilityService';
import { invalidateContentCache } from './contentService';

// ────────────────────────────────────────────────────────────────────
// 30 subject templates
// ────────────────────────────────────────────────────────────────────

export const SUBJECT_TEMPLATES: string[] = [
    '{Quick question|Quick one|Quick check}',
    '{Following up|Circling back|Touching base}',
    '{Hey|Hi|Hello}{,| —|}',
    '{Thoughts|A thought|Wanted to share}',
    '{Catching up|Catch-up|Just checking in}',
    '{Have a minute|Got a minute|Got a sec}?',
    '{Saw this and thought of you|Found something|This caught my eye}',
    '{Working on something|On a project|Putting something together}',
    '{Random|A bit of a random} question',
    'Re: {our chat|earlier|the other day}',
    '{Coffee|A coffee|Coffee chat}{?| sometime?| sometime}',
    '{This week|Sometime this week|Free this week}?',
    '{Heads up|Just a heads-up|FYI}',
    '{Wanted to ask|Curious|Question for you}',
    '{Are you|You} {around|free|available} {today|tomorrow|this week}?',
    '{Some thoughts|A few thoughts|Two cents} on {what we discussed|the topic|the idea}',
    '{Any chance|Wondering if} you {have time|are around}',
    '{Idea|An idea|Something to consider}',
    '{Update|Quick update|Small update}',
    '{Question|One question|Quick q}',
    '{Hope you are well|Hope all is well|Hope things are good}',
    '{Sharing|Wanted to share|Passing along} {this|something}',
    '{Need your input|Could use your input|Would love your input}',
    '{Plan for|Planning for|Thinking about} {next week|the week ahead|tomorrow}',
    '{Chat|A chat|Chatting} soon?',
    '{Worth a look|Take a look|FYI when you get a chance}',
    '{Mind|Would you mind} {sharing|telling me}{?|}',
    '{News|Some news|A bit of news}',
    'Re: {follow-up|check-in|the thing}',
    '{Reaching out|Just reaching out|Wanted to reach out}',
];

// ────────────────────────────────────────────────────────────────────
// 50 body templates — varied length, structure, and tone.
// Each one resolves to ~5K-50K spintax permutations.
// ────────────────────────────────────────────────────────────────────

export const BODY_TEMPLATES: string[] = [
    `{Hi|Hey|Hello}{,| there,| friend,}\n\n{Hope|Trust|Wanted to say I hope} {your week is|things are|all is} going {well|smoothly|great}. {Quick question:|Just a thought —|Wanted to check —} {do|are} you {still planning|on track|considering} {to|on} {meet|sync|catch up} {next week|sometime|soon}?\n\n{Let me know|Lmk|Just lmk} {when you can|when works|whenever}.`,

    `{Hey|Hi}{,| —|}\n\n{Wanted|Just wanted|I wanted} to {share|pass along|drop} {an article|a piece|something} I {came across|found|read} {today|earlier|recently}. {Thought you might|You might|I think you would} {like it|enjoy it|find it useful}.\n\n{No rush|Take your time|Whenever} {to look at it|to read|to check it out}.`,

    `{Hi|Hey|Hello},\n\n{Just|I just|Wanted to} {circle back|follow up|check in} on {what we discussed|our chat|the idea}. {Any|Got any|Have any} {updates|news|progress} {on your end|since}?\n\n{Cheers|Best|Talk soon}.`,

    `{Hey there|Hi|Hello},\n\n{How|How is|How was} your {week|day|morning} going? {Mine has been|Things have been} {busy but good|fairly steady|productive}.\n\n{Wanted to|Just wanted to|Just wanted} say {hi|hello|hey}.`,

    `{Hi|Hey},\n\n{Saw|Noticed|Just saw} {your post|the article|the thread} about {the new project|what you're working on|the recent update}. {Looks great|Looks promising|Sounds interesting}.\n\n{Would love to hear|Curious|Interested} {more|about how it goes|what you think}.`,

    `{Hey|Hi},\n\n{Quick|A quick|One} question — {do you|are you|have you} {happen to know|know of|know} {anyone who|someone who|somebody who} {has experience|works|specializes} in {this area|something similar|that kind of thing}?\n\n{No worries if not|Totally okay if you don't|If not, no problem}.`,

    `{Hi|Hello|Hey} {there|},\n\n{Hope|Hoping|Just hoping} {the week|the day|things} {is treating|is going|are going} {you well|smoothly|alright}. {Wanted to share a thought|Just thinking out loud|Random thought}: {what if|have you considered|maybe} {we|you|one could} {try|look into|explore} {it differently|a new angle|something new}?\n\n{Curious to hear|Would love to know|Let me know} {your take|what you think|your thoughts}.`,

    `{Hi|Hey|Hello},\n\n{Just a quick|Quick|Brief} {note|message|hello} {to say|to mention|to let you know} that {I appreciated|I really liked|I valued} {your input|your perspective|the conversation} {the other day|recently|last week}.\n\n{Talk soon|Until next time|See you around}.`,

    `{Hello|Hi|Hey},\n\n{Putting together|Working on|Drafting} {something|an outline|a plan} for {next week|the next phase|what comes next}. {Would love your input|Would value your thoughts|Could use your perspective} {when you have a moment|when free|whenever it's convenient}.\n\n{Thanks|Cheers|Appreciate it}.`,

    `{Hey|Hi},\n\n{Random one|Out of the blue|This might be random}: {are you|will you be} {around|in town|available} {next week|sometime|soon}?\n\n{Would be great to|Be nice to|Could be fun to} {catch up|grab a coffee|chat}.`,

    `{Hi|Hello},\n\n{Wanted|Just wanted|I wanted} to {check in|see how|ask how} {how things are|things are going|you're doing} {with|on} {the new role|the project|the move}. {Hopefully smoothly|Going okay I hope|Hope it's going well}.\n\n{Talk soon|Catch up soon|Until next time}.`,

    `{Hey|Hi|Hello},\n\n{Have you|Did you|Were you} {seen|caught|noticed} {the news|the announcement|the update} about {the industry|things|that}? {Curious|Interested|Wondering} {what you make of it|your take|how you see it}.\n\n{Lmk|Let me know|Drop a line} {when you can|sometime}.`,

    `{Hi|Hey},\n\n{Long time|Been a while|Hasn't been a while}. {Hope|Trust} you've been {well|good|busy in a good way}.\n\n{Should we|Want to|Let's} {grab time|find time|sync up} {soon|sometime|in the next couple weeks}?`,

    `{Hello|Hi|Hey} {there|},\n\n{Just|I just} {wrapped up|finished|got off} {a long|a busy|an intense} {week|day|stretch}. {Looking forward to|Trying to|Hoping for} {a quieter|a slower|a calm} {few days|stretch|weekend}.\n\n{How about you|You|And you}?`,

    `{Hi|Hey|Hello},\n\n{Question for you|Got a question|Need your take} — {when you|if you|whenever you} {get a moment|have a sec|find time}, {would love|would appreciate|can you share} {your thoughts on|your view of|your perspective on} {the proposal|the idea|the plan}?\n\n{No rush|Whenever|At your pace}.`,

    `{Hey|Hi},\n\n{Heard|Was hearing|Was told} {good things|great things|nice things} about {the launch|the recent work|what you've been up to}. {Congrats|Well done|Good for you}.\n\n{Drinks soon|Coffee soon|Catch up soon}?`,

    `{Hi|Hello|Hey},\n\n{This|It} might be a {long shot|stretch|reach} but — {do|did} you {happen to|by chance|maybe} {know|have any|recall} {a good resource|a recommendation|advice} on {the topic|something like that|that area}?\n\n{Cheers|Thanks|Appreciate it}.`,

    `{Hey|Hi},\n\n{Was thinking about|Thinking|Just thought about} {what you said|the conversation|your point} {the other day|recently|earlier}. {It stuck with me|Made me reflect|Got me thinking}.\n\n{More on that|Will share more|Let's dig into it} when {we next chat|we catch up|we meet}.`,

    `{Hi|Hey|Hello},\n\n{Hope|I hope|Hoping} {you|things on your side|your week is} {are well|are good|going smoothly}.\n\n{Wanted to|Just wanted to|Decided to} {drop a note|send a hi|reach out} {to say|to wish you|with} {a good week|a great day|warm regards}.`,

    `{Hey|Hi},\n\n{Quick one|One quick thing|Brief}: {are|will} you {still planning to|on track for|going to} {make it to|attend|come by} {the event|the meetup|that thing} {next week|on Friday|on Tuesday}?\n\n{Lmk|Just lmk|Let me know}.`,

    `{Hi|Hello},\n\n{I keep|Keep|Have been} {meaning to|intending to|wanting to} {follow up on|reply to|come back to} {your message|our last chat|the email}. {Apologies for|Sorry for|My apologies for} the {delay|slow reply|wait}.\n\n{Free this week|Around this week|Got time this week}?`,

    `{Hey|Hi|Hello} {there|},\n\n{Just|I was just} {thinking|brainstorming|noodling} on {something|an idea|the problem} {related to|around|about} {our last chat|the discussion|what we talked about}. {Mind if I|Can I|Want me to} {share|send over|run by you} {a quick draft|some thoughts|a few notes}?\n\n{Whenever|Take your time|No rush}.`,

    `{Hi|Hey},\n\n{Hope you don't mind|Hope it's okay|Sorry for} {the cold reach|reaching out cold|the random ping}. {Came across|Saw|Found} {your work|your profile|your team} and {wanted to|figured I'd|thought I'd} {say hi|introduce myself|reach out}.\n\n{Open to|Up for|Down for} {a quick chat|a brief intro|chatting}?`,

    `{Hello|Hi|Hey},\n\n{The|That} {project|piece of work|launch} you {posted about|shared|mentioned} {looked|sounded|seems} {really cool|impressive|interesting}. {How is it|How's it} {going|landing|received}?\n\n{Be great|Would be great} to {hear more|catch up on it|learn how it's progressing}.`,

    `{Hi|Hey},\n\n{Putting|Pulling|Drafting} {a list together|some notes|a doc} of {good reads|recommendations|references} for {next quarter|Q3|the team}. {Anything you'd|Got anything to|Any books you'd} {add|throw in|recommend}?\n\n{Curious|Interested|Open to anything}.`,

    `{Hey|Hi|Hello},\n\n{Hope|Hoping} {you're surviving|the week's treating you|things are tracking} {well|okay|alright}.\n\n{Quick favor|Could I ask a favor|Small ask}: {can you|would you|mind if you} {forward me|send me|share} {that link|that doc|the resource} {from the other day|we discussed|you mentioned}?`,

    `{Hi|Hey|Hello},\n\n{Saw|Just saw|Caught} {your post|the announcement|the news}. {Wow|Amazing|That's great}. {Big congrats|Congratulations|Well-deserved}.\n\n{Drinks|Coffee|A toast} {are on me|next time|owed to you}.`,

    `{Hey|Hi},\n\n{Trying|Working on|Attempting} to {sort out|figure out|untangle} {a thing|a problem|something} on my end. {Mind if I|Could I|Can I} {pick your brain|run something by you|ask your take} {sometime soon|when convenient|this week}?\n\n{No rush|Take your time|Whenever}.`,

    `{Hi|Hello},\n\n{Reading|Going through|Working through} {an interesting|a really good|a great} {book|article|paper} {right now|currently|at the moment}. {Will share|I'll send over|Want me to send} {the title|a link|the recommendation}?`,

    `{Hey|Hi|Hello},\n\n{Question|A question|Genuine question}: {how do you|what's your approach to|how do you handle} {staying focused|staying on top of things|balancing it all} {these days|right now|in this season}?\n\n{Always learning|Always curious|Genuinely interested}.`,

    `{Hi|Hey},\n\n{Wanted to wish|Just wanted to wish|Sending you} {you|some} {good vibes|good energy|positive thoughts} for {the week|the project|what's coming}.\n\n{Talk soon|Onward|Catch up soon}.`,

    `{Hey|Hi},\n\n{Quick|Just a quick|One quick} {update|note|status}: {wrapped up|finished|completed} {the task|the deliverable|the milestone} {today|this week|just now}. {Onto|Now onto|Moving to} {the next thing|what's next|the next phase}.\n\n{Hope your side|Hope things|Hope your end} {are going well|is going well|is on track}.`,

    `{Hi|Hello|Hey},\n\n{Curious|Wondering|Asking out of curiosity} — {what's your take|how do you see|what do you think} on {the recent shift|the new approach|the latest trend}?\n\n{Always interested|Curious|Open} {in your take|in hearing more|to a discussion}.`,

    `{Hey|Hi},\n\n{Just|Recently|Lately} {finished|wrapped|completed} {a stretch|a sprint|a long week} of {focus work|deep work|head-down time}. {Feeling good|Feeling satisfied|Glad it's done}.\n\n{What about you|How about you|And you}?`,

    `{Hi|Hello},\n\n{Hope all|I hope|Trust} is {well on your side|going well|going smoothly}.\n\n{Quick thought|Random thought|Wanted to flag}: {it might|maybe it would|perhaps it would} be {worth|interesting|useful} to {revisit|look at|chat about} {the original plan|where we started|the framing} {sometime|soon|when there's time}.`,

    `{Hey|Hi|Hello},\n\n{Coffee|A coffee|Quick coffee} {next week|sometime|whenever}? {On me|My treat|I'll pay}.\n\n{Just for|For} {a catch-up|a chat|a chance to connect} {— no agenda|— nothing in particular|— just to talk}.`,

    `{Hi|Hey},\n\n{Came across|Found|Discovered} {a tool|something|a resource} {today|earlier|recently} that {might be|seems|looks} {useful|relevant|interesting} for {what you're working on|your team|your situation}.\n\n{Want me to|Should I|Can I} {send it over|share|forward it}?`,

    `{Hey|Hi|Hello},\n\n{Have you|Are you|You} {got|getting|enjoying} {the weather|the season|the time off} {there|on your side|where you are}? {Hopefully|Trust it's|Imagine it's} {nicer|warmer|cooler} than {here|on my end|where I am}.\n\n{Catch up soon|Talk soon|Cheers}.`,

    `{Hi|Hello},\n\n{Will be|I'll be|I am going to be} {in town|nearby|in your area} {next week|on Tuesday|sometime soon}. {Want to|Should we|Free to} {grab a meal|grab lunch|meet up}?\n\n{Lmk|Let me know|Just lmk}.`,

    `{Hey|Hi},\n\n{Following up|Wanted to follow up|Circling back} on {our last|the last|that earlier} {message|chat|conversation}. {Any|Have any|Got any} {updates|news|progress}?\n\n{No pressure|Whenever you have time|Whenever}.`,

    `{Hi|Hey|Hello},\n\n{Hope|I hope|Hoping} the {week|month|quarter} {is going|has been going|started off} {well|on a good note|smoothly}.\n\n{Reaching out to|Just reaching out to|Wanted to} {say hi|wish you well|connect}.`,

    `{Hey|Hi},\n\n{Wanted to ask|Curious to ask|Asking} — {do you|are you|have you ever} {use|tried|worked with} {anything|any tools|something specific} {for|on|around} {the area|the topic|that}?\n\n{Always learning|Always interested|Curious}.`,

    `{Hi|Hello},\n\n{The|That} {idea|approach|framework} you {shared|mentioned|talked about} {keeps|has been|is} {coming back to me|sticking with me|on my mind}. {Maybe we should|We should|Should we} {explore it more|dig into it|talk it through} {sometime|when we next chat|soon}.\n\n{Cheers|Talk soon|Best}.`,

    `{Hey|Hi|Hello},\n\n{Quick check-in|Just checking in|Wanted to check in}. {How is|How's} {everything|all|the work} {going|holding up|treating you}?\n\n{Happy to|Glad to|Always glad to} {hear back|reconnect|catch up}.`,

    `{Hi|Hey},\n\n{Was|Just was|Recently was} {thinking about|reminded of|reflecting on} {something you said|a comment from you|your perspective} {the other day|earlier|a while back}. {Made me realize|Got me thinking|Made me see} {something different|a different angle|a fresh take}.\n\n{Will|I'll|Want to} {share more|elaborate|dig in} {when we next talk|soon|in person}.`,

    `{Hello|Hi|Hey},\n\n{Random|Out of the blue|This is random}: {do you|did you|have you} {watch|see|catch} {anything good|something interesting|a great show} {recently|last weekend|lately}? {Always looking for|Open to|In need of} {recommendations|new picks|good suggestions}.\n\n{Cheers|Talk soon|Lmk}.`,

    `{Hi|Hey},\n\n{Wanted|Just wanted|Quickly wanted} to {acknowledge|recognize|appreciate} {your help|the assist|the input} {last week|on the project|recently}. {Genuinely|Really|Truly} {appreciate it|grateful|thankful}.\n\n{Owe you one|I owe you|Returning the favor sometime}.`,

    `{Hey|Hi|Hello},\n\n{Heard|Was told|Just heard} you've been {really busy|head down|all-in} {lately|recently|this past month}. {Hope|Hoping} {it's the good kind|the work is rewarding|you're holding up}.\n\n{Whenever|When time allows|If you get a breather} — {a coffee|a chat|a quick sync}?`,

    `{Hi|Hello},\n\n{Sharing|Just sharing|Passing along} {something|a small thing|a quick thought} that {might|may|could} {be useful|land|resonate}.\n\n{Talk soon|Cheers|Best}.`,

    `{Hi|Hey|Hello},\n\n{Mid-week|Mid-month|End-of-week} {check-in|hello|note}. {Hope|I hope|Trust} {you're well|you're good|things are good}. {The week|The month|This stretch} {has been|is being|is shaping up} {fine on my end|fairly steady|busy but good}.\n\n{Catch you|Catch up|Connect} {later|soon|in a bit}.`,

    `{Hey|Hi|Hello},\n\n{Tomorrow|Next week|This Friday} I'll be {free|available|less busy} {after|in the|around the} {afternoon|morning|evening}. {Want to|Up for|Free to} {chat|grab a quick call|sync briefly}?\n\n{Lmk|Let me know|Just lmk} {what works|when works|the best time}.`,
];

// ────────────────────────────────────────────────────────────────────
// 20 sign-off templates. {{sender_name}} substituted at render.
// ────────────────────────────────────────────────────────────────────

export const SIGNOFF_TEMPLATES: string[] = [
    `{Best|Cheers|Thanks},\n{{sender_name}}`,
    `{Thanks|Thank you|Many thanks}!\n{{sender_name}}`,
    `{Talk soon|Speak soon|See you soon},\n{{sender_name}}`,
    `{Take care|All the best|Best wishes},\n{{sender_name}}`,
    `Cheers,\n{{sender_name}}`,
    `Best,\n{{sender_name}}`,
    `{Have a great|Have a good|Enjoy your} {day|week|rest of the week},\n{{sender_name}}`,
    `{Onwards|Onward|Forward},\n{{sender_name}}`,
    `{Warm regards|Regards|Kind regards},\n{{sender_name}}`,
    `{Until next time|Til next|Catch you next time},\n{{sender_name}}`,
    `— {{sender_name}}`,
    `{{sender_name}}`,
    `{Yours|Truly|Sincerely}, {{sender_name}}`,
    `{Stay well|Be well|Stay safe},\n{{sender_name}}`,
    `{Catch up soon|See you|Soon},\n{{sender_name}}`,
    `{Thanks again|Thanks a lot|Many thanks},\n{{sender_name}}`,
    `{Always|Always good|Always happy} {to chat|to hear from you|to connect},\n{{sender_name}}`,
    `{Looking forward|Looking forward to it|Looking forward to hearing back},\n{{sender_name}}`,
    `{Best|Cheers},\n{{sender_name}} 🙂`,
    `{Take it easy|Easy does it|Take care},\n{{sender_name}}`,
];

// ────────────────────────────────────────────────────────────────────
// 5 thread-reply skeletons — used when a recipient generates a reply
// to a warmup email. Different from initial bodies: shorter, more
// conversational, often agreeing/extending rather than initiating.
// ────────────────────────────────────────────────────────────────────

export const THREAD_REPLY_TEMPLATES: string[] = [
    `{Thanks|Got it|Noted}{,| —|.} {Sounds good|Makes sense|Good point}. {Will|I'll|Going to} {follow up|reply later|circle back} {with more|properly|when I have a minute}.`,

    `{Yes|Yep|Definitely} — {still|absolutely|for sure} {planning to|on track to|going to} {meet|sync|catch up}. {Friday|Next week|Sometime} {works|is good|is open}?\n\n{Cheers|Best|Talk soon}.`,

    `{Appreciate the note|Thanks for sharing|Thanks for the heads-up}. {Will take a look|I'll dig in|Adding to my list}.\n\n{Talk soon|Cheers|Catch up soon}.`,

    `{Good question|That's a good one|Makes me think}. {Honestly|Truthfully|TBH} {I'm not sure|haven't decided|am still figuring out}. {Will share|I'll come back|More to come} {when I have a clearer view|when I know more|once it firms up}.`,

    `{Sounds great|Sounds good|Works for me}. {Lmk|Let me know|Just lmk} {when you're free|the time|what works}.`,
];

// ────────────────────────────────────────────────────────────────────
// Sanity check the corpus shape so a typo in the constants above
// doesn't ship a corrupt seed. Called at startup of the seeder.
// ────────────────────────────────────────────────────────────────────

function assertCorpusShape(): void {
    if (SUBJECT_TEMPLATES.length < 30) {
        throw new Error(`Subject corpus too small: have ${SUBJECT_TEMPLATES.length}, need 30+`);
    }
    if (BODY_TEMPLATES.length < 50) {
        throw new Error(`Body corpus too small: have ${BODY_TEMPLATES.length}, need 50+`);
    }
    if (SIGNOFF_TEMPLATES.length < 20) {
        throw new Error(`Signoff corpus too small: have ${SIGNOFF_TEMPLATES.length}, need 20+`);
    }
    if (THREAD_REPLY_TEMPLATES.length < 5) {
        throw new Error(`Thread-reply corpus too small: have ${THREAD_REPLY_TEMPLATES.length}, need 5+`);
    }
}

// ────────────────────────────────────────────────────────────────────
// Idempotent seeder. Templates are upserted by sha256(spintax) so
// re-running this against an existing DB is a no-op for unchanged
// rows. Edited rows update in place; deleted rows are NOT removed
// (we never want a redeploy to drop active templates underneath
// running workers — operator removes manually).
// ────────────────────────────────────────────────────────────────────

function hashKey(spintax: string, kind: string): string {
    return crypto.createHash('sha256').update(`${kind}|${spintax}`).digest('hex').slice(0, 32);
}

interface SeedResult {
    inserted: number;
    updated: number;
    skipped: number;
}

async function seedKind(kind: 'subject' | 'body' | 'signoff' | 'thread_reply', items: string[]): Promise<SeedResult> {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const spintax of items) {
        const id = hashKey(spintax, kind);
        // Use the deterministic id as the primary key so re-seeds are
        // clean upserts. The Prisma model's id is a free-form String so
        // any uuid / hash works.
        const existing = await prisma.warmupTemplate.findUnique({ where: { id } });
        if (!existing) {
            await prisma.warmupTemplate.create({
                data: { id, kind, spintax, language: 'en', weight: 1, active: true },
            });
            inserted += 1;
        } else if (existing.spintax !== spintax || !existing.active) {
            await prisma.warmupTemplate.update({
                where: { id },
                data: { spintax, active: true },
            });
            updated += 1;
        } else {
            skipped += 1;
        }
    }

    return { inserted, updated, skipped };
}

export async function seedWarmupCorpus(): Promise<{
    subject: SeedResult;
    body: SeedResult;
    signoff: SeedResult;
    thread_reply: SeedResult;
}> {
    assertCorpusShape();
    logger.info('[WARMUP_SEED] starting corpus seed');

    const [subject, body, signoff, thread_reply] = await Promise.all([
        seedKind('subject', SUBJECT_TEMPLATES),
        seedKind('body', BODY_TEMPLATES),
        seedKind('signoff', SIGNOFF_TEMPLATES),
        seedKind('thread_reply', THREAD_REPLY_TEMPLATES),
    ]);

    invalidateContentCache();

    logger.info('[WARMUP_SEED] complete', {
        subject_inserted: subject.inserted,
        body_inserted: body.inserted,
        signoff_inserted: signoff.inserted,
        thread_reply_inserted: thread_reply.inserted,
    });

    return { subject, body, signoff, thread_reply };
}
