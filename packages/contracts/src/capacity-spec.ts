/** D-145 PB1 — capacity_spec substrate (contracts).
 *
 *  Per § B.1 + § B.4 + § B.17. Every Part B primitive (`data.fetch` /
 *  `bridge.dispatch` / `enrichment.lookup` / `ai.synthesize` /
 *  `recipe.invoke` / `approval.request` / `provenance.link`) declares
 *  a `CapacitySpec` describing its prerequisites; the engine walks
 *  the spec halt-on-first-gap before invoking the primitive. The
 *  walker emits typed gap + remediation pairs that user-surface
 *  layers (webclient banner, bridge popup, OS notification) render
 *  uniformly.
 *
 *  PB1 ships pure types + closed-list enums + `capacityKey(req)` +
 *  `validateCapacitySpec(spec)` + `capacityParamsForAudit(req)`. No
 *  runtime side effects. Walker / cache / probes / audit emission
 *  ship in PB1.2 – PB1.7 (`packages/engine/src/capacity/`).
 *
 *  Spec: `docs/d-145-spec.md` § B.1 + § B.4 + § B.17.
 *  Design draft: `docs/d-145-pb1-design.md`. */

// ── N.1 — CapacityKind (closed list, 9 values) ──────────────────────

export const CAPACITY_KINDS = [
  'bridge_online',
  'ingredient_installed',
  'logged_in',
  'annotation',
  'annotation_not_required',
  'permission_grant',
  'connection_active',
  'pool_quota_available',
  'selector_freshness',
] as const;
export type CapacityKind = (typeof CAPACITY_KINDS)[number];
export const CAPACITY_KIND_SET: ReadonlySet<CapacityKind> = new Set(CAPACITY_KINDS);

// ── N.2 — CapacityRequirement (per-kind discriminated union) ────────

export type PoolKind = 'free' | 'byok';

export const POOL_KINDS: ReadonlyArray<PoolKind> = ['free', 'byok'];
export const POOL_KIND_SET: ReadonlySet<PoolKind> = new Set(POOL_KINDS);

export type CapacityRequirement =
  | { kind: 'bridge_online' }
  | { kind: 'ingredient_installed'; slug: string }
  | { kind: 'logged_in'; site: string }
  | { kind: 'annotation'; ref: string }
  | { kind: 'annotation_not_required' }
  | { kind: 'permission_grant'; permission: string }
  | {
      kind: 'connection_active';
      vendor: string;
      entity?: string;
      // Optional `connection_id` narrows from "any healthy enabled
      // Source for vendor[/entity]" to a specific D-125 connection
      // record. Validator rejects when `connection_id` is set but
      // `entity` is missing — connection_id is per-entity per D-128.
      connection_id?: string;
    }
  | { kind: 'pool_quota_available'; pool: PoolKind }
  | { kind: 'selector_freshness'; slug: string };

// ── N.4 — CapacityRemediation ───────────────────────────────────────

export const CAPACITY_REMEDIATION_ACTIONS = [
  'show_bridge_install_prompt',
  'offer_install',
  'open_login_tab',
  'lazy_ask_user',
  'request_permission_grant',
  'enroll_connection',
  'check_pool_quota',
  'mark_ingredient_degraded',
  // Pass-2 fold for typed probe-failure path. Walker maps
  // `CapacityProbeFailure` results to this action.
  'repair_capacity_probe',
  'noop',
] as const;
export type CapacityRemediationAction = (typeof CAPACITY_REMEDIATION_ACTIONS)[number];
export const CAPACITY_REMEDIATION_ACTION_SET: ReadonlySet<CapacityRemediationAction> = new Set(
  CAPACITY_REMEDIATION_ACTIONS,
);

export type CapacityRemediationVisibility = 'user_visible' | 'engine_internal';

export interface CapacityRemediation {
  action: CapacityRemediationAction;
  /** Localized at v1; locale identifier is server-default. */
  user_facing_copy: string;
  /** Optional click-target for surfaces that render CTAs. */
  cta_path?: string;
  /** PB7 renders only `user_visible`; engine-internal gaps only land
   *  in audit (per § N.10 visibility split). When omitted the
   *  resolver falls back to the action-default (PB1.6 registry). */
  visibility?: CapacityRemediationVisibility;
}

