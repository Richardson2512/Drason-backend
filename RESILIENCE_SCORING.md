# Resilience Score Calculation & Healing Speed Multipliers

## Overview

The **resilience score** (0-100) measures an entity's (mailbox or domain) infrastructure health and recovery trajectory. It directly controls healing speed, volume limits, and operator override capability.

## Score Adjustments

| Event | Adjustment | Notes |
|-------|-----------|-------|
| Pause triggered | -15 | Any bounce-triggered pause |
| Phase graduation | +10 | Successfully completing a recovery phase |
| Relapse (re-pause during recovery) | -25 | Severe penalty for repeat failures |
| 7 days stable (no incidents) | +5 | Automatic improvement |
| Rehab origin starting score | 40 | Lower than default (infrastructure was blacklisted) |
| Default starting score | 50 | Standard starting point |

**Score bounds:** Clamped to [0, 100].

## Healing Speed Multiplier

The resilience score determines how fast entities heal (time required per phase):

| Score Range | Multiplier | Effect |
|-------------|-----------|--------|
| 0 – 30 | 2.0x | Double healing time (entity is volatile) |
| 31 – 70 | 1.0x | Normal healing speed |
| 71 – 100 | 0.75x | Faster healing (proven stable) |

### Example

A mailbox in the `QUARANTINE` phase requires 3 clean days to graduate to `PROBATION`:
- Score 80 → 3 × 0.75 = **2.25 days**
- Score 50 → 3 × 1.0 = **3 days**
- Score 20 → 3 × 2.0 = **6 days**

## Phase Volume Limits

During recovery, each phase has a daily send cap (per mailbox):

| Phase | Base Limit | With Multiplier |
|-------|-----------|----------------|
| PAUSED | 0 sends | N/A |
| QUARANTINE | 5 sends/day | 5 × multiplier |
| PROBATION | 15 sends/day | 15 × multiplier |
| MONITORING | 30 sends/day | 30 × multiplier |
| WARNING | 50 sends/day | 50 × multiplier |
| HEALTHY | No cap | ∞ |

## Aggregate Throttle Caps

In addition to individual mailbox limits, domain and org-level caps prevent total volume from exceeding safe recovery limits:

| Level | Cap | Active When |
|-------|-----|-------------|
| Domain | 30 sends/day | Any mailbox in domain is recovering |
| Organization | 100 sends/day | Any entity in org is recovering |

## Hard Floor (Transition Gate)

The transition gate (`checkTransitionGate`) prevents operations when infrastructure scores below the hard floor:

| Score | Behavior |
|-------|----------|
| ≥ 60 | Auto-transition (safe to operate) |
| 25 – 59 | Operator acknowledgment required |
| 1 – 24 | **BLOCKED** — no override possible |
| 0 | All infrastructure paused |

## Score Recovery Path

```
Initial Assessment → Score 50
     ↓ Pause event
Score 35 (−15)
     ↓ 7 days stable
Score 40 (+5)
     ↓ Phase graduation
Score 50 (+10)
     ↓ Another graduation
Score 60 (+10)
     ↓ 7 more days stable
Score 65 (+5)
     → Now in faster healing bracket (0.75x at 71+)
```
