import type Database from 'better-sqlite3';
import { ASSET_SEARCH_TERMS, PURSUIT_CLASS_ID, assetSearchTerms, AssetValidationError, type AssetClassPreset, type AssetCreateInput, type AssetPatch, type AssetRule, type AssetRuleOffset } from '@recued/contracts';
import { createAssetClassStore, type AssetClassStore } from './asset-classes.js';

/** D-325 §4.4 amendment (2026-10-24) — a type of thing the owner keeps, as an AI
 * is told it, and what an AI's create of one is held to. The owner: "hint.tool for
 * the create job so AI knows what shape the passport obj is to create a passport
 * out of blank". `work.type` describes a type from its class preset; an extracted
 * create that names a type keeps only that type's fields, and its type's own
 * reminders start at once (ruled "reminders on"). A reminder an AI writes itself
 * still waits for the owner (`writeAsset` stores an extracted rule switched off). */
export type AssetTypes = Pick<AssetClassStore, 'get' | 'list'>;

const catalogs = new WeakMap<Database.Database, AssetTypes>();
/** Building a class store registers the starter types, so one per database. */
export const assetTypes = (db: Database.Database): AssetTypes => {
  let found = catalogs.get(db);
  if (!found) { found = createAssetClassStore(db); catalogs.set(db, found); }
  return found;
};

const GROUPS = ['dates', 'readings', 'observations'] as const;
type FieldGroup = (typeof GROUPS)[number];
const listed = (shown: readonly string[]): string =>
  shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
const quoted = (names: readonly string[]): string => listed(names.map(name => `\`${name}\``));
const span = (offset: AssetRuleOffset): string => `${offset.amount} ${offset.amount === 1 ? offset.unit.slice(0, -1) : offset.unit}`;
/** When a rule falls due, by the field it reads. */
const due = (when: AssetRule['when']): string => {
  switch (when.kind) {
    case 'expiry': return when.offset?.amount ? `${span(when.offset)} before ${when.field}` : `on ${when.field}`;
    case 'interval': return `${span(when.every)} after ${when.field}`;
    case 'objective': return `when ${when.field} ${when.direction === 'rising' ? 'reaches' : 'falls to'} ${when.target} ${when.unit}`;
    case 'condition': return `when ${when.field} is reported`;
  }
};
const remind = (schedule: AssetRule['schedule']): string[] => [...new Set([
  ...schedule.before.map(point => point.amount ? `${span(point)} before` : 'on the day'),
  ...(schedule.on_day ? ['on the day'] : []), ...(schedule.after ? [`then every ${span(schedule.after)}`] : []),
])];
/** Whether creating one of this type needs the contact who holds it (§15.3). */
export const assetTypeNeedsHolder = (type: Pick<AssetClassPreset, 'id' | 'fields'>): boolean =>
  ['passport', 'id_card', 'visa', 'driving_licence'].includes(type.id) || type.fields.settings.holder_required === true;

export interface AssetTypeEntry { type: string; name: string; dates: string[]; holder_required?: true }
export interface AssetTypeReminder { title: string; due: string; remind: string[]; off?: true }
export interface AssetTypeShape extends AssetTypeEntry { readings?: string[]; observations?: string[]; attributes?: Record<string, string>; search_keywords?: string[]; reminders: AssetTypeReminder[] }
/** D-342 slice 4 — the details a built-in type keeps as attributes, each with what goes there, so a
 *  model creates one in the owner's words under the names its page and readers use. A class
 *  declares dates, readings, conditions and settings only, so a built-in type names its own here.
 *  A horizon is the year or date it means (ruling 10): "this year" read next year is wrong. */
const TYPE_ATTRIBUTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [PURSUIT_CLASS_ID]: {
    horizon: 'when, such as "2027" or "by summer 2027"; none for a habit',
    why: 'why it matters to them',
    where_i_am: 'where they are with it now',
  },
};

/** The attributes a built-in type names (`TYPE_ATTRIBUTES`), or none. A read of a thing of that
 *  type shows an unset one as null, and an AI's write is held to them (D-342): an update calls no
 *  `work.type`, so the names come with the thing. */
export const assetTypeAttributeNames = (classId: string | null | undefined): readonly string[] =>
  classId != null && Object.hasOwn(TYPE_ATTRIBUTES, classId) ? Object.keys(TYPE_ATTRIBUTES[classId]!) : [];

export const listAssetTypes = (types: readonly AssetClassPreset[]): AssetTypeEntry[] => types.map(type => ({
  type: type.id, name: type.name, dates: Object.keys(type.fields.dates), ...(assetTypeNeedsHolder(type) ? { holder_required: true as const } : {}),
}));
export const describeAssetType = (type: AssetClassPreset): AssetTypeShape => {
  const readings = Object.keys(type.fields.readings); const observations = Object.keys(type.fields.observations);
  const searchKeywords = assetSearchTerms(type.fields.settings[ASSET_SEARCH_TERMS]);
  return {
    ...listAssetTypes([type])[0]!, ...(readings.length ? { readings } : {}), ...(observations.length ? { observations } : {}),
    ...(Object.hasOwn(TYPE_ATTRIBUTES, type.id) ? { attributes: { ...TYPE_ATTRIBUTES[type.id] } } : {}),
    ...(searchKeywords.length ? { search_keywords: searchKeywords } : {}),
    reminders: type.rules.map(rule => ({ title: rule.title, due: due(rule.when), remind: remind(rule.schedule),
      ...(!rule.enabled || rule.muted || !rule.reaction.notify ? { off: true as const } : {}) })),
  };
};