// ── CapacitySpec ────────────────────────────────────────────────────

export interface CapacitySpec {
  capacities: CapacityRequirement[];
  /** Per-key remediation map. Keys may be either:
   *    - `capacityKey(req)` — exact-key form, the only form recipes /
   *      ingredients should write.
   *    - `req.kind` — kind-only fallback when the requirement is unique
   *      within the spec. Validator (PB1.1) rejects ambiguous use.
   *  See § N.3 lookup precedence. */
  remediations: Record<string, CapacityRemediation>;
}

// ── N.3 — capacityKey (normative key function) ──────────────────────

/** Maps every `CapacityRequirement` to a stable string used for
 *  (a) `remediations` map lookup, (b) cache key partitioning,
 *  (c) audit/transparency `capacity_key` field. */
export const capacityKey = (req: CapacityRequirement): string => {
  switch (req.kind) {
    case 'bridge_online':
    case 'annotation_not_required':
      return req.kind;
    case 'ingredient_installed':
    case 'selector_freshness':
      return `${req.kind}:${req.slug}`;
    case 'logged_in':
      return `${req.kind}:${req.site}`;
    case 'annotation':
      // Audit projection redacts the contact_id portion (§ N.7); the
      // key itself stays verbatim because it has to round-trip into
      // the remediations map / cache without a round-trip projection.
      return `${req.kind}:${req.ref}`;
    case 'permission_grant':
      return `${req.kind}:${req.permission}`;
    case 'connection_active': {
      const entity = req.entity ?? '*';
      return req.connection_id !== undefined
        ? `${req.kind}:${req.vendor}:${entity}:${req.connection_id}`
        : `${req.kind}:${req.vendor}:${entity}`;
    }
    case 'pool_quota_available':
      return `${req.kind}:${req.pool}`;
  }
};

// ── N.5 — CapacityCheck + CapacityCheckResult + CapacityProbeFailure ─

export interface CapacityCheck {
  kind: CapacityKind;
  /** `capacityKey(req)` — deterministic; load-bearing for audit replay. */
  capacity_key: string;
  ok: boolean;
  /** True when the result came from cache. */
  cached: boolean;
  /** Populated when `cached === true`. */
  cache_age_ms?: number;
  /** Small, audit-friendly — never content; closed-list per probe. */
  detail?: string;
  /** ms epoch — populated even on cache hit (refers to the original
   *  probe timestamp). */
  checked_at: number;
}

export interface CapacityWalkCorrelation {
  /** Engine run id (PB3 wires); undefined for standalone walks. */
  run_id?: string;
  /** Unique per walk invocation (uuid); load-bearing for observability. */
  walk_id: string;
  /** When walk runs per-intent (§ B.1.2 rule 1). */
  intent_id?: string;
  /** When called from a recipe step's own `capacity_spec`. */
  recipe_id?: string;
  /** e.g. `bridge.dispatch` / `ai.synthesize`. */
  primitive?: string;
}

export type CapacityCheckResult =
  | { ok: true; checks: CapacityCheck[]; correlation: CapacityWalkCorrelation }
  | {
      ok: false;
      gap: CapacityRequirement;
      /** `capacityKey(gap)`. */
      gap_key: string;
      remediation: CapacityRemediation;
      /** Includes the failing check at end. */
      checks: CapacityCheck[];
      correlation: CapacityWalkCorrelation;
    };

/** Probe-failure path (Pass-2 fold). Probe code never throws to the
 *  walker; the probe registry's switch wraps every probe's `probe()`
 *  call so a thrown exception becomes a `CapacityProbeFailure`
 *  result, mapped to the `repair_capacity_probe` remediation by the
 *  walker. */
export interface CapacityProbeFailure {
  ok: false;
  failure: 'probe_error';
  /** Closed-list error code or audit-friendly hint — never content. */
  detail: string;
}

/** Closed-list of `CapacityProbeFailure.detail` values. PB1.4's probe
 *  registry wrapper synthesizes one of these on a thrown exception or
 *  a probe timeout; PB1.5's audit projection asserts the set is
 *  exhaustive (privacy gate — no free-form strings cross into audit). */
