import type { Asset, AssetClassPreset, AssetCreateInput, AssetPatch, AssetRule, Sphere } from './assets.js';
import type { Commitment } from './work-entities.js';
import type { SituationDismissal, SituationRef, SituationResult } from './situation.js';
import type { Episode, EpisodeInput, Occasion, OccasionInput, RetainedHistoryEvidence } from './proactive-history.js';
import type { AssetDocumentDetails } from './asset-documents.js';

/** D-339 slice 15 adds `goal`: a body goal that looks reached, for the owner to mark (D-342 §17). */
export const PROACTIVE_PROPOSAL_KINDS = ['asset', 'link', 'merge', 'close', 'rule', 'schedule', 'occasion', 'last_done', 'trip', 'recall', 'completion', 'ranking', 'relation', 'habit', 'goal'] as const;
export type ProactiveProposalKind = typeof PROACTIVE_PROPOSAL_KINDS[number];
export type ProactiveProposalLane = 'likely_asset' | 'gift' | 'return' | 'pickup' | 'bundle';
export interface ProactiveProposal {
  id: string;
  key: string;
  kind: ProactiveProposalKind;
  title: string;
  explanation: string;
  state: 'proposed' | 'accepted' | 'dismissed' | 'retracted';
  payload: Record<string, unknown>;
  sources: SituationRef[];
  confidence: 'high' | 'medium' | 'low';
  lane?: ProactiveProposalLane;
  merchant?: string;
  subject?: SituationRef;
  origin: 'intake' | 'owner' | 'learner' | 'pack';
  result?: SituationRef;
  dismissal?: SituationDismissal | 'not_an_asset';
  created_at: number;
  updated_at: number;
  edited_at?: number;
  shown_at?: number;
}
export type ProactiveProposalInput = Pick<ProactiveProposal, 'key' | 'kind' | 'title' | 'explanation' | 'payload' | 'sources' | 'confidence' | 'origin'>
  & Partial<Pick<ProactiveProposal, 'lane' | 'merchant' | 'subject'>>;
export interface ProactiveSuppression {
  id: string;
  kind: 'person' | 'place' | 'date_range' | 'episode' | 'proposal_kind' | 'merchant';
  value?: string;
  from?: number;
  to?: number;
  created_at: number;
  /** A hidden or deleted episode's title, so its exclusion is listed by name. */
  label?: string;
  /** On a row that stands for one item of a hidden episode's evidence: that episode's
   *  id. It is listed with, and removed with, the episode's own row. */
  of?: string;
}
export interface YoursOccurrence {
  id: string;
  asset_id: string;
  subject_kind?: 'asset' | 'occasion';
  rule_id: string;
  /** The commitment's statement, or the subject and rule for a notice. */
  title: string;
  /** The day it falls due, when the clock knows one. */
  due_on: string | null;
  question: boolean;
  commitment: Commitment | null;
  current_ask_id: string | null;
  later_until: number | null;
  /** A forwarded proof can propose closing it (§5.3): an open action of an
   *  expiry or interval rule. Absent otherwise, and from an older server. */
  closes_by_proof?: true;
  /** §15.7 (2026-10-24) — an open renewal, such as a passport's: a later date closes it,
   *  so Due asks for that date (`occurrence.renewed`) instead of offering Done. `current`
   *  is the date it replaces. Absent otherwise, and from an older server. */
  renewal?: { field: string; current: string };
}
export interface YoursSourceControl { id: string; name: string; enabled: boolean; proposals: number }
/** D-342 — what the owner is working toward, kept as an asset of this built-in class. Its own
 *  facts are `attributes.horizon` / `why` / `where_i_am`, `dates.target_on` and
 *  `readings.progress`; the Pursuits tab lists them and the Assets tab leaves them out. */
export const PURSUIT_CLASS_ID = 'pursuit';
/** How a pursuit ended, kept on it as `attributes.ended_as` (D-342 ruling 8). A pursuit ended
 *  with its parent has none. */
