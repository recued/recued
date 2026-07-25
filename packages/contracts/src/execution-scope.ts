/** D-119 Phase 15 — execution scope (recipe + ingredient install gate).
 *  D-126 Phase 1.2 — derivation now keys on the required `kind` field
 *  via `kindToScope`; the prior shape/slug inference rules retired.
 *
 *  An ingredient or recipe declares which runtimes can host its
 *  execution: `'device'` (extension or webapp) or `'server'`
 *  (recued-server). The engine derives the *maximum-possible* scope
 *  from each ingredient's `kind`; the author may declare a *narrower*
 *  intent. Validators reject declarations wider than the derivation;
 *  the install gate refuses recipes whose derived scope excludes the
 *  current device role.
 *
 *  Derivation rules (per ingredient, via `kindToScope`):
 *    - `kind: 'service'`                                   → ['server']
 *    - `kind: 'dom' | 'chat'`                              → ['device']
 *    - `kind: 'http' | 'ai' | 'mcp' | 'storage'
 *             | 'connection'`                              → ['device', 'server']
 *
 *  `kindToScope` itself returns the finer-grained `DeviceClass[]`
 *  (`'ext' | 'server' | 'webapp'`) — the recipe-level `ExecutionScope`
 *  collapses ext + webapp into the legacy `'device'` class. Per-runtime
 *  webapp restrictions (no DOM, no chat) are already captured because
 *  those kinds resolve to `['ext']`, never `['ext','server','webapp']`.
 *
 *  Recipe-level derivation = intersection of every ingredient's
 *  derived scope. A recipe mixing `kind: 'dom'` + `kind: 'service'`
 *  ingredients yields the empty set — install fails on every runtime,
 *  surfacing the conflict at validate time.
 *
 *  Spec: `docs/d-119-spec.md` lines 442–467, 614–623;
 *        `docs/d-126-spec.md` § A.2, § 1.2.
 */

import type { IngredientKind, IngredientManifest } from './ingredient.js';

/** Runtime that can host recipe execution. `device` = extension
 *  (browser, manual / live-tab); `server` = recued-server (24/7,
 *  warehouse-resident). Mirrors `RuntimeRole` from `role.ts` but
 *  uses the user-facing vocabulary established by D-119 (extension
 *  → device in UI). */
export type ExecutionScope = 'device' | 'server';

/** Canonical full-scope tuple. Order is significant only for
 *  rendering — set semantics elsewhere. */
export const ALL_EXECUTION_SCOPES: readonly ExecutionScope[] = ['device', 'server'] as const;

/** True iff the value is a syntactically valid execution-scope array
 *  (non-empty, only known members, no duplicates). Pure shape check;
 *  does not consult derivation. */
export const isValidExecutionScope = (value: unknown): value is ExecutionScope[] => {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<unknown>();
  for (const v of value) {
    if (v !== 'device' && v !== 'server') return false;
    if (seen.has(v)) return false;
    seen.add(v);
  }
  return true;
};

/** True iff `subset` ⊆ `superset` (set semantics, order-insensitive). */
export const isExecutionScopeSubset = (
  subset: readonly ExecutionScope[],
  superset: readonly ExecutionScope[],
): boolean => {
  if (subset.length === 0) return true;
  const big = new Set(superset);
  return subset.every((s) => big.has(s));
};

/** Sort a scope tuple into canonical order (`device` before `server`)
 *  for stable rendering and equality comparisons. Returns a fresh array. */
export const sortExecutionScope = (scope: readonly ExecutionScope[]): ExecutionScope[] =>
  [...new Set(scope)].sort((a, b) => ALL_EXECUTION_SCOPES.indexOf(a) - ALL_EXECUTION_SCOPES.indexOf(b));

// ────────────────────────────────────────────────────────────────
// D-126 — DeviceClass + per-kind scope lookup
// ────────────────────────────────────────────────────────────────

/** Finer-grained runtime classification used by `kindToScope` (D-126
 *  § A.2). `ExecutionScope` collapses `'ext'` and `'webapp'` into the
 *  single `'device'` class for recipe-level derivation; this type
 *  preserves the distinction at the per-kind layer so install gates
 *  can reason about webapp-specific kind restrictions (DOM / chat are
 *  ext-only — see `project_webapp_runtime_constraints.md`). */
export type DeviceClass = 'ext' | 'server' | 'webapp';

/** Canonical full DeviceClass tuple. Order is significant only for
 *  rendering — set semantics elsewhere. */
