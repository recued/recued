import type { AssetEvidence, AssetStatus, Sphere } from './assets.js';
import type { Commitment } from './work-entities.js';
import type { NotificationDeliveryChannel } from './notifications.js';
import { ASSET_FACT_CONTEXT_REQUEST_SCHEMA, type AssetFactContext, type AssetFactContextRequest } from './asset-fact-context.js';
import { calendarDayMs, dueSpan } from './due-day.js';

export const SITUATION_CONTEXT_MAX_BYTES = 6000;
/** At most this many items in one `situation.query` result. The tool returns every match up to
 *  it, where the owner's surfaces show three a group: a trip for eight travellers lists all eight
 *  passports. Past it, `omitted` counts the rest and the caller narrows the query. */
export const SITUATION_TOOL_MAX_ITEMS = 100;

export type SituationBasis = 'declared' | 'derived' | 'inferred';
export type SituationVerdict = 'match' | 'near' | 'outside' | 'unknown';
/** `ended`: a trip, event or booking already over, returned only to a question
 * about a span that reaches back over it, never to a forward list. */
/** `holds` (D-340 §4): a state, shown while it holds. Never `due` and never news, so the
 * Agenda, Coming up and reminders leave it out.
 * `pursuing` (D-342 §5): an active pursuit, what the owner is working toward, given only to the
 * read that asks for them (`include_pursuits`). Never `due` and never news. */
export type SituationReason = 'due' | 'collides' | 'related' | 'missing' | 'last_time' | 'ended' | 'holds' | 'pursuing';
export interface SituationRef { collection: string; id: string; field?: string }
export interface SituationPlace { key: string; name: string }
export interface SituationDimension<T> {
  value: T | null;
  verdict: SituationVerdict;
  basis: SituationBasis;
  evidence: AssetEvidence[];
}
export interface SituationWindow { from: number; to: number }
export interface TripDetails {
  subject: SituationRef;
  destination_country?: string;
  travellers: string[];
  entry_on?: string;
  exit_on?: string;
  /** A generic short-stay table cannot decide special residence/family routes. */
  special_entry_status?: boolean;
}
/** An asset's own fields as the owner entered them, on every item the asset
 * produced, so a model reads them beside its clocks: a passport's nationality,
 * a car's odometer, any attribute the owner added. Plain values only, within a
 * size cap; a structured value or a field past the cap is named in `left_out`,
 * and text past its own cap says how much it lost. Identifying strings and
 * anchors stay out: the asset's record holds them, where egress aliases them.
 * Settings and attributes keep the asset's own map shape, and egress scans
 * their text as content here and on the asset's own read alike. */
export interface SituationAssetDetails {
  class_id?: string;
  status: AssetStatus;
  /** A null date or reading is explicitly unknown, as on the asset. */
  dates?: Record<string, string | null>;
  readings?: Record<string, { value: number; unit: string; as_of: number } | null>;
  settings?: Record<string, string | number | boolean>;
  /** An unset attribute its type names (a pursuit's Where I am, D-342) is null: unknown, as a date
   *  can be, so a model that changes it has its name. */
  attributes?: Record<string, string | number | boolean | null>;
  left_out?: string[];
  /** D-339 slice 6 (§5.3) — an asset whose values a model reads only when the owner allows it (a
   *  Body): the names of its readings and states, in place of `readings`, which it then lacks. Since
   *  slice 13, its dates and details too (a birth date, a gender), in place of `dates` and
   *  `attributes`; each list only when the asset has some. */
  values_on_request?: { readings: string[]; states: string[]; dates?: string[]; attributes?: string[];
    /** D-339 slice 15 — a body goal's reading, in words, when the goal is held. */
    goal?: string;
    /** D-339 slice 16 — the readings the owner set a range for, in words, when the Body is held. */
    ranges?: string[]; how: string };
  /** D-339 slice 15 (D-342 §17) — a pursuit's body goal: the reading in words, its target, where it
   *  started, and, where the read can work it out, where the Body is now. */
  goal?: SituationGoalDetails;
  /** D-339 slice 16 — the owner's own ranges on a Body: its normal for a reading, and the day it was set. */
  ranges?: Array<{ reading: string; low?: number; high?: number; unit: string; set_on: string }>;
}
export interface SituationGoalDetails {
  reading: string;
  target: { value: number; unit: string };
  start: { value: number; day: string };
  now?: { value: number; day: string };
  to_go?: number;
  /** In the goal's unit a week, above 0 toward the target. */
  per_week?: number;
  weeks_left?: number;
  looks_reached?: true;
}
/** D-343 slice 5 (§5) — the days of the last week, on the owner's clock, that they recorded doing or
 *  skipping a pursuit in Close the day, newest first, each as its weekday and date ("Thu
 *  2026-11-05"). A day listed in neither is one they did not record: unknown, never a day they
 *  missed (§3.5). Absent when they recorded none. */
