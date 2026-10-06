/** Poll-manager / G6 — declarative `event_triggers` reconciler.
 *
 *  Recipes declare warehouse-bus subscriptions in their JSON
 *  (`RecipeDefinition.event_triggers`), but until this slice NOTHING
 *  materialized those declarations into live subscriptions — the
 *  Phase-3 `event-trigger-binder` module (a separate bus-subscription
 *  path) was never constructed in production (the same
 *  silent-dead-surface trap slice 1 found one layer up), so every
 *  installed reactive recipe (the `surface-stalling-deals` trio, the
 *  compiled pack alerts) sat inert. The binder is now DELETED
 *  (pre-launch: no parallel dead path); this reconciler replaces it by
 *  materializing declarations into the ONE dispatch path — the
 *  `event_triggers` STORE the live `EventTriggerDispatcher` subscribes
 *  and the #automation surface governs.
 *
 *  AUTHORING SUGAR (design § 3/§ 4 compile-down). An entry is either
 *  RAW (`event` bus pattern + optional `filter`) or SUGAR (`on`
 *  canonical form + `connection`/`fields`/`where`). Sugar compiles
 *  HERE — `compileTriggerSugarEntry` against the live vendor registry
 *  (built-ins + installed 3rd-party packs via `getVendorEntities`), so
 *  an alias form (`on: deal.changed`) fans wider automatically when a
 *  conforming pack installs (reconcile re-runs on every recipe-store
 *  mutation — a pack install mutates the store). Each compiled
 *  subscription materializes as one row carrying the lowered
 *  `filter` / `fields` dispatch-filter halves; raw entries' `filter`
 *  now materializes too (the dispatcher evaluates it — the slice-2
 *  "store/dispatcher path has no filter" skip is closed).
 *
 *  D-319 — ONE SET OF ROWS PER DISH. A dish is a recipe switched on, with
 *  its own settings, and each of its recipe's declared triggers is made
 *  once for it, fires as it and runs with its settings. A recipe with no
 *  dish has no rows: nothing of it is switched on.
 *
 *  Reconcile = diff `(recipe_id, publisher_id, dish_id, pattern, filter,
 *  fields)` between installed STORED recipes × their dishes and the store's
 *  `origin: 'recipe'` rows:
 *
 *  - declared but missing  → create (DISARMED `enabled: false`, `origin:
 *    'recipe'`). The reconciler never starts anything by itself: a recipe
 *    update that declares a new trigger, or a dish made before D-319, gets
 *    its rows OFF; switching the dish on (`dish-automation.ts`) is what
 *    turns rows on (D-179 P5c's posture, D-319 § 3.3)
 *  - present but undeclared → remove (recipe uninstalled / edited, or its
 *    dish removed)
 *  - present and declared   → UNTOUCHED — the row's `enabled` and its fire
 *    bookkeeping survive every reconcile (a `triggers.delete` on a
 *    recipe-origin row, by contrast, is undone by the next reconcile —
 *    clients hide Remove for them). Editing an entry's filter/fields
 *    changes its identity (a fresh row, disarmed) — the same posture a
 *    pattern edit has always had.
 *
 *  Scope guards:
 *  - `composition.*` events are SKIPPED — the reception bridge's
 *    local-dispatch marker (D-173 resolves compiled recipes BY it;
 *    it never rides the warehouse bus).
 *  - `schedule.*` events are SKIPPED — the decomposer's
 *    `scheduled-operate` marker for the cron substrate's vocabulary.
 *    (Previously skipped only by accident — those entries carry a
 *    `filter`, and filters used to skip wholesale.)
 *  - sugar entries that don't parse, and alias entries with zero live-
 *    registry coverage, are SKIPPED (the latter self-heals on the next
 *    reconcile after a conforming pack registers).
 *  - invalid bus patterns are SKIPPED (defensive — recipe JSON is
 *    user-editable; compiled sugar patterns are well-formed by
 *    construction but run through the same check).
 *
 *  Bundled (non-installed) community recipes do NOT materialize —
 *  the declared set reads `listStored()` (install = opt-in), the same
 *  posture as the auto-run roster. Callers run reconcile at boot, on
 *  every recipe-store mutation (`setOnMutated`), and on maintenance
 *  exit; on change they rebuild the dispatcher + recompute watches +
 *  emit `automation_rule_changed`. */

