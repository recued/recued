import { PURSUIT_CLASS_ID, isAssetDate, type Asset, type AssetPatch, type AssetReading, type BodyGoalProgress, type PursuitEnding } from '@recued/contracts';
import { yoursCalendarDate } from './yours-dates.js';
import { goalProgressWords } from './body-goal-words.js';

/** D-342 — what the owner is working toward, as the Pursuits tab and its form read it. A
 * pursuit is an asset of the built-in Pursuit class; its own facts are its horizon, why and
 * where-I-am attributes, its target date and its progress reading. */
export const isPursuit = (asset: Pick<Asset, 'class_id'>): boolean => asset.class_id === PURSUIT_CLASS_ID;
/** A pursuit is active or ended; `lent` counts as active, as it does across Yours. */
export const pursuitActive = (asset: Pick<Asset, 'status'>): boolean => asset.status === 'active' || asset.status === 'lent';
/** The facts a pursuit's page shows in its Pursuit section, so its Facts list leaves them
 * out. Progress stays with the readings, where its history and updates are. */
export const PURSUIT_FACTS: ReadonlySet<string> = new Set(['attributes.horizon', 'attributes.why', 'attributes.where_i_am', 'attributes.ended_as', 'dates.target_on',
  /** D-339 slice 15 — a goal on a Body, shown as its Goal. */
  'settings.goal']);
export const PURSUIT_ENDING_WORDS: Readonly<Record<PursuitEnding, string>> = { reached: 'Reached', let_go: 'Let go' };

const words = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const targetOn = (asset: Asset): string | null => { const on = asset.dates.target_on; return typeof on === 'string' && isAssetDate(on) ? on : null; };
const progressOf = (asset: Asset): AssetReading | null => asset.readings.progress ?? null;
/** §7 — each level by target date, a pursuit with none after those with one, then by name. */
const byTarget = (a: Asset, b: Asset): number => {
  const x = targetOn(a); const y = targetOn(b);
  if (x !== y) return x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
  return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

export interface PursuitRow { asset: Asset; depth: number }
/** §7 — the active pursuits as a tree by parent. One whose parent is not an active pursuit
 * here (ended, not a pursuit, or not on file) is a root. Parents cannot form a loop on the
 * server; a loop that reached this list is still shown, from its first member by order. */
export const pursuitTree = (assets: readonly Asset[]): PursuitRow[] => {
  const active = assets.filter(asset => isPursuit(asset) && pursuitActive(asset)).sort(byTarget);
  const ids = new Set(active.map(asset => asset.id));
  const children = new Map<string, Asset[]>();
  for (const asset of active) if (asset.belongs_to && ids.has(asset.belongs_to)) {
    const siblings = children.get(asset.belongs_to); if (siblings) siblings.push(asset); else children.set(asset.belongs_to, [asset]);
  }
  const rows: PursuitRow[] = []; const seen = new Set<string>();
  const walk = (asset: Asset, depth: number) => {
    if (seen.has(asset.id)) return; seen.add(asset.id); rows.push({ asset, depth });
    for (const child of children.get(asset.id) ?? []) walk(child, depth + 1);
  };
  for (const asset of active) if (!asset.belongs_to || !ids.has(asset.belongs_to)) walk(asset, 0);
  for (const asset of active) walk(asset, 0);
  return rows;
};
/** Ended pursuits, the most recently ended first. */
export const endedPursuits = (assets: readonly Asset[]): Asset[] => {
  const endedAt = (asset: Asset) => asset.field_sources.status?.at ?? asset.updated_at;
  return assets.filter(asset => isPursuit(asset) && !pursuitActive(asset)).sort((a, b) => endedAt(b) - endedAt(a) || a.name.localeCompare(b.name));
};
/** The active pursuits that end with this one: its parts, as the server's retirement walks
 * them (a part whose retirement is `part`, and that part's own parts). */
export const pursuitPartsEnding = (asset: Asset, assets: readonly Asset[]): Asset[] => {
  const parts: Asset[] = []; const seen = new Set([asset.id]);
  const walk = (id: string) => {
    for (const child of assets) if (child.belongs_to === id && !seen.has(child.id) && pursuitActive(child) && child.retirement === 'part') {
      seen.add(child.id); parts.push(child); walk(child.id);
    }
  };
  walk(asset.id); return parts;
};
/** How it ended (ruling 8). A pursuit that ended because the one it was part of did keeps no
 * ending of its own; the server marks that write as the retirement's. */
export const pursuitEndingWords = (asset: Asset): string => {
  const ending = asset.attributes.ended_as;
  if (ending === 'reached' || ending === 'let_go') return PURSUIT_ENDING_WORDS[ending];
  return asset.field_sources.status?.ref.startsWith('retirement:') ? 'Ended with the pursuit it was part of' : 'Ended';
};
/** §7 — what a pursuit says, in the owner's words, with the field each fact is kept in. A
 * line on the Pursuits tab gives the horizon, where they are, progress and the target date;
 * its page gives why in place of progress, which its readings show with their history. A
 * fact not given is left out. */
export const pursuitFacts = (asset: Asset, place: 'line' | 'page' = 'line',
  /** D-339 slice 15 — a goal on a Body: where it stands, in place of a typed progress, on both. */
  goal?: BodyGoalProgress): Array<[label: string, value: string, path: string]> => {
  const progress = place === 'line' && !goal ? progressOf(asset) : null; const target = targetOn(asset);
  const why = place === 'page' ? words(asset.attributes.why) : '';
  return [
    ...(words(asset.attributes.horizon) ? [['Horizon', words(asset.attributes.horizon), 'attributes.horizon'] as [string, string, string]] : []),
    ...(why ? [['Why', why, 'attributes.why'] as [string, string, string]] : []),
    ...(words(asset.attributes.where_i_am) ? [['Where I am', words(asset.attributes.where_i_am), 'attributes.where_i_am'] as [string, string, string]] : []),
    ...(goal ? [['Goal', goalProgressWords(goal), 'settings.goal'] as [string, string, string]] : []),
    ...(progress ? [['Progress', `${progress.value} ${progress.unit}`, 'readings.progress'] as [string, string, string]] : []),
    ...(target ? [['Target date', yoursCalendarDate(target), 'dates.target_on'] as [string, string, string]] : []),
  ];
};

/** What "Part of" offers: every active pursuit but this one and any under it, ended ones'
 * parts included (the server refuses a loop), indented by depth, and the current parent even
 * when it is not one of them. */
export const pursuitPartChoices = (own: Asset | undefined, pursuits: readonly Asset[], parentName?: string): Array<[string, string]> => {
  const below = new Set(own ? [own.id] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const asset of pursuits) if (asset.belongs_to && below.has(asset.belongs_to) && !below.has(asset.id)) { below.add(asset.id); grew = true; }
  }
  const choices: Array<[string, string]> = [['', 'Nothing: it stands on its own'],
    ...pursuitTree(pursuits).filter(row => !below.has(row.asset.id)).map(({ asset, depth }): [string, string] => [asset.id, `${'– '.repeat(depth)}${asset.name}`])];
  if (own?.belongs_to && !choices.some(([id]) => id === own.belongs_to)) choices.push([own.belongs_to, parentName ?? 'Its current parent']);
  return choices;
};

