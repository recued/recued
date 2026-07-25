/** D-166 Slice 4b — `composeForRole` dispatcher.
 *
 *  The gateway evaluates contract policy one `applies_to` ROLE at a time: it
 *  gathers every composite_keys scope that declares the role, scans that scope's
 *  rows for the dispatch context, projects each row onto canonical policy fields
 *  (Slice 4a), and folds them through the merge engine (Slice 3) in precedence
 *  order. This module is that dispatcher — PURE: it takes the schema's
 *  composite_keys, a `ResolutionContext` (segment-name → value), and an injected
 *  `scan` callback, so it unit-tests with a fake scan and has no storage / DB
 *  dependency. The 4d gateway slice supplies the real `scan` (a thin adapter over
 *  `ContractStore.scan`) and chains the role compositions.
 *
 *  Two role KINDS (D-165 §"Dispatch composition" / D-166 §"Composition
 *  algorithm"):
 *    - INVENTORY roles (`ingredient_inventory` / `pack_inventory`) return the raw
 *      row SET — they list installed inventory, they don't merge a policy. A
 *      context that names an id narrows the list; an empty context lists all.
 *    - POLICY roles (grant_resolution / approval_composition / risk_override /
 *      timeout_override / cache_ttl_override) project + fold their
 *      contributing scopes into one `{ policy, conflicts }` via `composeRows`.
 *
 *  Path resolution. A POLICY scope contributes only when every `required`
 *  segment is resolvable from context (else it can't apply — skipped). The scan
 *  anchors on the required prefix (keeping the optional-tail "match-all" row in
 *  range); `rowMatchesContext` then drops sibling optional-tail specifics. An
 *  INVENTORY scope scans the longest leading run of present segments (empty ⇒
 *  whole scope).
 *
 *  Spec: D-166 §"Composition algorithm (final form)" (386–423) +
 *  D-165 §"Dispatch composition" (1372–1400). */

import { composeRows, FIELD_LATTICES, type ComposeResult, type ContractMergeRow, type MergeConflict } from './contract-merge.js';
import { POLICY_PROJECTIONS, projectToPolicyFields } from './contract-project.js';
import { isInventoryRole, type CompositeKeySchema, type DispatchRole } from './contract-schema.js';
import type { CatalogOperationResolution, OperationApproval, OperationRiskTier } from './ingredient-catalog.js';
import { RISK_TIER_RANK } from './ingredient.js';

// ════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════

/** A dispatch context: segment-name → value, the inputs from which scope paths
 *  are built. Keys are composite_keys segment names (`ingredient_id`,
 *  `pack_slug`, `installed_pack_id`, `connection_name`, `group_id_or_operation_id`,
 *  `group_id`, `actor`, `operation_id`, … and D-166's `channel_id` / `contract_id`).
 *  A missing / undefined key means "not provided" — a policy scope needing it as
 *  a `required` segment is skipped; an optional-tail or inventory segment resolves
 *  to match-all. Schema-driven by design (no fixed field list), so a future D's
 *  new segment needs no change here. */
export type ResolutionContext = Readonly<Record<string, string | undefined>>;

/** The minimal stored-row shape the dispatcher reads — a subset of the store's
 *  `ContractRow` (segments + value), so a `ContractStore.scan` result is
 *  structurally assignable. */
export interface ContractRowLike {
  segments: readonly string[];
  value: Readonly<Record<string, unknown>>;
}

/** Injected row source: every row in `scope` whose segments START WITH
 *  `prefixSegments` (empty ⇒ the whole scope), the `scanNamespace` primitive.
 *  4d adapts `ContractStore.scan`; tests pass a fake. */
export type ScanFn = (scope: string, prefixSegments: readonly string[]) => readonly ContractRowLike[];

/** The result of composing one role. Inventory roles return rows; policy roles
 *  return a merged policy + any same-precedence conflicts (`composeRows`). */
export type RoleComposition =
  | { kind: 'inventory'; rows: ContractRowLike[] }
  | { kind: 'policy'; policy: Record<string, unknown>; conflicts: MergeConflict[] };

// ════════════════════════════════════════════════════════════════
// Path resolution (pure)
// ════════════════════════════════════════════════════════════════

/** The scan prefix for a POLICY scope: each `required` segment resolved from
 *  context. `required` is a segment prefix by the schema invariant, so this is a
 *  valid leading prefix. Returns null when any required segment is absent — the
 *  scope can't apply to this context and contributes nothing. The scan anchors
 *  here (NOT on the optional tail) so the optional-tail "match-all" row stays in
 *  range; `rowMatchesContext` narrows the tail afterwards. */