export interface SituationRecordedDays { done: string[]; skipped: string[] }
export interface SituationQuery {
  time: number | SituationWindow;
  place?: SituationPlace;
  people?: string[];
  subjects?: SituationRef[];
  text?: string;
  changed_since?: number;
  surface?: 'tool' | 'today' | 'digest' | 'prefetch' | 'push';
  /** Last-time is available only to the opted-in digest caller. */
  include_last_time?: boolean;
  /** D-342 §5 — host-only: the read lists the owner's active pursuits beside the window, each a
   *  `pursuit` item with the reason `pursuing`. Only the Agenda suggestions' own run sets it. */
  include_pursuits?: boolean;
  limit_clusters?: number;
  limit_items?: number;
}
/** An adapter's minimum fact, never a copy of an entire source record. */
export interface SituationFact {
  ref: SituationRef;
  title: string;
  kind: string;
  basis: SituationBasis;
  when?: SituationWindow;
  /** A declared whole day retains its label across caller timezones. The
   * window still supplies actual instants for overlap and verdict arithmetic. */
  when_day?: string;
  act_by?: number;
  place?: SituationPlace;
  people: string[];
  subjects: SituationRef[];
  related: SituationRef[];
  /** A computed clock can describe an existing canonical obligation. */
  represents?: SituationRef;
  evidence: AssetEvidence[];
  updated_at: number;
  consequence: 'routine' | 'floor';
  sphere?: Sphere;
  /** Time-limited context, such as a trip, expires with the source event. */
  valid_until?: number;
  missing?: boolean;
  last_time?: boolean;
  /** The anniversary-aligned comparison preserves the actual historical
   * when value while judging its season against the caller's window. */
  last_time_comparison?: SituationWindow;
  trip?: TripDetails;
  travel_document?: { holder?: string; issued_on?: string | null; expires_on?: string | null; nationality?: string };
  /** A visa, which a trip check names for its holder (`people`): its own name and the
   * country and expiry its owner recorded. Whether it covers a trip is the reader's call. */
  visa?: { name: string; valid_for?: string; expires_on?: string };
  /** The one bounded copy a fact may carry: an asset's own fields. */
  details?: SituationAssetDetails;
  /** D-343 slice 5 (§5) — a pursuit's closing records over the last week, for the read that lists
   *  pursuits (`include_pursuits`). Read-time context, like `details`. */
  recorded?: SituationRecordedDays;
  /** Native request for this rule's graph; identity only, no relationship read. */
  context?: AssetFactContextRequest;
}
export interface SituationItem {
  ref: SituationRef;
  kind: string;
  /** The owner's notifications name it only as "a reminder in Yours": an occasion the owner keeps
   * private (`occasionIsPrivate`, D-407 slice 3) and its calendar series, a sensitive asset, an
   * event its own calendar marks private (D-407 Q8), or an item that cites one (the Agenda's
   * rule). Set only on the copy a model reads, beside its title: the chat's and a recipe's or an
   * MCP app's (the kernel `situation-query`). */
  private?: true;
  what: SituationDimension<string>;
  when: SituationDimension<SituationWindow>;
  /** When it happens, written for a model on the turn's clock (`2026-10-20 09:00–10:00
   * (UTC-07:00)`, `2026-10-20, all day`). Set only on the copy a model reads, from the
   * chat's tool or its lookup, and only when the turn names a zone. */
  when_text?: string;
  when_day?: string;
  where: SituationDimension<SituationPlace>;
  who: SituationDimension<string[]>;
  reasons: SituationReason[];
  basis: SituationBasis;
  evidence: AssetEvidence[];
  consequence: 'routine' | 'floor';
  sphere?: Sphere;
  updated_at: number;
  /** Read-time context, not part of the situation: a saved snapshot leaves it out. */
  details?: SituationAssetDetails;
  /** Read-time context: the days of the last week the owner recorded a pursuit (D-343 slice 5). */
  recorded?: SituationRecordedDays;
  /** Read-time native request, copied to situation.query to inspect this rule. */
  context?: AssetFactContextRequest;
  /** Where a trip goes and its days of entry and exit, as its booking or the owner
   * gave them, so a model can weigh a traveller's documents against it. Its
   * travellers are `who`. Read-time context, like `details`. */
  trip?: Pick<TripDetails, 'destination_country' | 'entry_on' | 'exit_on' | 'special_entry_status'>;
}
export interface SituationCluster {
  id: string;
  subjects: SituationRef[];
  span: SituationWindow | null;
  items: SituationItem[];
  omitted: number;
}
export interface SituationResult {
  /** Explicit relationship inspection; normal situation reads do not compute it. */
  fact_context?: AssetFactContext;
  clusters: SituationCluster[];
  omitted: number;
  /** More than one record matched a name; the caller must ask which one. */
  ambiguous: Array<{ name: string; choices: SituationRef[] }>;
  /** Sources the owner's read could not finish: each held more records than one
   *  read may, so its items can be missing. A scoped contract is refused instead
   *  and never sees this. */
  partial?: string[];
}