export interface PursuitDraft {
  name: string; horizon: string; why: string; where_i_am: string; progress: string; unit: string; target_on: string;
  part_of: string; private: boolean; household: boolean;
  /** D-343 slice 4 — "Ask me in the evening" (`settings.evening`): Close the day lists it. */
  evening: boolean;
}
export const pursuitDraft = (own?: Asset, partOf = ''): PursuitDraft => {
  const progress = own ? progressOf(own) : null;
  return { name: own?.name ?? '', horizon: words(own?.attributes.horizon), why: words(own?.attributes.why), where_i_am: words(own?.attributes.where_i_am),
    progress: progress ? String(progress.value) : '', unit: progress?.unit ?? '', target_on: own ? targetOn(own) ?? '' : '',
    part_of: own ? own.belongs_to ?? '' : partOf, private: own?.settings.sensitive === true, household: own?.audience === 'household',
    evening: own?.settings.evening === true };
};
export class PursuitFieldError extends Error {
  constructor(readonly field: keyof PursuitDraft, message: string) { super(message); this.name = 'PursuitFieldError'; }
}
/** The form as a create's input (no `own`), or as an edit's whole patch for `changedAssetPatch`
 * to reduce to what changed. A cleared fact is sent as null only when it had a value, and a
 * progress the owner left as it was keeps its reading, time and all, so it is not a new one. */
export const pursuitPatch = (draft: PursuitDraft, own: Asset | undefined, now: number): AssetPatch => {
  const name = draft.name.trim();
  if (!name) throw new PursuitFieldError('name', 'Say what you are working toward.');
  if (name.length > 200) throw new PursuitFieldError('name', 'Keep it under 200 characters.');
  const amount = draft.progress.trim(); const unit = draft.unit.trim();
  if (amount && !Number.isFinite(Number(amount))) throw new PursuitFieldError('progress', 'Enter progress as a number, such as 12.');
  if (amount && !unit) throw new PursuitFieldError('unit', 'Say what the number counts, such as books.');
  if (!amount && unit) throw new PursuitFieldError('progress', 'Enter a number for this unit, or clear the unit.');
  if (draft.target_on && !isAssetDate(draft.target_on)) throw new PursuitFieldError('target_on', 'Choose a date, or leave it empty.');
  const prior = own ? progressOf(own) : null;
  const progress: AssetReading | null = !amount ? null : prior && prior.value === Number(amount) && prior.unit === unit ? prior
    : { value: Number(amount), unit, as_of: now, evidence: [] };
  const attributes = Object.fromEntries((['horizon', 'why', 'where_i_am'] as const).flatMap((key): Array<[string, string | null]> => {
    const value = draft[key].trim();
    return value ? [[key, value]] : own && own.attributes[key] != null ? [[key, null]] : [];
  }));
  // A box the owner did not change is not sent: saving it would mark its value as typed.
  const shown = pursuitDraft(own);
  if (!own) return { name, ...(Object.keys(attributes).length ? { attributes } : {}), ...(draft.target_on ? { dates: { target_on: draft.target_on } } : {}),
    ...(progress ? { readings: { progress } } : {}), ...(draft.part_of ? { belongs_to: draft.part_of } : {}),
    ...(draft.private || draft.evening ? { settings: { ...(draft.private ? { sensitive: true } : {}), ...(draft.evening ? { evening: true } : {}) } } : {}),
    ...(draft.household ? { audience: 'household' } : {}) };
  const settings = { ...(draft.private !== shown.private ? { sensitive: draft.private } : {}),
    ...(draft.evening !== shown.evening ? { evening: draft.evening } : {}) };
  return { name, attributes, dates: { target_on: draft.target_on || null }, readings: { progress }, belongs_to: draft.part_of || null,
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(draft.household !== shown.household ? { audience: draft.household ? 'household' : 'owner' } : {}) };
};
