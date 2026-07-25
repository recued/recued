/** D-145 PA9 — Enrichment evidence contract.
 *
 *  Every D-145 enrichment producer declares a substrate-managed
 *  contract at registry load. The validator enforces presence on
 *  every field; missing fields hard-fail registry load with
 *  `enrichment_declaration_incomplete`. Per-class consistency rules
 *  layer on top: `confidence_kind: 'emits_confidence'` requires
 *  `temporal_class IN ('aggregate_window', 'time_bound')` and
 *  `sample_floor ≥ 30` (PSI calibration baseline per D-133).
 *
 *  Why this contract. The earlier 8-producer table was concise but
 *  elided invariants that future producers would silently violate
 *  without substrate enforcement. The declaration prevents three
 *  failure modes per spec § A.7.5:
 *    1. "AI insight" producers without `sample_floor` that emit
 *       thin signal under sparse data.
 *    2. Producers without `privacy_class` that silently leak via MCP.
 *    3. Producers without `benchmark_scenarios` that aren't measured
 *       by C.3 — drift unnoticed.
 *
 *  Spec count. Spec text says "16-field"; the interface in § A.7.5
 *  enumerates 15 substantive fields. PA9 ships the canonical interface
 *  verbatim — the off-by-one in spec text is a rounding artefact.
 *  Ratchet test asserts every documented field present.
 *
 *  Spec: D-145 § A.7.5. */

import {
  isSourceDegradationReason,
  type SourceDegradationReason,
} from './engagement-evidence.js';
import type { SuggestDirective } from './enrichment-registry.js';

// ────────────────────────────────────────────────────────────────
// Closed-list types
// ────────────────────────────────────────────────────────────────

/** Spec § A.7.5 — what kind of fact the topic captures. Note this
 *  enum is *adjacent to* (not the same as) D-136's `TemporalClass`
 *  on `EnrichmentDefinition`:
 *
 *  - D-136 `TemporalClass`: `'stable_truth' | 'time_bound' | 'aggregate_window'`
 *  - D-145 `DeclarationTemporalClass`: `'snapshot' | 'time_bound' | 'aggregate_window' | 'cumulative'`
 *
 *  D-145's `'snapshot'` overlaps semantically with D-136's
 *  `'stable_truth'` (state at observation, no historical chain) but
 *  the engine reasons over the declaration enum directly. The
 *  `'cumulative'` variant is new at D-145 — counters / running totals
 *  that monotonically grow without windowing.
 *
 *  **Deliberate cross-substrate divergence on PSI-eligible producers**:
 *  D-136 gate-1 requires `emits_confidence: true` topics to declare
 *  `temporal_class: 'stable_truth'` on the registry side (the legacy
 *  PSI-on-stable-truth-only invariant from D-133's narrowing). D-145
 *  spec § A.7.5 example shows the same producers carrying
 *  `temporal_class: 'aggregate_window'` on the *declaration* side
 *  (because PSI-eligible producers DO aggregate over a rolling window
 *  — the declaration's framing is the producer's actual semantics,
 *  not the legacy substrate hold). The cross-layer mapping is
 *  intentional: registry-side `'stable_truth'` satisfies D-136 gate-1;
 *  declaration-side `'aggregate_window'` documents the actual compute
 *  pattern for the C.3 benchmark + AI introspection. The
 *  `D145_PSI_LAYER_DIVERGENCE_LOCKED` test in
 *  `d-145-phase-9-enrichment-declaration-complete.ratchet.test.ts`
 *  asserts the divergence is intentional + a future maintainer can't
 *  silently "fix" it in either direction without amending the gate. */
export const DECLARATION_TEMPORAL_CLASSES = [
  'snapshot',
  'time_bound',
  'aggregate_window',
  'cumulative',
] as const;
export type DeclarationTemporalClass = (typeof DECLARATION_TEMPORAL_CLASSES)[number];
export const DECLARATION_TEMPORAL_CLASS_SET: ReadonlySet<string> = new Set(
  DECLARATION_TEMPORAL_CLASSES,
);
export const isDeclarationTemporalClass = (
  raw: unknown,
): raw is DeclarationTemporalClass =>
  typeof raw === 'string' && DECLARATION_TEMPORAL_CLASS_SET.has(raw);

/** Spec § A.7.5 — what kind of identity the row keys on. Mirrors
 *  D-136's `IdentityAggregation` (the spec uses the same closed list). */
export const DECLARATION_IDENTITY_AGGREGATIONS = [
  'scenario',
  'perspective',
] as const;
export type DeclarationIdentityAggregation =
  (typeof DECLARATION_IDENTITY_AGGREGATIONS)[number];
