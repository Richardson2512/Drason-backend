# Drason / Superkabe - Customer Onboarding Guide

**Version**: v1 (Design Partner)
**Last updated**: 2026-05-15
**Audience**: First-cohort design partner customers + their concierge onboarding engineer

This doc is the honest, scoped tour of what the platform does today, what's roadmap, and the gotchas a paid customer should know before they wire production traffic through us.

---

## 1. The pitch in 30 seconds

Drason is a self-healing cold-email + LinkedIn outreach platform. You bring your own mailboxes, your own LinkedIn accounts (via Unipile), and your own enrichment provider keys. We provide:

1. **Native sending engine** - not a wrapper over Smartlead/Instantly. We own the SMTP transport, the send queue, the per-mailbox capacity tracker, the spam-rate detector, and the recovery pipeline.
2. **5-phase healing pipeline** - when a mailbox burns out (bounce rate ≥3%, blacklist hit, ISP feedback loop), we automatically (a) pause it, (b) move it to quarantine, (c) ramp it back through a paired-warmup cycle, (d) gate it to a restricted send window, (e) graduate it back to full throughput. **Zero manual reconnects in steady state.**
3. **Multi-channel sequences with one identity** - a lead is a workspace-level record. Email reply on a campaign pauses any in-flight LinkedIn touchpoints for the same person. Configurable per-org via 4 cross-channel modes (OFF / HARD / CLASSIFIED / ASYMMETRIC).
4. **Reply intelligence** - Kimi K2.5 classifies inbound replies into 9 categories (positive / qualified / objection / referral / soft_no / hard_no / angry / auto-OOO / unclassified). Per-class auto-actions: suppress, pause-lead, alert.
5. **CAN-SPAM + Yahoo/Gmail bulk-sender compliant by default** - mandatory mailing address, RFC 8058 one-click unsubscribe, List-Unsubscribe-Post headers, EU compliance mode.
6. **BYOK enrichment waterfall** - Apollo + Surfe + Clay (inbound-webhook only) + 3 stub providers. No vendor markup; you pay your enrichment vendor directly.

---

## 2. What works today (sell this)

| Capability | Status | Notes |
|---|---|---|
| Cold email sequences (multi-step, A/B variants) | ✅ Production-shaped | Send-time spreading, ESP-aware routing, per-org BullMQ priority queues |
| Healing pipeline (5-phase auto-recovery) | ✅ Production-shaped | The differentiator. Owns the burned-mailbox problem end-to-end |
| Mixed email + LinkedIn sequences | ✅ Production-shaped | 6 LinkedIn step types: view profile, follow, like post, connection request, DM, InMail |
| LinkedIn agent stack (24/7) | ✅ Production-shaped | Supervisor + signal monitor + ICP matcher + enrichment + reply classifier |
| Cross-channel reply pause | ✅ Production-shaped | 4 modes, configurable per org |
| Reply classifier + auto-actions | ✅ Production-shaped | Per-class rules: suppress / pause-lead / alert |
| CAN-SPAM compliance | ✅ Production-shaped | Mailing address required; one-click unsubscribe enforced |
| BYOK enrichment - Apollo | ✅ Production-shaped | Sync. Returns LinkedIn URL + email + phone + company metadata |
| BYOK enrichment - Surfe | ✅ Production-shaped | Sync. Same coverage as Apollo |
| Inbound enrichment - Clay | ✅ Production-shaped | Webhook-based. Push from Clay table → Drason auto-creates Leads |
| Polar billing - Starter / Pro / Pro tiers / Growth / Scale | ✅ Production-shaped | Webhook-validated, idempotent |
| Dedicated IPs (Super Sender) | ✅ Production-shaped | AWS SES-powered, 30-day ramp, $39/IP/mo |
| LinkedIn account add-on slots | ✅ Production-shaped | $X/slot/month via Polar, auto-released on disconnect |
| Production frontend build (`next build`) | ✅ Clean | 355 static pages generate without error |
| Backend type-check (`tsc --noEmit`) | ✅ Clean | Zero TS errors |
| Unit test suite | ✅ 59 tests passing | Step registry, Apollo URL normalizer, lead health, suppression filter, tracking tokens |
| Polar webhook signature verification | ✅ HMAC-SHA256 + replay window | Standard Webhooks compliant |
| Org-isolation on tenant data | ✅ Verified | Defensive layer added to mailbox provisioning |
| Inbound email XSS sanitization | ✅ DOMPurify | Strict allowlist applied to Unibox + AI previews + sequence step previews |