export const CAPACITY_PROBE_FAILURE_DETAILS = [
  'probe_threw',
  'probe_timeout',
  'probe_unavailable',
  'probe_misconfigured',
] as const;
export type CapacityProbeFailureDetail = (typeof CAPACITY_PROBE_FAILURE_DETAILS)[number];
export const CAPACITY_PROBE_FAILURE_DETAIL_SET: ReadonlySet<CapacityProbeFailureDetail> = new Set(
  CAPACITY_PROBE_FAILURE_DETAILS,
);

export type CapacityProbeResult =
  | { ok: true; detail?: string }
  | { ok: false; detail?: string }
  | CapacityProbeFailure;

export const isCapacityProbeFailure = (
  r: CapacityProbeResult,
): r is CapacityProbeFailure =>
  r.ok === false && 'failure' in r && r.failure === 'probe_error';

// ── N.7 — Audit + transparency redaction (privacy) ──────────────────

/** Identity-bearing field names that MUST NEVER appear in audit /
 *  transparency / cache rows. Privacy-assertion test surface (P1-P7
 *  in PB1's privacy.test.ts) walks every emitted artifact + asserts
 *  none of these strings appear in keys or values. */
export const IDENTITY_BEARING_FIELDS: ReadonlyArray<string> = [
  'contact_id',
  'email',
  'phone',
  'address',
  'mail_thread_id',
  'name',
];

/** Per-kind audit/transparency projection of a CapacityRequirement.
 *  Discriminator is `kind`; payload is closed per kind so the
 *  privacy gate is mechanical. */
export type CapacityAuditParams =
  | { kind: 'bridge_online' }
  | { kind: 'annotation_not_required' }
  | { kind: 'ingredient_installed'; slug: string }
  | { kind: 'selector_freshness'; slug: string }
  | { kind: 'logged_in'; site: string }
  | {
      kind: 'annotation';
      // The contact_id is identity-bearing; never persisted in audit.
      ref_kind: string;
      ref_hash: string;
      path_template: string;
    }
  | { kind: 'permission_grant'; permission: string }
  | {
      kind: 'connection_active';
      vendor: string;
      entity?: string;
      // `connection_id` is non-sensitive (synthetic), but hashing
      // keeps the audit row stable across rotations.
      connection_id_hash?: string;
    }
  | { kind: 'pool_quota_available'; pool: PoolKind };

/** Stable 12-char projection of a string. Audit / transparency rows
 *  use it for any field that might leak identity (annotation refs,
 *  connection_id). DJB-2-style rolling hash — no crypto dependency,
 *  good enough for substrate-internal de-duplication.
 *
 *  Stability across server restarts is load-bearing (audit replay
 *  consumers expect the same input to produce the same hash). The
 *  formula is fixed substrate; do not swap algorithms without a
 *  spec change. */
const stableHash12 = (s: string): string => {
  // FNV-1a 32-bit + position-shift; deterministic across runtimes.
  let h1 = 2166136261;
  let h2 = 0x811c9dc5 ^ 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c;
    h2 = Math.imul(h2, 2246822519);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, '0');
  const b = (h2 >>> 0).toString(16).padStart(8, '0');
  return (a + b).slice(0, 12);
};

/** Parse an annotation ref into `{ ref_kind, path_template }`. The
 *  ref shape is `data.<collection>.<id>.<topic>(.subpath)?` — for
 *  example `data.contact.<contact_id>.aliases.facebook` →
 *  `{ ref_kind: 'data.contact.aliases.facebook',
 *     path_template: 'data.contact.{id}.aliases.facebook' }`.
 *
 *  Substrate-internal — never echoes back identity-bearing
 *  segments. `<id>` is heuristically detected as the third segment
 *  (zero-indexed `2`) when the first two segments are `data.<col>`.
 *  Unknown shapes round-trip the whole ref as `path_template` with
 *  `ref_kind = '<unknown>'` so audit rows still carry a hash for
 *  correlation but no claim about parsing accuracy. */