export const DECLARATION_IDENTITY_AGGREGATION_SET: ReadonlySet<string> = new Set(
  DECLARATION_IDENTITY_AGGREGATIONS,
);
export const isDeclarationIdentityAggregation = (
  raw: unknown,
): raw is DeclarationIdentityAggregation =>
  typeof raw === 'string' && DECLARATION_IDENTITY_AGGREGATION_SET.has(raw);

/** Spec § A.7.5 — confidence-kind discriminator.
 *
 *  - `'none'` — deterministic producer; no notion of confidence.
 *  - `'derived_band'` — bands over a confidence-emitting source
 *    (e.g. `commitment_reliability_band` over
 *    `commitment_followthrough_score`). Not PSI-eligible directly
 *    (the source IS PSI-eligible).
 *  - `'emits_confidence'` — the producer emits a `0..1` confidence
 *    field on its `value` shape; PSI-eligible per D-133. */
export const CONFIDENCE_KINDS = [
  'none',
  'derived_band',
  'emits_confidence',
] as const;
export type ConfidenceKind = (typeof CONFIDENCE_KINDS)[number];
export const CONFIDENCE_KIND_SET: ReadonlySet<string> = new Set(CONFIDENCE_KINDS);
export const isConfidenceKind = (raw: unknown): raw is ConfidenceKind =>
  typeof raw === 'string' && CONFIDENCE_KIND_SET.has(raw);

/** Spec § A.7.5 — coverage metadata posture.
 *
 *  - `'declared'` — producer states coverage at registry-load time;
 *    a static fact about the producer's source set.
 *  - `'computed'` — producer computes per-row coverage at compute
 *    time, populating `coverage.sources_*` per D-139 P5 contract. */
export const COVERAGE_POSTURES = ['declared', 'computed'] as const;
export type CoveragePosture = (typeof COVERAGE_POSTURES)[number];
export const COVERAGE_POSTURE_SET: ReadonlySet<string> = new Set(COVERAGE_POSTURES);
export const isCoveragePosture = (raw: unknown): raw is CoveragePosture =>
  typeof raw === 'string' && COVERAGE_POSTURE_SET.has(raw);

/** Spec § A.7.5 — privacy class.
 *
 *  - `'public_metadata'` — safe for all consumers (peer-MCP, D-149
 *    reception). Operational metadata; no user-behavior inference.
 *  - `'user_inferable'` — exposes user behavior; default user-only
 *    access (per-pair-only at MCP, even when `mcp_exposed_default`
 *    is true).
 *  - `'sensitive'` — relationship / health / financial inferences;
 *    per-pair only; never auto-exposed via MCP. */
export const PRIVACY_CLASSES = [
  'public_metadata',
  'user_inferable',
  'sensitive',
] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];
export const PRIVACY_CLASS_SET: ReadonlySet<string> = new Set(PRIVACY_CLASSES);
export const isPrivacyClass = (raw: unknown): raw is PrivacyClass =>
  typeof raw === 'string' && PRIVACY_CLASS_SET.has(raw);

/** Spec § A.7.5 — sliding-window declaration. `null` for snapshot /
 *  cumulative producers; populated for aggregate_window /
 *  time_bound producers that read a rolling slice of source
 *  history. `'all_time'` is a sentinel for cumulative-style
 *  windowing (e.g. `champion_deal_count`'s 1y range). `n` is
 *  required when `kind !== 'all_time'`. */
export const DECLARATION_WINDOW_KINDS = [
  'rolling_days',
  'rolling_weeks',
  'all_time',
] as const;
export type DeclarationWindowKind = (typeof DECLARATION_WINDOW_KINDS)[number];
export const DECLARATION_WINDOW_KIND_SET: ReadonlySet<string> = new Set(
  DECLARATION_WINDOW_KINDS,
);
export const isDeclarationWindowKind = (
  raw: unknown,
): raw is DeclarationWindowKind =>
  typeof raw === 'string' && DECLARATION_WINDOW_KIND_SET.has(raw);

export interface DeclarationWindow {
  kind: DeclarationWindowKind;
  /** Required when `kind !== 'all_time'`. Forbidden when
   *  `kind === 'all_time'` (validator-enforced). */
  n?: number;
}

/** Producer-kind discriminator. Mirrors D-122's
 *  `EnrichmentProducerKind` closed list — duplicated here to keep
 *  the declaration substrate dep-free of the registry. */
export const DECLARATION_PRODUCER_KINDS = [
  'reactive',
  'housekeeping',
] as const;
export type DeclarationProducerKind = (typeof DECLARATION_PRODUCER_KINDS)[number];
export const DECLARATION_PRODUCER_KIND_SET: ReadonlySet<string> = new Set(
  DECLARATION_PRODUCER_KINDS,
);
export const isDeclarationProducerKind = (
  raw: unknown,
): raw is DeclarationProducerKind =>
  typeof raw === 'string' && DECLARATION_PRODUCER_KIND_SET.has(raw);

