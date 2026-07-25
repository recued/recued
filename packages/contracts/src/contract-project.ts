/** D-166 Slice 4a — value_shape → canonical policy-field projection.
 *
 *  The Slice-3 merge engine (`contract-merge.ts`) composes on CANONICAL policy-
 *  field names — the `FIELD_LATTICES` keys — and its strict-family rules
 *  (`stricter_wins` / `tightening_only` / `union_with_stricter_wins`) THROW on any
 *  non-lattice field. D-165's value_shapes (`contract-schema.ts`) use STORAGE
 *  names that don't all match (`resolved_operations`→`allowed_operation_ids`, the
 *  `denied`→`allowed` deny-flag, plus key/metadata fields that aren't policy at
 *  all). This module is the bridge: it projects a stored value-shape row onto
 *  canonical lattice fields so the dispatcher (4b) and the `tightening_only`
 *  write-enforcement (4c) can feed it straight into `composeRows` / `wouldLoosen`.
 *
 *  Three policy shapes are projected (the two inventory shapes —
 *  `installed_ingredient_info` / `installed_pack_info` — are returned as row-sets
 *  by the inventory roles, never policy-merged, so they have no projection):
 *    - grant_policy        → fully canonical already (identity rename).
 *    - override_policy      → `denied`→`allowed` as a DENY-FLAG (see below); rest
 *                             identity.
 *    - merge_card_resolution→ `resolved_approval`→`approval`,
 *                             `resolved_operations`→`allowed_operation_ids`;
 *                             pack_slug / group_id (key) + resolved_at /
 *                             resolved_by (metadata) DROPPED.
 *
 *  Deny-flag (the `denied`→`allowed` case). `override_policy` is a
 *  `tightening_only` scope — a user override may only RESTRICT, never grant. So
 *  `denied` is a one-way flag, NOT a bidirectional boolean: `denied: true` emits
 *  the strict pole `allowed: false`; `denied: false` (like absent) carries NO
 *  constraint and is DROPPED. A naive negation (`allowed = !denied`) would emit
 *  `allowed: true` from `denied: false`, and since the tightening check skips
 *  fields with no prior constraint that allow would slip through and widen the
 *  grant — the exact loosening the scope forbids. The deny-flag can only ever
 *  emit `allowed: false`, so an override never loosens.
 *
 *  A projection is the complete whitelist for its shape: a storage field NOT in
 *  `rename` is dropped (that's how merge_card sheds its key + metadata). A `null`
 *  / `undefined` optional value is dropped too (no constraint — and a `null`
 *  reaching the lattice validators would throw).
 *
 *  Pure; storage- and context-agnostic. Keyed on value_shape NAME (1:1 with a
 *  scope today, but the projection is a property of the shape, so a future
 *  grant-like scope reusing a shape reuses its projection). The companion
 *  `validatePolicyProjections` proves the map stays consistent with the live
 *  schema + lattice registry (a build-time ratchet, the same idiom as
 *  `validateContractSchemaRegistry`).
 *
 *  Spec: `docs/d-166-spec.md` §"Composition algorithm" (value_shape → canonical
 *  projection step) + §"Merge algebra formalization". */

import { ContractMergeError, FIELD_LATTICES } from './contract-merge.js';
import { isInventoryRole, type ContractSchemaRegistry } from './contract-schema.js';

// ════════════════════════════════════════════════════════════════
// The projection map
// ════════════════════════════════════════════════════════════════

/** How one value_shape's stored fields map onto canonical `FIELD_LATTICES`
 *  fields. `rename` is the COMPLETE whitelist (storage field → canonical field) —
 *  any stored field absent from it is dropped. `deny_flag` lists `rename` source
 *  fields that are one-way deny flags onto a bool target: a `true` emits the
 *  strict pole `false`, a `false` carries no constraint and is dropped (the
 *  `denied`→`allowed` case — a `tightening_only` override may only restrict). */
export interface PolicyProjection {
  /** Storage field → canonical lattice field. Identity entries (same name on
   *  both sides) are explicit so the whitelist — and `validatePolicyProjections`
   *  — see every projected field. */
  rename: Readonly<Record<string, string>>;
  /** Storage fields (each also a `rename` key) that are one-way deny flags: the
   *  target must be a `bool` lattice field, and the shape must type the source
   *  `bool` / `bool?`. `true` → target `false` (strict); `false` → dropped. */
  deny_flag?: readonly string[];
}