/** What a typed create sent beyond its type. A preset declares every field its
 * rules read, so its own fields are the whole allowance; a type that names its
 * attributes (a pursuit) allows those, beside search keywords. */
export interface AssetTypeIssues {
  unknown: Partial<Record<FieldGroup | 'attributes', string[]>>;
  holder: boolean;
  rules: boolean;
  settings: boolean;
}
type TypedInput = Pick<AssetCreateInput, FieldGroup | 'attributes' | 'holder_contact' | 'rules' | 'settings'>;
/** The attributes a write sends that a type naming its attributes does not name, nor `has`. */
export const assetTypeExtraAttributes = (classId: string | null | undefined, attributes: Readonly<Record<string, unknown>> | undefined,
  has: (name: string) => boolean = () => false): string[] => {
  const named = assetTypeAttributeNames(classId);
  return named.length === 0 ? [] : Object.keys(attributes ?? {}).filter(name => name !== ASSET_SEARCH_TERMS && !named.includes(name) && !has(name));
};
export const assetTypeIssues = (type: AssetClassPreset, input: TypedInput): AssetTypeIssues | null => {
  const unknown: AssetTypeIssues['unknown'] = {};
  for (const group of GROUPS) {
    const extra = Object.keys(input[group] ?? {}).filter(field => !Object.hasOwn(type.fields[group], field));
    if (extra.length) unknown[group] = extra;
  }
  const attributes = assetTypeExtraAttributes(type.id, input.attributes);
  if (attributes.length) unknown.attributes = attributes;
  const issues = { unknown, holder: assetTypeNeedsHolder(type) && !input.holder_contact,
    rules: input.rules != null && input.rules.length > 0, settings: input.settings != null && Object.keys(input.settings).length > 0 };
  return Object.keys(unknown).length || issues.holder || issues.rules || issues.settings ? issues : null;
};
/** How a surface names its own holder argument and the tool that describes types. */
export interface AssetTypeWords { holder: string; describe: string }
export const KERNEL_ASSET_TYPE_WORDS: AssetTypeWords = {
  holder: '`holder_contact`, the contact id or email address of the person it belongs to', describe: 'work.type',
};
/** A write that sent attributes its type does not name, in the words a model is told: the names
 *  to use instead. An asset's note (`body`) is one such attribute. */
export const assetTypeAttributesText = (classId: string, extra: readonly string[]): string =>
  `Type \`${classId}\` keeps its details under the attributes ${quoted(assetTypeAttributeNames(classId))}, `
  + `not ${listed(extra.map(name => (name === 'note' ? 'a note' : `\`${name}\``)))}.`;
export const assetTypeIssueText = (type: AssetClassPreset, issues: AssetTypeIssues, words: AssetTypeWords): string => {
  const parts: string[] = [];
  for (const group of GROUPS) {
    const extra = issues.unknown[group]; if (!extra?.length) continue;
    const kept = Object.keys(type.fields[group]);
    parts.push(`Type \`${type.id}\` keeps ${kept.length ? `the ${group} ${quoted(kept)}` : `no ${group}`}, not ${quoted(extra)}.`);
  }
  if (issues.unknown.attributes?.length) parts.push(assetTypeAttributesText(type.id, issues.unknown.attributes));
  if (issues.holder) parts.push(`Type \`${type.id}\` needs its holder: pass ${words.holder}.`);
  if (issues.rules) parts.push('Its reminders come from its type, so leave out rules. A reminder of your own can be added to the asset afterwards, and it waits for the owner.');
  if (issues.settings) parts.push('Its settings come from its type, so leave out settings.');
  return [...parts, `${words.describe} describes each type.`].join(' ');
};
export class AssetTypeError extends AssetValidationError {
  constructor(readonly type: AssetClassPreset, readonly issues: AssetTypeIssues) {
    super(assetTypeIssueText(type, issues, KERNEL_ASSET_TYPE_WORDS), 'class_id');
    this.name = 'AssetTypeError';
  }
}
export const unknownAssetTypeText = (id: string, types: AssetTypes, describe: string): string => {
  const known = types.list().map(type => type.id);
  return `There is no asset type \`${id}\`. ${describe} lists them${known.length ? `: ${quoted(known.slice(0, 30))}${known.length > 30 ? ' and more' : ''}` : ''}.`;
};

/** The writer's facts on a new asset of a type, at the writer's rank: the type's
 * empty fields and defaults, under what the writer sent. */
export const typedAssetFacts = (type: AssetClassPreset, patch: AssetPatch): AssetPatch => {
  const sphere = patch.sphere ?? type.sphere;
  return { ...patch, class_id: type.id, audience: patch.audience ?? type.audience, retirement: patch.retirement ?? type.retirement,
    ...(sphere ? { sphere } : {}),
    dates: { ...type.fields.dates, ...patch.dates }, readings: { ...type.fields.readings, ...patch.readings },
    observations: { ...type.fields.observations, ...patch.observations } };
};
/** The type's own part: its reminders, settings and the version they came from,
 * written as accepting its class-update offer would (`applyClass`), so they are
 * on and no lower-ranked writer changes them. The ref names the type, so the
 * asset page says "From its type", never "Entered by you". */
export const assetTypeApplication = (type: AssetClassPreset) => ({
  class_id: type.id,
  settings: { ...structuredClone(type.fields.settings), class_version: type.version, class_rule_ids: type.rules.map(rule => rule.id) },
  rules: structuredClone(type.rules),
  source: { kind: 'owner' as const, ref: `type:${type.id}@${type.version}` },
  preset_application: true as const,
});