// ────────────────────────────────────────────────────────────────
// Tunable parameters (Amended 2026-05-26 — § A.7.8)
// ────────────────────────────────────────────────────────────────

/** Spec § A.7.8 — closed list of UI hint units the renderer formats
 *  inline alongside numeric tunable values (`14 days`, `0.5 ratio`).
 *  Extend cautiously — adding a unit means UI + i18n string + the
 *  matching format helper. */
export const ENRICHMENT_TUNABLE_PARAM_UNITS = [
  'days',
  'hours',
  'count',
  'percent',
  'ratio',
] as const;
export type EnrichmentTunableParamUnit =
  (typeof ENRICHMENT_TUNABLE_PARAM_UNITS)[number];
export const ENRICHMENT_TUNABLE_PARAM_UNIT_SET: ReadonlySet<string> = new Set(
  ENRICHMENT_TUNABLE_PARAM_UNITS,
);
export const isEnrichmentTunableParamUnit = (
  raw: unknown,
): raw is EnrichmentTunableParamUnit =>
  typeof raw === 'string' && ENRICHMENT_TUNABLE_PARAM_UNIT_SET.has(raw);

/** Spec § A.7.8 — value carried by a tunable param. Number for
 *  `kind: 'number'`; string for `kind: 'enum'`. The store + accessor
 *  validate against the declaration; callers see the narrow type via
 *  `getNumber` / `getEnum`. */
export type EnrichmentTunableParamValue = number | string;

/** Spec § A.7.8 — per-param declaration. Discriminated by `kind`:
 *
 *  - `'number'` — numeric input. `default` + `min` + `max` all
 *    required; `min ≤ default ≤ max`. UI renders a numeric input
 *    with bounds; the accessor clamps reads defensively.
 *
 *  - `'enum'` — closed-list choice. `default` + `enum_values`
 *    required; `default ∈ enum_values`. UI renders radio buttons
 *    (≤ 5 values) or a select (> 5).
 *
 *  Every variant carries `ui_label` + `ui_help` (required) and an
 *  optional `unit` UI hint formatting numeric values inline.
 *
 *  Per-key naming: validator enforces `^[a-z][a-z0-9_]*$` on the
 *  containing record's key (matches topic + pref naming convention). */
export type EnrichmentTunableParamSpec =
  | {
      kind: 'number';
      default: number;
      min: number;
      max: number;
      unit?: EnrichmentTunableParamUnit;
      ui_label: string;
      ui_help: string;
    }
  | {
      kind: 'enum';
      default: string;
      enum_values: ReadonlyArray<string>;
      unit?: EnrichmentTunableParamUnit;
      ui_label: string;
      ui_help: string;
    };

/** Spec § A.7.8 — key shape. Lowercase snake_case to match topic +
 *  pref naming convention. The validator enforces this on every key
 *  in `tunable_params`. */
export const ENRICHMENT_TUNABLE_PARAM_KEY_RE = /^[a-z][a-z0-9_]*$/;

// ────────────────────────────────────────────────────────────────
// Per-class consistency constants
// ────────────────────────────────────────────────────────────────

/** Per-PSI calibration discipline (D-133 narrowing rules). PSI
 *  baseline window needs at least 30 source rows for the rolling
 *  distribution to be meaningful; sub-floor producers can't reliably
 *  detect drift. Spec § A.7.5 worked example. */
export const PSI_SAMPLE_FLOOR_MINIMUM = 30;

/** Closed list of `temporal_class` values that may carry
 *  `confidence_kind: 'emits_confidence'`. Spec § A.7.5: PSI is only
 *  meaningful on aggregate_window + time_bound topics. snapshot +
 *  cumulative producers are not PSI-eligible. */
export const PSI_ELIGIBLE_TEMPORAL_CLASSES: ReadonlyArray<DeclarationTemporalClass> = [
  'aggregate_window',
  'time_bound',
] as const;

// ────────────────────────────────────────────────────────────────
// EnrichmentDeclaration — the substrate-managed declaration shape
// ────────────────────────────────────────────────────────────────

/** Spec § A.7.5 — every D-145 enrichment producer declares this
 *  contract at registry load. Validator enforces presence on every
 *  field; missing fields hard-fail registry load. */
