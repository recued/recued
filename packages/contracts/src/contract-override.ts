/** D-166 override-write path — the rpc DTO types + a pure wire-input
 *  normalizer for the `collection.contract.*` family that authors
 *  actor-scoped `contract.override.*` tightening rows. One row is keyed
 *  `(actor, ingredient_id, operation_id?)`; every present field can only
 *  RESTRICT the existing admission flow. D-211's global owner replacement of
 *  pack operation `{risk, approval}` lives separately in
 *  `owner-operation-override.ts` and has no actor/contract dimension.
 *
 *  These types are the wire contract shared by the backend handler
 *  (`backend/server/src/contract-handler.ts`) and the Settings → Advanced
 *  inventory UI. The persisted row value's structural shape is owned by the
 *  `override_policy` value_shape in `contract-schema.ts` — this module mirrors
 *  it as a TypeScript surface for the rpc + the picker form.
 *
 *  Spec: D-166; the runtime consumer is
 *  `packages/engine/src/catalog-gateway.ts` (`applyOverrideTightening`). */

import type { Actor } from './commits.js';
import {
  isCatalogForm,
  type OperationApproval,
  type OperationRiskTier,
} from './ingredient-catalog.js';
import type { IngredientKind, IngredientManifest } from './ingredient.js';
import {
  derivePerOpDependencyReads,
  type DependencyReadAdmission,
} from './work-entity-dependency-admission.js';

/** The `contract.*` scope name override rows live under (a `composite_keys`
 *  entry in `D165_CONTRACT_SCHEMA`). Shared so the handler + tests + UI never
 *  spell the literal. */
export const OVERRIDE_SCOPE = 'override';

/** The risk ceiling an override may impose on auto-execution (the op tier above
 *  which approval is forced). NOT `RiskTier` — `destructive` always needs
 *  approval so it has no place on the ceiling, and `none` ("approve everything")
 *  is the strictest setting. Mirrors `override_policy.max_risk_without_approval`. */
export type OverrideRiskCeiling = 'read' | 'write' | 'admin' | 'none';

/** A user-authored override policy (the `collection.contract.upsertOverride`
 *  request `policy`). All fields optional — an absent field leaves the
 *  authored/composed posture unchanged. Mirrors the `override_policy`
 *  value_shape field-for-field, PLUS the wire-only `confirm_risk_downgrade`
 *  flag (never stored). An all-absent policy is a no-op and is rejected by the
 *  rpc (`deleteOverride` is the clear path). */
export interface OverridePolicyInput {
  /** Force-deny the operation (projects to `allowed:false` at dispatch).
   *  Tighten-only. */
  denied?: boolean;
  /** Tighten the approval posture through the existing stricter-wins lattice. */
  approval?: OperationApproval;
  /** Force approval for any op at or above this tier. Tighten-only. */
  max_risk_without_approval?: OverrideRiskCeiling;
  /** Tighten the per-call timeout (ms). Not yet consumed at dispatch (D-166
   *  Inv 6 — no `CatalogOperationResolution` slot); persisted forward-compat. */
  timeout_ms?: number;
  /** Tighten the read-cache TTL (ms). Not yet consumed at dispatch (D-166
   *  Inv 7); persisted forward-compat. */
  cache_ttl_ms?: number;
}

/** One persisted override row, projected for the rpc response + the inventory
 *  UI. `operation_id` is null for an ingredient-wide override (the
 *  `[actor, ingredient_id]` 2-segment key). */
export interface OverrideView {
  actor: Actor;
  ingredient_id: string;
  operation_id: string | null;
  policy: OverridePolicyInput;
  written_at: number;
}

/** Normalize a wire policy object into the row value the store persists: drop
 *  `null`/`undefined` fields (clean rows — a cleared facet is simply absent, not
 *  an explicit null), while PRESERVING any other unknown keys so the store's `validateContractWrite`
 *  rejects them loudly (`unknown_field`) rather than the handler silently
 *  swallowing a client typo. Types are NOT checked here — the store's
 *  value_shape validator is the single structural gate. */
export const overrideRowValue = (
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const value: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(input)) {
    if (v !== undefined && v !== null) value[key] = v;
  }
  return value;
};

/** True when a policy carries no effective (non-null) field — a meaningless
 *  upsert the rpc rejects so override rows always rule on something and
 *  clearing routes through `deleteOverride`. */
export const isEmptyOverridePolicy = (
  input: Readonly<Record<string, unknown>>,
): boolean => Object.keys(overrideRowValue(input)).length === 0;

// ════════════════════════════════════════════════════════════════
// Catalog-operations inventory (Slice A2) — the picker source
// ════════════════════════════════════════════════════════════════

