/** D-320 phase 3, slice 3a — a step that names no connection signs in through its
 *  slot (D-320 §3.2, §6 step 3). Pure, so a server's run, its doors, the
 *  corpus migration and a drive of a shipped recipe all read one rule; a server passes
 *  its recorded bindings to `catalogSignInReader`.
 *
 *  A recipe names no connection: a step calls an operation, and the operation's
 *  pack says which sign-in, its slot, it needs. Every reader of a step's connection
 *  still reads it from a setting (`{{config.<var>}}`), so a step that needs a
 *  sign-in and names none is given a setting here, in the run's own copy of the
 *  recipe:
 *  1. the setting another step of the same slot names;
 *  2. else the recipe's API setting named after the slot (`hubspot`, or
 *     `azure_devops` for `azure-devops`);
 *  3. else, with one such slot left, the recipe's one API setting that no step
 *     names. A canonical op-step already follows this rule (one setting, the steps
 *     omit it); a pack's operation now does too;
 *  4. else a setting declared for the slot, named after it, with no value.
 *  The run then treats the step as one whose setting is empty: the dish's and the
 *  run's choice, the pack's default, the pick layer, the run's record and what a
 *  called recipe inherits all apply. A value a caller gives under the slot's name
 *  is that setting's value, as it was while the recipe declared it, so an AI client
 *  holding an old tool list still reaches the connection it named.
 *
 *  A mail or MCP setting is never given to an API step: before this, a recipe whose
 *  one setting was its mail sender handed it to every canonical op-step that named
 *  none. A step that needs no API sign-in is left as it is: a kernel op, a cli,
 *  storage or MCP catalog (spec §3.1), and a catalog nothing here can place. A
 *  recipe with nothing to give is returned as it came, the same object. */