export interface EnrichmentDeclaration {
  /** Canonical enrichment topic name (closed list). Must match a
   *  registered topic on `ENRICHMENT_REGISTRY`. */
  topic: string;
  /** Entity scopes the producer reads. Free-form strings — the
   *  declaration substrate documents the broader source surface
   *  (including non-cascade-relevant ones like
   *  `'data.memory.recued_plan'`); the registry's `aggregates_from`
   *  carries the cascade-walker subset separately. */
  operates_on: ReadonlyArray<string>;
  /** Canonical time field used for windowing. `null` for snapshot /
   *  cumulative producers reading state at compute time. */
  event_time_field: string | null;
  /** Window for aggregate_window / time_bound topics; `null` for
   *  snapshot / cumulative. */
  window: DeclarationWindow | null;
  /** Reactive (event-driven) vs housekeeping (idle-driven). */
  producer_kind: DeclarationProducerKind;
  /** What kind of fact the topic captures. */
  temporal_class: DeclarationTemporalClass;
  /** What kind of identity the row keys on. */
  identity_aggregation: DeclarationIdentityAggregation;
  /** Minimum source rows for the producer to compute. Under the
   *  floor → emit `coverage.sources_degraded: 'sample_floor_unmet'`
   *  + abstain; never compute thin. PSI-eligible producers must
   *  declare ≥ 30. */
  sample_floor: number;
  /** Confidence-kind discriminator. */
  confidence_kind: ConfidenceKind;
  /** Coverage-metadata posture. */
  coverage: CoveragePosture;
  /** Closed list per D-139 widened with D-148 additions
   *  (`sample_floor_unmet` / `partial_api_failure` / etc.). The
   *  producer enumerates which reasons it can populate; values
   *  outside the closed list fail validator load. */
  source_degradation_reasons: ReadonlyArray<SourceDegradationReason>;
  /** Privacy classification — gates default user-only access. */
  privacy_class: PrivacyClass;
  /** Per-topic MCP visibility default. Overridable per-pair via
   *  D-137 + D-136 P7.E user-override; declaration value is the
   *  default. */
  mcp_exposed_default: boolean;
  /** Event types that invalidate cached enrichment rows
   *  (`data.commitment.state_changed` / etc.). Drives reactive
   *  producer dispatch + cascade hooks. Free-form per-topic. */
  invalidation_triggers: ReadonlyArray<string>;
  /** Benchmark fixture IDs that exercise this producer. Every
   *  producer MUST have ≥ 1 fixture covering it in C.3 (validator-
   *  enforced — empty array fails). */
  benchmark_scenarios: ReadonlyArray<string>;
  /** D-164 P2 — bench-style `{ field: type }` annotation literal that
   *  the catalog substrate renders into the system prompt for this
   *  topic. Uses `REF<X>` markers on fields whose value is a key into
   *  collection `X` (per internal benchmarks
   *  src/enrichment-episodes/catalog.js` convention). Non-empty
   *  (validator-enforced); shape is opaque to the validator beyond
   *  presence. */
  return_shape: string;
  /** D-164 P2 — default `SuggestDirective` the runtime wraps into a
   *  `{ found: false, suggest }` `EnrichmentResult<T>` when this
   *  producer has no row for the requested target. `null` when no
   *  natural deterministic fallback exists (e.g. operational signals
   *  whose recourse is configuration, not another query). Populated
   *  directive shape is validated for presence on `tool` / `kind` /
   *  `hint`. */
  suggest_directive: SuggestDirective | null;
  /** D-164 P3 — framework-side affordance read by the D-160 batch
   *  tool dispatcher (design doc § 6). When the LLM emits multiple
   *  `tool_use` blocks in one turn and EVERY entry's
   *  `concurrency_safe` is true, the framework runs them in parallel;
   *  any `false` in the batch collapses to sequential dispatch in
   *  emit order. Every D-145 producer is read-only over warehouse
   *  data, so all 16 declare `true`; a future producer that fans
   *  out to a rate-limited external API would declare `false`.
   *  Required (not defaulted) — the catalog substrate would silently
   *  mis-batch on an absent field. */
  concurrency_safe: boolean;
  /** Spec § A.7.8 (Amended 2026-05-26) — OPTIONAL per-topic
   *  user-tunable parameters surfaced in Settings → Housekeeping per-
   *  topic card alongside trust state + pool policy + MCP visibility.
   *  Closed list per topic — each entry declares `kind` discriminator
   *  + `default` + bounds (`min`/`max` for number, `enum_values` for
   *  enum) + `ui_label` + `ui_help`. Validator-gated at registry load
   *  (`enrichment_tunable_params_invalid` on bound / enum / type
   *  violations). Most topics don't expose tunables — the field is
   *  optional, and the 16-field required core stays intact. The
   *  producer reads effective values via `ctx.tunableParams.{getNumber,
   *  getEnum}(topic, key)`; the typed accessor returns
   *  override-or-default and clamps numbers to `[min, max]` defensively.
   *
   *  Pilot topic: `project_stall_signal.stall_window_days` (industry-
   *  specific 14d default — SaaS ~7d, consulting ~30d, architecture
   *  ~365d). */
  tunable_params?: Readonly<Record<string, EnrichmentTunableParamSpec>>;
}

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