export const PURSUIT_ENDINGS = ['reached', 'let_go'] as const;
export type PursuitEnding = typeof PURSUIT_ENDINGS[number];
/** D-342 — `only` reads pursuits alone, `exclude` every asset but them. */
export type YoursPursuitsFilter = 'only' | 'exclude';
/** D-343 slice 5 — a pursuit's activity, from the owner's closing records: the day they last recorded
 *  doing it (YYYY-MM-DD on the server's clock), and on how many days of the last 30 they did. A
 *  skipped record is not activity, and a day they recorded nothing about is unknown, so this is no
 *  streak (D-343 §3.5). */
export interface YoursPursuitActivity { last_on: string; days_30: number }
export type YoursAssetFilter = 'missing_facts' | 'overdue';
export type YoursAssetSphere = Sphere | 'unsorted';
/** Read-only projection of the displayed asset's rules and canonical tasks. */
export interface YoursAssetSummary {
  asset_id: string;
  open_tasks: number;
  active_rules: number;
  /** Earliest unsettled due day, including an overdue obligation. */
  next_due: { on: string; title: string; rule_id: string; commitment_id?: string;
    state: 'overdue' | 'today' | 'upcoming'; estimated: boolean } | null;
  missing: Array<{ path: `${'dates' | 'readings' | 'observations'}.${string}`;
    reason: 'unknown' | 'future' | 'unconfirmed' }>;
}
/** The household's Telegram group. D-325 §15.7 (2026-10-24) — it only receives:
 *  reminders are posted there without buttons and nothing sent back answers, so it
 *  names no owner or member ids. A selection saved before also carried those. */
export interface HouseholdTelegramSelection {
  connection_name: string; connection_enrolled_at: number; recipient: string; selected_at: number;
}
/** Every list only shows its tasks (D-325 §15.7, 2026-10-24). A selection saved before
 *  also carries a `mode`, which nothing reads; it stays as stored, since the tasks' scope
 *  is a hash of the selection and changing it would remove and post them again. */
export interface HouseholdHomeAssistantSelection {
  connection_name: string; connection_enrolled_at: number; base_url: string; entity_id: string; selected_at: number;
}
/** A to-do list a Home Assistant connection offers, so Settings can offer it by name
 *  instead of asking for its id (D-325 §15.7 amendment). `usable`: Recued can keep its
 *  tasks there, and `reason` says why not. Every list only shows them (2026-10-24). */
export interface HouseholdHomeAssistantList { entity_id: string; name: string; usable: boolean; reason?: string }
/** A "last time" class's measured dark run (§9) and the owner's bar for it (P11). */
export interface YoursRecallRate { class_id: string; scored: number; relevant: number; rate: number; minimum_rate: number | null; qualified: boolean }
/** §15.7 — what Settings → Privacy → Learning shows of "last time" (P21), read
 * without the refreshes a Yours snapshot runs. */
export interface YoursLearningStatus {
  last_time: 'unasked' | 'on' | 'off';
  /** The once-only question waits in the bell. */
  asked: boolean;
  classes: YoursRecallRate[];
}
/** D-339 slices 7b and 9 (2026-11-17) — one reading's recent days on the open asset's page, drawn as
 *  a sparkline beside it: a point a day (the day's last value, in the owner's zone), oldest first, in
 *  the reading's current unit, over the last `days` days, today included. Three lenses go with it
 *  (`backend/server/src/situations/asset-reading-trends.ts`), each absent when too few days hold it:
 *  - `usual`, what the latest is read against: the median ± the median absolute deviation of the
 *    days before the latest, over the asset's last `usual.days` (`baseline_days`), as the `baseline`
 *    transform and the Body's states compute it;
 *  - `trend`, which way the line goes (the `trend` transform): its change a week, in the reading's
 *    unit, and the days its points span;
 *  - `averages`, the mean of the last 7 and 30 days, each with the period before it when that holds
 *    enough days.
 *  An older server sends neither `days` (it drew 30) nor the slice-9 fields. */
