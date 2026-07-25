/** granted-scope coverage — pure helpers bridging a pack's declared per-op
 *  `required_scopes` to an enrolled connection's vendor-granted
 *  `granted_scopes`, so pack-readiness can answer "does this connection
 *  already cover the pack (reuse) or is a scope missing (re-authorize)?"
 *
 *  Two pure functions, no IO:
 *   - `requiredScopesByConnection(manifest)` walks the pack's compositions
 *     (`contents[]`), maps each op's ingredient to the connection slot it
 *     dispatches through (`http` / `connection` / `mcp` shared config), and
 *     unions every op's `required_scopes` per slot.
 *   - `scopeCoverage(needed, granted)` compares a needed set against a
 *     connection's granted set. `granted === undefined` (a non-oauth or
 *     pre-field row) → `known: false`: the consumer renders "coverage
 *     unknown" (a soft hint), never a hard "missing" warning.
 *
 *  This is a READINESS pre-flight, NOT an authorization gate. OAuth scope is
 *  the VENDOR's authz (the vendor rejects an under-scoped token at call
 *  time); Recued's own gate is the per-op contract grant. The coverage check
 *  just spares the user a runtime 403 by getting the token scoped right up
 *  front — `required_scopes` itself is unenforced declarative metadata
 *  (`ingredient-catalog.ts`).
 *
 *  Two deliberate follow-ups (kept OUT to keep this slice tight):
 *   - per-vendor scope-name NORMALIZATION (Google returns canonical-URL
 *     scopes, vendors alias names) — this does EXACT string compare, so a
 *     registered vendor whose granted names differ from its `required_scopes`
 *     could read as "missing." Surface coverage as a soft hint until that
 *     lands.
 *   - the slot → ENROLLED-connection resolution: this keys by the slot name
 *     the manifest's ingredients declare (e.g. `"hubspot"`). Mapping a slot
 *     to the connection record actually bound at install is the consumer's
 *     (readiness UI's) job. */

import type { BulkPackManifest } from './bulk-pack.js';
import type { IngredientRow } from './op-model.js';

/** The connection-slot name an ingredient's ops dispatch through — the
 *  `http` / `connection` / `mcp` shared-config `connection` field. cli / ai /
 *  storage ingredients bind none (no OAuth scope to attribute). */
const ingredientConnectionSlot = (row: IngredientRow): string | undefined =>
  row.http?.connection ?? row.connection?.connection ?? row.mcp?.connection;

/** Union a pack's per-op `required_scopes` per connection slot. Returns a map
 *  from connection-slot name (as the manifest's ingredients declare it, e.g.
 *  `"hubspot"`) → sorted, de-duped scope list. An op whose ingredient binds no
 *  connection (cli / ai) contributes nothing; a connection slot with no
 *  scope-bearing op is absent. Empty for a v1 recipe-only pack (no
 *  compositions) or a pack whose ops declare no `required_scopes`. */