/** Spec § A.7.5 — pure validator over an `EnrichmentDeclaration`.
 *  Returns the array of issue strings (empty when the declaration
 *  passes every gate). Surfaces:
 *    - presence: every field populated
 *    - closed-list discipline on every enum
 *    - per-class consistency:
 *      - `confidence_kind: 'emits_confidence'` requires
 *        `temporal_class IN ('aggregate_window', 'time_bound')` +
 *        `sample_floor ≥ 30` (PSI calibration baseline per D-133).
 *    - window-shape: `kind: 'all_time'` forbids `n`; other kinds
 *      require `n > 0`.
 *    - `benchmark_scenarios` non-empty (C.3 invariant). */
export const validateEnrichmentDeclaration = (
  decl: EnrichmentDeclaration,
): string[] => {
  const issues: string[] = [];

  // ── Presence + closed-list ──────────────────────────────────
  if (typeof decl.topic !== 'string' || decl.topic.length === 0) {
    issues.push("field 'topic' must be a non-empty string");
  }
  if (!Array.isArray(decl.operates_on) || decl.operates_on.length === 0) {
    issues.push("field 'operates_on' must be a non-empty string array");
  } else {
    for (let i = 0; i < decl.operates_on.length; i++) {
      const item = decl.operates_on[i];
      if (typeof item !== 'string' || item.length === 0) {
        issues.push(`field 'operates_on[${i}]' must be a non-empty string`);
      }
    }
  }
  if (decl.event_time_field !== null && typeof decl.event_time_field !== 'string') {
    issues.push("field 'event_time_field' must be a string or null");
  } else if (typeof decl.event_time_field === 'string' && decl.event_time_field.length === 0) {
    issues.push("field 'event_time_field' must be a non-empty string when not null");
  }
  if (decl.window !== null && (typeof decl.window !== 'object' || Array.isArray(decl.window))) {
    issues.push("field 'window' must be an object or null");
  } else if (decl.window !== null) {
    if (!isDeclarationWindowKind(decl.window.kind)) {
      issues.push(
        `field 'window.kind' must be one of ${DECLARATION_WINDOW_KINDS.join(' / ')}`,
      );
    }
    if (decl.window.kind === 'all_time') {
      if (decl.window.n !== undefined) {
        issues.push("field 'window.n' must be omitted when kind === 'all_time'");
      }
    } else if (
      typeof decl.window.n !== 'number'
      || !Number.isFinite(decl.window.n)
      || decl.window.n <= 0
    ) {
      issues.push("field 'window.n' must be a positive finite number when kind !== 'all_time'");
    }
  }
  if (!isDeclarationProducerKind(decl.producer_kind)) {
    issues.push(
      `field 'producer_kind' must be one of ${DECLARATION_PRODUCER_KINDS.join(' / ')}`,
    );
  }
  if (!isDeclarationTemporalClass(decl.temporal_class)) {
    issues.push(
      `field 'temporal_class' must be one of ${DECLARATION_TEMPORAL_CLASSES.join(' / ')}`,
    );
  }
  if (!isDeclarationIdentityAggregation(decl.identity_aggregation)) {
    issues.push(
      `field 'identity_aggregation' must be one of ${DECLARATION_IDENTITY_AGGREGATIONS.join(' / ')}`,
    );
  }
  if (
    typeof decl.sample_floor !== 'number'
    || !Number.isFinite(decl.sample_floor)
    || decl.sample_floor < 1
    || !Number.isInteger(decl.sample_floor)
  ) {
    issues.push("field 'sample_floor' must be a positive integer");
  }
  if (!isConfidenceKind(decl.confidence_kind)) {
    issues.push(`field 'confidence_kind' must be one of ${CONFIDENCE_KINDS.join(' / ')}`);
  }
  if (!isCoveragePosture(decl.coverage)) {
    issues.push(`field 'coverage' must be one of ${COVERAGE_POSTURES.join(' / ')}`);
  }
  if (!Array.isArray(decl.source_degradation_reasons)) {
    issues.push("field 'source_degradation_reasons' must be an array");
  } else {
    for (let i = 0; i < decl.source_degradation_reasons.length; i++) {
      const reason = decl.source_degradation_reasons[i];
      if (!isSourceDegradationReason(reason)) {
        issues.push(
          `field 'source_degradation_reasons[${i}]' (${JSON.stringify(reason)}) is not a registered SourceDegradationReason`,
        );
      }
    }
  }
  if (!isPrivacyClass(decl.privacy_class)) {
    issues.push(`field 'privacy_class' must be one of ${PRIVACY_CLASSES.join(' / ')}`);
  }
  if (typeof decl.mcp_exposed_default !== 'boolean') {
    issues.push("field 'mcp_exposed_default' must be a boolean");
  }
  if (!Array.isArray(decl.invalidation_triggers)) {
    issues.push("field 'invalidation_triggers' must be a string array");
  } else {
    for (let i = 0; i < decl.invalidation_triggers.length; i++) {
      const trig = decl.invalidation_triggers[i];
      if (typeof trig !== 'string' || trig.length === 0) {
        issues.push(`field 'invalidation_triggers[${i}]' must be a non-empty string`);
      }
    }
  }
  if (!Array.isArray(decl.benchmark_scenarios) || decl.benchmark_scenarios.length === 0) {
    issues.push(
      "field 'benchmark_scenarios' must be a non-empty string array (C.3 invariant — every producer MUST have ≥ 1 fixture)",
    );
  } else {
    for (let i = 0; i < decl.benchmark_scenarios.length; i++) {
      const scn = decl.benchmark_scenarios[i];
      if (typeof scn !== 'string' || scn.length === 0) {
        issues.push(`field 'benchmark_scenarios[${i}]' must be a non-empty string`);
      }
    }
  }
  // D-164 P2 — return_shape: non-empty (trimmed) annotation literal.
  if (typeof decl.return_shape !== 'string' || decl.return_shape.trim().length === 0) {
    issues.push("field 'return_shape' must be a non-empty string (bench-style {field: type} annotation)");
  }
  // D-164 P3 — concurrency_safe: required boolean. Catalog substrate
  // assumes presence; an absent / non-boolean value would silently
  // mis-batch under D-160's parallel-dispatch rule.
  if (typeof decl.concurrency_safe !== 'boolean') {
    issues.push("field 'concurrency_safe' must be a boolean (D-160 batch dispatcher reads this)");
  }
  // D-164 P2 — suggest_directive: null OR populated SuggestDirective with
  // non-empty (trimmed) tool + kind + hint; args is optional and unconstrained.
  if (decl.suggest_directive !== null) {
    if (typeof decl.suggest_directive !== 'object' || Array.isArray(decl.suggest_directive)) {
      issues.push("field 'suggest_directive' must be a SuggestDirective object or null");
    } else {
      const sd = decl.suggest_directive;
      if (typeof sd.tool !== 'string' || sd.tool.trim().length === 0) {
        issues.push("field 'suggest_directive.tool' must be a non-empty string when suggest_directive is non-null");
      }
      if (typeof sd.kind !== 'string' || sd.kind.trim().length === 0) {
        issues.push("field 'suggest_directive.kind' must be a non-empty string when suggest_directive is non-null");
      }
      if (typeof sd.hint !== 'string' || sd.hint.trim().length === 0) {
        issues.push("field 'suggest_directive.hint' must be a non-empty string when suggest_directive is non-null");
      }
    }
  }

  // ── Tunable params (§ A.7.8 — Amended 2026-05-26) ───────────
  // Optional — many topics don't expose tunables. When present, every
  // key + spec validates against the discriminated shape; bound /
  // enum / type violations surface as `enrichment_tunable_params_invalid`.
  if (decl.tunable_params !== undefined) {
    if (
      typeof decl.tunable_params !== 'object'
      || decl.tunable_params === null
      || Array.isArray(decl.tunable_params)
    ) {
      issues.push(
        `enrichment_tunable_params_invalid: topic '${decl.topic}' field 'tunable_params' must be a plain object when present`,
      );
    } else {
      for (const [key, spec] of Object.entries(decl.tunable_params)) {
        const path = `tunable_params['${key}']`;
        if (!ENRICHMENT_TUNABLE_PARAM_KEY_RE.test(key)) {
          issues.push(
            `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}' key must match /^[a-z][a-z0-9_]*$/`,
          );
          continue;
        }
        if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
          issues.push(
            `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}' must be an EnrichmentTunableParamSpec object`,
          );
          continue;
        }
        if (typeof spec.ui_label !== 'string' || spec.ui_label.trim().length === 0) {
          issues.push(
            `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.ui_label' must be a non-empty string`,
          );
        }
        if (typeof spec.ui_help !== 'string' || spec.ui_help.trim().length === 0) {
          issues.push(
            `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.ui_help' must be a non-empty string`,
          );
        }
        if (spec.unit !== undefined && !isEnrichmentTunableParamUnit(spec.unit)) {
          issues.push(
            `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.unit' must be one of ${ENRICHMENT_TUNABLE_PARAM_UNITS.join(' / ')} (or omitted)`,
          );
        }
        if (spec.kind === 'number') {
          if (typeof spec.default !== 'number' || !Number.isFinite(spec.default)) {
            issues.push(
              `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.default' must be a finite number when kind === 'number'`,
            );
          }
          if (typeof spec.min !== 'number' || !Number.isFinite(spec.min)) {
            issues.push(
              `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.min' must be a finite number when kind === 'number'`,
            );
          }
          if (typeof spec.max !== 'number' || !Number.isFinite(spec.max)) {
            issues.push(
              `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.max' must be a finite number when kind === 'number'`,
            );
          }
          if (
            typeof spec.min === 'number'
            && typeof spec.max === 'number'
            && Number.isFinite(spec.min)
            && Number.isFinite(spec.max)
            && spec.min > spec.max
          ) {
            issues.push(
              `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}' min (${spec.min}) > max (${spec.max})`,
            );
          }
          if (
            typeof spec.default === 'number'
            && typeof spec.min === 'number'
            && typeof spec.max === 'number'
            && Number.isFinite(spec.default)
            && Number.isFinite(spec.min)
            && Number.isFinite(spec.max)
            && (spec.default < spec.min || spec.default > spec.max)
          ) {
            issues.push(
              `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}' default (${spec.default}) must lie within [min=${spec.min}, max=${spec.max}]`,
            );
          }
        } else if (spec.kind === 'enum') {
          if (typeof spec.default !== 'string' || spec.default.length === 0) {
            issues.push(
              `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.default' must be a non-empty string when kind === 'enum'`,
            );
          }
          if (
            !Array.isArray(spec.enum_values)
            || spec.enum_values.length === 0
            || spec.enum_values.some((v) => typeof v !== 'string' || v.length === 0)
          ) {
            issues.push(
              `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.enum_values' must be a non-empty array of non-empty strings when kind === 'enum'`,
            );
          }
          if (
            typeof spec.default === 'string'
            && Array.isArray(spec.enum_values)
            && !spec.enum_values.includes(spec.default)
          ) {
            issues.push(
              `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}' default '${spec.default}' must be a member of enum_values [${spec.enum_values.join(', ')}]`,
            );
          }
        } else {
          issues.push(
            `enrichment_tunable_params_invalid: topic '${decl.topic}' field '${path}.kind' must be 'number' or 'enum' (got ${JSON.stringify((spec as { kind?: unknown }).kind)})`,
          );
        }
      }
    }
  }

  // ── Per-class consistency ───────────────────────────────────
  // Gate — emits_confidence requires aggregate_window | time_bound
  // + sample_floor ≥ 30 (PSI calibration baseline per D-133).
  if (
    decl.confidence_kind === 'emits_confidence'
    && isDeclarationTemporalClass(decl.temporal_class)
    && !PSI_ELIGIBLE_TEMPORAL_CLASSES.includes(decl.temporal_class)
  ) {
    issues.push(
      `enrichment_declaration_invariant: topic '${decl.topic}' has confidence_kind: 'emits_confidence' `
        + `but temporal_class: '${decl.temporal_class}' — PSI is only meaningful on `
        + `${PSI_ELIGIBLE_TEMPORAL_CLASSES.join(' / ')} (D-133 narrowing).`,
    );
  }
  if (
    decl.confidence_kind === 'emits_confidence'
    && typeof decl.sample_floor === 'number'
    && Number.isFinite(decl.sample_floor)
    && decl.sample_floor < PSI_SAMPLE_FLOOR_MINIMUM
  ) {
    issues.push(
      `enrichment_declaration_invariant: topic '${decl.topic}' has confidence_kind: 'emits_confidence' `
        + `but sample_floor (${decl.sample_floor}) < ${PSI_SAMPLE_FLOOR_MINIMUM} `
        + `— PSI calibration baseline requires ≥ ${PSI_SAMPLE_FLOOR_MINIMUM}.`,
    );
  }
  // Gate — aggregate_window / time_bound require window populated.
  if (
    isDeclarationTemporalClass(decl.temporal_class)
    && (decl.temporal_class === 'aggregate_window' || decl.temporal_class === 'time_bound')
    && decl.window === null
  ) {
    issues.push(
      `enrichment_declaration_invariant: topic '${decl.topic}' has temporal_class: '${decl.temporal_class}' `
        + `but window is null — aggregate_window / time_bound producers must declare a window.`,
    );
  }
  // Gate — snapshot / cumulative require window null + event_time_field null.
  // (Codex P2 fold) — original gate only checked window; event_time_field
  // could leak through. Snapshot / cumulative producers read state at
  // compute time; both fields must be null.
  if (
    isDeclarationTemporalClass(decl.temporal_class)
    && (decl.temporal_class === 'snapshot' || decl.temporal_class === 'cumulative')
    && decl.window !== null
  ) {
    issues.push(
      `enrichment_declaration_invariant: topic '${decl.topic}' has temporal_class: '${decl.temporal_class}' `
        + `but window is non-null — snapshot / cumulative producers must declare window: null.`,
    );
  }
  if (
    isDeclarationTemporalClass(decl.temporal_class)
    && (decl.temporal_class === 'snapshot' || decl.temporal_class === 'cumulative')
    && decl.event_time_field !== null
  ) {
    issues.push(
      `enrichment_declaration_invariant: topic '${decl.topic}' has temporal_class: '${decl.temporal_class}' `
        + `but event_time_field is non-null — snapshot / cumulative producers read state at compute time `
        + `and must declare event_time_field: null.`,
    );
  }
  // Gate — aggregate_window / time_bound require event_time_field populated.
  if (
    isDeclarationTemporalClass(decl.temporal_class)
    && (decl.temporal_class === 'aggregate_window' || decl.temporal_class === 'time_bound')
    && decl.event_time_field === null
  ) {
    issues.push(
      `enrichment_declaration_invariant: topic '${decl.topic}' has temporal_class: '${decl.temporal_class}' `
        + `but event_time_field is null — aggregate_window / time_bound producers must anchor their `
        + `window on a canonical time field.`,
    );
  }

  return issues;
};