---

## 3. What's still roadmap - don't promise

| Item | Why it's not customer-blocking | ETA |
|---|---|---|
| Enrichment providers - Lusha, Hunter, ZoomInfo | Apollo + Surfe cover the same use cases; if customer's only stack is Lusha, this matters | Q3 |
| LastCheckMap Redis backing for IMAP worker | Survives single-instance restart fine; only matters at multi-instance horizontal scale | Q3 |
| MIME body parsing via library (currently regex) | Works for ~95% of real-world emails; corner cases (multipart with embedded base64) may show truncated bodies | Q4 |
| Reply-action audit trail UI | Notifications + Slack alerts cover it for now; full audit table TBD | Q3 |
| Templates page Sentry-style error surfacing | Type-checking + manual smoke tests are the current safety net | Q4 |
| Customer-facing docs site | This file is the v1. A proper docs.drason.com is next | Q3 |
| Self-serve onboarding flow | Concierge onboarding is current model; self-serve is the next milestone | Q4 |
| External observability (Sentry, uptime monitor) | Logged via internal observability service + Slack alerts; no external dashboard yet | Q3 (operational) |

---

## 4. Setup checklist for a new customer

Run through these in order during concierge onboarding:

### 4.1 Provision the workspace
1. Operator creates a Drason account; we provision the Organization row.
2. Set `mailing_address` on the org (required for every commercial email - CAN-SPAM § 5(a)(5)).
3. Pick subscription tier in Settings → Billing → Polar checkout.

### 4.2 Connect sending infrastructure
1. Add at least one email mailbox via Settings → Mailboxes → Connect (OAuth for Gmail / Microsoft 365, or SMTP+IMAP for custom).
2. Verify DKIM / SPF / DMARC on the sending domain (Settings → Domains shows the records).
3. *Optional but recommended*: Buy a dedicated IP (`/dashboard/sequencer/super-sender`). 30-day ramp begins immediately.
4. *Optional*: Connect LinkedIn accounts via Settings → LinkedIn → Unipile flow.

### 4.3 Connect enrichment (if doing LinkedIn-side outreach)
1. Settings → Enrichment → Add provider.
2. Pick **Apollo** or **Surfe** (real implementations) and paste the API key.
3. If using **Clay**, set up an export from your Clay table to our webhook URL (Settings → Enrichment → Clay shows the URL + signing secret).
4. Set provider order in the waterfall; the first hit wins per field.

### 4.4 First campaign
1. New campaign → wizard walks 7 steps (Basics, Leads, Sequence, Mailboxes, Schedule, Settings, Review).
2. Import contacts via CSV / manual paste / Clay sync.
3. Build a sequence - mix of email + LinkedIn steps (e.g., view-profile → connection-request → DM → email).
4. **Use a `find_linkedin_url` step BEFORE any LinkedIn touchpoint** if your contacts don't all have LinkedIn URLs in the CSV. The wizard's review screen tells you the coverage % and warns when missing.
5. Launch from the detail page. The status flips to `active` and the dispatcher picks it up on the next 60s tick.

### 4.5 Day-2 operations
- **Unibox** (`/dashboard/sequencer/unibox`) - triage replies. Per-class auto-actions are configurable in Settings → Reply Actions.
- **Infrastructure** (`/dashboard/infrastructure`) - DNS + blacklist status, refreshed every 24h in background. Doesn't block sends.
- **Analytics** (`/dashboard/sequencer/analytics`) - per-campaign open/click/reply/bounce funnel.
- **Mailbox health** - auto-paused mailboxes show on the Sequencer dashboard. Auto-resume happens after the healing pipeline graduates them; no operator action needed in steady state.

---

## 5. Gotchas (read these before launch)

### 5.1 Apollo / Surfe API rate limits are yours, not ours
We're strict BYOK - your enrichment vendor sees your API calls under your account, your rate limits, your spend. Spike protection on the platform side is a 10s timeout per call + waterfall short-circuit on first hit; we never retry against a 429.

### 5.2 LinkedIn step "view profile / follow / like" count against the 100/day "other actions" cap
LinkedIn's API groups view/follow/like under one daily bucket. We track this per LinkedIn account; if your sequence has 4 LinkedIn warm-up steps before the DM, you'll burn 4× per lead against that cap. Plan accordingly.

