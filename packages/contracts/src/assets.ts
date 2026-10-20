/** D-325 — durable things, typed clocks and ranked facts. Classes are presets;
 * neither classes nor free-text attributes are a rule language. */
import type { SourceRowIdentity, CommitmentExpiryPolicy } from './work-entities.js';

export const ASSET_STATUSES = ['active', 'lent', 'sold', 'lost', 'retired'] as const;
export type AssetStatus = typeof ASSET_STATUSES[number];
export type Sphere = 'personal' | 'professional';
export type AssetAudience = 'owner' | 'household';
export const ASSET_IDENTIFYING_FIELD_NOTE =
  'Optional; no reminder needs it. AI apps you connect can read it exactly as typed, so enter only part of it if that’s enough.';
export const ASSET_SOURCE_RANKS = { owner: 100, confirmed_document: 80, observation: 60, extracted: 40, ai_guess: 10 } as const;
export type AssetContributionKind = keyof typeof ASSET_SOURCE_RANKS;
export interface AssetFactSource {
  kind: AssetContributionKind;
  ref: string;
  at: number;
  /** Distinguishes successive manual samples even within one clock tick. */
  revision?: string;
}
export interface AssetEvidence {
  collection: string;
  id: string;
  field?: string;
  value?: string | number | boolean | null;
}
export interface AssetReading {
  value: number;
  unit: string;
  as_of: number;
  evidence: AssetEvidence[];
}
export interface AssetCondition {
  active: boolean;
  certainty: 'confirmed' | 'conditional';
  as_of: number;
  evidence: AssetEvidence[];
  /** Stamped by the bound observation writer, never by its input. */
  source: string;
}
export interface AssetValue {
  amount: string;
  currency: string;
  as_of: number;
  basis: 'purchase' | 'appraisal' | 'insured' | 'estimate' | 'market';
  evidence: AssetEvidence[];
}
export type AssetAnchor =
  | { kind: 'place'; name?: string; latitude?: number; longitude?: number; address?: string }
  | { kind: 'identifier'; scheme: string; value: string }
  | { kind: 'instrument'; identifier: string; quantity?: number };
export interface AssetRuleOffset { amount: number; unit: 'days' | 'weeks' | 'months' }
export interface AssetReminderSchedule {
  before: AssetRuleOffset[];
  on_day: boolean;
  /** An occurrence with an action can repeat after its date; a notice cannot. */
  after?: AssetRuleOffset;
}
export type AssetRuleWhen =
  | { kind: 'expiry'; field: string; offset?: AssetRuleOffset }
  | { kind: 'interval'; field: string; every: AssetRuleOffset }
  | { kind: 'objective'; field: string; target: number; unit: string; direction: 'rising' | 'falling'; mode: 'usage' | 'condition'; lead_days: number; lead_value?: number; every?: number }
  | { kind: 'condition'; field: string; certainty: 'confirmed' | 'conditional' };
export interface AssetRule {
  id: string;
  when: AssetRuleWhen;
  title: string;
  enabled: boolean;
  muted: boolean;
  consequence: 'routine' | 'floor';
  reaction: { notify: boolean; occurrence: 'action' | 'notice' | null; emit: boolean };
  expiry_policy: CommitmentExpiryPolicy;
  schedule: AssetReminderSchedule;
  /** Owner-edited rows are pinned against preset updates. */
  pinned: boolean;
  verified_as_of?: string;
}
export interface Asset extends SourceRowIdentity {
  id: string;
  name: string;
  class_id?: string;
  status: AssetStatus;
  holder_contact?: string;
  document_number?: string;
  serial_number?: string;
  exact_address?: string;
  belongs_to?: string;
  audience?: AssetAudience;
  sphere?: Sphere;
  sphere_override?: Sphere;
  /** Only typed fields may be named by a rule. A null is an explicitly unknown
   * field, allowing an interval to ask for last-done without inventing a date. */
  dates: Record<string, string | null>;
  readings: Record<string, AssetReading | null>;
  observations: Record<string, AssetCondition | null>;
  values: AssetValue[];
  anchors: AssetAnchor[];
  attributes: Record<string, unknown>;
  settings: Record<string, unknown>;
  rules: AssetRule[];
  field_sources: Record<string, AssetFactSource>;
  /** Owner-authorized handoff floors. The manual fact keeps its provenance
   * until an enrolled writer supplies an observation strictly after this time. */
  automatic_updates?: Record<string, number>;
  retirement: 'part' | 'cancel_or_transfer';
  created_at: number;
  updated_at: number;
  /** Read-time inheritance; never persisted as an item's own facts. */
  inherited_fields?: Record<string, string>;
  source_extension_blob?: Record<string, unknown>;
}
export interface AssetWriteSource {
  kind: 'owner' | 'confirmed_document' | 'extracted';
  ref: string;
}
export type AssetPatch = Partial<Pick<Asset,
  'name' | 'status' | 'dates' | 'readings' | 'observations' | 'values' | 'anchors' | 'attributes' | 'settings' | 'rules' | 'retirement'>>
  & { class_id?: string | null; holder_contact?: string | null; belongs_to?: string | null;
    audience?: AssetAudience | null; sphere?: Sphere | null; sphere_override?: Sphere | null;
    document_number?: string | null; serial_number?: string | null; exact_address?: string | null };
