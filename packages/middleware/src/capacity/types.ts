/** D-145 PB1 — engine-side capacity_spec types.
 *
 *  These types live in the engine package because they reference
 *  emit/probe deps that are only meaningful in a server-running
 *  context. Pure type / closed-list types stay in
 *  `@recued/contracts/capacity-spec` so consumers (recipes, ui)
 *  don't pull engine-internal interfaces.
 *
 *  Spec: `docs/d-145-spec.md` § B.4. Design: `docs/d-145-pb1-design.md`. */

import type {
  CapacityCheck,
  CapacityCheckAuditDetail,
  CapacityCheckGapTransparencyEvent,
  CapacityCheckResult,
  CapacityInvalidationPayload,
  CapacityInvalidationSource,
  CapacityKind,
  CapacityProbeResult,
  CapacityRequirement,
  CapacitySpec,
} from '@recued/contracts';

// ── Walk context (passed to walker; constructed by PB1.7 composer) ──

export interface CapacityCounters {
  cache_hits: Record<CapacityKind, number>;
  cache_misses: Record<CapacityKind, number>;
  invalidations: Record<string, number>;
  gaps: Record<CapacityKind, number>;
  probe_errors: Record<CapacityKind, number>;
  walk_durations_ms: Map<string, number[]>;
  audit_emit_failures: number;
  transparency_emit_failures: number;
  snapshot(): CapacityCountersSnapshot;
}

export interface CapacityCountersSnapshot {
  cache_hits: Record<string, number>;
  cache_misses: Record<string, number>;
  invalidations: Record<string, number>;
  gaps: Record<string, number>;
  probe_errors: Record<string, number>;
  walk_duration_ms_p50: Record<string, number>;
  walk_duration_ms_p95: Record<string, number>;
  audit_emit_failures: number;
  transparency_emit_failures: number;
}

export interface CapacityWalkContext {
  /** Stable across walks within a turn — prevents the cache from
   *  hashing transient state into keys. Optional: when absent, the
   *  cache key omits the `bridge_instance_id` field (single-bridge
   *  default). */
  bridge_instance_id?: string;
  /** Engine run id (PB3 wires). */
  run_id?: string;
  /** When called per-intent (capacity walks per § B.1.2 rule 1). */
  intent_id?: string;
  /** When a recipe step walks its own spec. */
  recipe_id?: string;
  /** For engine-internal walks (e.g. `bridge.dispatch`). */
  primitive?: string;
  audit_emitter: CapacityAuditEmitter;
  transparency_emitter: CapacityTransparencyEmitter;
  counters?: CapacityCounters;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable for deterministic tests; defaults to `randomUUID()`. */
  walk_id?: string;
}

// ── Probes ──────────────────────────────────────────────────────────

export interface CapacityProbe {
  kind: CapacityKind;
  /** Probe execution. PB1.4's registry wraps every call in a
   *  try/catch + per-probe timeout; thrown errors / timeouts
   *  surface to the walker as `CapacityProbeFailure`. */
  probe(req: CapacityRequirement, ctx: CapacityWalkContext): Promise<CapacityProbeResult>;
}

export interface CapacityProbeRegistry {
  /** Per-kind dispatch + try/catch wrapping. Always resolves —
   *  thrown probes are mapped to a `CapacityProbeFailure` result. */
  probe(req: CapacityRequirement, ctx: CapacityWalkContext): Promise<CapacityProbeResult>;
  /** Test escape hatch: replace a probe in-place. */
  override(probe: CapacityProbe): void;
  /** Test escape hatch: revert all overrides. */
  resetOverrides(): void;
}

// ── Cache ───────────────────────────────────────────────────────────

export interface CapacityCacheRow {
  capacity_kind: CapacityKind;
  capacity_key: string;
  bridge_instance_id?: string;
  vendor?: string;
  entity?: string;
  connection_id?: string;
  slug?: string;
  pool?: string;
  permission?: string;
  site?: string;
  result: CapacityProbeResult;
  checked_at: number;
}

export interface CapacityCache {
  read(key: string, ctx: CapacityWalkContext): CapacityCacheRow | null;
  write(key: string, ctx: CapacityWalkContext, row: CapacityCacheRow): void;
  /** Returns count of rows dropped. */
  invalidate(predicate: (row: CapacityCacheRow) => boolean): number;
  /** Dispatches to per-kind drop logic via topic + payload matching. */
  invalidateByTopic(payload: CapacityInvalidationPayload): number;
  clear(): void;
  /** Test introspection. */
  size(): number;
}

// ── Audit + transparency emitters ────────────────────────────────────

export interface CapacityAuditEmitter {
  emitOk(detail: CapacityCheckAuditDetail, ctx: CapacityWalkContext): Promise<void>;
  emitGap(detail: CapacityCheckAuditDetail, ctx: CapacityWalkContext): Promise<void>;
}

export interface CapacityTransparencyEmitter {
  emit(event: CapacityCheckGapTransparencyEvent): Promise<void>;
}

// ── Re-exports for the engine barrel ────────────────────────────────

export type {
  CapacityCheck,
  CapacityCheckAuditDetail,
  CapacityCheckGapTransparencyEvent,
  CapacityCheckResult,
  CapacityInvalidationPayload,
  CapacityInvalidationSource,
  CapacityKind,
  CapacityProbeResult,
  CapacityRequirement,
  CapacitySpec,
};