export const ALL_DEVICE_CLASSES: readonly DeviceClass[] = ['ext', 'server', 'webapp'] as const;

/** Maximum DeviceClass set a single ingredient kind can run on (D-126
 *  § A.2). Closed switch — adding an `IngredientKind` member without
 *  extending this lookup is a compile error. */
export const kindToScope = (kind: IngredientKind): readonly DeviceClass[] => {
  switch (kind) {
    case 'dom':
    case 'chat':
      return ['ext'];
    case 'service':
    case 'cli':
      // D-182 — cli ops shell out to a local binary the server hosts;
      // server-only, same as a D-118 service.
      return ['server'];
    case 'http':
    case 'ai':
    case 'mcp':
    case 'storage':
    case 'connection':
      return ['ext', 'server', 'webapp'];
  }
};

/** Collapse a DeviceClass into the legacy 2-class `ExecutionScope` used
 *  by recipe-level derivation. `'ext'` and `'webapp'` both fold into
 *  `'device'` (the historical extension-side class); `'server'` passes
 *  through. Webapp-specific kind restrictions are already encoded
 *  upstream by `kindToScope` returning `['ext']` (never `['webapp']`)
 *  for kinds the webapp cannot host. */
const deviceClassToExecutionScope = (cls: DeviceClass): ExecutionScope =>
  cls === 'server' ? 'server' : 'device';

// ────────────────────────────────────────────────────────────────
// Per-ingredient derivation
// ────────────────────────────────────────────────────────────────

/** Maximum scope a single ingredient can run under, derived from its
 *  required `kind` field via `kindToScope` and collapsed to the
 *  recipe-level `ExecutionScope` vocabulary. Pure derivation — never
 *  consults the manifest's own declared `execution_scope` (that's the
 *  validator's job to compare against). */
export const deriveIngredientScope = (manifest: IngredientManifest): ExecutionScope[] =>
  sortExecutionScope(kindToScope(manifest.kind).map(deviceClassToExecutionScope));

// ────────────────────────────────────────────────────────────────
// Recipe-level derivation (intersection across ingredients)
// ────────────────────────────────────────────────────────────────

/** Maximum scope a recipe can run under, given the manifests of every
 *  ingredient it references. Intersection across `deriveIngredientScope`
 *  — a recipe is hostable on a runtime iff every ingredient is.
 *
 *  Returns `['device', 'server']` for a recipe with zero ingredients
 *  (transform-only — both runtimes can host it). Returns `[]` when
 *  the intersection is empty (e.g., a recipe mixing `kind: 'service'`
 *  + a `kind: 'chat'` ingredient — uninstallable on either runtime). */
export const deriveExecutionScope = (
  manifests: readonly IngredientManifest[],
): ExecutionScope[] => {
  let possible: Set<ExecutionScope> = new Set(ALL_EXECUTION_SCOPES);
  for (const m of manifests) {
    const ingredientScope = new Set(deriveIngredientScope(m));
    for (const s of [...possible]) {
      if (!ingredientScope.has(s)) possible.delete(s);
    }
    if (possible.size === 0) break;
  }
  return sortExecutionScope([...possible]);
};

// ────────────────────────────────────────────────────────────────
// Effective scope (narrower of declared vs derived) — for badges
// ────────────────────────────────────────────────────────────────

/** Effective execution scope shown to the user: the narrower of the
 *  author's declared intent (when present + valid) and the manifest-
 *  derived constraint. The derived scope wins when no declaration is
 *  present; otherwise the intersection narrows further toward the
 *  author's intent.
 *
 *  Both inputs accepted as `readonly` arrays; result canonical-sorted. */
export const effectiveExecutionScope = (
  declared: readonly ExecutionScope[] | undefined,
  derived: readonly ExecutionScope[],
): ExecutionScope[] => {
  if (!declared || declared.length === 0) return sortExecutionScope([...derived]);
  const narrowed = declared.filter((s) => derived.includes(s));
  return sortExecutionScope(narrowed);
};

/** Render-ready label for a scope tuple. Used by marketplace cards
 *  and recipe-card badges. Empty input is normalized to a single
 *  `'incompatible'` label so callers don't have to special-case. */
export const executionScopeLabel = (scope: readonly ExecutionScope[]): string => {
  const sorted = sortExecutionScope(scope);
  if (sorted.length === 0) return 'Incompatible';
  if (sorted.length === ALL_EXECUTION_SCOPES.length) return 'Device + server';
  if (sorted[0] === 'device') return 'Device only';
  return 'Server only';
};
