/**
 * Single source of truth for every Slack alert event_type the platform can
 * emit. Each entry maps the raw event_type string used at the call site to a
 * human-readable label, description, and group for the preferences UI.
 *
 * Adding a new alert? Add it here too. Anything fired through
 * SlackAlertService.sendAlert with an unknown event_type still goes out
 * (default enabled) but appears in the "Uncategorized" group on the prefs
 * page so the operator can opt out.
 */

export interface SlackEventDef {
    event_type: string;
    label: string;
    description: string;
    group: SlackEventGroup;
    /** Whether this event is on by default for a freshly-connected workspace. */
    default_enabled: boolean;
}

export type SlackEventGroup =
    | 'protection'
    | 'sequencer'
    | 'warmup'
    | 'imports'
    | 'load_balancing'
    | 'predictive'
    | 'billing'
    | 'trial';

export const SLACK_EVENT_GROUPS: { key: SlackEventGroup; label: string; description: string }[] = [
    { key: 'protection',     label: 'Protection',     description: 'Mailbox / domain pauses, recoveries, and warnings driven by the protection layer.' },
    { key: 'sequencer',      label: 'Sequencer',      description: 'Campaign activation, completion, replies, and send-rate anomalies.' },
    { key: 'warmup',         label: 'Warmup',         description: 'Mailbox warmup pool events.' },
    { key: 'imports',        label: 'Imports',        description: 'Lead and contact import jobs finishing across CSV, API, Instantly, and Smartlead.' },
    { key: 'load_balancing', label: 'Load balancing', description: 'Automatic mailbox redistribution across campaigns.' },
    { key: 'predictive',     label: 'Predictive',     description: 'Forward-looking risk signals and pre-emptive actions.' },
    { key: 'billing',        label: 'Billing',        description: 'Subscription cancellations and payment failures.' },
    { key: 'trial',          label: 'Trial',          description: 'Trial expiration warnings and expiry events.' },
];