export type AssetCreateInput = AssetPatch & { name: string; source: AssetWriteSource; source_id?: string; idempotency_key?: string };
export type AssetUpdateInput = AssetPatch & { id: string; source: AssetWriteSource };
/** The installed binding supplies asset, source and permitted fields. */
export interface AssetObservationInput {
  binding_id: string;
  readings?: Record<string, AssetReading>;
  observations?: Record<string, Omit<AssetCondition, 'source'>>;
}
export interface AssetClassPreset {
  id: string;
  name: string;
  version: number;
  origin: string;
  fields: Pick<Asset, 'dates' | 'readings' | 'observations' | 'settings'>;
  rules: AssetRule[];
  audience: AssetAudience;
  sphere?: Sphere;
  retirement: Asset['retirement'];
  /** Pack-declared relation data, never a new rule grammar or a grant. */
  travel_validity?: TravelValidityRule[];
}
export interface TravelValidityRule {
  id: string;
  destination_countries: string[];
  /** Explicit applicability; an absent nationality never passes this check. */
  except_nationalities: string[];
  months_after_exit: number;
  issued_within_years: number;
  verified_as_of: string;
  source_url: string;
  label: string;
}

export const validateAssetClassPreset = (value: AssetClassPreset): void => {
  if (!value || !/^[a-z][a-z0-9_]{0,127}$/u.test(value.id) || typeof value.name !== 'string' || !value.name.trim()
    || value.name.length > 200 || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.origin !== 'string'
    || !value.origin.trim() || !value.fields || JSON.stringify(value).length > 65536) throw new Error('Invalid class preset');
  validateAsset({ ...value.fields, id: value.id, source_id: `class:${value.id}`, name: value.name, status: 'active',
    audience: value.audience, retirement: value.retirement, ...(value.sphere ? { sphere: value.sphere } : {}),
    rules: value.rules, values: [], anchors: [], attributes: {}, field_sources: {}, created_at: 0, updated_at: 0,
    last_seen_at: 0, sync_state: 'live', conflict_policy: 'recued_wins' });
  if (value.travel_validity !== undefined) {
    if (!Array.isArray(value.travel_validity) || value.travel_validity.length > 100) throw new Error('Invalid travel validity table');
    const ids = new Set<string>();
    for (const rule of value.travel_validity) {
      if (!rule || typeof rule.id !== 'string' || !rule.id.trim() || ids.has(rule.id) || !isAssetDate(rule.verified_as_of)
        || !Number.isSafeInteger(rule.months_after_exit) || rule.months_after_exit < 0 || rule.months_after_exit > 24
        || !Number.isSafeInteger(rule.issued_within_years) || rule.issued_within_years < 1 || rule.issued_within_years > 20
        || typeof rule.label !== 'string' || !rule.label.trim() || typeof rule.source_url !== 'string' || !/^https:\/\//u.test(rule.source_url)
        || !Array.isArray(rule.destination_countries) || !rule.destination_countries.length || !Array.isArray(rule.except_nationalities)
        || [...rule.destination_countries, ...rule.except_nationalities].some(code => typeof code !== 'string' || !/^[A-Z]{2}$/u.test(code))) throw new Error('Invalid travel validity rule');
      ids.add(rule.id);
    }
  }
};