const strictRequiredPrefix = (
  ck: CompositeKeySchema,
  context: ResolutionContext,
): string[] | null => {
  const prefix: string[] = [];
  for (const seg of ck.required) {
    const v = context[seg];
    if (v === undefined) return null;
    prefix.push(v);
  }
  return prefix;
};

/** The scan prefix for an INVENTORY scope: the longest leading run of segments
 *  present in context (stops at the first absent). Empty ⇒ scan the whole scope
 *  (list-all). Never null — inventory always lists. */
const lenientLeadingPrefix = (
  ck: CompositeKeySchema,
  context: ResolutionContext,
): string[] => {
  const prefix: string[] = [];
  for (const seg of ck.segments) {
    const v = context[seg];
    if (v === undefined) break;
    prefix.push(v);
  }
  return prefix;
};

/** Whether a scanned row applies to the context's optional-tail selection. The
 *  required prefix already matches (it was the scan prefix). For each optional-
 *  tail segment, two cases:
 *
 *    - context OMITS it → governed by the scope's `optional_tail_match` mode
 *      (default `'match_all'`):
 *        · `'match_all'` — EVERY row applies, the bare match-all row AND every
 *          tail-specific row. The fail-CLOSED direction for `override`: a broad
 *          request (no `operation_id`) inherits every per-operation tightening, so
 *          a `tightening_only` override that denies one operation is NOT silently
 *          dropped when the gateway evaluates the ingredient broadly (dropping
 *          them would widen effective permissions — the loosening D-166 forbids).
 *        · `'baseline_only'` — ONLY the bare row that also omits the segment (the
 *          baseline cell) applies; a tail-specific row is dropped. D-166 P2:
 *          policy_matrix's `contract_id` overlay must not bleed into a no-contract
 *          call — a (channel, actor) lookup with no contract resolves the baseline
 *          cell alone, never another contract's overlay.
 *
 *    - context TARGETS it (has a value) → only the bare match-all row (which omits
 *      the segment) and the row whose segment EQUALS the context value apply; a
 *      sibling specific (different value — e.g. `delete_deal` when the request is
 *      `read_deals`, or contract B when the call is under contract A) is dropped.
 *      Identical in both modes.
 *
 *  Vacuously true for a scope with no optional_tail. */
const rowMatchesContext = (
  row: ContractRowLike,
  ck: CompositeKeySchema,
  context: ResolutionContext,
): boolean => {
  const omitMode = ck.optional_tail_match ?? 'match_all';
  for (const seg of ck.optional_tail ?? []) {
    const ctxValue = context[seg];
    const i = ck.segments.indexOf(seg);
    if (ctxValue === undefined) {
      // context omits this tail segment. 'match_all' keeps every row; for
      // 'baseline_only' a row that CARRIES the segment is a tail-specific overlay
      // and is dropped, leaving only the bare baseline row (which omits it, so
      // `i >= row.segments.length`).
      if (omitMode === 'baseline_only' && i < row.segments.length) return false;
      continue;
    }
    // The row carries this segment and it disagrees with the targeted value → a
    // sibling specific; drop it. (A row that omits the segment is the bare
    // match-all row — `i >= row.segments.length` — and always applies.)
    if (i < row.segments.length && ctxValue !== row.segments[i]) return false;
  }
  return true;
};

// ════════════════════════════════════════════════════════════════
// composeForRole
// ════════════════════════════════════════════════════════════════

/** Compose every scope that declares `role` into one role result for `context`
 *  (D-166 §"Composition algorithm"). Inventory roles return the matching row set;
 *  policy roles project each row (Slice 4a) and fold them through `composeRows`
 *  (Slice 3) in precedence order. Pure — all IO is the injected `scan`.
 *
 *  A policy scope whose `required` segments aren't all in context is skipped (it
 *  can't apply). Projection runs ONLY for policy roles; an inventory shape that
 *  reached the policy branch would throw `ContractMergeError` (fail-closed —
 *  `projectToPolicyFields` rejects inventory shapes), surfacing a mis-declared
 *  schema rather than silently mis-merging.
 *
 *  NOTE (D-166 Slice 4b → 4d — per-role FIELD ownership): a policy role result is
 *  the FULL composed policy of every scope that CONTRIBUTES to `role` (the
 *  `applies_to` list governs which scopes contribute + their precedence). It is
 *  NOT yet filtered to the fields that role "owns". The `override` value_shape
 *  carries five fields, one per single-surface role (D-165 §"override_policy":
 *  approval → approval_composition, max_risk_without_approval → risk_override,
 *  timeout_ms → timeout_override, cache_ttl_ms → cache_ttl_override, denied →
 *  grant_resolution), yet it `applies_to` all five — so e.g.
 *  `composeForRole('timeout_override')` returns `approval` / `allowed` alongside
 *  `timeout_ms`. Harmless until consumed: the 4d gateway's `mergeRoleResults`
 *  pins the role → owned-fields map (the consumer is where field ownership
 *  becomes concrete) and extracts each role's slice from its composed policy.
 *  Deciding that map here, with no consumer, would mean inventing a field table
 *  the spec doesn't give + widening D-165's `grant.applies_to`; deferred to 4d
 *  on purpose (same shape as 4a deferring the policy_resolution merge_rule to
 *  this slice). */