const projectAnnotationRef = (
  ref: string,
): { ref_kind: string; path_template: string } => {
  const segments = ref.split('.');
  if (segments.length < 3 || segments[0] !== 'data') {
    return { ref_kind: '<unknown>', path_template: '<unknown>' };
  }
  // segments[0]='data', segments[1]=collection, segments[2]=id,
  // segments[3..] = subpath (the topic / alias / annotation key).
  const collection = segments[1]!;
  const subpath = segments.slice(3);
  if (subpath.length === 0) {
    // No topic suffix — bare collection lookup. Treat the id as the
    // identity-bearing segment and project to '<id>' template only.
    return {
      ref_kind: `data.${collection}`,
      path_template: `data.${collection}.{id}`,
    };
  }
  return {
    ref_kind: `data.${collection}.${subpath.join('.')}`,
    path_template: `data.${collection}.{id}.${subpath.join('.')}`,
  };
};

/** Audit-side capacity key — same as `capacityKey(req)` for kinds
 *  whose raw key carries no identity. For `annotation` the raw ref
 *  is identity-bearing (`data.contact.<contact_id>.aliases.…`); the
 *  audit-side key replaces it with the projection's `ref_kind` +
 *  truncated `ref_hash`. For `connection_active` with a
 *  `connection_id` segment, the segment is hashed.
 *
 *  The walker / cache / remediation lookup MUST use the raw
 *  `capacityKey(req)` — only audit + transparency emit go through
 *  this projection. */
export const capacityKeyForAudit = (req: CapacityRequirement): string => {
  switch (req.kind) {
    case 'annotation': {
      const projected = projectAnnotationRef(req.ref);
      return `annotation:${projected.ref_kind}:${stableHash12(req.ref)}`;
    }
    case 'connection_active': {
      const entity = req.entity ?? '*';
      if (req.connection_id !== undefined) {
        return `connection_active:${req.vendor}:${entity}:${stableHash12(req.connection_id)}`;
      }
      return `connection_active:${req.vendor}:${entity}`;
    }
    default:
      return capacityKey(req);
  }
};

/** Project a `CapacityRequirement` to its audit/transparency shape.
 *  Pure function — never reads external state, never mutates input.
 *  PB1's privacy test surface (P1-P7) asserts the projection's
 *  output schema declares no identity-bearing field name. */
export const capacityParamsForAudit = (
  req: CapacityRequirement,
): CapacityAuditParams => {
  switch (req.kind) {
    case 'bridge_online':
    case 'annotation_not_required':
      return { kind: req.kind };
    case 'ingredient_installed':
      return { kind: 'ingredient_installed', slug: req.slug };
    case 'selector_freshness':
      return { kind: 'selector_freshness', slug: req.slug };
    case 'logged_in':
      return { kind: 'logged_in', site: req.site };
    case 'annotation': {
      const projected = projectAnnotationRef(req.ref);
      return {
        kind: 'annotation',
        ref_kind: projected.ref_kind,
        ref_hash: stableHash12(req.ref),
        path_template: projected.path_template,
      };
    }
    case 'permission_grant':
      return { kind: 'permission_grant', permission: req.permission };
    case 'connection_active': {
      const out: CapacityAuditParams = {
        kind: 'connection_active',
        vendor: req.vendor,
      };
      if (req.entity !== undefined) out.entity = req.entity;
      if (req.connection_id !== undefined) {
        out.connection_id_hash = stableHash12(req.connection_id);
      }
      return out;
    }
    case 'pool_quota_available':
      return { kind: 'pool_quota_available', pool: req.pool };
  }
};

// ── N.8 — CapacitySpecValidationIssue + CapacitySpecValidationError ─

export const CAPACITY_SPEC_VALIDATION_ISSUE_KINDS = [
  'unknown_capacity_kind',
  'missing_required_field',
  'unknown_remediation_action',
  'missing_remediation',
  'ambiguous_kind_only_remediation',
  'sentinel_action_mismatch',
  'connection_active_missing_entity',
  'duplicate_capacity_key',
] as const;
export type CapacitySpecValidationIssueKind =
  (typeof CAPACITY_SPEC_VALIDATION_ISSUE_KINDS)[number];