import {
  ACCT_ALIAS_VALUES,
  CRM_ALIAS_VALUES,
  isCanonicalOpStep,
  parseOpId,
  retiredConnectionsOf,
  type BulkPackManifest,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';

import type { PackOpResolution } from './op-step-lower.js';

/** How a catalog signs in: through the API slot named, through none (a cli,
 *  storage or MCP catalog), or not known here. */
export type CatalogSignIn = { slot: string } | 'none' | 'unknown';

export interface SlotSettingsInput {
  /** The installed packs' catalogs (`buildPackOpResolution`): where a pack's
   *  operation (`<publisher>.<pack>.<op>`) fetches from. */
  packs?: PackOpResolution;
  /** How a catalog signs in (`catalogSignInReader`). */
  signInOf: (catalog: string) => CatalogSignIn;
}

export interface SlotSettings {
  recipe: RecipeDefinition;
  /** Each setting declared here, by name: the slot it is for. */
  derived: Readonly<Record<string, string>>;
  /** Each slot a step that named no connection was given a setting for, and that
   *  setting: one declared here, or one the recipe already had. */
  bySlot: Readonly<Record<string, string>>;
}

/** A pure `{{config.<var>}}` connection ref. */
const PURE_CONFIG_REF = /^\{\{\s*config\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

const CRM = new Set<string>(CRM_ALIAS_VALUES);
const ACCT = new Set<string>(ACCT_ALIAS_VALUES);

const STEP_ARRAYS = ['prefetch_steps', 'steps', 'trigger_steps'] as const;
type StepArray = (typeof STEP_ARRAYS)[number];

/** The setting named after `slot`: its letters, digits and underscores, any other
 *  character an underscore (`azure-devops` → `azure_devops`). */
export const slotSettingName = (slot: string): string => {
  const name = slot.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
};

/** How `manifest`'s composition `catalog` signs in: an `http` ingredient through the
 *  connection name it declares, any other kind through none. */
export const compositionSignIn = (
  manifest: BulkPackManifest | null | undefined,
  catalog: string,
): CatalogSignIn => {
  for (const content of manifest?.contents ?? []) {
    if (content.type !== 'composition' || content.composition.slug !== catalog) continue;
    const ingredient = content.composition.ingredients?.[0];
    if (ingredient?.kind !== 'http') return 'none';
    const name = ingredient.http?.connection;
    return typeof name === 'string' && name.length > 0 ? { slot: name } : 'none';
  }
  return 'unknown';
};

/** A binding a server recorded for a catalog: the connection's slot, if the install
 *  stored one, and the pack whose install bound it. */
export interface CatalogSignInBinding {
  slot?: string;
  installed_pack_id?: string;
}

/** How each catalog signs in, read once per catalog: the slot its bindings recorded,
 *  else the one its pack's manifest declares (the order the run's slot reader keeps).
 *  A catalog whose manifest is not at hand but that some connection is bound to signs
 *  in through an API connection: only such a catalog is bound. A server passes its
 *  bindings (`bindingsOf`); without them, the shipped manifests decide alone. */
export const catalogSignInReader = (deps: {
  bindingsOf?: (catalog: string) => readonly CatalogSignInBinding[];
  packs?: PackOpResolution;
  packManifestOf: (pack_slug: string) => BulkPackManifest | null | undefined;
}): ((catalog: string) => CatalogSignIn) => {
  const packOf = new Map<string, string>();
  for (const [ref, binding] of deps.packs ?? []) {
    packOf.set(binding.catalog_slug, ref.slice(ref.indexOf('.') + 1));
  }
  const seen = new Map<string, CatalogSignIn>();
  return (catalog) => {
    const known = seen.get(catalog);
    if (known !== undefined) return known;
    const bindings = deps.bindingsOf?.(catalog) ?? [];
    const recorded = bindings.find((binding) => binding.slot !== undefined)?.slot;
    const pack = bindings[0]?.installed_pack_id ?? packOf.get(catalog);
    const authored = pack !== undefined ? compositionSignIn(deps.packManifestOf(pack), catalog) : 'unknown';
    const answer: CatalogSignIn = authored === 'none'
      ? 'none'
      : typeof authored === 'object'
        ? { slot: recorded ?? authored.slot }
        : bindings.length > 0 ? { slot: recorded ?? catalog } : 'unknown';
    seen.set(catalog, answer);
    return answer;
  };
};

/** The family a vendor-neutral step signs in through: `crm` for
 *  `core.crm.deal.search` or a legacy bare `deal.search`, `acct` likewise. */
const vendorNeutralFamily = (step: Readonly<Record<string, unknown>>): string | undefined => {
  if (typeof step.op !== 'string') return undefined;
  const parsed = parseOpId(step.op);
  if (parsed?.tier === 'kernel') {
    return parsed.domain === 'crm' || parsed.domain === 'acct' ? parsed.domain : undefined;
  }
  if (parsed === null && isCanonicalOpStep(step as unknown as RecipeStep)) {
    const entity = step.op.split('.')[0] ?? '';
    return CRM.has(entity) ? 'crm' : ACCT.has(entity) ? 'acct' : undefined;
  }
  return undefined;
};

/** The slot a step signs in through, or undefined when it needs no API sign-in or
 *  none can be placed. */
const slotOfStep = (step: Readonly<Record<string, unknown>>, input: SlotSettingsInput): string | undefined => {
  const signInOf = (catalog: string): string | undefined => {
    const signIn = input.signInOf(catalog);
    return typeof signIn === 'object' ? signIn.slot : undefined;
  };
  if (typeof step.op === 'string') {
    const parsed = parseOpId(step.op);
    if (parsed?.tier === 'pack') {
      const binding = input.packs?.get(parsed.pack_ref);
      // Not installed: the dispatch resolve reports it.
      return binding !== undefined ? signInOf(binding.catalog_slug) : undefined;
    }
    // A vendor-neutral op (`core.crm.deal.search`, or a legacy bare `deal.search`)
    // signs in through its family.
    return vendorNeutralFamily(step);
  }
  return typeof step.ingredient === 'string' ? signInOf(step.ingredient) : undefined;
};

const isApiSetting = (definition: unknown): boolean => {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) return false;
  const { type, connection_kind } = definition as { type?: unknown; connection_kind?: unknown };
  return type === 'connection' && (connection_kind === undefined || connection_kind === 'api');
};

/** D-320 phase 3 (3e) — whether `recipe` still declares an API connection setting:
 *  the shape before 3e, a `type: 'connection'` setting of the API kind or of none. */
export const declaresApiConnectionSetting = (recipe: Pick<RecipeDefinition, 'variables'>): boolean =>
  Object.values((recipe.variables ?? {}) as Readonly<Record<string, unknown>>).some(isApiSetting);

/** Give each step that needs a sign-in and names no connection the setting for its
 *  slot (see the module comment). */
export const withSlotSettings = (recipe: RecipeDefinition, input: SlotSettingsInput): SlotSettings => {
  const variables = (recipe.variables ?? {}) as Readonly<Record<string, unknown>>;
  const apiSettings = Object.keys(variables).filter((name) => isApiSetting(variables[name]));
  const fedBy = new Map<string, string>();
  const named = new Set<string>();
  const needing: Array<{ array: StepArray; index: number; slot: string }> = [];
  for (const array of STEP_ARRAYS) {
    const steps = (recipe[array] ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>;
    steps.forEach((step, index) => {
      if (step === null || typeof step !== 'object') return;
      const slot = slotOfStep(step, input);
      if (typeof step.connection === 'string') {
        const variable = PURE_CONFIG_REF.exec(step.connection.trim())?.[1];
        if (variable === undefined) return;
        named.add(variable);
        if (slot !== undefined && !fedBy.has(slot)) fedBy.set(slot, variable);
        return;
      }
      // Any other shape is the resolve's to judge.
      if (step.connection !== undefined || slot === undefined) return;
      needing.push({ array, index, slot });
    });
  }
  if (needing.length === 0) return { recipe, derived: {}, bySlot: {} };

  const slots = [...new Set(needing.map((need) => need.slot))];
  const settingFor = new Map<string, string>();
  for (const slot of slots) {
    const fed = fedBy.get(slot);
    if (fed !== undefined) settingFor.set(slot, fed);
  }
  for (const slot of slots) {
    if (settingFor.has(slot)) continue;
    const name = slotSettingName(slot);
    if (apiSettings.includes(name)) settingFor.set(slot, name);
  }
  const left = slots.filter((slot) => !settingFor.has(slot));
  const taken = new Set(settingFor.values());
  const unnamed = apiSettings.filter((name) => !named.has(name) && !taken.has(name));
  if (left.length === 1 && apiSettings.length === 1 && unnamed.length === 1) {
    settingFor.set(left[0]!, unnamed[0]!);
  }
  const declared: Record<string, unknown> = {};
  const derived: Record<string, string> = {};
  for (const slot of slots) {
    if (settingFor.has(slot)) continue;
    const base = slotSettingName(slot);
    let name = base;
    for (let n = 1; name in variables || name in declared; n += 1) {
      name = n === 1 ? `${base}_connection` : `${base}_connection_${n}`;
    }
    declared[name] = { label: `${slot} connection`, type: 'connection', connection_kind: 'api', default: '' };
    derived[name] = slot;
    settingFor.set(slot, name);
  }

  const out: Record<string, unknown> = { ...recipe };
  if (Object.keys(declared).length > 0) out.variables = { ...variables, ...declared };
  for (const array of STEP_ARRAYS) {
    const mine = needing.filter((need) => need.array === array);
    if (mine.length === 0) continue;
    const steps = [...((recipe[array] ?? []) as ReadonlyArray<Record<string, unknown>>)];
    for (const { index, slot } of mine) {
      steps[index] = { ...steps[index], connection: `{{config.${settingFor.get(slot)!}}}` };
    }
    out[array] = steps;
  }
  return { recipe: out as unknown as RecipeDefinition, derived, bySlot: Object.fromEntries(settingFor) };
};

/** D-320 phase 3 (3d) — each vendor-neutral family the recipe's steps sign in
 *  through, and the setting they name (once `withSlotSettings` has run, every such
 *  step names one). `context.connections` gives the family the connection the run
 *  settled on, so a vendor-neutral recipe reads `{{context.connections.crm}}`
 *  without knowing whose CRM it is. A family whose steps name two settings is left
 *  out, as a slot that settled on two connections is. */
export const vendorNeutralSettings = (recipe: RecipeDefinition): Readonly<Record<string, string>> => {
  const named = new Map<string, Set<string>>();
  for (const array of STEP_ARRAYS) {
    for (const step of (recipe[array] ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>) {
      if (step === null || typeof step !== 'object') continue;
      const family = vendorNeutralFamily(step);
      const variable = family !== undefined && typeof step.connection === 'string'
        ? PURE_CONFIG_REF.exec(step.connection.trim())?.[1]
        : undefined;
      if (family === undefined || variable === undefined) continue;
      named.set(family, (named.get(family) ?? new Set<string>()).add(variable));
    }
  }
  return Object.fromEntries([...named]
    .filter(([, variables]) => variables.size === 1)
    .map(([family, variables]) => [family, [...variables][0]!]));
};

/** D-320 phase 3 (3d) — `context.connections`: each slot that settled on one
 *  connection (`bySlot`), and each vendor-neutral family under its own name, from
 *  the value its setting settled on. A slot of the same name keeps its own.
 *
 *  D-320 ruling 20 — a search on that setting which nobody pointed at a connection
 *  read every one that serves it (`fannedOut`: setting → the connections read). The
 *  family is given the one connection its steps used, and is left out when they
 *  used several, as a slot that settled on two is. */
export const contextConnectionsOf = (
  bySlot: Readonly<Record<string, string>>,
  families: Readonly<Record<string, string>>,
  config: Readonly<Record<string, unknown>>,
  fannedOut: Readonly<Record<string, readonly string[]>> = {},
): Record<string, string> => {
  const out: Record<string, string> = { ...bySlot };
  for (const [family, setting] of Object.entries(families)) {
    if (Object.prototype.hasOwnProperty.call(out, family)) continue;
    const used = new Set<string>(fannedOut[setting] ?? []);
    const value = config[setting];
    if (typeof value === 'string' && value.trim() !== '') used.add(value.trim());
    if (used.size === 1) out[family] = [...used][0]!;
  }
  return out;
};

/** D-320 phase 3 (3c) — the names a recipe still reads a saved value under without
 *  declaring them: the setting a run gives each slot (named after it), and each old
 *  connection setting's name it maps to a slot. An update must not call a value
 *  saved under one of them "no longer used" (D-303): the run still reads it. */
export const slotSettingNamesOf = (recipe: RecipeDefinition, input: SlotSettingsInput): ReadonlySet<string> =>
  new Set([...Object.keys(withSlotSettings(recipe, input).derived), ...Object.keys(retiredConnectionsOf(recipe))]);

/** D-320 phase 3 (3c, ruling 18) — a value given under an old connection setting's
 *  name (`metadata.retired_connections`: old name → slot) is the value of the
 *  setting its slot was given (`bySlot`), unless that has one of its own. A dish
 *  saved before the recipe dropped the setting, and an AI client holding an old
 *  tool list, still reach the connection they named; dropped, the value would leave
 *  the run on the pack's default, in another account.
 *
 *  Returns the config (the same object when nothing was carried) and each old name
 *  carried, with the setting it became. The old name itself is left for the run to
 *  drop, as a retired setting's is. */
export const carryRetiredConnections = (
  recipe: RecipeDefinition,
  config: Readonly<Record<string, unknown>>,
  bySlot: Readonly<Record<string, string>>,
): { config: Readonly<Record<string, unknown>>; carried: Readonly<Record<string, string>> } => {
  const carried: Record<string, string> = {};
  let out: Record<string, unknown> | undefined;
  for (const [old, slot] of Object.entries(retiredConnectionsOf(recipe))) {
    const value = config[old];
    const setting = bySlot[slot];
    if (typeof value !== 'string' || value.trim() === '' || setting === undefined) continue;
    const own = (out ?? config)[setting];
    if (typeof own === 'string' && own.trim() !== '') continue;
    out ??= { ...config };
    out[setting] = value.trim();
    carried[old] = setting;
  }
  return { config: out ?? config, carried };
};
