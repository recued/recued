import type { AssetEvidence, AssetStatus, Sphere } from './assets.js';
import type { Commitment } from './work-entities.js';
import { ASSET_FACT_CONTEXT_REQUEST_SCHEMA, type AssetFactContext } from './asset-fact-context.js';

export const SITUATION_CONTEXT_MAX_BYTES = 6000;
/** At most this many items in one `situation.query` result. The tool returns every match up to
 *  it, where the owner's surfaces show three a group: a trip for eight travellers lists all eight
 *  passports. Past it, `omitted` counts the rest and the caller narrows the query. */
export const SITUATION_TOOL_MAX_ITEMS = 100;

export type SituationBasis = 'declared' | 'derived' | 'inferred';
export type SituationVerdict = 'match' | 'near' | 'outside' | 'unknown';
/** `ended`: a trip, event or booking already over, returned only to a question
 * about a span that reaches back over it, never to a forward list. */
export type SituationReason = 'due' | 'collides' | 'related' | 'missing' | 'last_time' | 'ended';
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
  attributes?: Record<string, string | number | boolean>;
  left_out?: string[];
}
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
}
export interface SituationItem {
  ref: SituationRef;
  kind: string;
  what: SituationDimension<string>;
  when: SituationDimension<SituationWindow>;
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
 * are supplied by the host and cannot be requested through this shape. */
export type SituationQueryInput = Omit<SituationQuery, 'surface' | 'include_last_time'>;
export const SITUATION_QUERY_SCHEMA = {
  type: 'object', additionalProperties: false, oneOf: [{ required: ['time'], not: { required: ['context'] } }, { required: ['context'], maxProperties: 1 }],
  properties: {
    context: ASSET_FACT_CONTEXT_REQUEST_SCHEMA,
    time: { anyOf: [{ type: 'integer' }, { type: 'object', additionalProperties: false,
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

export const parseSituationQueryInput = (raw: unknown): SituationQueryInput => {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const refuse = (): never => { throw new Error('Invalid situation query; use time, place, people, subjects, text, changed_since and positive whole-number limits only'); };
  const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
  if (!object(raw) || Object.keys(raw).some(key => key === 'context' || !Object.hasOwn(SITUATION_QUERY_SCHEMA.properties, key))) return refuse();
  const time = raw.time;
  if (!instant(time) && !(object(time) && Object.keys(time).every(key => key === 'from' || key === 'to')
    && instant(time.from) && instant(time.to) && time.from <= time.to)) return refuse();
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
  return structuredClone(raw) as unknown as SituationQueryInput;
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
export interface SituationDeliverySettings {
  frequency: 'daily' | 'weekly' | 'off';
  /** ISO weekday, Monday=1. */
  weekday: number;
  time: string;
  day_of: boolean;
}
export interface SituationDeliveryStatus {
  settings: SituationDeliverySettings;
  last_run: { at: number; mode: string; state: string; text: string; delivered_to: string[] } | null;
  last_sent?: { at: number; mode: string; text: string; delivered_to: string[] } | null;
  pending?: number;
  uncertain?: number;
  /** D-325 §15.7 amendment — when the next digest goes, as the scheduler decides it (quiet
   *  hours included), and the server's zone to say it in. Absent while the digest is off or
   *  nothing can send, and from an older server. */
  next_at?: number;
  time_zone?: string;
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
  proposal_count: number;
  newest_proposal: { id: string; title: string } | null;
  unmatched_replies: Array<{ id: string; text: string; reason: string; created_at: number }>;
  phone_ready: boolean;
}