export interface CapacitySpecValidationIssue {
  kind: CapacitySpecValidationIssueKind;
  /** When the issue scopes to one requirement. */
  capacity_key?: string;
  /** Human-readable. Never echoes user-content fields verbatim. */
  detail: string;
}

export class CapacitySpecValidationError extends Error {
  readonly code = 'CAPACITY_SPEC_MALFORMED' as const;
  readonly issues: ReadonlyArray<CapacitySpecValidationIssue>;
  constructor(issues: ReadonlyArray<CapacitySpecValidationIssue>) {
    super(`capacity_spec malformed: ${issues.length} issue(s)`);
    this.name = 'CapacitySpecValidationError';
    this.issues = issues;
  }
}

/** Sentinel-action invariants: certain capacity kinds may only carry
 *  specific remediation actions. The validator rejects mismatches. */
const SENTINEL_REQUIRED_ACTIONS: Partial<Record<CapacityKind, CapacityRemediationAction>> = {
  annotation_not_required: 'noop',
  selector_freshness: 'mark_ingredient_degraded',
};

/** Hint fields the validator examines per kind to flag
 *  `missing_required_field`. Closed list in lockstep with the
 *  `CapacityRequirement` discriminated union. */
const requirementMissingFields = (req: CapacityRequirement): string[] => {
  switch (req.kind) {
    case 'bridge_online':
    case 'annotation_not_required':
      return [];
    case 'ingredient_installed':
    case 'selector_freshness':
      return req.slug && req.slug.length > 0 ? [] : ['slug'];
    case 'logged_in':
      return req.site && req.site.length > 0 ? [] : ['site'];
    case 'annotation':
      return req.ref && req.ref.length > 0 ? [] : ['ref'];
    case 'permission_grant':
      return req.permission && req.permission.length > 0 ? [] : ['permission'];
    case 'connection_active':
      return req.vendor && req.vendor.length > 0 ? [] : ['vendor'];
    case 'pool_quota_available':
      return POOL_KIND_SET.has(req.pool) ? [] : ['pool'];
  }
};

/** Resolve the remediation entry for a requirement using § N.3
 *  precedence:
 *    1. exact `capacityKey(req)` lookup
 *    2. kind-only fallback (when the kind is unique in the spec)
 *  Returns `null` when no entry resolves; the validator uses this to
 *  emit `missing_remediation`. */
export const resolveRemediationEntry = (
  spec: CapacitySpec,
  req: CapacityRequirement,
): CapacityRemediation | null => {
  const exact = spec.remediations[capacityKey(req)];
  if (exact) return exact;
  const kindOnly = spec.remediations[req.kind];
  if (kindOnly) return kindOnly;
  return null;
};

/** Validate a `CapacitySpec`. Collects every issue (does NOT bail on
 *  the first) so recipe authors / ingredient submissions see every
 *  problem at once. The walker calls this defensively before
 *  iterating; downstream callers never see partially-validated
 *  specs. */