export const composeForRole = (
  compositeKeys: Readonly<Record<string, CompositeKeySchema>>,
  role: DispatchRole,
  context: ResolutionContext,
  scan: ScanFn,
): RoleComposition => {
  const contributing = Object.entries(compositeKeys).filter(([, ck]) =>
    ck.applies_to.includes(role),
  );

  if (isInventoryRole(role)) {
    const rows = contributing.flatMap(([name, ck]) =>
      scan(name, lenientLeadingPrefix(ck, context)).filter((r) => rowMatchesContext(r, ck, context)),
    );
    return { kind: 'inventory', rows: [...rows] };
  }

  const tagged: ContractMergeRow[] = contributing.flatMap(([name, ck]) => {
    const prefix = strictRequiredPrefix(ck, context);
    if (prefix === null) return [];
    return scan(name, prefix)
      .filter((r) => rowMatchesContext(r, ck, context))
      .map((r) => ({
        value: projectToPolicyFields(ck.value_shape, r.value),
        merge_precedence: ck.merge_precedence,
        merge_rule: ck.merge_rule,
      }));
  });

  const { policy, conflicts }: ComposeResult = composeRows(tagged);
  return { kind: 'policy', policy, conflicts };
};

// ════════════════════════════════════════════════════════════════
// Per-role field ownership + mergeRoleResults (Slice 4d.2)
// ════════════════════════════════════════════════════════════════

/** Which canonical policy field each POLICY role OWNS — the resolution of the
 *  Slice 4b deferred P2. `composeForRole` returns the FULL composed policy of
 *  every scope contributing to a role, but the `override` value_shape's five
 *  fields each feed a DIFFERENT single-surface role (D-165 §override_policy) while
 *  `override` itself `applies_to` all five — so e.g. `approval` leaks into
 *  grant_resolution's composition (via the grant scope) as well as
 *  approval_composition's (via override). This map pins each canonical field to
 *  ONE owning role — disjoint across roles — so `mergeRoleResults` takes every
 *  field from exactly one place and the leaks are dropped.
 *
 *  Ownership is by FIELD SEMANTICS, not by which scopes happen to carry the field:
 *    - grant_resolution     owns the grant-shaped fields (the allow/deny decision,
 *      its operation sets, the grant's risk tier) + D-166 P2 policy_matrix's
 *      cell-admission fields (`allowed_kinds`, `denied_ingredient_ids`).
 *    - approval_composition owns `approval` + policy_matrix's `approval_tier`.
 *    - risk_override        owns `max_risk_without_approval` (the no-approval risk
 *      ceiling) + policy_matrix's `allowed_risk_tiers`.
 *    - timeout_override / cache_ttl_override own their integer field.
 *
 *  At dispatch via the CATALOG GATEWAY only `override` rows resolve (a `grant` row
 *  needs an installed_pack_id the runtime can't supply until the D-165 P3 install
 *  planner; policy_matrix needs `channel_id` + `actor_id`, which the gateway's
 *  per-operation context lacks), so grant_resolution effectively carries only
 *  `allowed` (the override deny-flag) there. policy_matrix's owned fields populate
 *  only when a channel×actor consumer (the D-153 migration slice) supplies that
 *  context. The map is written for the full model so neither follow-on changes it.
 *
 *  `validateRoleOwnership` proves this stays consistent with the live projections
 *  + lattice (every projection target owned by exactly one role) — the same
 *  build-time-ratchet idiom as `validatePolicyProjections`. */
