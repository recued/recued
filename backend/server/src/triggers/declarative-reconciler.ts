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
 *  Reconcile = diff `(recipe_id, publisher_id, pattern, filter,
 *  fields)` between installed STORED recipes and the store's
 *  `origin: 'recipe'` rows:
 *
 *  - declared but missing  → create (DISARMED `enabled: false`, `origin:
 *    'recipe'`) — the owner arms it in #automation; installing/saving never
 *    silently starts reactive automation (D-179 P5c; see the create call below)
 *  - present but undeclared → remove (recipe uninstalled / edited)
 *  - present and declared   → UNTOUCHED — the user's `enabled` toggle
 *    and the row's fire bookkeeping survive every reconcile, so
 *    governance disarm sticks (a `triggers.delete` on a recipe-origin
 *    row, by contrast, is undone by the next reconcile — clients hide
 *    Remove for them). Editing an entry's filter/fields changes its
 *    identity (a fresh row, disarmed) — the same posture a pattern edit
 *    has always had.
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
import { compileTriggerSugarEntry } from '@recued/contracts';
import { isValidPattern } from '@recued/warehouse-events';
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
  /** D-179 P5c — managed-dish dissolution on uninstall (owner decision
   *  2026-06-12). When a removed recipe-origin row binds a dish whose
   *  `managed_by_trigger_id` matches it (the dish the enable path
   *  auto-minted), the dish + its continuity snapshot dissolve with
   *  the row. User-assigned dishes are never touched. Optional —
   *  absent ⇒ rows remove as before and any managed dish lingers
   *  (harmless; orphaned dishes are user-deletable). */
  dishStore?: {
    get(dish_id: string): { managed_by_trigger_id?: string } | null;
    delete(dish_id: string): boolean;
  };
  dishContextStore?: { clear(dish_id: string): void };
}

export interface ReconcileResult {
  created: number;
  removed: number;
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

interface Declaration {
  recipe_id: string;
  publisher_id: string;
  pattern: string;
  filter?: Record<string, unknown>;
  fields?: string[];
}

/** Collision-proof identity (JSON-array encoding — filter values may
 *  contain any delimiter a join would pick). Applied identically to
 *  declared entries and stored rows, so pre-sugar rows (no
 *  filter/fields) keep matching their unchanged declarations across
 *  the upgrade — `enabled` stickiness survives. */
const declarationKey = (d: Declaration): string =>
  JSON.stringify([
    d.publisher_id,
    d.recipe_id,
    d.pattern,
    canonicalFilter(d.filter),
    canonicalFields(d.fields),
  ]);

const isSyntheticMarker = (pattern: string): boolean =>
  pattern === 'composition' || pattern.startsWith('composition.')
  || pattern === 'schedule' || pattern.startsWith('schedule.');

const isRecordsDurablePointer = (pattern: string): boolean =>
  pattern === 'record.*'
  || pattern === 'record.created'
  || pattern === 'record.updated'
  || pattern === 'record.deleted';

export const reconcileDeclarativeTriggers = (
  deps: ReconcileDeclarativeTriggersDeps,
): ReconcileResult => {
  const now = deps.now ?? (() => Date.now());
  const mint = deps.mintTriggerId ?? defaultMint;
  const vendorEntities = deps.getVendorEntities?.() ?? [];

  // Declared set from installed recipes.
  const declared = new Map<string, Declaration>();
  let skipped = 0;
  const declare = (d: Declaration): void => {
    const key = declarationKey(d);
    if (!declared.has(key)) declared.set(key, d);
  };
  for (const row of deps.listStored()) {
    let definition: RecipeDefinition;
    try {
      definition = JSON.parse(row.recipe_json) as RecipeDefinition;
    } catch {
      continue;
    }
    const entries = definition.event_triggers;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') {
        skipped += 1;
        continue;
      }
      // SUGAR form — compile against the live registry.
      if (typeof entry.on === 'string') {
        const compiled = compileTriggerSugarEntry(entry, vendorEntities);
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
      if (!isValidPattern(pattern)) {
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
        pattern,
        ...(filter !== undefined ? { filter } : {}),
      });
    }
  }

  // Managed rows currently in the store.
  const managed = deps.store.list().filter((t) => t.origin === 'recipe');
  const managedByKey = new Map(
    managed.map((t) => [
      declarationKey({
        recipe_id: t.recipe_id,
        publisher_id: t.publisher_id,
        pattern: t.pattern,
        ...(t.filter !== undefined ? { filter: t.filter } : {}),
        ...(t.fields !== undefined ? { fields: t.fields } : {}),
      }),
      t,
    ] as const),
  );

  let created = 0;
  for (const [key, decl] of declared) {
    if (managedByKey.has(key)) continue;
    deps.store.create({
      trigger_id: mint(),
      recipe_id: decl.recipe_id,
      publisher_id: decl.publisher_id,
      pattern: decl.pattern,
      // D-179 P5c (owner decision 2026-06-12) — recipe-origin triggers
      // materialize DISARMED. The user arms them in #automation; the
      // enable path then mints + binds the managed dish. Default-off
      // matches the trust direction (D-177): installing a pack never
      // silently starts reactive automation.
      enabled: false,
      created_at: now(),
      origin: 'recipe',
      ...(decl.filter !== undefined ? { filter: decl.filter } : {}),
      ...(decl.fields !== undefined ? { fields: decl.fields } : {}),
    });
    created += 1;
  }

  let removed = 0;
  for (const [key, row] of managedByKey) {
    if (declared.has(key)) continue;
    if (deps.store.remove(row.trigger_id)) {
      removed += 1;
      // D-179 P5c — dissolve the row's auto-minted dish (uninstall =
      // end of the execution instance). Managed-marker match only.
      if (row.dish_id !== undefined && deps.dishStore) {
        const dish = deps.dishStore.get(row.dish_id);
        if (dish && dish.managed_by_trigger_id === row.trigger_id) {
          deps.dishStore.delete(row.dish_id);
          deps.dishContextStore?.clear(row.dish_id);
        }
      }
    }
  }

  return { created, removed, skipped, changed: created > 0 || removed > 0 };
};