export const validateCapacitySpec = (
  spec: CapacitySpec,
): CapacitySpecValidationIssue[] => {
  const issues: CapacitySpecValidationIssue[] = [];

  // Track per-kind requirement counts for ambiguity detection.
  const perKindCount = new Map<CapacityKind, number>();
  const seenKeys = new Set<string>();

  for (const req of spec.capacities) {
    if (!CAPACITY_KIND_SET.has(req.kind)) {
      issues.push({
        kind: 'unknown_capacity_kind',
        detail: `capacity kind '${(req as { kind?: string }).kind ?? 'undefined'}' is not in CAPACITY_KINDS`,
      });
      continue;
    }
    perKindCount.set(req.kind, (perKindCount.get(req.kind) ?? 0) + 1);

    const missing = requirementMissingFields(req);
    if (missing.length > 0) {
      issues.push({
        kind: 'missing_required_field',
        capacity_key: capacityKey(req),
        detail: `requirement '${req.kind}' missing required field(s): ${missing.join(', ')}`,
      });
    }

    if (
      req.kind === 'connection_active' &&
      req.connection_id !== undefined &&
      req.entity === undefined
    ) {
      issues.push({
        kind: 'connection_active_missing_entity',
        capacity_key: capacityKey(req),
        detail: `connection_active requirement supplies connection_id but missing entity (per D-128 connection_id is per-entity)`,
      });
    }

    const key = capacityKey(req);
    if (seenKeys.has(key)) {
      issues.push({
        kind: 'duplicate_capacity_key',
        capacity_key: key,
        detail: `two requirements produce the same capacity key '${key}'`,
      });
    }
    seenKeys.add(key);
  }

  // Validate the remediation map.
  for (const req of spec.capacities) {
    if (!CAPACITY_KIND_SET.has(req.kind)) continue;
    const exactKey = capacityKey(req);
    const exactEntry = spec.remediations[exactKey];
    const kindEntry = spec.remediations[req.kind];

    if (!exactEntry && !kindEntry) {
      issues.push({
        kind: 'missing_remediation',
        capacity_key: exactKey,
        detail: `no remediation entry resolves for capacity '${exactKey}'`,
      });
      continue;
    }

    // Ambiguity gate: kind-only key only allowed when this kind is
    // unique within the spec. The exact-key path always wins, so
    // ambiguity only fires when the spec relies solely on the
    // kind-only fallback for multiple requirements of the same kind.
    if (!exactEntry && kindEntry) {
      const count = perKindCount.get(req.kind) ?? 0;
      if (count > 1) {
        issues.push({
          kind: 'ambiguous_kind_only_remediation',
          capacity_key: exactKey,
          detail: `remediation for '${req.kind}' uses kind-only key but ${count} requirements share that kind`,
        });
        continue;
      }
    }

    const entry = (exactEntry ?? kindEntry) as CapacityRemediation;
    if (!CAPACITY_REMEDIATION_ACTION_SET.has(entry.action)) {
      issues.push({
        kind: 'unknown_remediation_action',
        capacity_key: exactKey,
        detail: `remediation action '${entry.action}' is not in CAPACITY_REMEDIATION_ACTIONS`,
      });
      continue;
    }

    const required = SENTINEL_REQUIRED_ACTIONS[req.kind];
    if (required !== undefined && entry.action !== required) {
      issues.push({
        kind: 'sentinel_action_mismatch',
        capacity_key: exactKey,
        detail: `capacity '${req.kind}' must use action '${required}', got '${entry.action}'`,
      });
    }
  }

  return issues;
};

/** Throw `CapacitySpecValidationError` when the spec has issues.
 *  Used by the walker (PB1.2) defensively before iterating. */
export const assertValidCapacitySpec = (spec: CapacitySpec): void => {
  const issues = validateCapacitySpec(spec);
  if (issues.length > 0) throw new CapacitySpecValidationError(issues);
};

// ── N.9 — Cache contract (split per-kind) ───────────────────────────

export interface CapacityCachePolicy {
  capacity_kind: CapacityKind;
  /** False for `annotation` + `annotation_not_required` at v1. */
  cacheable: boolean;
  /** The capacityKey(req) shape components used as cache key. */
  cache_key_parts: ReadonlyArray<string>;
  /** 0 when `cacheable === false`. */
  ttl_ms: number;
  /** PB1-local topic names; see § N.11 `CapacityInvalidationTopic`. */
  invalidation_topics: ReadonlyArray<CapacityInvalidationTopic>;
}

// ── N.11 — CapacityInvalidationTopic ────────────────────────────────

export const CAPACITY_INVALIDATION_TOPICS = [
  'bridge.online_state_changed',
  'bridge.login_state_changed',
  'bridge.user_refresh_login',
  'ingredient.installed',
  'ingredient.uninstalled',
  'ingredient.bumped',
  'permission.grant_changed',
  'connection.enrolled',
  'connection.disabled',
  'connection.reprobed',
  // PA11 join — the load-bearing PA11 → PB1 contract. Disabling a
  // Source via `WorkEntityStore.setSourceEnabled(id, false)`
  // publishes this topic; the cache invalidates every
  // `connection_active` row keyed on the same vendor/entity.
  'source.enabled_changed',
  'quota.headroom_changed',
] as const;
export type CapacityInvalidationTopic = (typeof CAPACITY_INVALIDATION_TOPICS)[number];
export const CAPACITY_INVALIDATION_TOPIC_SET: ReadonlySet<CapacityInvalidationTopic> = new Set(
  CAPACITY_INVALIDATION_TOPICS,
);