/** The public tool and recipe input. Surface, owner, spheres and recall opt-in
 * are supplied by the host and cannot be requested through this shape. Parsed, its `time`
 * is instants: a day the caller named is resolved to its whole span (`parseSituationQueryInput`). */
export type SituationQueryInput = Omit<SituationQuery, 'surface' | 'include_last_time' | 'include_pursuits'>;
/** D-338 — a whole day, `YYYY-MM-DD`, read on the owner's clock.
 *  ⛔ Not under `from` / `to`: the chat's argument check reads a field named `from` or `to` as an
 *  identifier the model must have read (`tool-argument-grounding.ts`, for mail's addresses), and
 *  tomorrow's date is in no packet. `first_day` / `last_day` also say that both ends count. */
const SITUATION_DAY_SCHEMA = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
export const SITUATION_QUERY_SCHEMA = {
  type: 'object', additionalProperties: false, oneOf: [{ required: ['time'], not: { required: ['context'] } }, { required: ['context'], maxProperties: 1 }],
  properties: {
    context: ASSET_FACT_CONTEXT_REQUEST_SCHEMA,
    time: { anyOf: [SITUATION_DAY_SCHEMA, { type: 'object', additionalProperties: false,
      required: ['first_day', 'last_day'], properties: { first_day: SITUATION_DAY_SCHEMA, last_day: SITUATION_DAY_SCHEMA } },
    { type: 'integer' }, { type: 'object', additionalProperties: false,
      required: ['from', 'to'], properties: { from: { type: 'integer' }, to: { type: 'integer' } } }] },
    place: { type: 'object', additionalProperties: false, required: ['key', 'name'],
      properties: { key: { type: 'string', maxLength: 500 }, name: { type: 'string', maxLength: 500 } } },
    people: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
    subjects: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
      required: ['collection', 'id'], properties: { collection: { type: 'string', maxLength: 100 },
        id: { type: 'string', maxLength: 2000 }, field: { type: 'string', maxLength: 500 } } } },
    text: { type: 'string', maxLength: 2048 }, changed_since: { type: 'integer' },
    // No maximum: the tool returns every match (up to the query's per-call guard), so a
    // trip for eight travellers lists all eight passports. The owner's surfaces keep theirs.
    limit_clusters: { type: 'integer', minimum: 1 }, limit_items: { type: 'integer', minimum: 1 },
  },
} as const;