export class AssetValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message); this.name = 'AssetValidationError';
  }
}
const fail = (field: string, message: string): never => { throw new AssetValidationError(`${field}: ${message}`, field); };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isAssetDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const offset = (value: unknown, field: string, positive: boolean): void => {
  if (!record(value) || !finite(value.amount) || !Number.isInteger(value.amount)
    || value.amount < (positive ? 1 : 0) || value.amount > 36_500
    || !['days', 'weeks', 'months'].includes(String(value.unit))) fail(field, 'use a whole number of days, weeks or months');
};
const key = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const text = (value: unknown, maximum = 1000): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const timestamp = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
const evidence = (value: unknown, field: string): void => {
  if (!Array.isArray(value)) return fail(field, 'evidence must be a list of records');
  if (value.length > 100) fail(field, 'evidence must be a list of records');
  for (const item of value) {
    if (!record(item) || !text(item.collection, 200) || !text(item.id, 2000)
      || (item.field !== undefined && !text(item.field, 200))
      || (item.value !== undefined && item.value !== null && typeof item.value !== 'string' && typeof item.value !== 'boolean' && !finite(item.value))) fail(field, 'invalid evidence reference');
  }
};
const json = (value: unknown, field: string): void => {
  // A JSON roundtrip alone converts NaN to null and silently removes undefined.
  const visit = (item: unknown, depth: number): void => {
    if (depth > 12) fail(field, 'too deeply nested');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || finite(item)) return;
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return; }
    if (record(item)) { for (const [name, entry] of Object.entries(item)) { if (['__proto__', 'prototype', 'constructor'].includes(name)) fail(field, 'reserved key'); visit(entry, depth + 1); } return; }
    fail(field, 'must contain only JSON values');
  };
  visit(value, 0);
  if (JSON.stringify(value).length > 128_000) fail(field, 'too large');
};

export const validateAssetRule = (rule: AssetRule, asset: Pick<Asset, 'dates' | 'readings' | 'observations'>): void => {
  if (!record(rule) || !key(rule.id)) fail('rules.id', 'use a stable field-style identifier');
  if (!text(rule.title, 500)) fail('rules.title', 'a title is required');
  for (const field of ['enabled', 'muted', 'pinned'] as const) if (typeof rule[field] !== 'boolean') fail(`rules.${field}`, 'must be boolean');
  if (!['routine', 'floor'].includes(rule.consequence)) fail('rules.consequence', 'unknown consequence');
  if (!['strict_expire', 'escalate_overdue', 'indefinite'].includes(rule.expiry_policy)) fail('rules.expiry_policy', 'unknown policy');
  const when = rule.when;
  if (!record(when) || !key(when.field)) fail('rules.when', 'a typed field is required');
  switch (when.kind) {
    case 'expiry': case 'interval':
      if (!Object.hasOwn(asset.dates, when.field)) fail('rules.when.field', 'no such date field');
      if (when.kind === 'expiry' && when.offset !== undefined) offset(when.offset, 'rules.when.offset', false);
      if (when.kind === 'interval') offset(when.every, 'rules.when.every', true);
      break;
    case 'objective':
      if (!Object.hasOwn(asset.readings, when.field)) fail('rules.when.field', 'no such reading');
      if (!finite(when.target) || !text(when.unit, 80) || !finite(when.lead_days) || when.lead_days < 0
        || (when.every !== undefined && (!finite(when.every) || when.every <= 0 || when.mode !== 'usage'))
        || (when.lead_value !== undefined && (!finite(when.lead_value) || when.lead_value < 0))
        || !['rising', 'falling'].includes(when.direction) || !['usage', 'condition'].includes(when.mode)) fail('rules.when', 'invalid objective');
      if (asset.readings[when.field] && asset.readings[when.field]!.unit !== when.unit) fail('rules.when.unit', 'the reading and target must use the same unit');
      break;
    case 'condition':
      if (!Object.hasOwn(asset.observations, when.field)) fail('rules.when.field', 'no such observation');
      if (!['confirmed', 'conditional'].includes(when.certainty)) fail('rules.when.certainty', 'unknown certainty');
      break;
    default: fail('rules.when.kind', 'only expiry, interval, objective and condition are supported');
  }
  if (!record(rule.reaction) || typeof rule.reaction.notify !== 'boolean' || typeof rule.reaction.emit !== 'boolean'
    || ![null, 'action', 'notice'].includes(rule.reaction.occurrence)) fail('rules.reaction', 'invalid reaction');
  const schedule = rule.schedule;
  if (!record(schedule) || !Array.isArray(schedule.before) || schedule.before.length > 24 || typeof schedule.on_day !== 'boolean') fail('rules.schedule', 'invalid schedule');
  schedule.before.forEach((point, index) => offset(point, `rules.schedule.before.${index}`, false));
  if (schedule.after !== undefined) {
    offset(schedule.after, 'rules.schedule.after', true);
    if (rule.reaction.occurrence !== 'action') fail('rules.schedule.after', 'only an action may repeat after its date');
  }
  if (rule.verified_as_of !== undefined && !isAssetDate(rule.verified_as_of)) fail('rules.verified_as_of', 'use YYYY-MM-DD');
};