export interface YoursReadingTrend {
  field: string;
  unit: string;
  days?: number;
  /** A point a day. `day` (D-339 slice 11) is the day it is for, as the server counted it: a Body's
   *  Records day, else the owner's day of `at`. A page that labels days uses it, since `at` (a Body
   *  day's start, in the zone it was recorded in) can fall on another day in the browser's zone.
   *  Absent from older servers. */
  points: Array<{ at: number; value: number; day?: string }>;
  usual?: { median: number; low: number; high: number; days?: number };
  trend?: { direction: 'rising' | 'falling' | 'steady'; per_week: number; days: number };
  averages?: Array<{ days: number; value: number; previous?: number }>;
}
/** D-339 slice 14 — a reading on a Body that has probably changed since it was measured:
 *  - `weight_moved`: a body measure (body fat, lean body mass, muscle mass, waist) whose weight has moved
 *    by at least the Body's `stale_weight_change_kg` since the day it was measured;
 *  - `too_old`: past its days (`stale_after_days` for a body measure, `stale_weight_days` for weight);
 *  - `growing`: a height measured more than `stale_height_days` ago, for someone under 18.
 *  `day` is the day it is for, `days_old` how long ago that was on the owner's clock. */
export interface YoursReadingStale {
  field: string;
  reason: 'weight_moved' | 'too_old' | 'growing';
  day: string;
  days_old: number;
  /** For `weight_moved`: the weight on that day, and the latest. */
  weight_then?: { value: number; unit: string };
  weight_now?: { value: number; unit: string };
}
export interface YoursSnapshot {
  assets: Asset[];
  /** D-325 — host comparisons for the open asset only, using this read's saved
   * inputs. Absent on lists, plain facts and older servers. No rule verdicts. */
  reading_comparisons?: { asset_id: string; rules: Array<{ rule_id: string; comparison: import('./asset-fact-context.js').AssetReadingComparison }> };
  /** D-339 slice 7b — the open asset's readings with two or more days in the last 30. Absent on
   *  lists, for an asset with none, and from an older server. */
  reading_trends?: { asset_id: string; readings: YoursReadingTrend[] };
  /** D-339 slice 14 — the open Body's readings that have probably changed since they were measured.
   *  Absent for another asset, a Body with none, and from an older server. */
  reading_staleness?: { asset_id: string; readings: YoursReadingStale[] };
  /** D-339 slice 15 — the body goals this read shows, each worked out from its Body: on the Pursuits tab,
   *  a goal's own page, and a Body's page (the goals on it). */
  goal_progress?: import('./body-goals.js').BodyGoalProgress[];
  /** D-339 slice 12a — on a Body's page: the owner's chats' switch for every Body's numbers, Off · Ask ·
   *  Allow. Absent for another asset, and from an older server, whose Body page then shows no switch. */
  body_numbers?: { chats: import('./body-numbers.js').BodyNumbersMode };
  /** §15.3 — the open asset's holder by name; `name` is null for a contact no longer
   *  on file. Absent for a list, an asset with no holder, and from an older server. */
  holder?: { contact_id: string; name: string | null };
  /** Summaries cover only assets on this page; older servers may omit them. */
  asset_summaries?: YoursAssetSummary[];
  related_assets: Asset[];
  /** Matching assets before pagination, including search, attention and sphere filters. */
  total_assets: number;
  /** Echoes an applied filter. Unreadable summaries are excluded and counted. */
  asset_filter?: { kind: YoursAssetFilter; unavailable: number };
  /** Echoes the applied resolved-sphere filter; older servers may omit it. */
  asset_sphere?: YoursAssetSphere;
  /** D-342 — echoes the applied pursuits filter. A server older than it ignores the request
   *  and omits this, and its list then holds every asset. */
  pursuits?: YoursPursuitsFilter;
  /** D-343 slice 5 (D-342 §7) — on a read that lists pursuits or opens one: when the owner last
   *  recorded working on each, from their closing records, by its id. A pursuit never recorded
   *  done has no entry. Absent from a server older than the slice, whose pursuit page then shows
   *  no history: its `episodes` are not the pursuit's. */
  pursuit_activity?: Record<string, YoursPursuitActivity>;
  classes: AssetClassPreset[];
  proposals: ProactiveProposal[];
  total_proposals: number;
  matching_proposals?: number;
  occurrences: YoursOccurrence[];
  /** The `+done` address of each mailbox whose mail can propose: forwarding the
   *  email that proves a renewal or service there, from that mailbox, proposes
   *  closing its open task. Absent from an older server. */
  proof_addresses?: string[];
  occasions: Occasion[];
  /** D-407 slice 3 — this server keeps each occasion's own privacy (`Occasion.private`, `occasionIsPrivate`).
   *  Absent from an older server, which stores the field unread: the app then offers no Private choice. */
  occasion_privacy?: true;
  /** D-407 slice 2 — this server keeps an occasion that comes back whenever the last one says (`Occasion.after_each`)
   *  and takes "When is the next one?" (`occasion.next`). Absent from an older server: the app offers neither. */
  occasion_next?: true;
  /** D-407 — this server sends an occasion's alert before its time (`Occasion.alert_minutes`). Absent from an older
   *  server: the app offers none. */
  occasion_alert?: true;
  /** D-407 slice 4 — this server writes an occasion's own calendar event (`Occasion.in_calendar`, the calendar in
   *  `settings.occasion_calendar`). Absent from an older server: the app offers neither. */
  occasion_calendar_events?: true;
  /** D-407 slice 4 — each occasion's own event as last written, by occasion id: absent where it has none. `error` says
   *  why the last write failed, and it is tried again. */
  occasion_events?: Record<string, { name: string; error?: string;
    /** D-407 slice 5 (U2) — the event is one the occasion holds but did not write, as a clinic's invite: its title and
     *  start, who sent it, and the title of the booking the same invite made. One appointment, never three records. */
    appointment?: { title: string; start_at: number; is_all_day: boolean; organizer?: string; booking?: string } }>;
  episodes: Episode[];
  /** When a visible episode anchor is on a different page, this is the offset of the returned episode page. */
  episode_page_offset?: number;
  derived_episodes?: EpisodeInput[];
  recall_rates?: YoursRecallRate[];
  history_receipts?: Array<{ mailbox: string; cutoff: number; at: number; candidates: number }>;
  history_evidence?: RetainedHistoryEvidence[];
  /** A connection's `display_name` is what Settings calls it; absent from an older
   *  server, which leaves the connection's own name. */
  /** `telegram_connections`: the Telegram connections bound to a group, any of which
   *  can be the household's. */
  household?: { telegram: HouseholdTelegramSelection | null; telegram_connections: Array<{ name: string; enrolled_at: number; recipient: string; display_name?: string }>;
    /** The assets whose reminders reach the household, so Settings can name them
     *  (D-325 §15.7 amendment): the first few by name, and how many in all. Absent
     *  from an older server. */
    shared_assets?: { assets: Array<{ id: string; name: string }>; total: number };
    home_assistant?: { selection: HouseholdHomeAssistantSelection | null; connections: Array<{ name: string; enrolled_at: number; display_name?: string }>; issue: string | null; uncertain: number } };
  sources: YoursSourceControl[];
  suppressions: ProactiveSuppression[];
  /** §15.4 — what the owner hid from Today and the brief, to restore. */
  situation_dismissals?: Array<{ key: string; scope: 'item' | 'kind'; code: Exclude<SituationDismissal, 'wrong'>; label: string; kind: string; until: number | null; at: number }>;
  intake: { emails_read: number; receipts_found: number; likely_assets: number; last_scan_at: number | null };
  unmatched_replies: Array<{ id: string; text: string; reason: string; created_at: number }>;
  subscriber_issues?: Array<{ subscriber_id: string; revision: number; run_id: string; state: string; at: number }>;
  subscribers?: Array<{ trigger_id: string; recipe_id: string; pattern: string; contract_id?: string }>;
  subscriber_contracts?: Array<{ id: string; name: string }>;
  observation_recipes?: Array<{ id: string; name: string; publisher: string; hash: string }>;
  /** D-404 slice E — on a thing's page (`asset_id`), the installed recipes that work on things of its
   *  type (a setting that takes a thing of it, a type of the same name included), by name. Absent on
   *  the list, and from an older server. */
  thing_recipes?: Array<{ id: string; name: string }>;
  observation_bindings?: Array<{ id: string; asset_id: string; actor_ref: string; source_ref: string; fields: string[]; enabled: boolean; available?: boolean; recipe_hash?: string }>;
  observation_handoffs?: Array<{ id: string; path: string; at: number;
    value: Asset['readings'][string] | Asset['observations'][string]; source: Asset['field_sources'][string] }>;
  phone_ready: boolean;
  settings: { digest: 'daily' | 'weekly' | 'off'; last_time: 'unasked' | 'on' | 'off'; measures: boolean;
    /** D-407 slice 4 (Q3) — the one calendar occasions put their events in, chosen once by the owner, never by the AI;
     *  `null` or absent: none chosen, so every occasion is Recued only. `keeps_private: false` once the calendar
     *  dropped an event's private marking: private occasions are not written there. */
    occasion_calendar?: OccasionCalendarChoice | null };
  situations?: SituationResult;
  delivery?: import('./situation.js').SituationDeliveryStatus;
  sphere_placements: Array<{ ref: SituationRef; sphere?: Sphere; reason: string; pinned: boolean; source?: string }>;
  sphere_sources?: Array<{ source: string; name: string; sphere?: Sphere }>;
  retirement_impact?: { parts: number; contracts: number; open_occurrences: number };
}
export interface YoursReadRequest { asset_id?: string; occasion_id?: string; episode_id?: string; contact_id?: string; trace_id?: string; include_derived?: boolean; search?: string; asset_filter?: YoursAssetFilter; asset_sphere?: YoursAssetSphere; pursuits?: YoursPursuitsFilter; offset?: number; limit?: number; proposal_offset?: number; proposal_kind?: ProactiveProposalKind; include_closed?: boolean; include_asset_summaries?: boolean; mark_shown?: boolean;
  /** D-339 slice 7b — with `asset_id`, the open asset's 30-day `reading_trends`, for its page. Asked for
   *  by the page alone, so no other read pays for it; an older server ignores it. */
  include_reading_trends?: boolean;
  /** On the Episodes list, follow this stored episode if its date moved it away from the requested page. */
  episode_anchor?: string }