/** Throws on the first validator issue. Used at registry-load
 *  time to surface declaration mistakes before any cycle runs. */
export class EnrichmentDeclarationError extends Error {
  override readonly name = 'EnrichmentDeclarationError';
}

export const assertEnrichmentDeclaration = (
  decl: EnrichmentDeclaration,
): void => {
  const issues = validateEnrichmentDeclaration(decl);
  if (issues.length > 0) {
    throw new EnrichmentDeclarationError(
      `enrichment_declaration_incomplete: topic '${decl.topic}': ${issues[0]}`,
    );
  }
};

// ────────────────────────────────────────────────────────────────
// Closed list of D-145 producer topic IDs
// ────────────────────────────────────────────────────────────────

/** Spec § A.7.1 — work-entity producer set (8). */
export const D145_WORK_ENTITY_PRODUCER_TOPICS = [
  'commitment_followthrough_score',
  'commitment_imbalance',
  'outbound_commitment_overdue_count',
  'task_completion_velocity',
  'task_signal_density_per_thread',
  'project_stall_signal',
  'project_velocity',
  'note_relevance_decay',
] as const;
export type D145WorkEntityProducerTopic =
  (typeof D145_WORK_ENTITY_PRODUCER_TOPICS)[number];

/** Spec § A.7.2 — engine + reliability producer set (7). */
export const D145_ENGINE_RELIABILITY_PRODUCER_TOPICS = [
  'open_loop_pressure',
  'commitment_reliability_band',
  'preferred_channel_by_contact',
  'project_next_action_gap',
  'task_duplicate_candidate',
  'source_freshness_degradation',
  'context_packet_quality',
] as const;
export type D145EngineReliabilityProducerTopic =
  (typeof D145_ENGINE_RELIABILITY_PRODUCER_TOPICS)[number];