/** One declared operation of a catalog-form ingredient, projected for the
 * owner operation-default editor and the legacy Settings restriction picker.
 * `operation_id` is the fully-qualified `<slug>.<op>` both writers use. */
export interface CatalogOperationView {
  operation_id: string;
  /** The manifest `operations` MAP KEY (the short `op`, e.g. `audio.transcribe`)
   *  — distinct from the qualified `operation_id` (`<author>/<slug>.<op>`). This
   *  is the id the `cli_reachability` allowlist + the gateway's cli stage key on
   *  (`cli-tool-universe` derives its rows from `Object.entries(operations)`), so
   *  a cli-op grant toggle MUST use THIS, not the qualified `operation_id`. */
  operation_key: string;
  risk_tier: OperationRiskTier;
  /** Author-declared approval, when the op carries one. Absent means the
   * resolver's existing provider/risk fallback remains in force. */
  approval?: OperationApproval;
  groups: string[];
  /** D-192 Slice 7 — the container reads granting THIS op transitively admits
   *  (`work_entity_sources[].source_dependencies[]`): granting a write op like
   *  Linear `issue.create` also lets the gateway read `team.search` to resolve the
   *  container, WITHOUT a separate team-read grant. The grant grid discloses this
   *  ("also reads: team") so the grant is legible. Present only on the (few) ops a
   *  dependency binds; absent otherwise. Same admission the gate
   *  (`deriveAllowedOperations`) computes — one shared definition, no drift. */
  also_reads?: DependencyReadAdmission[];
}

/** One catalog-form ingredient + its operations, for the picker's two-level
 *  ingredient → operation selection. `name` is the display label so the picker
 *  needs no second lookup. Sourced from the manifest registry (NOT
 *  `contract.installed_ingredient`, which stays empty until the D-165 P3 install
 *  planner writes it). */
export interface CatalogIngredientView {
  ingredient_id: string;
  name: string;
  operations: CatalogOperationView[];
  /** The AUTHORED slug of the pack that installed this ingredient, when the
   *  server resolved one from its inventory. Grant surfaces filter a pack's
   *  slice of the op universe with it; the manifest-derived composition slug is
   *  only a fallback, and it is WRONG for a Records pack, whose catalog
   *  registers under a content-addressed `records-<hash>` id. */
  pack_slug?: string;
  /** The ingredient's `IngredientKind` (from the manifest). Grant surfaces read
   *  it to ROUTE a per-op toggle to the right authority store: a `cli` op's
   *  admission is the SEPARATE `cli_reachability` allowlist (fail-closed), NOT
   *  the `contract_grant` op axis, so a cli op must write `cli.reachability.set`,
   *  not `contract.grant.write`. Absent when the manifest declares no kind. */
  kind?: IngredientKind;
}

/** Project a manifest set into the picker inventory: keep only catalog-form
 *  manifests (those with a non-empty `operations` map), project each operation
 *  to its policy-relevant fields, and sort deterministically (ingredients by
 *  slug, operations by operation_id) so the picker renders stably. Pure. */
export const catalogIngredientViews = (
  manifests: readonly IngredientManifest[],
): CatalogIngredientView[] =>
  manifests
    .filter((manifest) => isCatalogForm(manifest))
    .map((manifest) => {
      const operations = manifest.operations ?? {};
      // D-192 Slice 7 — op_key → the container reads granting it admits, computed
      // ONCE per manifest from `work_entity_sources[].source_dependencies[]` (the
      // SAME admission the gate applies). Keyed by the manifest op key, which is
      // what `source.ops[slot]` names — so it joins straight onto `operation_key`.
      const perOpReads = derivePerOpDependencyReads({
        sources: manifest.work_entity_sources,
        riskOfOp: (op) =>
          Object.prototype.hasOwnProperty.call(operations, op)
            ? operations[op]?.risk_tier
            : undefined,
      });
      return {
        ingredient_id: manifest.slug,
        name: manifest.name,
        ...(manifest.kind !== undefined ? { kind: manifest.kind } : {}),
        // `Object.entries` (not `.values`) so the MAP KEY — the id cli_reachability
        // keys on — is projected alongside the qualified `operation_id`.
        operations: Object.entries(operations)
          .map(([operation_key, op]) => {
            const also_reads = perOpReads.get(operation_key);
            return {
              operation_id: op.operation_id,
              operation_key,
              risk_tier: op.risk_tier,
              ...(op.approval !== undefined ? { approval: op.approval } : {}),
              groups: [...(op.groups ?? [])],
              ...(also_reads !== undefined ? { also_reads } : {}),
            };
          })
          .sort((a, b) => a.operation_id.localeCompare(b.operation_id)),
      };
    })
    .sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id));