/** `timeZone` is the clock a day is read on: the turn's in chat, else the server's. Without one
 *  a day is a UTC day, as a date-only due is (`dueSpan`). */
export const parseSituationQueryInput = (raw: unknown, timeZone?: string): SituationQueryInput => {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const refuse = (): never => { throw new Error('Invalid situation query; give time as a day "YYYY-MM-DD", days {"first_day","last_day"} or Unix ms, and use place, people, subjects, text, changed_since and positive whole-number limits only'); };
  const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
  if (!object(raw) || Object.keys(raw).some(key => key === 'context' || !Object.hasOwn(SITUATION_QUERY_SCHEMA.properties, key))) return refuse();
  // A day spans its midnight on that clock to the instant before the next one, so a span of
  // days ends where the Agenda's does (`agendaLines`).
  const day = (value: unknown): { start: number; end: number } | undefined => {
    const ms = typeof value === 'string' ? calendarDayMs(value) : null;
    if (ms === null) return undefined;
    const span = dueSpan(ms, timeZone);
    return { start: span.start, end: span.end - 1 };
  };
  const time = raw.time;
  const keys = (value: Record<string, unknown>, ...names: string[]): boolean =>
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
  let window: SituationQueryInput['time'];
  if (instant(time)) window = time;
  else if (typeof time === 'string') { const one = day(time); if (!one) return refuse(); window = { from: one.start, to: one.end }; }
  else if (object(time) && keys(time, 'first_day', 'last_day')) {
    const first = day(time.first_day), last = day(time.last_day);
    if (!first || !last || first.start > last.end) return refuse();
    window = { from: first.start, to: last.end };
  } else if (object(time) && keys(time, 'from', 'to') && instant(time.from) && instant(time.to) && time.from <= time.to) {
    window = { from: time.from, to: time.to };
  } else return refuse();
  if (raw.place !== undefined && !(object(raw.place) && Object.keys(raw.place).every(key => key === 'key' || key === 'name')
    && string(raw.place.key, 500) && string(raw.place.name, 500))) return refuse();
  if (raw.people !== undefined && !(Array.isArray(raw.people) && raw.people.length <= 20 && raw.people.every(value => string(value, 500)))) return refuse();
  if (raw.subjects !== undefined && !(Array.isArray(raw.subjects) && raw.subjects.length <= 20 && raw.subjects.every(value => object(value)
    && Object.keys(value).every(key => ['collection', 'id', 'field'].includes(key)) && string(value.collection, 100) && string(value.id, 2000)
    && (value.field === undefined || string(value.field, 500))))) return refuse();
  if (raw.text !== undefined && !string(raw.text, 2048)) return refuse();
  if (raw.changed_since !== undefined && !instant(raw.changed_since)) return refuse();
  for (const key of ['limit_clusters', 'limit_items'] as const) {
    if (raw[key] !== undefined && !(Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 1)) return refuse();
  }
  return { ...(structuredClone(raw) as unknown as SituationQueryInput), time: window };
};
export type SituationState = 'new' | 'proposed' | 'accepted' | 'dismissed' | 'resolved';
export type SituationDismissal = 'not_now' | 'not_this_one' | 'never_this_kind' | 'wrong';
export interface SituationSnapshot {
  id: string;
  state: SituationState;
  cluster: SituationCluster;
  urgency: 'routine' | 'floor' | 'day_of';
  proposal?: { kind: string; text: string; target: SituationRef; held_run_id?: string };
  dismissal?: SituationDismissal;
}
export interface SituationRevision {
  revision: number;
  situation_id: string;
  at: number;
  cause: { source: string; revision?: number };
  changed_fields: string[];
  before: SituationSnapshot | null;
  after: SituationSnapshot;
}
/** D-325 §15.7 amendment (2026-11-02) — how many days a digest covers, counted from the day it
 *  goes, that day included: 2 is today and tomorrow. A weekly digest covers at least 7, so no
 *  day falls between two digests. */