### 5.3 First reply within 72h of a Pro tier upgrade may not be classified by Kimi
The reply classifier runs on every inbound, but the AI re-classification fires only when the rule-based pass returns low confidence. First-time upgrades may have a cache-warmup delay of ~30s. The Unibox shows the final class after the AI pass; the per-class actions correctly fire on the AI-final result, not the rule result.

### 5.4 Mixed-channel campaigns require LinkedIn senders to be in `OK` status at launch time
We re-validate at launch - if your LinkedIn account is in `CREDENTIALS` (re-auth required) or `ERROR` state, the campaign launch is blocked with a clear error message. Reconnect on Settings → LinkedIn → Reconnect.

### 5.5 The dedicated IP ramps over 30 days
Day 1: 50 sends/day. Day 30: full tier limit. Don't expect immediate full throughput; this is the AWS SES warmup curve and accelerating it would tank deliverability.

### 5.6 Healing pipeline holds outbound during recovery - that's the point
When a mailbox drops into `restricted_send` or `warm_recovery` phase, daily caps drop (10/day, then 50/day). This is by design. Visible on the Mailboxes page; auto-resume on graduation.

### 5.7 Cross-channel reply pause is configurable but defaults to ASYMMETRIC
- **OFF**: no cross-channel signals
- **HARD**: any reply on either channel pauses both
- **CLASSIFIED**: only positive/qualified/hard_no/angry classes propagate
- **ASYMMETRIC** (default): email replies pause LinkedIn, but LinkedIn replies don't pause email (LinkedIn replies are noisier; the reverse signal isn't reliable enough to halt email outreach)

Set the mode in Settings → Reply Actions → Cross-channel.

### 5.8 Out-of-office (OOO) auto-replies don't clear ramp progress
When Kimi classifies a reply as `auto` (OOO), the lead is paused via `ooo_until` extracted from the message. The campaign resumes automatically after that date. We don't clear the OOO hold on subsequent low-confidence replies (objection / soft_no / unclassified) - only on definitive human reply classes (positive / qualified / hard_no / angry / referral).

### 5.9 Sending is NOT blocked by the daily infrastructure assessment
The DNS + DNSBL snapshot runs every 24h in the background. It shows on the dashboard as a small floater toast, never blocks the UI, and never gates the dispatcher. Real-time protection is the executionGate at send time (mailbox status, domain status, bounce rate, recipient-domain complaints, healing caps). The assessment is informational; it tells you what's drifting.

### 5.10 Template + saved-sequence read access is gated on `edit_sequences` capability
A read-only viewer (e.g., agency-mode client guest) cannot list or read templates or saved sequences. Marketing playbooks stay scoped to operators.

---

## 6. Pricing reality check

For a design-partner customer, you should expect:
- **40–60% off list**, locked for 12 months
- **Concierge onboarding** - your engineering contact walks you through the first campaign
- **Weekly check-in** until you're at steady state
- **48h response on any platform issue you hit**

In return, we ask:
- Honest feedback on what's confusing or broken
- Permission to ship a same-week patch when something matters
- A reference call after 90 days of green metrics

---

## 7. Known limitations (be upfront)

- We're not yet horizontally-scaled. Single-instance staging. Latency is fine for design partners but multi-instance hardening is on roadmap.
- We don't yet have an external uptime monitor or status page. Use the Slack channel we'll share for incident communication.
- Some surfaces (Reply Actions config, Analytics deep-dives) are functional but not polished. We'll be iterating fast.
- The first paying customer is, by definition, the production canary. We've audited deeply across LinkedIn (Campaigns/Contacts/Accounts/Unibox/Signals/ICP/Overview) and Sequencer (Campaigns/Unibox/Templates/Warmup/Mailboxes/Domains/Analytics/Settings/Reply Actions/Super-Sender/Infrastructure) and shipped 30+ documented P0/P1 fixes - but you may still find sharp edges. We will move fast on whatever you hit.

---

## 8. Support & contact

- Primary contact: your concierge onboarding engineer (provided separately)
- Slack: shared channel set up at signup
- Email: support@superkabe.com (response within 24h for design partners)
- Critical-path incidents: text/call your contact engineer's direct line

---

*This document is intentionally honest. If something doesn't work as described, it's a bug - please flag it.*