export const requiredScopesByConnection = (
  manifest: BulkPackManifest,
): Record<string, string[]> => {
  const acc = new Map<string, Set<string>>();
  for (const content of manifest.contents ?? []) {
    if (content.type !== 'composition') continue;
    const comp = content.composition;
    // ingredient slug → its connection slot (only the kinds that bind one).
    const slotByIngredient = new Map<string, string>();
    for (const ing of comp.ingredients) {
      const slot = ingredientConnectionSlot(ing);
      if (slot !== undefined && slot.trim() !== '') {
        slotByIngredient.set(ing.slug, slot.trim());
      }
    }
    for (const op of comp.operations) {
      const scopes = op.required_scopes;
      if (scopes === undefined || scopes.length === 0) continue;
      const slot = slotByIngredient.get(op.ingredient);
      if (slot === undefined) continue;
      const set = acc.get(slot) ?? new Set<string>();
      for (const raw of scopes) {
        const s = raw.trim();
        if (s !== '') set.add(s);
      }
      acc.set(slot, set);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [slot, set] of acc) {
    // Only emit a slot that ended up with >=1 real scope — a slot whose ops
    // carried only whitespace scopes would otherwise surface as `{slot: []}`
    // and read as a scope-bearing connection with nothing needed.
    if (set.size > 0) out[slot] = [...set].sort();
  }
  return out;
};

/** EVERY connection slot a pack's compositions bind — a superset of
 *  {@link requiredScopesByConnection} that ALSO emits slots with no OAuth
 *  `required_scopes` (an API-key connection like Stripe: a real dependency the
 *  pack won't run without, just not scope-bearing). Same per-slot scope union;
 *  a slot with no scopes emits `[]`. An op whose ingredient binds no connection
 *  (cli / ai / storage) still contributes nothing — so a pure-cli pack yields
 *  `{}`. The readiness UI enumerates THIS so a no-scope connection still shows a
 *  "set up" row (scope-bearing ones additionally show coverage). */
export const declaredConnectionSlots = (
  manifest: BulkPackManifest,
): Record<string, string[]> => {
  const acc = new Map<string, Set<string>>();
  for (const content of manifest.contents ?? []) {
    if (content.type !== 'composition') continue;
    const comp = content.composition;
    const slotByIngredient = new Map<string, string>();
    for (const ing of comp.ingredients) {
      const slot = ingredientConnectionSlot(ing);
      if (slot !== undefined && slot.trim() !== '') {
        const s = slot.trim();
        slotByIngredient.set(ing.slug, s);
        // Seed EVERY declared slot up front — this is the one behavioural
        // difference from requiredScopesByConnection: a no-scope slot survives.
        if (!acc.has(s)) acc.set(s, new Set<string>());
      }
    }
    for (const op of comp.operations) {
      const scopes = op.required_scopes;
      if (scopes === undefined || scopes.length === 0) continue;
      const slot = slotByIngredient.get(op.ingredient);
      if (slot === undefined) continue;
      const set = acc.get(slot) ?? new Set<string>();
      for (const raw of scopes) {
        const s = raw.trim();
        if (s !== '') set.add(s);
      }
      acc.set(slot, set);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [slot, set] of acc) out[slot] = [...set].sort();
  return out;
};

/** Fork 1 — the union of `required_scopes` a set of packs need on ONE connection
 *  slot. Pass the INSTALLED packs' manifests (least-privilege: an uninstalled
 *  pack's needs are not requested) + the slot/vendor; get the sorted, de-duped
 *  union the connection should be authorized for. Empty when no installed pack
 *  declares a scope-bearing op on that slot. The enroll flow SEEDs the requested
 *  set with the vendor const / user-typed scopes, then unions THIS on top — the
 *  const is a floor, never a ceiling, so a pack's write op is requested once its
 *  pack is installed. */
export const unionRequiredScopesForConnection = (
  manifests: readonly BulkPackManifest[],
  slot: string,
): string[] => {
  const acc = new Set<string>();
  for (const manifest of manifests) {
    for (const s of requiredScopesByConnection(manifest)[slot] ?? []) acc.add(s);
  }
  return [...acc].sort();
};

/** The result of comparing a pack's needed scopes against a connection's
 *  vendor-granted set. */
export interface ScopeCoverage {
  /** Whether the connection's granted set is KNOWN (vendor-reported). False
   *  for a non-oauth or pre-field connection → consumers render "coverage
   *  unknown" (a soft hint), never a hard "missing scopes" warning. */
  known: boolean;
  /** True iff `known` AND every needed scope is in the granted set (an empty
   *  `needed` is trivially covered when known). */
  covered: boolean;
  /** The needed scopes NOT in the granted set (sorted, de-duped). Empty when
   *  covered, or when `known` is false (unknown ≠ missing). */
  missing: string[];
}

/** Compare a needed scope set against a connection's granted set. Exact
 *  string match (OAuth scopes are case-sensitive); per-vendor name
 *  normalization is a follow-up (see module header). `granted === undefined`
 *  → unknown coverage (`known: false`, no missing). */
export const scopeCoverage = (
  needed: readonly string[],
  granted: readonly string[] | undefined,
): ScopeCoverage => {
  if (granted === undefined) return { known: false, covered: false, missing: [] };
  const have = new Set(
    granted.map((s) => s.trim()).filter((s) => s !== ''),
  );
  const missing = [
    ...new Set(needed.map((s) => s.trim()).filter((s) => s !== '' && !have.has(s))),
  ].sort();
  return { known: true, covered: missing.length === 0, missing };
};