export interface CapacityInvalidationPayload {
  topic: CapacityInvalidationTopic;
  bridge_instance_id?: string;
  site?: string;
  slug?: string;
  permission?: string;
  vendor?: string;
  entity?: string;
  connection_id?: string;
  source_id?: string;
  pool?: PoolKind;
}

export interface CapacityInvalidationSubscription {
  topic: CapacityInvalidationTopic;
  unsubscribe: () => void;
}

export interface CapacityInvalidationSource {
  subscribe(
    topic: CapacityInvalidationTopic,
    handler: (payload: CapacityInvalidationPayload) => void,
  ): CapacityInvalidationSubscription;
  /** Source-store wiring — each underlying store calls publish() to
   *  fan out its specific invalidation topic. The PB1.7 server
   *  composer wires the publish() calls into each store's existing
   *  emit hook (PA11 `setSourceEnabled` → `source.enabled_changed`,
   *  D-125 connection enroll/disable → `connection.*`, etc.). */
  publish(payload: CapacityInvalidationPayload): void;
}

// ── CapacityCachePolicy registry (per-kind TTL + invalidation) ──────

export const CAPACITY_CACHE_POLICIES: Readonly<Record<CapacityKind, CapacityCachePolicy>> = {
  bridge_online: {
    capacity_kind: 'bridge_online',
    cacheable: true,
    cache_key_parts: ['bridge_instance_id'],
    ttl_ms: 30_000,
    invalidation_topics: ['bridge.online_state_changed'],
  },
  ingredient_installed: {
    capacity_kind: 'ingredient_installed',
    cacheable: true,
    cache_key_parts: ['slug'],
    ttl_ms: 60 * 60_000,
    invalidation_topics: ['ingredient.installed', 'ingredient.uninstalled'],
  },
  logged_in: {
    capacity_kind: 'logged_in',
    cacheable: true,
    cache_key_parts: ['bridge_instance_id', 'site'],
    ttl_ms: 5 * 60_000,
    invalidation_topics: ['bridge.login_state_changed', 'bridge.user_refresh_login'],
  },
  annotation: {
    capacity_kind: 'annotation',
    cacheable: false,
    cache_key_parts: [],
    ttl_ms: 0,
    invalidation_topics: [],
  },
  annotation_not_required: {
    capacity_kind: 'annotation_not_required',
    cacheable: false,
    cache_key_parts: [],
    ttl_ms: 0,
    invalidation_topics: [],
  },
  permission_grant: {
    capacity_kind: 'permission_grant',
    cacheable: true,
    cache_key_parts: ['permission'],
    ttl_ms: 60 * 60_000,
    invalidation_topics: ['permission.grant_changed'],
  },
  connection_active: {
    capacity_kind: 'connection_active',
    cacheable: true,
    cache_key_parts: ['vendor', 'entity_or_star', 'connection_id_or_any'],
    ttl_ms: 5 * 60_000,
    invalidation_topics: [
      'connection.enrolled',
      'connection.disabled',
      'connection.reprobed',
      'source.enabled_changed',
    ],
  },
  pool_quota_available: {
    capacity_kind: 'pool_quota_available',
    cacheable: true,
    cache_key_parts: ['pool'],
    ttl_ms: 60_000,
    invalidation_topics: ['quota.headroom_changed'],
  },
  selector_freshness: {
    capacity_kind: 'selector_freshness',
    cacheable: true,
    cache_key_parts: ['slug'],
    // 24h cache recheck — shorter than the 7d ingredient TTL by
    // design so degradation surfaces faster than the underlying
    // freshness window. See § N.10.
    ttl_ms: 24 * 60 * 60_000,
    invalidation_topics: ['ingredient.bumped'],
  },
};

export const CACHEABLE_CAPACITY_KINDS: ReadonlySet<CapacityKind> = new Set(
  CAPACITY_KINDS.filter((k) => CAPACITY_CACHE_POLICIES[k].cacheable),
);