export const SLACK_EVENT_CATALOG: SlackEventDef[] = [
    // ── Protection ─────────────────────────────────────────────────────
    { event_type: 'mailbox_paused',                       label: 'Mailbox paused',                        description: 'A mailbox was auto-paused due to deliverability degradation.',         group: 'protection',     default_enabled: true  },
    { event_type: 'domain_paused',                        label: 'Domain paused',                         description: 'A sending domain was auto-paused.',                                    group: 'protection',     default_enabled: true  },
    { event_type: 'mailbox_recovered',                    label: 'Mailbox recovered',                     description: 'A previously paused mailbox returned to healthy.',                     group: 'protection',     default_enabled: true  },
    { event_type: 'domain_recovered',                     label: 'Domain recovered',                      description: 'A previously paused domain returned to healthy.',                      group: 'protection',     default_enabled: true  },
    { event_type: 'campaign_recovered',                   label: 'Campaign recovered',                    description: 'A previously paused campaign returned to healthy.',                    group: 'protection',     default_enabled: true  },
    { event_type: 'suggested_warn_mailbox',               label: 'Mailbox warning (suggested)',           description: 'A mailbox is trending toward needing intervention.',                   group: 'protection',     default_enabled: false },
    { event_type: 'suggested_pause_mailbox',              label: 'Mailbox pause (suggested)',             description: 'Protection layer suggests pausing this mailbox.',                      group: 'protection',     default_enabled: true  },
    { event_type: 'suggested_warn_domain',                label: 'Domain warning (suggested)',            description: 'A domain is trending toward needing intervention.',                    group: 'protection',     default_enabled: false },
    { event_type: 'suggested_pause_domain',               label: 'Domain pause (suggested)',              description: 'Protection layer suggests pausing this domain.',                       group: 'protection',     default_enabled: true  },
    { event_type: 'suggested_pause_domain_correlation',   label: 'Domain pause (correlation)',            description: 'Multiple mailboxes on the same domain are degrading at once.',         group: 'protection',     default_enabled: true  },
    { event_type: 'suggested_pause_campaign',             label: 'Campaign pause (suggested)',            description: 'Protection layer suggests pausing this campaign.',                     group: 'protection',     default_enabled: true  },

    // ── Sequencer ──────────────────────────────────────────────────────
    { event_type: 'campaign.activated',                   label: 'Campaign launched',                     description: 'A campaign moved from draft to active.',                                group: 'sequencer',      default_enabled: true  },
    { event_type: 'campaign.completed',                   label: 'Campaign completed',                    description: 'All leads in the campaign have finished sending.',                      group: 'sequencer',      default_enabled: true  },
    { event_type: 'campaign.first_reply',                 label: 'First reply on a campaign',             description: 'The first reply landed on a campaign.',                                 group: 'sequencer',      default_enabled: true  },
    { event_type: 'reply.received',                       label: 'Every reply received',                  description: 'Pings on every inbound reply. Can be chatty.',                          group: 'sequencer',      default_enabled: false },
    { event_type: 'campaign.bounce_spike',                label: 'Bounce-rate spike',                     description: 'Campaign bounce rate exceeded the safe-send threshold.',                group: 'sequencer',      default_enabled: true  },
    { event_type: 'campaign.unsubscribe_spike',           label: 'Unsubscribe-rate spike',                description: 'Campaign unsubscribe rate exceeded the safe threshold.',                group: 'sequencer',      default_enabled: true  },
    { event_type: 'campaign.send_blocked.postal_address', label: 'Send blocked: missing postal address', description: 'Sender does not have a postal address configured; sends paused.',       group: 'sequencer',      default_enabled: true  },
    { event_type: 'campaign.send_blocked.no_mailboxes',   label: 'Send blocked: no healthy mailboxes',   description: 'No mailboxes available for the campaign; sends paused.',                group: 'sequencer',      default_enabled: true  },

    // ── Warmup ─────────────────────────────────────────────────────────
    { event_type: 'mailbox.warmup_graduated',             label: 'Mailbox graduated from warmup',         description: 'A mailbox finished warmup and is ready for full sending.',              group: 'warmup',         default_enabled: true  },

    // ── Imports ────────────────────────────────────────────────────────
    { event_type: 'import.csv_completed',                 label: 'CSV import completed',                  description: 'A CSV lead import finished.',                                           group: 'imports',        default_enabled: true  },
    { event_type: 'import.api_completed',                 label: 'API import completed',                  description: 'A public-API lead import finished.',                                    group: 'imports',        default_enabled: false },
    { event_type: 'import.instantly_completed',           label: 'Instantly import completed',            description: 'An Instantly migration import finished.',                               group: 'imports',        default_enabled: true  },
    { event_type: 'import.smartlead_completed',           label: 'Smartlead import completed',            description: 'A Smartlead migration import finished.',                                group: 'imports',        default_enabled: true  },

    // ── Load balancing ─────────────────────────────────────────────────
    { event_type: 'load_balancing_report',                label: 'Load-balancing report',                 description: 'Periodic summary of mailbox distribution across campaigns.',            group: 'load_balancing', default_enabled: false },
    { event_type: 'load_balancing_add',                   label: 'Mailbox added to campaign',             description: 'Auto-redistribution attached a mailbox to a campaign.',                 group: 'load_balancing', default_enabled: false },
    { event_type: 'load_balancing_remove',                label: 'Mailbox removed from campaign',         description: 'Auto-redistribution detached a mailbox from a campaign.',               group: 'load_balancing', default_enabled: false },

    // ── Predictive ─────────────────────────────────────────────────────
    { event_type: 'predictive_risk',                      label: 'Predictive risk identified',            description: 'Forward-looking signal flagged a campaign as trending risky.',          group: 'predictive',     default_enabled: true  },
    { event_type: 'predictive_action_add',                label: 'Predictive recommendation (add)',       description: 'Predictive layer recommended adding a mailbox/lead/etc.',               group: 'predictive',     default_enabled: false },
    { event_type: 'predictive_action_remove',             label: 'Predictive recommendation (remove)',    description: 'Predictive layer recommended removing a mailbox/lead/etc.',             group: 'predictive',     default_enabled: false },

    // ── Billing ────────────────────────────────────────────────────────
    { event_type: 'billing.payment_failed',               label: 'Payment failed',                        description: 'A subscription invoice failed to charge.',                              group: 'billing',        default_enabled: true  },
    { event_type: 'billing.subscription_canceled',        label: 'Subscription canceled',                 description: 'A subscription was canceled (by user or system).',                      group: 'billing',        default_enabled: true  },

    // ── Trial ──────────────────────────────────────────────────────────
    { event_type: 'trial.expiring_soon',                  label: 'Trial expiring soon',                   description: 'A trial will expire within the warning window.',                        group: 'trial',          default_enabled: true  },
    { event_type: 'trial.expired',                        label: 'Trial expired',                         description: 'A trial just expired.',                                                 group: 'trial',          default_enabled: true  },
];

export function findEventDef(eventType: string): SlackEventDef | undefined {
    return SLACK_EVENT_CATALOG.find(e => e.event_type === eventType);
}

export function defaultPreferenceForEvent(eventType: string): boolean {
    return findEventDef(eventType)?.default_enabled ?? true;
}