import { randomUUID } from 'node:crypto';
import type { ConnectionVendorEntity, RecipeDefinition } from '@recued/contracts';
import {
  compileTriggerSugarEntry,
  eventPatternSegments,
  resolveEventPatternSettings,
  settingOfEventSegment,
} from '@recued/contracts';
import { extractVariableDefault } from '@recued/engine';
import { isValidPattern } from '@recued/warehouse-events';
import type { EventTrigger } from '@recued/contracts';
import type { EventTriggersStore } from './store.js';

/** The stored-recipe subset the reconciler reads. Matches
 *  `RecipeStore.listStored()` rows (`recipe_json` parsed lazily here
 *  so a malformed row skips cleanly). */
export interface StoredRecipeRowLike {
  recipe_id: string;
  publisher_id: string;
  recipe_json: string;
}

export interface ReconcileDeclarativeTriggersDeps {
  store: EventTriggersStore;
  listStored: () => StoredRecipeRowLike[];
  /** Live vendor registry thunk (built-ins + installed 3rd-party
   *  packs — `liveVendorRegistry`). The sugar compile fans alias forms
   *  across it. Absent (older callers / tests) → sugar entries still
   *  compile, but alias forms see zero coverage and skip. */
  getVendorEntities?: () => ReadonlyArray<
    Pick<ConnectionVendorEntity, 'vendor' | 'entity' | 'crm_alias'>
  >;
  now?: () => number;
  mintTriggerId?: () => string;
  /** D-319 — every dish: a recipe's declared triggers are made once per dish
   *  of it, and a trigger with `template_variable` (D-315 §5.1) is narrowed
   *  to the template THAT dish's setting holds — a dish with none chosen
   *  gets no row for it. So is a raw pattern with a setting part. Absent ⇒
   *  no dish, so no row. */
  listDishes?: () => ReadonlyArray<ReconcilerDish>;
}

/** The slice of a dish the reconciler reads. */
export interface ReconcilerDish {
  readonly dish_id: string;
  readonly recipe_id: string;
  /** The settings a run of the dish reads: its group's under its own
   *  (`dishTriggerSettings`). */
  readonly config_overlay: Readonly<Record<string, unknown>>;
}

/** The settings a dish's triggers are made from: what a run of it reads
 *  (`mergeRecipeConfigLayers`), its group's settings under its own. Without
 *  the group's, a folder set on the group reached every run and no trigger. */
export const dishTriggerSettings = (
  dish: ReconcilerDish & { readonly group_id?: string },
  groupOverlay: (group_id: string) => Readonly<Record<string, unknown>> | undefined,
): ReconcilerDish => dish.group_id === undefined
  ? dish
  : { ...dish, config_overlay: { ...(groupOverlay(dish.group_id) ?? {}), ...dish.config_overlay } };

export interface ReconcileResult {
  created: number;
  removed: number;
  /** D-315 §5.1 — rows re-pointed in place to the template their recipe's
   *  setting holds now, or to the pattern part (a folder, a mailbox) it holds. */
  repointed: number;
  /** Declared entries skipped (composition.* / schedule.* markers,
   *  unparseable sugar, zero-coverage alias, invalid pattern) —
   *  observability for the boot log. */
  skipped: number;
  changed: boolean;
}