/** value_shape name → its projection. The KEY SET is, by construction, exactly
 *  the policy value_shapes (the inventory shapes are excluded — they are returned
 *  as row-sets). `validatePolicyProjections` asserts this against the schema. */
export const POLICY_PROJECTIONS: Readonly<Record<string, PolicyProjection>> = {
  /** Already canonical after the Slice-4a reshape (`granted`→`allowed`,
   *  `approval_required_operations`→`approval_required_operation_ids`): identity. */
  grant_policy: {
    rename: {
      allowed: 'allowed',
      approval: 'approval',
      risk_tier: 'risk_tier',
      denied_operation_ids: 'denied_operation_ids',
      approval_required_operation_ids: 'approval_required_operation_ids',
      max_risk_without_approval: 'max_risk_without_approval',
    },
  },
  /** `denied`→`allowed` as a one-way DENY-FLAG (denied:true → allowed:false;
   *  denied:false drops — a `tightening_only` override may only restrict, never
   *  grant); everything else is already canonical. */
  override_policy: {
    rename: {
      denied: 'allowed',
      approval: 'approval',
      max_risk_without_approval: 'max_risk_without_approval',
      timeout_ms: 'timeout_ms',
      cache_ttl_ms: 'cache_ttl_ms',
    },
    deny_flag: ['denied'],
  },
  /** The user's resolution of a contested (pack, group): the approval + the
   *  resolved allowed-operation set. pack_slug / group_id live in the row PATH and
   *  resolved_at / resolved_by are provenance metadata — none are policy, so they
   *  are dropped (absent from `rename`). */
  merge_card_resolution: {
    rename: {
      resolved_approval: 'approval',
      resolved_operations: 'allowed_operation_ids',
    },
  },
};

/** Whether a value_shape has a policy projection (i.e. is policy-merged, not an
 *  inventory row-set). */
export const isPolicyValueShape = (valueShape: string): boolean =>
  Object.prototype.hasOwnProperty.call(POLICY_PROJECTIONS, valueShape);

// ════════════════════════════════════════════════════════════════
// projectToPolicyFields — one stored row → canonical lattice row
// ════════════════════════════════════════════════════════════════

/** Project a stored value-shape row onto canonical `FIELD_LATTICES` fields so it
 *  can feed `composeRows` / the strict rules without throwing. Drops `null` /
 *  `undefined` (no constraint) and any field not in the projection (key /
 *  metadata). A `deny_flag` field emits the strict pole `false` for `true` and is
 *  dropped for `false` (never emits an `allowed: true`, so an override can't
 *  loosen). Pure — `value` is not mutated.
 *
 *  Throws `ContractMergeError` on a value_shape with no projection (an inventory
 *  shape mis-routed here, or an unknown shape) and on a non-boolean value for a
 *  `deny_flag` field — fail-closed, consistent with the engine's strict-rule
 *  contract. */
export const projectToPolicyFields = (
  valueShape: string,
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const projection = POLICY_PROJECTIONS[valueShape];
  if (!projection) {
    throw new ContractMergeError(
      `no policy projection for value_shape '${valueShape}' (inventory shapes are returned as row-sets, never projected)`,
    );
  }
  const denyFlag = new Set(projection.deny_flag ?? []);
  const out: Record<string, unknown> = {};
  for (const [storageField, canonicalField] of Object.entries(projection.rename)) {
    const raw = value[storageField];
    // null / undefined = "no constraint" for an optional field — drop it so it
    // never reaches the lattice validators (where a null would throw).
    if (raw === null || raw === undefined) continue;
    if (denyFlag.has(storageField)) {
      if (typeof raw !== 'boolean') {
        throw new ContractMergeError(
          `field '${storageField}': a deny-flag projection expects a boolean, got ${JSON.stringify(raw)}`,
        );
      }
      // One-way: deny (true) emits the strict pole; non-deny (false) carries no
      // constraint and is dropped — a tightening_only override never loosens.
      if (raw) out[canonicalField] = false;
      continue;
    }
    out[canonicalField] = raw;
  }
  return out;
};

// ════════════════════════════════════════════════════════════════
// validatePolicyProjections — self-consistency ratchet
// ════════════════════════════════════════════════════════════════