/** Spec § A.7 — full set of 15 D-145 producer topics. */
export const D145_PRODUCER_TOPICS = [
  ...D145_WORK_ENTITY_PRODUCER_TOPICS,
  ...D145_ENGINE_RELIABILITY_PRODUCER_TOPICS,
] as const;
export type D145ProducerTopic = (typeof D145_PRODUCER_TOPICS)[number];
export const D145_PRODUCER_TOPIC_SET: ReadonlySet<string> = new Set(
  D145_PRODUCER_TOPICS,
);
export const isD145ProducerTopic = (raw: unknown): raw is D145ProducerTopic =>
  typeof raw === 'string' && D145_PRODUCER_TOPIC_SET.has(raw);

/** Spec § A.7.2 — 4 PSI-eligible D-145 producers per D-136 P5b /
 *  D-133 narrowing. The closed list — additions require widening
 *  this constant + bumping the registry markers + adding C.3
 *  benchmark scenarios.
 *
 *  - `commitment_followthrough_score` (PA9.a)
 *  - `task_completion_velocity` (PA9.a)
 *  - `project_velocity` (PA9.a)
 *  - `context_packet_quality` (PA9.b) */
export const D145_PSI_ELIGIBLE_PRODUCER_TOPICS: ReadonlyArray<D145ProducerTopic> = [
  'commitment_followthrough_score',
  'task_completion_velocity',
  'project_velocity',
  'context_packet_quality',
] as const;
export const D145_PSI_ELIGIBLE_PRODUCER_TOPIC_SET: ReadonlySet<string> = new Set(
  D145_PSI_ELIGIBLE_PRODUCER_TOPICS,
);
export const isD145PsiEligibleProducerTopic = (
  raw: unknown,
): raw is D145ProducerTopic =>
  typeof raw === 'string' && D145_PSI_ELIGIBLE_PRODUCER_TOPIC_SET.has(raw);