export const ROLE_OWNED_FIELDS: Readonly<Partial<Record<DispatchRole, readonly string[]>>> = {
  grant_resolution: [
    'allowed',
    'allowed_operation_ids',
    'denied_operation_ids',
    'approval_required_operation_ids',
    'risk_tier',
  ],
  // D-187 — the matrix's per-cell `approval_tier` / `allowed_kinds` /
  // `allowed_risk_tiers` / `denied_ingredient_ids` owned fields were dropped with
  // the policy matrix (their only projection producer, `policy_matrix_cell`, is gone).
  approval_composition: ['approval'],
  risk_override: ['max_risk_without_approval'],
  timeout_override: ['timeout_ms'],
  cache_ttl_override: ['cache_ttl_ms'],
};

/** The effective canonical policy + every same-precedence conflict the
 *  contributing roles surfaced. */
export interface MergedRolePolicy {
  /** Each owned field taken from its owning role's composed policy. */
  policy: Record<string, unknown>;
  /** Same-precedence conflicts from every processed role, deduped — the same
   *  override-row conflict appears once per role `override` applies_to, so an
   *  identical conflict is collapsed. Over-reporting is safe (the gateway raises a
   *  merge card); a conflict is never silently dropped. */
  conflicts: MergeConflict[];
}

/** Merge the per-role compositions (`composeForRole` output, keyed by role) into
 *  ONE canonical effective policy by FIELD OWNERSHIP: each canonical field is
 *  taken from the role that OWNS it (`ROLE_OWNED_FIELDS`), so a field that leaked
 *  into a non-owning role's composition is dropped. Pure.
 *
 *  Inventory compositions (`kind: 'inventory'`) and roles with no ownership are
 *  skipped — they contribute no policy field. A policy role whose composition is
 *  absent contributes nothing (its owned fields stay unset). Because ownership is
 *  disjoint, no two roles can write the same field, so the merge is unambiguous
 *  without cross-role conflict detection. */
export const mergeRoleResults = (
  perRole: Readonly<Partial<Record<DispatchRole, RoleComposition>>>,
): MergedRolePolicy => {
  const policy: Record<string, unknown> = {};
  const conflictByKey = new Map<string, MergeConflict>();
  for (const [role, composition] of Object.entries(perRole) as Array<
    [DispatchRole, RoleComposition | undefined]
  >) {
    if (!composition || composition.kind !== 'policy') continue;
    const owned = ROLE_OWNED_FIELDS[role];
    if (!owned) continue;
    for (const field of owned) {
      if (Object.prototype.hasOwnProperty.call(composition.policy, field)) {
        policy[field] = composition.policy[field];
      }
    }
    for (const conflict of composition.conflicts) {
      conflictByKey.set(JSON.stringify(conflict), conflict);
    }
  }
  return { policy, conflicts: [...conflictByKey.values()] };
};

// ════════════════════════════════════════════════════════════════
// projectToResolution (Slice 4d.2)
// ════════════════════════════════════════════════════════════════

const APPROVAL_ORDER: readonly OperationApproval[] = ['never', 'ask', 'always'];
const stricterApproval = (a: OperationApproval, b: OperationApproval): OperationApproval =>
  APPROVAL_ORDER.indexOf(a) >= APPROVAL_ORDER.indexOf(b) ? a : b;

/** Rank of an effective risk tier for the no-approval CEILING comparison — the
 *  canonical {@link RISK_TIER_RANK} (read 0 … destructive 3). The ceiling enum
 *  (`max_risk_without_approval`: none|read|write|admin) has no `destructive` —
 *  it always needs approval — so it ranks above every ceiling. */
const RISK_CEILING_RANK = RISK_TIER_RANK;
/** Rank of a `max_risk_without_approval` ceiling value. `none` = nothing runs
 *  without approval (ranks below `read`). */
const CEILING_RANK: Readonly<Record<string, number>> = { none: -1, read: 0, write: 1, admin: 2 };

/** TIGHTEN a base `CatalogOperationResolution` (the existing connection-keyed
 *  profile-floor result) with the merged canonical contract policy
 *  (`mergeRoleResults` output). The override layer may only RESTRICT — it never
 *  loosens the base — so this is always safe to apply on top of the floor:
 *
 *    - base already `deny`         → returned unchanged (nothing is stricter than
 *      deny; its structural deny_reason is preserved).
 *    - `allowed: false` (deny-flag)→ force deny (`operation_not_granted`). The
 *      deny-flag projection only ever emits `false`, so this can only tighten.
 *    - `approval`                  → escalate to stricter(base, canonical).
 *    - `max_risk_without_approval` → if `effective_risk_tier` exceeds the ceiling,
 *      force approval ≥ `ask`.
 *    - verdict recomputed: `never` → admit, else ask (mirrors the catalog resolver).
 *
 *  `timeout_ms` / `cache_ttl_ms` have NO slot in `CatalogOperationResolution`
 *  (D-166 Invariants 6/7 — "not yet wired") and are intentionally ignored until
 *  the resolution shape is extended. The grant-set fields (`allowed_operation_ids`
 *  / `denied_*` / `risk_tier`) also have no slot — the base already encodes the
 *  grant decision via the profile floor — and carry no contributor until 4d.5
 *  grants resolve, so they too are ignored today. Pure; `base` is not mutated. */