/** Stable codes for a `POLICY_PROJECTIONS` ↔ schema/lattice inconsistency. */
export type PolicyProjectionIssueCode =
  | 'unknown_value_shape'
  | 'source_not_a_field'
  | 'target_not_a_lattice'
  | 'deny_flag_not_in_rename'
  | 'deny_flag_target_not_bool'
  | 'deny_flag_source_not_boolean'
  | 'missing_policy_projection'
  | 'projection_for_inventory_shape';

export interface PolicyProjectionIssue {
  code: PolicyProjectionIssueCode;
  /** The value_shape, or `<value_shape>.<field>`, the issue is about. */
  entry: string;
  detail: string;
}

/** Prove `POLICY_PROJECTIONS` is consistent with a contract schema registry +
 *  the canonical `FIELD_LATTICES`: every projection targets a real bool/other
 *  lattice field and renames real value-shape fields; every deny-flag is renamed,
 *  targets a `bool` lattice field, and is typed boolean on the shape; and the
 *  projection KEY SET is EXACTLY the registry's policy value_shapes (a scope with
 *  any non-inventory `applies_to` role). Pure; returns every issue (empty ⇒
 *  consistent). A build-time ratchet — the same idiom as
 *  `validateContractSchemaRegistry`; if a future D adds a policy scope/shape and
 *  forgets its projection, this catches it before `projectToPolicyFields` throws
 *  at runtime. */
export const validatePolicyProjections = (
  registry: ContractSchemaRegistry,
): PolicyProjectionIssue[] => {
  const issues: PolicyProjectionIssue[] = [];
  const add = (code: PolicyProjectionIssueCode, entry: string, detail: string): void => {
    issues.push({ code, entry, detail });
  };

  // Soundness — every declared projection matches the schema + lattice.
  for (const [shapeName, projection] of Object.entries(POLICY_PROJECTIONS)) {
    const shape = registry.value_shapes[shapeName];
    if (!shape) {
      add('unknown_value_shape', shapeName, `no value_shape '${shapeName}' in the registry`);
      continue;
    }
    const fieldSet = new Set(shape.fields);
    for (const [source, target] of Object.entries(projection.rename)) {
      if (!fieldSet.has(source)) {
        add('source_not_a_field', `${shapeName}.${source}`, `rename source '${source}' is not a field of '${shapeName}'`);
      }
      if (!Object.prototype.hasOwnProperty.call(FIELD_LATTICES, target)) {
        add('target_not_a_lattice', `${shapeName}.${source}`, `rename target '${target}' is not a FIELD_LATTICES field`);
      }
    }
    for (const flag of projection.deny_flag ?? []) {
      const target = projection.rename[flag];
      if (target === undefined) {
        add('deny_flag_not_in_rename', `${shapeName}.${flag}`, `deny_flag field '${flag}' is not in rename`);
      } else if (FIELD_LATTICES[target]?.domain !== 'bool') {
        add('deny_flag_target_not_bool', `${shapeName}.${flag}`, `deny_flag target '${target}' must be a bool lattice field`);
      }
      const descriptor = shape.types[flag];
      if (descriptor !== 'bool' && descriptor !== 'bool?') {
        add('deny_flag_source_not_boolean', `${shapeName}.${flag}`, `deny_flag field '${flag}' must be typed bool/bool? (is '${String(descriptor)}')`);
      }
    }
  }

  // Completeness — projection key set == the registry's policy value_shapes. A
  // scope contributing only to inventory roles is an inventory scope; any other
  // role makes it a policy scope (`isInventoryRole` is the shared split).
  const policyShapes = new Set<string>();
  for (const ck of Object.values(registry.composite_keys)) {
    const inventoryOnly = ck.applies_to.every(isInventoryRole);
    if (!inventoryOnly) policyShapes.add(ck.value_shape);
  }
  for (const shapeName of policyShapes) {
    if (!Object.prototype.hasOwnProperty.call(POLICY_PROJECTIONS, shapeName)) {
      add('missing_policy_projection', shapeName, `policy value_shape '${shapeName}' has no projection`);
    }
  }
  for (const shapeName of Object.keys(POLICY_PROJECTIONS)) {
    if (!policyShapes.has(shapeName)) {
      add('projection_for_inventory_shape', shapeName, `'${shapeName}' has a projection but is not a policy value_shape (inventory shapes are row-sets)`);
    }
  }

  return issues;
};