const defaultMint = (): string => `t-${randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** Canonical JSON for the declaration identity: flat objects sort
 *  their keys, arrays sort their elements (filter AND-semantics and
 *  fields any-of semantics are both order-independent, so reordering
 *  an entry's keys must not re-mint its row). */
const canonicalFilter = (filter: Record<string, unknown> | undefined): string =>
  filter === undefined
    ? 'null'
    : JSON.stringify(Object.fromEntries(Object.entries(filter).sort(([a], [b]) => (a < b ? -1 : 1))));

const canonicalFields = (fields: string[] | undefined): string =>
  fields === undefined ? 'null' : JSON.stringify([...fields].sort());

export interface Declaration {
  recipe_id: string;
  publisher_id: string;
  /** D-319 — the dish the row is made for. `null` only on a stored row
   *  written before D-319, which therefore matches no declaration. */
  dish_id?: string | null;
  pattern: string;
  filter?: Record<string, unknown>;
  fields?: string[];
  /** D-315 §5.1 — the recipe setting its `record.template` came from. Not
   *  part of the identity: the row follows the setting (`reconcile…`). */
  template_variable?: string;
  /** The parts of `pattern` a setting filled (`{{config.<setting>}}` in the
   *  recipe's `event`), by position. Not part of the identity either: the row
   *  follows the setting the same way. */
  setting_segments?: number[];
}

/** Collision-proof identity (JSON-array encoding — filter values may
 *  contain any delimiter a join would pick). Applied identically to
 *  declared entries and stored rows, so a row keeps matching its unchanged
 *  declaration — `enabled` stickiness survives. */
export const declarationKey = (d: Declaration): string =>
  JSON.stringify([
    d.publisher_id,
    d.recipe_id,
    d.dish_id ?? null,
    d.pattern,
    canonicalFilter(d.filter),
    canonicalFields(d.fields),
  ]);

/** A stored row, as a declaration of the dish it was made for. */
export const rowDeclaration = (row: EventTrigger): Declaration => ({
  recipe_id: row.recipe_id,
  publisher_id: row.publisher_id,
  dish_id: row.dish_id ?? null,
  pattern: row.pattern,
  ...(row.filter !== undefined && row.filter !== null ? { filter: row.filter } : {}),
  ...(row.fields !== undefined && row.fields !== null ? { fields: row.fields } : {}),
});

const isSyntheticMarker = (pattern: string): boolean =>
  pattern === 'composition' || pattern.startsWith('composition.')
  || pattern === 'schedule' || pattern.startsWith('schedule.');

const isRecordsDurablePointer = (pattern: string): boolean =>
  pattern === 'record.*'
  || pattern === 'record.created'
  || pattern === 'record.updated'
  || pattern === 'record.deleted';

/** ⛔ D-296 — the one trigger a recipe's update may CARRY OVER: a dish's
 *  single row of it, when the recipe now declares exactly one DIFFERENT
 *  trigger.
 *
 *  A changed declaration (event, filter or fields) is a new identity, so the
 *  reconcile used to remove the row — with its armed state and its settings
 *  dish — and create the new one DISARMED (D-179 P5c: installing a pack never
 *  silently starts automation). An owner whose automation the update touched
 *  lost it silently and had to redo every setting. Traced over the whole
 *  history (2026-09-23): 0 of 27 release upgrades changed a key, and the one
 *  edit that ever did was exactly this shape — one row before, one after, same
 *  recipe. That pairing is unambiguous; anything else (a recipe with several
 *  rows, a count that changed) cannot be paired and still switches off — the
 *  update dialog names those (`triggersSwitchedOff`).
 *
 *  `managed` / `declaredKeys` are ONE dish's rows and declaration keys of
 *  its recipe (D-319 — two dishes of a recipe each carry their own row). */
export const carriedTriggerFor = (
  managed: ReadonlyArray<{ key: string; row: EventTrigger }>,
  declaredKeys: readonly string[],
): { row: EventTrigger; newKey: string } | null =>
  managed.length === 1 && declaredKeys.length === 1 && managed[0]!.key !== declaredKeys[0]
    ? { row: managed[0]!.row, newKey: declaredKeys[0]! }
    : null;

/** The trigger declarations one recipe makes for one dish of it — its
 *  `event_triggers`, the authoring sugar compiled against the vendor
 *  registry (a `template_variable` narrowed to the template the dish's
 *  `settings` hold), the markers and records pointers skipped. Shared by the
 *  reconciler and the update preview (D-296), so a warning about what an
 *  update switches off reads the SAME declarations the reconcile will. The
 *  declarations carry no `dish_id`; the caller adds its dish's. */
export const recipeTriggerDeclarations = (
  recipe: { recipe_id: string; publisher_id: string; definition: RecipeDefinition },
  vendorEntities: ReadonlyArray<Pick<ConnectionVendorEntity, 'vendor' | 'entity' | 'crm_alias'>>,
  settings: Readonly<Record<string, unknown>> = {},
): { declarations: Declaration[]; skipped: number } => {
  const declarations: Declaration[] = [];
  let skipped = 0;
  const row = { recipe_id: recipe.recipe_id, publisher_id: recipe.publisher_id };
  const declare = (d: Declaration): void => { declarations.push(d); };
  const entries = recipe.definition.event_triggers;
  if (!Array.isArray(entries)) return { declarations, skipped };
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      skipped += 1;
      continue;
    }
    // SUGAR form — compile against the live registry.
    if (typeof entry.on === 'string') {
      const compiled = compileTriggerSugarEntry(entry, vendorEntities, {
        templateOf: (variable) => {
          const held = settings[variable];
          return typeof held === 'string' && held.length > 0 ? held : null;
        },
      });
      if (compiled === null || compiled.length === 0) {
        skipped += 1;
        continue;
      }
      let declaredAny = false;
      for (const sub of compiled) {
        if (!isValidPattern(sub.pattern)) continue;
        declare({
          recipe_id: row.recipe_id,
          publisher_id: row.publisher_id,
          pattern: sub.pattern,
          ...(sub.filter !== undefined ? { filter: sub.filter } : {}),
          ...(sub.fields !== undefined ? { fields: sub.fields } : {}),
          ...(typeof entry.template_variable === 'string' ? { template_variable: entry.template_variable } : {}),
        });
        declaredAny = true;
      }
      if (!declaredAny) skipped += 1;
      continue;
    }
    // RAW form.
    const pattern = entry.event;
    if (typeof pattern !== 'string' || pattern.length === 0) {
      skipped += 1;
      continue;
    }
    if (isSyntheticMarker(pattern)) {
      skipped += 1;
      continue;
    }
    // D-221 record pointers are delivered from their transactional outbox,
    // not the best-effort warehouse bus. Materializing a second mutable
    // trigger row would create a misleading arm/config surface that the
    // durable subscriber snapshot could not safely reinterpret.
    if (isRecordsDurablePointer(pattern)) {
      skipped += 1;
      continue;
    }
    // A part the dish's setting fills (`data.file.{{config.file_slug}}.*.created`):
    // the value a run of this dish reads there — its own setting, else the
    // recipe's default, as the engine fills it. None, or a value that is not one
    // plain part, and the dish gets no row: it would start for every folder.
    const setting_segments = eventPatternSegments(pattern)
      .flatMap((segment, index) => (settingOfEventSegment(segment) === null ? [] : [index]));
    const subscribed = setting_segments.length === 0
      ? pattern
      : resolveEventPatternSettings(pattern, (setting) =>
        Object.prototype.hasOwnProperty.call(settings, setting)
          ? settings[setting]
          : extractVariableDefault(recipe.definition.variables?.[setting]));
    if (subscribed === null || !isValidPattern(subscribed)) {
      skipped += 1;
      continue;
    }
    const filter = entry.filter !== undefined
      && entry.filter !== null
      && typeof entry.filter === 'object'
      && !Array.isArray(entry.filter)
      && Object.keys(entry.filter).length > 0
      ? entry.filter
      : undefined;
    declare({
      recipe_id: row.recipe_id,
      publisher_id: row.publisher_id,
      pattern: subscribed,
      ...(filter !== undefined ? { filter } : {}),
      ...(setting_segments.length > 0 ? { setting_segments } : {}),
    });
  }
  return { declarations, skipped };
};

/** D-319 — the dishes each recipe was switched on as. */
const dishesByRecipe = (dishes: ReadonlyArray<ReconcilerDish>): Map<string, ReconcilerDish[]> => {
  const byRecipe = new Map<string, ReconcilerDish[]>();
  for (const dish of dishes) {
    byRecipe.set(dish.recipe_id, [...(byRecipe.get(dish.recipe_id) ?? []), dish]);
  }
  return byRecipe;
};

export const reconcileDeclarativeTriggers = (
  deps: ReconcileDeclarativeTriggersDeps,
): ReconcileResult => {
  const now = deps.now ?? (() => Date.now());
  const mint = deps.mintTriggerId ?? defaultMint;
  const vendorEntities = deps.getVendorEntities?.() ?? [];
  const dishes = dishesByRecipe(deps.listDishes?.() ?? []);

  // Declared set: each installed recipe's triggers, once per dish of it.
  const declared = new Map<string, Declaration>();
  let skipped = 0;
  const declare = (d: Declaration): void => {
    const key = declarationKey(d);
    if (!declared.has(key)) declared.set(key, d);
  };
  for (const row of deps.listStored()) {
    const ofRecipe = dishes.get(row.recipe_id) ?? [];
    if (ofRecipe.length === 0) continue;
    let definition: RecipeDefinition;
    try {
      definition = JSON.parse(row.recipe_json) as RecipeDefinition;
    } catch {
      continue;
    }
    for (const dish of ofRecipe) {
      const recipe = recipeTriggerDeclarations(
        { recipe_id: row.recipe_id, publisher_id: row.publisher_id, definition },
        vendorEntities,
        dish.config_overlay,
      );
      skipped += recipe.skipped;
      for (const d of recipe.declarations) declare({ ...d, dish_id: dish.dish_id });
    }
  }

  // Managed rows currently in the store.
  const managed = deps.store.list().filter((t) => t.origin === 'recipe');
  const managedByKey = new Map(managed.map((t) => [declarationKey(rowDeclaration(t)), t] as const));

  // D-315 §5.1 — a row narrowed to its dish's template follows the setting:
  // when the owner picks another template, the row is re-pointed in place — on
  // or off as it was, its history kept. Paired only when exactly one row and
  // one declaration of the dish differ by the template alone; anything else is
  // left to the rules below.
  // A row whose pattern a setting filled (`{{config.<setting>}}`) follows the
  // same way when the owner picks another folder: the parts the setting filled
  // are left out of the pairing, and the row's pattern is re-pointed.
  let repointed = 0;
  const withoutTemplate = (filter: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (filter === undefined) return undefined;
    const rest = Object.fromEntries(Object.entries(filter).filter(([path]) => path !== 'record.template'));
    return Object.keys(rest).length > 0 ? rest : undefined;
  };
  /** `d`'s identity without what a setting chose: its template, and the
   *  pattern parts at `settingSegments` (a filled pattern is plain parts, so a
   *  plain split is right here). */
  const looseKey = (d: Declaration, settingSegments: readonly number[] = []): string => {
    const filter = withoutTemplate(d.filter);
    return declarationKey({
      recipe_id: d.recipe_id,
      publisher_id: d.publisher_id,
      dish_id: d.dish_id ?? null,
      pattern: d.pattern.split('.').map((part, index) => (settingSegments.includes(index) ? '{{setting}}' : part)).join('.'),
      ...(filter !== undefined ? { filter } : {}),
      ...(d.fields !== undefined ? { fields: d.fields } : {}),
    });
  };
  const followers = [...declared].filter(([key, d]) => !managedByKey.has(key)
    && (d.template_variable !== undefined || d.setting_segments !== undefined));
  for (const [key, decl] of followers) {
    const segments = decl.setting_segments ?? [];
    const loose = looseKey(decl, segments);
    const rivals = followers.filter(([, other]) => looseKey(other, segments) === loose);
    const rows = [...managedByKey].filter(([rowKey, row]) =>
      !declared.has(rowKey)
      && (decl.template_variable === undefined || typeof row.filter?.['record.template'] === 'string')
      && looseKey(rowDeclaration(row), segments) === loose);
    if (rivals.length !== 1 || rows.length !== 1) continue;
    const [rowKey, row] = rows[0]!;
    const updated = deps.store.update(row.trigger_id, decl.template_variable !== undefined
      ? { filter: decl.filter ?? null }
      : { pattern: decl.pattern });
    if (updated === null) continue;
    managedByKey.delete(rowKey);
    managedByKey.set(key, updated);
    repointed += 1;
  }

  // D-296 — per dish, the single row an update may carry to its single new
  // declaration (`carriedTriggerFor`).
  const dishOf = (d: Declaration): string =>
    JSON.stringify([d.publisher_id, d.recipe_id, d.dish_id ?? null]);
  const managedByDish = new Map<string, Array<{ key: string; row: EventTrigger }>>();
  for (const [key, row] of managedByKey) {
    const at = dishOf(rowDeclaration(row));
    managedByDish.set(at, [...(managedByDish.get(at) ?? []), { key, row }]);
  }
  const declaredByDish = new Map<string, string[]>();
  for (const [key, decl] of declared) {
    declaredByDish.set(dishOf(decl), [...(declaredByDish.get(dishOf(decl)) ?? []), key]);
  }
  // The owner's state is read before anything is written: a row a reviewed
  // execution parks (D-261) reads `enabled: false` but is on for the owner.
  const carryTo = new Map<string, { row: EventTrigger; enabled: boolean }>();
  for (const [dish, rows] of managedByDish) {
    const carried = carriedTriggerFor(rows, declaredByDish.get(dish) ?? []);
    if (carried !== null) {
      carryTo.set(carried.newKey, { row: carried.row, enabled: deps.store.ownerEnabled(carried.row.trigger_id) });
    }
  }

  let created = 0;
  for (const [key, decl] of declared) {
    if (managedByKey.has(key)) continue;
    const carry = carryTo.get(key);
    const prior = carry?.row;
    const trigger = deps.store.create({
      trigger_id: mint(),
      recipe_id: decl.recipe_id,
      publisher_id: decl.publisher_id,
      pattern: decl.pattern,
      // D-319 — a row the reconciler makes starts OFF: switching its dish on
      // is what starts it (`dish-automation.ts`), so neither a recipe update
      // that declares a new trigger nor a dish made before D-319 starts
      // anything by itself (D-179 P5c's posture).
      // D-296 — except the one row an update CARRIES OVER, which keeps the
      // owner's armed state and poll interval.
      enabled: carry?.enabled ?? false,
      dish_id: decl.dish_id ?? null,
      ...(prior?.watch_interval_ms !== undefined && prior.watch_interval_ms !== null
        ? { watch_interval_ms: prior.watch_interval_ms }
        : {}),
      created_at: now(),
      origin: 'recipe',
      ...(decl.filter !== undefined ? { filter: decl.filter } : {}),
      ...(decl.fields !== undefined ? { fields: decl.fields } : {}),
    });
    // Its last outcome too: Automation shows it ("last fired", tripped).
    if (prior !== undefined && prior.last_fired_at !== null) {
      deps.store.update(trigger.trigger_id, { last_fired_at: prior.last_fired_at, last_error: prior.last_error });
    }
    created += 1;
  }

  let removed = 0;
  for (const [key, row] of managedByKey) {
    if (declared.has(key)) continue;
    if (deps.store.remove(row.trigger_id)) removed += 1;
  }

  return { created, removed, repointed, skipped, changed: created > 0 || removed > 0 || repointed > 0 };
};