export type SituationDigestLookAhead = 2 | 3 | 7 | 14;
export interface SituationDeliverySettings {
  frequency: 'daily' | 'weekly' | 'off';
  /** ISO weekday, Monday=1. */
  weekday: number;
  time: string;
  day_of: boolean;
  /** How far ahead the digest looks. A current server always names it. Absent from an older
   *  server, whose digest always covers 7 days and which would store the field but ignore it,
   *  so a client sends it only to a server that named it. */
  look_ahead_days?: SituationDigestLookAhead;
}
/** D-325 §15.7 amendment (2026-11-02, later) — the Agenda: a message apart from the Digest
 *  that lists one day in time order, recurring events included, and repeats what has not
 *  changed. Amended 2026-11-03: it can go once a week instead, listing seven days. */
export interface SituationAgendaSettings {
  enabled: boolean;
  /** HH:MM in the server's zone. */
  time: string;
  /** The day it lists: the day it goes, or the next one. A weekly agenda's seven days start there. */
  day: 'today' | 'tomorrow';
  /** §15.7 amendment (2026-11-03) — each day, or once a week on `weekday`. A current server
   *  always names both. A server whose Agenda is daily only names neither and drops both from a
   *  save, so a client offers Weekly only to a server that named it. */
  frequency?: 'daily' | 'weekly';
  /** ISO weekday a weekly agenda goes on, Monday=1. */
  weekday?: number;
  /** D-338 slice 3 — after the agenda goes out, Recued's AI looks it over and sends suggestions,
   *  as a scheduled prompt the Agenda keeps in step. A server before it names none and drops it
   *  from a save, so a client offers it only to a server that named it. */
  suggestions?: boolean;
}
/** D-340 ruling 13 — how a stream message's AI suggestions went: inside it, or why it went without them.
 *  The message names the reason in plain words; Today shows it beside when the message went. */
export type SituationSuggestionsOutcome = 'included' | 'stuck' | 'failed' | 'unfinished' | 'approval' | 'not_started';
/** D-340 ruling 13 — a stream run's timing, for Today: when Recued started preparing it (its set time), and
 *  how its suggestions went. A run before it, or one with no suggestions asked for, has neither. */
export interface SituationRunTiming {
  prepared_at?: number;
  suggestions?: SituationSuggestionsOutcome;
}
export interface SituationAgendaStatus {
  settings: SituationAgendaSettings;
  /** D-338 §11 — `mentions`: the names the text links in the app, each with the record it opens
   *  (a birthday's name opens the contact). A server before it sends none. */
  last_run: ({ at: number; mode: string; state: string; text: string; delivered_to: string[];
    mentions?: Array<{ text: string; ref: { collection: string; id: string } }> } & SituationRunTiming) | null;
  last_sent: ({ at: number; mode: string; text: string; delivered_to: string[];
    mentions?: Array<{ text: string; ref: { collection: string; id: string } }> } & SituationRunTiming) | null;
  pending: number;
  uncertain: number;
  /** When the next agenda goes, quiet hours included, and the server's zone to say it in.
   *  Absent while it is off or nothing can send. A weekly agenda missed on its weekday goes
   *  later that week, so this can name a day that is not its weekday. */
  next_at?: number;
  time_zone?: string;
  /** D-338 slice 3 — the conversation the AI suggestions run in, once they have one. */
  suggestions_session_id?: string;
  /** D-343 slice 4 — Close the day, the evening message beside the Agenda (ruling 19). A server
   *  before it names none, so a client offers it only to a server that named it. */
  close_day?: SituationCloseDayStatus;
  /** D-340 slice 2 — the daily and weekly streams, which took over the Agenda and Coming up: a
   *  server that names them sends by them, and its Agenda and Coming up settings above are the
   *  ones it carried over, no longer used. A server before it names none, and a client keeps the
   *  Agenda and Coming up cards for it. */
  streams?: SituationStreamsStatus;
}
/** D-340 slice 2 (§3.1, rulings 1, 7 and 11) — the daily stream or the weekly one: one message at
 *  its time that holds the parts the owner checks, sent to the channels they pick. Daily and weekly
 *  are tabs on Today, each its own schedule, and both can be on (ruling 11). Its message is "Your
 *  day · Sat 7 Nov" or "Your week · Mon 2 Nov to Sun 8 Nov" (ruling 12). */
