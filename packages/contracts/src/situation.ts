import type { AssetEvidence, Sphere } from './assets.js';
import type { Commitment } from './work-entities.js';

export type SituationBasis = 'declared' | 'derived' | 'inferred';
export type SituationVerdict = 'match' | 'near' | 'outside' | 'unknown';
export type SituationReason = 'due' | 'collides' | 'related' | 'missing' | 'last_time';
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
}
export interface SituationCluster {
  id: string;
  subjects: SituationRef[];
  span: SituationWindow | null;
  items: SituationItem[];
  omitted: number;
}
export interface SituationResult {
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
  type: 'object', additionalProperties: false, required: ['time'],
  properties: {
    time: { anyOf: [{ type: 'integer' }, { type: 'object', additionalProperties: false,
      required: ['from', 'to'], properties: { from: { type: 'integer' }, to: { type: 'integer' } } }] },
    place: { type: 'object', additionalProperties: false, required: ['key', 'name'],
      properties: { key: { type: 'string', maxLength: 500 }, name: { type: 'string', maxLength: 500 } } },
    people: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
    subjects: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
      required: ['collection', 'id'], properties: { collection: { type: 'string', maxLength: 100 },
        id: { type: 'string', maxLength: 2000 }, field: { type: 'string', maxLength: 500 } } } },
    text: { type: 'string', maxLength: 2048 }, changed_since: { type: 'integer' },
    limit_clusters: { type: 'integer', minimum: 1, maximum: 5 }, limit_items: { type: 'integer', minimum: 1, maximum: 3 },
  },
} as const;

export const parseSituationQueryInput = (raw: unknown): SituationQueryInput => {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const refuse = (): never => { throw new Error('Invalid situation query; use time, place, people, subjects, text, changed_since and bounded limits only'); };
  const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const instant = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
  if (!object(raw) || Object.keys(raw).some(key => !Object.hasOwn(SITUATION_QUERY_SCHEMA.properties, key))) return refuse();
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
  for (const [key, max] of [['limit_clusters', 5], ['limit_items', 3]] as const) {
    if (raw[key] !== undefined && !(Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 1 && (raw[key] as number) <= max)) return refuse();
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
    reminders_started: boolean; commitment: Commitment; sphere?: Sphere }>;
  proposal_count: number;
  newest_proposal: { id: string; title: string } | null;
  unmatched_replies: Array<{ id: string; text: string; reason: string; created_at: number }>;
  phone_ready: boolean;
}