export interface YoursSpherePlacement { sphere?: Sphere; reason: string; pinned: boolean; source?: string }
/** Owner UI controls. Grant creation remains in Contracts. These commands
 * cannot run recipes, mint grants, or accept a standing delegation. */
/** D-407 slice 4 (Q3) — the calendar occasions put their events in: a connected calendar's `slug` and `calendar_id` as
 *  `collection.calendar.event.destinations` lists it, and its name. */
export interface OccasionCalendarChoice { slug: string; calendar_id: string; name: string; keeps_private?: false }

export type YoursCommand =
  | import('./asset-fact-context.js').AssetAttributeReadingCommand
  | import('./asset-fact-context.js').AssetAddEvidenceCommand
  | { action: 'asset.create'; input: Omit<AssetCreateInput, 'source'>; class_id?: string }
  | { action: 'asset.update'; id: string; patch: AssetPatch; confirm_retirement?: boolean }
  /** D-339 slice 15 — set a goal on a Body's reading, or change the one it has (`pursuit_id`). The
   *  server takes the start and the unit from the Body; a new goal is a pursuit with the Body's privacy. */
  | { action: 'goal.set'; asset_id: string; reading: import('./body-goals.js').BodyGoalField; target: number; pursuit_id?: string;
    name?: string; target_on?: string | null; why?: string | null }
  /** D-339 slice 16 — set the owner's own range for a Body's reading, say it is still right (the same
   *  bounds again), or remove it (both null). The unit is the Body's reading's; the day is today. */
  | { action: 'range.set'; asset_id: string; reading: import('./body-goals.js').BodyGoalField; low: number | null; high: number | null }
  | { action: 'asset.automatic_updates'; id: string; path: string;
    expected: { value: Asset['readings'][string] | Asset['observations'][string]; source: Asset['field_sources'][string] } }
  | { action: 'asset.delete'; id: string; confirmed: boolean }
  | { action: 'asset.link'; id: string; parent_id: string | null }
  | { action: 'asset.same_thing'; id: string; other_id: string; merge: boolean }
  | { action: 'class.save'; preset: AssetClassPreset; create?: boolean }
  | { action: 'class.delete'; id: string }
  | { action: 'class.apply'; asset_id: string; class_id: string }
  | { action: 'proposal.create'; proposal: ProactiveProposalInput }
  | { action: 'proposal.edit'; id: string; title?: string; payload?: Record<string, unknown> }
  | { action: 'proposal.accept'; ids: string[] }
  | { action: 'proposal.dismiss'; id: string; code: SituationDismissal | 'not_an_asset'; correction?: { asset_id: string; patch: AssetPatch }; episode_correction?: EpisodeInput }
  | { action: 'proposal.delete'; id: string }
  | { action: 'source.set'; id: string; enabled: boolean }
  | { action: 'merchant.stop'; merchant: string }
  | { action: 'intake.forget'; confirmed: boolean }
  | { action: 'intake.scan' }
  | { action: 'occurrence.last_done'; id: string; on: string | null }
  | { action: 'occurrence.later'; id: string; until: number }
  | { action: 'occurrence.renewed'; id: string; on: string }
  | { action: 'occurrence.acknowledge'; id: string }
  | { action: 'rule.save'; asset_id: string; rule: AssetRule; confirm_floor_mute?: boolean }
  | { action: 'rule.delete'; asset_id: string; rule_id: string; confirm_floor_delete?: boolean }
  | { action: 'suppression.save'; suppression: Omit<ProactiveSuppression, 'id' | 'created_at'> }
  | { action: 'suppression.delete'; id: string }
  | { action: 'sphere.source'; source: string; sphere: Sphere | null }
  | { action: 'sphere.item'; ref: SituationRef; sphere: Sphere | null }
  | { action: 'unmatched.dismiss'; id: string }
  | { action: 'occasion.save'; occasion: OccasionInput; confirm_floor_mute?: boolean }
  | { action: 'occasion.delete'; id: string; confirm_floor_delete?: boolean }
  /** D-407 slice 5 (§4.1, Q4, Q5) — the *Occasion* tick on a calendar event: wraps a new occasion around the event, or
   *  with `occasion_id` makes the event the next one of an occasion waiting for its date. `private` is the tick's
   *  *Private*. On an event an occasion already holds, it changes that occasion's privacy only. The event itself is
   *  never written: it stays the calendar's (a clinic's invite), and the occasion follows it. Offered only where the
   *  event's snapshot carries `occasion` (`CalendarEventOccasion`). */
  | { action: 'occasion.adopt_event'; slug: string; source_id: string; occasion_id?: string; private: boolean }
  /** D-407 slice 5 — the tick taken off: the event is let go and stays in its calendar. An occasion the tick made goes
   *  with it; one it was the next of goes back to waiting for its next date. */
  | { action: 'occasion.release_event'; slug: string; source_id: string }
  /** D-407 slice 2 — "When is the next one?" answered: its date, or `null` for "No next one". */
  | { action: 'occasion.next'; id: string; on: string | null;
    /** Its time of day, HH:mm, on the occasion's zone (else the server's); `null` makes it a day. Absent: as it was. */
    time?: string | null }
  | { action: 'episode.save'; episode: EpisodeInput }
  | { action: 'episode.delete'; id: string; suppress?: boolean }
  /** P44 — hide an episode where it is cited, stored or assembled: it is never shown
   *  or suggested from again (P17) until its exclusion is removed. */
  | { action: 'episode.hide'; id: string }
  | { action: 'recall.class'; class_id: string; minimum_rate: number }
  | { action: 'history.forget'; confirmed: boolean }
  /** An older webclient also sends the group's member ids, which are not read (D-325 §15.7, 2026-10-24). */
  | { action: 'household.telegram'; connection_name: string | null; connection_enrolled_at?: number }
  | { action: 'household.home_assistant'; connection_name: string | null; connection_enrolled_at?: number; entity_id?: string }
  | { action: 'place.save'; name: string; key?: string; aliases: string[] }
  /** `from: 'today'` — the owner opened an item Today showed, which the learner counts
   *  as acting on its kind (D-325 §8). */
  | { action: 'navigation.open'; ref: SituationRef; from?: 'today' }
  /** §15.4 — a coded answer to an item Recued put in a cluster, from Today. */
  | { action: 'situation.dismiss'; ref: SituationRef; kind: string; code: SituationDismissal; label: string }
  | { action: 'situation.restore'; key: string }
  | { action: 'trip.save'; trip: import('./situation.js').TripDetails }
  | { action: 'binding.save'; asset_id: string; recipe_id: string; fields: string[]; expected_recipe_hash?: string }
  | { action: 'binding.disable'; asset_id: string; id: string }
  /** D-339 slice 19 — set up a Body's summary: `summarize-body-signals` enrolled as its writer for every reading and
   *  condition, at the installed version, and a dish of it switched on with the Body and that binding. Adding a Body
   *  does it by itself; this is for a Body added before, or one whose summary was enrolled for an older version. */
  | { action: 'body.summary.setup'; asset_id: string }
  /** D-339 slice 20 — set up a Wearable's sync check: `check-wearable-sync` enrolled as its writer, a dish of it
   *  switched on with the Wearable and that binding, and a schedule each day. Done by itself once the Wearable
   *  belongs to a Body; this is for one whose check is not ready. */
  | { action: 'wearable.check.setup'; asset_id: string }
  | { action: 'file.attach'; asset_id: string; record_id: string }
  | { action: 'file.details'; asset_id: string; link_id: string; record_id: string; details: AssetDocumentDetails }
  | { action: 'file.detach'; asset_id: string; link_id: string; record_id: string }
  | { action: 'delivery.update'; settings: Partial<import('./situation.js').SituationDeliverySettings> }
  | { action: 'delivery.send_now' }
  /** §15.7 amendment (2026-11-02, later) — the Agenda's settings and Send now. An older server
   *  refuses both as an unknown change; a client offers them only to a server that answers
   *  `yours.agenda`. */
  | { action: 'agenda.update'; settings: Partial<import('./situation.js').SituationAgendaSettings> }
  | { action: 'agenda.send_now' }
  /** D-343 slice 4 — Close the day's settings and Send now, and Today's "Close the day", which opens
   *  a conversation holding today's evening notice (`conversation` in the result). An older server
   *  refuses each as an unknown change; a client offers them only to a server that named them
   *  (`SituationAgendaStatus.close_day`, `ProactiveToday.close_day`). */
  | { action: 'close_day.update'; settings: Partial<import('./situation.js').SituationCloseDaySettings> }
  | { action: 'close_day.send_now' }
  | { action: 'close_day.open' }
  | { action: 'close_day.retry_reply'; id: string }
  | { action: 'close_day.review_reply'; id: string }
  /** D-340 slice 2 — a stream's settings, its Send now, and the preview of its next message (§3.7;
   *  `preview` in the result). An older server refuses each as an unknown change; a client offers
   *  them only to a server that named its streams (`SituationAgendaStatus.streams`). */
  | { action: 'stream.update'; stream: import('./situation.js').SituationStreamKind; settings: Partial<import('./situation.js').SituationStreamSettings> }
  | { action: 'stream.send_now'; stream: import('./situation.js').SituationStreamKind }
  | { action: 'stream.preview'; stream: import('./situation.js').SituationStreamKind }
  | { action: 'subscriber.reconciled'; subscriber_id: string; revision: number; run_id: string }
  | { action: 'subscriber.contract'; trigger_id: string; contract_id: string | null }
  | { action: 'settings.update'; digest?: 'daily' | 'weekly' | 'off'; last_time?: 'on' | 'off'; measures?: boolean;
    /** D-407 slice 4 — the calendar occasions put their events in; `null` for none (Recued only). */
    occasion_calendar?: Pick<OccasionCalendarChoice, 'slug' | 'calendar_id' | 'name'> | null };
export interface YoursCommandResult { message: string; id?: string; changed?: number; failed?: Array<{ id: string; reason: string }>;
  /** D-343 slice 4 — `close_day.open`: the conversation it made, and its notice, which the app's
   *  reply quotes. */
  conversation?: { session_id: string; message_id: string; title: string; text: string };
  /** D-340 slice 2 — `stream.preview`: the stream's next message as it would go now. */
  preview?: import('./situation.js').SituationStreamPreview }