export type SituationStreamKind = 'daily' | 'weekly';
export interface SituationStreamSettings {
  enabled: boolean;
  /** HH:MM in the server's zone. */
  time: string;
  /** The day it lists, the day it goes or the next. A weekly stream's seven days start there. */
  day: 'today' | 'tomorrow';
  /** ISO weekday a weekly stream goes on, Monday=1. The daily one keeps it and does not use it. */
  weekday: number;
  /** Its parts (§3.1): the day in time order, and what changed in the days ahead. Reminders and
   *  the suggestions inside it come with D-340 slices 3 and 4. */
  agenda: boolean;
  coming_up: boolean;
  /** How far ahead Coming up looks, from the day it goes. A weekly stream looks at least 7 days. */
  look_ahead_days: SituationDigestLookAhead;
  /** D-338 slice 3 — after it goes, the AI looks its Agenda over and sends suggestions, as a
   *  scheduled prompt the stream keeps in step. Only with the Agenda. */
  suggestions: boolean;
  /** Daily only: what is due that day, on a day it lists no Agenda ("Due today", §3.2). */
  due_today: boolean;
  /** D-340 slice 5 (§3.4) — every part names a private item (an asset the owner marked sensitive,
   *  a private occasion (`occasionIsPrivate`, D-407 slice 3) or event (D-407 Q8), or an item citing
   *  one), in the channels it goes to, and its
   *  AI suggestions may name one too. Off, each reads "Reminder in Yours", as before. The daily
   *  stream's also decides Close the day's, which goes where it goes. */
  include_private: boolean;
  /** D-340 slice 3 (§3.1) — daily only, and only listing today: the owner's reminders due that day,
   *  each with its buttons, inside this message instead of one by one. An urgent one (consequence
   *  floor) still goes at once, and reminders for the household's shared items go to the household
   *  as before. A server before slice 3 names none, and a client then offers none. */
  reminders: boolean;
  /** The channels it goes to (ruling 7). Null is every channel that is set up, where the Agenda
   *  and Coming up went. */
  channels: NotificationDeliveryChannel[] | null;
}
export interface SituationStreamStatus {
  settings: SituationStreamSettings;
  last_run: SituationAgendaStatus['last_run'];
  last_sent: SituationAgendaStatus['last_sent'];
  pending: number;
  uncertain: number;
  /** When it next goes, quiet hours included, and the server's zone to say it in. Absent while
   *  it is off or nothing can send. */
  next_at?: number;
  time_zone?: string;
  /** The conversation its AI suggestions run in, once they have one. */
  suggestions_session_id?: string;
}
export interface SituationStreamsStatus { daily: SituationStreamStatus; weekly: SituationStreamStatus }
/** D-340 §3.7 (ruling 10) — the next message of a stream, as it would go now: its title, how many
 *  lines each part holds, and its text on request. Nothing is sent or marked by it, and no model is
 *  asked: Coming up's groups read without their summaries. */
export interface SituationStreamPreview {
  title: string;
  /** `reminders` (D-340 slice 3) and `suggestions` (slice 4, 1 when they finished before it goes):
   *  absent from a server before them. */
  counts: { states: number; agenda: number; due_today: number; coming_up: number; reminders?: number; suggestions?: number };
  /** Empty when there is nothing to send now. */
  text: string;
  next_at?: number;
  time_zone?: string;
}
/** D-343 slice 4 (§3.1, rulings 3, 5 and 19) — the evening message that lists the day and asks what
 *  the owner did. Off until they turn it on, at a time that is a proposal, not a cutoff: a reply
 *  closes the day whenever it comes. It goes where the Agenda goes. */