export const validateAsset = (asset: Asset): void => {
  if (!text(asset.id, 2000) || !text(asset.source_id, 2000)) fail('id', 'asset and Source identities are required');
  if (!text(asset.name, 200)) fail('name', 'a name of at most 200 characters is required');
  if (!(ASSET_STATUSES as readonly unknown[]).includes(asset.status)) fail('status', 'unknown status');
  if (asset.audience !== undefined && !['owner', 'household'].includes(asset.audience)) fail('audience', 'unknown audience');
  for (const field of ['sphere', 'sphere_override'] as const) if (asset[field] !== undefined && !['personal', 'professional'].includes(asset[field]!)) fail(field, 'unknown sphere');
  if (!['part', 'cancel_or_transfer'].includes(asset.retirement)) fail('retirement', 'unknown retirement behavior');
  for (const field of ['class_id', 'holder_contact', 'belongs_to', 'document_number', 'serial_number', 'exact_address'] as const) {
    if (asset[field] !== undefined && typeof asset[field] !== 'string') fail(field, 'must be text');
  }
  for (const field of ['dates', 'readings', 'observations'] as const) {
    if (!record(asset[field])) fail(field, 'must be keyed by typed field names');
    for (const name of Object.keys(asset[field])) if (!key(name)) fail(field, 'invalid field name');
  }
  for (const [name, date] of Object.entries(asset.dates)) if (date !== null && !isAssetDate(date)) fail(`dates.${name}`, 'use YYYY-MM-DD or null');
  for (const [name, reading] of Object.entries(asset.readings)) {
    if (reading !== null && (!record(reading) || !finite(reading.value) || !text(reading.unit, 80)
      || !timestamp(reading.as_of) || !Array.isArray(reading.evidence))) fail(`readings.${name}`, 'invalid reading');
    if (reading) evidence(reading.evidence, `readings.${name}.evidence`);
  }
  for (const [name, condition] of Object.entries(asset.observations)) {
    if (condition !== null && (!record(condition) || typeof condition.active !== 'boolean' || !timestamp(condition.as_of)
      || !['confirmed', 'conditional'].includes(condition.certainty) || !text(condition.source)
      || !Array.isArray(condition.evidence))) fail(`observations.${name}`, 'invalid condition');
    if (condition) evidence(condition.evidence, `observations.${name}.evidence`);
  }
  if (asset.automatic_updates !== undefined) {
    if (!record(asset.automatic_updates)) fail('automatic_updates', 'must be a field map');
    for (const [path, at] of Object.entries(asset.automatic_updates)) {
      const [kind, name, extra] = path.split('.');
      if (extra || !key(name) || !['readings', 'observations'].includes(kind!)
        || !Object.hasOwn(asset[kind as 'readings' | 'observations'], name!)
        || asset.field_sources[path]?.kind !== 'owner' || !timestamp(at) || at < 0) fail('automatic_updates', 'invalid owner handoff');
    }
  }
  if (!Array.isArray(asset.rules) || asset.rules.length > 100) fail('rules', 'at most 100 rules');
  const ids = new Set<string>();
  for (const rule of asset.rules) { validateAssetRule(rule, asset); if (ids.has(rule.id)) fail('rules.id', 'duplicate identity'); ids.add(rule.id); }
  if (!Array.isArray(asset.anchors) || !Array.isArray(asset.values)) fail('anchors', 'anchors and values must be arrays');
  for (const anchor of asset.anchors) {
    if (!record(anchor)) fail('anchors', 'invalid anchor');
    if (anchor.kind === 'place') {
      if (anchor.latitude === undefined && !text(anchor.name) && !text(anchor.address)) fail('anchors.place', 'a place needs a name, address or coordinates');
      if ((anchor.latitude === undefined) !== (anchor.longitude === undefined)
        || (anchor.latitude !== undefined && (!finite(anchor.latitude) || Math.abs(anchor.latitude) > 90 || !finite(anchor.longitude) || Math.abs(anchor.longitude) > 180))) fail('anchors.place', 'invalid coordinates');
    } else if (anchor.kind === 'identifier') {
      if (!text(anchor.scheme, 80) || !text(anchor.value)) fail('anchors.identifier', 'scheme and value are required');
    } else if (anchor.kind === 'instrument') {
      if (!text(anchor.identifier) || (anchor.quantity !== undefined && !finite(anchor.quantity))) fail('anchors.instrument', 'invalid instrument');
    } else fail('anchors.kind', 'unknown anchor');
  }
  for (const value of asset.values) if (!record(value) || !/^-?\d+(?:\.\d+)?$/.test(value.amount) || !/^[A-Z]{3}$/.test(value.currency)
    || !timestamp(value.as_of) || !['purchase', 'appraisal', 'insured', 'estimate', 'market'].includes(value.basis) || !Array.isArray(value.evidence)) fail('values', 'invalid dated value');
  for (const value of asset.values) evidence(value.evidence, 'values.evidence');
  if (!record(asset.attributes) || !record(asset.settings)) fail('attributes', 'attributes and settings must be objects');
  json(asset, 'asset');
};