export const projectToResolution = (
  canonical: Readonly<Record<string, unknown>>,
  base: CatalogOperationResolution,
): CatalogOperationResolution => {
  // A deny is already maximally restrictive — an override can only tighten, and
  // nothing is stricter than deny. Leave it (and its deny_reason) untouched.
  if (base.verdict === 'deny') return base;

  // Deny-flag — the override denied this (actor, ingredient[, operation]).
  if (canonical.allowed === false) {
    return { ...base, verdict: 'deny', granted: false, deny_reason: 'operation_not_granted' };
  }

  let approval = base.approval;
  const canonicalApproval = canonical.approval;
  if (
    canonicalApproval === 'never'
    || canonicalApproval === 'ask'
    || canonicalApproval === 'always'
  ) {
    approval = stricterApproval(approval, canonicalApproval);
  }
  const ceiling = canonical.max_risk_without_approval;
  if (
    typeof ceiling === 'string'
    && Object.prototype.hasOwnProperty.call(CEILING_RANK, ceiling)
    && RISK_CEILING_RANK[base.effective_risk_tier] > CEILING_RANK[ceiling]
  ) {
    approval = stricterApproval(approval, 'ask');
  }

  if (approval === base.approval) return base; // no tightening — base is already correct
  return {
    ...base,
    approval,
    authorization_provenance: { pre_lift_approval: approval },
    verdict: approval === 'never' ? 'admit' : 'ask',
  };
};

// ════════════════════════════════════════════════════════════════
// validateRoleOwnership — self-consistency ratchet
// ════════════════════════════════════════════════════════════════

/** Stable codes for a `ROLE_OWNED_FIELDS` ↔ lattice/projection inconsistency. */
export type RoleOwnershipIssueCode =
  | 'owned_field_not_a_lattice'
  | 'field_owned_by_multiple_roles'
  | 'projection_target_unowned';

export interface RoleOwnershipIssue {
  code: RoleOwnershipIssueCode;
  /** The `<role>.<field>` or bare `<field>` the issue is about. */
  entry: string;
  detail: string;
}

/** Prove `ROLE_OWNED_FIELDS` is consistent with the canonical `FIELD_LATTICES` +
 *  the live `POLICY_PROJECTIONS`: every owned field is a real lattice field, no
 *  field is owned by two roles (ownership must be disjoint so `mergeRoleResults`
 *  is unambiguous), and every canonical field a policy projection targets is owned
 *  by SOME role (else `mergeRoleResults` would silently drop it). Pure; returns
 *  every issue (empty ⇒ consistent). Build-time ratchet, same idiom as
 *  `validatePolicyProjections`. */
export const validateRoleOwnership = (): RoleOwnershipIssue[] => {
  const issues: RoleOwnershipIssue[] = [];
  const owner = new Map<string, DispatchRole>();
  for (const [role, fields] of Object.entries(ROLE_OWNED_FIELDS) as Array<
    [DispatchRole, readonly string[]]
  >) {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(FIELD_LATTICES, field)) {
        issues.push({
          code: 'owned_field_not_a_lattice',
          entry: `${role}.${field}`,
          detail: `owned field '${field}' is not a FIELD_LATTICES field`,
        });
      }
      const prior = owner.get(field);
      if (prior !== undefined) {
        issues.push({
          code: 'field_owned_by_multiple_roles',
          entry: field,
          detail: `field '${field}' is owned by both '${prior}' and '${role}'`,
        });
      } else {
        owner.set(field, role);
      }
    }
  }
  const targets = new Set<string>();
  for (const projection of Object.values(POLICY_PROJECTIONS)) {
    for (const target of Object.values(projection.rename)) targets.add(target);
  }
  for (const target of targets) {
    if (!owner.has(target)) {
      issues.push({
        code: 'projection_target_unowned',
        entry: target,
        detail: `projection target '${target}' is owned by no role (mergeRoleResults would drop it)`,
      });
    }
  }
  return issues;
};