export interface SituationCloseDaySettings {
  enabled: boolean;
  /** HH:MM in the server's zone. */
  time: string;
}
/** A proven email reply still waiting for Chat admission, or an older handoff with no receipt. */
export interface EmailClosingReplyStatus {
  id: string;
  received_at: number;
  reason: 'waiting' | 'retry' | 'source_unavailable' | 'unknown';
  session_id?: string;
  retry_available: boolean;
}
export interface SituationCloseDayStatus {
  settings: SituationCloseDaySettings;
  last_run: { at: number; mode: string; state: string; text: string; delivered_to: string[] } | null;
  last_sent: { at: number; mode: string; text: string; delivered_to: string[] } | null;
  pending: number;
  uncertain: number;
  /** When it next goes, quiet hours included, and the server's zone to say it in. Absent while it
   *  is off or nothing can send. */
  next_at?: number;
  time_zone?: string;
  /** Recent unresolved inbound replies; absent on servers without durable email handoff. */
  email_replies?: EmailClosingReplyStatus[];
}
export interface SituationDeliveryStatus {
  settings: SituationDeliverySettings;
  /** The Digest's own runs: its due-day notes and Send now included, the Agenda's never. */
  last_run: { at: number; mode: string; state: string; text: string; delivered_to: string[] } | null;
  last_sent?: { at: number; mode: string; text: string; delivered_to: string[] } | null;
  pending?: number;
  uncertain?: number;
  /** D-325 §15.7 amendment — when the next digest goes, as the scheduler decides it (quiet
   *  hours included), and the server's zone to say it in. Absent while the digest is off or
   *  nothing can send, and from an older server. */
  next_at?: number;
  time_zone?: string;
  /** D-340 slice 2 — the streams took over: Coming up is a part of them, and these settings no
   *  longer send. A client leaves the card off the page. */
  streams?: true;
}
export interface ProactiveToday {
  situations: SituationResult;
  /** A cluster's one-line summary from the scheduled brief, keyed by cluster id.
   * Present only when background AI wrote one for these same values. */
  summaries?: Record<string, string>;
  /** The people the items name, by the id an item's `who` carries, as the owner's contacts
   * name them. A person no longer on file is left out. A server older than this sends none. */
  people?: Record<string, string>;
  occurrences: Array<{ id: string; asset_id: string; asset_name: string; subject_kind?: 'asset' | 'occasion'; question: boolean;
    reminders_started: boolean; commitment: Commitment; sphere?: Sphere;
    /** D-325 §15.7 (2026-10-24) — an open renewal, such as a passport's: its new date closes
     *  it, so Today's Done acknowledges it (`occurrence.acknowledge`). Absent otherwise. */
    renewal?: { field: string; current: string };
    /** The owner acknowledged its latest reminder: Today leaves it out until the next. */
    acknowledged?: true }>;
  /** D-407 slice 2 — the occasions that come back whenever the last one says and wait for their next date ("When is
   *  the next one?"), each with the date it last happened. Absent from an older server: Today asks nothing. */
  occasions_waiting?: Array<{ id: string; title: string; last_on: string }>;
  proposal_count: number;
  newest_proposal: { id: string; title: string } | null;
  unmatched_replies: Array<{ id: string; text: string; reason: string; created_at: number }>;
  phone_ready: boolean;
  /** D-343 slice 4 (ruling 20) — this server opens a conversation holding today's evening notice,
   *  quoted, for Today's "Close the day" (`yours.change` `close_day.open`). Absent from a server
   *  before it, so Today offers the button only to one that names it. */
  close_day?: true;
  /** D-340 slice 2 (§3.7) — this server keeps the daily and weekly streams, whose settings Today's
   *  "Daily stream" opens. Absent from a server before it. */
  stream?: true;
  /** D-340 slice 4 (§3.3) — the AI suggestions for today's daily stream, once they finished: their
   *  answer, and the conversation "Talk it over" opens. Absent before then, and from a server before
   *  slice 4. */
  suggestions?: { text: string; session_id: string; day: string };
}
