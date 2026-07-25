/** D-136 §A.14.1 P5b — External context pulse substrate.
 *
 *  Closes audit miss-edge M10 (external context drift). Producers
 *  that read external state at compute time (vendor APIs, web search,
 *  MCP tool results, third-party data) declare their dependencies in
 *  the producer manifest's `consumes_external_context` field; the
 *  substrate tracks an `external_context_pulse` row keyed on the
 *  declared `id` and bumps `lifecycle_action_pending = 'recompute'`
 *  on every consuming producer's chain-head rows when the pulse
 *  changes.
 *
 *  Three pulse providers govern HOW the pulse value gets refreshed:
 *
 *    - `'connection'` — the value is a hash of an outbound API
 *      response. Vendor reconcilers (D-128) call `recordPulse` with
 *      the new value after each successful fetch; the substrate
 *      compares to the prior value + fires the cascade when they
 *      diverge.
 *    - `'mcp_tool'` — the value is a hash of an MCP tool result.
 *      MCP-server-bound producers calling out to read external state
 *      record the pulse on each call.
 *    - `'periodic_check'` — the substrate polls the pulse provider
 *      on a schedule (P6 wires the poll task; P5b only ships the
 *      record + cascade primitives).
 *
 *  The cascade primitive `cascadeForExternalContextPulseChange`
 *  composes with the §A.5 cascade primitive set: same idempotency
 *  contract (column-state-driven), same per-topic queue-depth
 *  ceiling, same observability counters. The walk-cap planner
 *  composes too — pulse-induced enqueues still pass through the
 *  drain-consumer's budget gate at execute time.
 *
 *  Producer-version-hash composition is unchanged (still: code +
 *  model + prompt + adapter + ingredients) — external context is
 *  row-level state, not producer-version state. The substrate
 *  distinguishes "producer code unchanged but external world
 *  changed" from "producer code changed."
 *
 *  Spec: `docs/d-136-spec.md` §A.14.1 (external context pulse). */

import type Database from 'better-sqlite3';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Provider of the pulse-value refresh. Each shape has its own
 *  `recordPulse` callsite — vendor reconcilers for `connection`,
 *  MCP-tool producers for `mcp_tool`, periodic-poll task for
 *  `periodic_check`. */
export type ExternalContextPulseProvider =
  | 'connection'
  | 'mcp_tool'
  | 'periodic_check';

/** Producer-manifest declaration of an external context dependency.
 *  The producer reads external state at compute time + names it via
 *  a stable `id`; the substrate observes pulse changes on that id
 *  and invalidates the producer's outputs.
 *
 *  Stable identifiers are caller-chosen (e.g.
 *  `'hubspot_api_deal_meta'`, `'web_search_company_background'`).
 *  Two producers reading the same external state should declare the
 *  same `id` so a single pulse change fans out to both.
 *
 *  `invalidates_on_pulse_change: false` is for declarative-only
 *  tracking — the substrate records the pulse for observability but
 *  doesn't invalidate the producer's rows on change. Use cases:
 *  pulse providers whose changes are advisory (e.g. a vendor
 *  catalog update that the producer doesn't actually re-read). */
export interface ConsumesExternalContextEntry {
  id: string;
  pulse_provider: ExternalContextPulseProvider;
  invalidates_on_pulse_change: boolean;
}

/** Returned from `recordPulse` so callers can branch on the pulse
 *  outcome — typical pattern is "if changed, the cascade engine has
 *  fired automatically; otherwise no-op." Callers don't need to
 *  inspect this for correctness — pure observability. */
export interface PulseRecordResult {
  /** True iff the new value differs from the prior persisted value
   *  for this `context_id`. False on first-record (no prior) per
   *  spec — the substrate observes the value but doesn't fire the
   *  cascade since there's nothing to compare against. */
  changed: boolean;
  /** True iff this is the first time we've recorded this `context_id`.
   *  Distinct from `changed` — a first record is observed but not
   *  changed (`changed: false, first_record: true`). */
  first_record: boolean;
  /** The recorded pulse value (echoed for caller convenience). */
  pulse_value: string;
}

// ────────────────────────────────────────────────────────────────
// Pulse store
// ────────────────────────────────────────────────────────────────

export interface ExternalContextPulseStore {
  /** Persist a pulse value for `context_id`. Returns whether the
   *  value changed vs the prior record. Idempotent — same value
   *  re-recorded returns `changed: false`. */
  recordPulse(
    context_id: string,
    pulse_value: string,
    now: number,
    next_check_at?: number,
  ): PulseRecordResult;
  /** Read the most recent pulse value. Returns null when no record
   *  exists for `context_id`. */
  readPulse(context_id: string): {
    pulse_value: string;
    observed_at: number;
    next_check_at: number | null;
  } | null;
  /** List every recorded pulse — used by the periodic-check task to
   *  pick the next due `next_check_at <= now`. */
  listPulses(): ReadonlyArray<{
    context_id: string;
    pulse_value: string;
    observed_at: number;
    next_check_at: number | null;
  }>;
  /** Drop every record. Tests + manual reset only. */
  clear(): void;
}

const PULSE_TABLE = 'external_context_pulse';

export const createExternalContextPulseStore = (
  db: Database.Database,
): ExternalContextPulseStore => {
  // The schema is materialized by `ensureEnrichmentSchema` (P2 ships
  // the table). We don't re-CREATE here — the store is a thin reader/
  // writer over the existing table.
  const selectOne = db.prepare(
    `SELECT pulse_value, observed_at, next_check_at FROM ${PULSE_TABLE} WHERE context_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO ${PULSE_TABLE} (context_id, pulse_value, observed_at, next_check_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(context_id) DO UPDATE SET
         pulse_value = excluded.pulse_value,
         observed_at = excluded.observed_at,
         next_check_at = excluded.next_check_at`,
  );
  const selectAll = db.prepare(
    `SELECT context_id, pulse_value, observed_at, next_check_at FROM ${PULSE_TABLE}
       ORDER BY context_id ASC`,
  );
  const clear = db.prepare(`DELETE FROM ${PULSE_TABLE}`);

  return {
    recordPulse(context_id, pulse_value, now, next_check_at) {
      const prior = selectOne.get(context_id) as
        | { pulse_value: string; observed_at: number; next_check_at: number | null }
        | undefined;
      upsert.run(context_id, pulse_value, now, next_check_at ?? null);
      if (!prior) {
        return { changed: false, first_record: true, pulse_value };
      }
      return {
        changed: prior.pulse_value !== pulse_value,
        first_record: false,
        pulse_value,
      };
    },
    readPulse(context_id) {
      const row = selectOne.get(context_id) as
        | { pulse_value: string; observed_at: number; next_check_at: number | null }
        | undefined;
      if (!row) return null;
      return {
        pulse_value: row.pulse_value,
        observed_at: row.observed_at,
        next_check_at: row.next_check_at,
      };
    },
    listPulses() {
      const rows = selectAll.all() as Array<{
        context_id: string;
        pulse_value: string;
        observed_at: number;
        next_check_at: number | null;
      }>;
      return rows;
    },
    clear() {
      clear.run();
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Producer-context dependency registry
// ────────────────────────────────────────────────────────────────

/** Reverse-index of which producer topics consume a given pulse
 *  context_id. Built at producer registration time (the harness
 *  reads each producer's `consumes_external_context` declarations);
 *  the cascade primitive uses this to walk consumers when a pulse
 *  fires.
 *
 *  Two producers consuming the same context_id is the canonical
 *  cross-producer fan-out case — `'hubspot_api_deal_meta'` consumed
 *  by both `lifecycle_stage_inferred` + `deal_health_score`, say.
 *  The registry uses a `Map<context_id, Set<topic>>` for O(1)
 *  lookup at cascade fire time. */
export interface ExternalContextDependencyRegistry {
  /** Add a producer's declared dependencies. Idempotent — re-adding
   *  the same `(topic, context_id)` pair is a no-op. */
  add(topic: string, deps: ReadonlyArray<ConsumesExternalContextEntry>): void;
  /** Look up the topic set consuming a context_id. Returns an empty
   *  set when no producer declared the id. INCLUDES topics that
   *  declared `invalidates_on_pulse_change: false` — those are
   *  observers, not invalidators. The cascade primitive should call
   *  `invalidatingConsumersOf` instead; `consumersOf` is for general
   *  observability (e.g. registry.describe). */
  consumersOf(context_id: string): ReadonlySet<string>;
  /** D-136 §A.14.1 — invalidating subset of `consumersOf`. Returns
   *  only topics whose declaration carried
   *  `invalidates_on_pulse_change: true`. Called by
   *  `cascadeForExternalContextPulseChange` so opt-out declarers
   *  (advisory-only consumers) don't get their rows recomputed on
   *  every pulse change. */
  invalidatingConsumersOf(context_id: string): ReadonlySet<string>;
  /** Drop every entry. Tests only. */
  clear(): void;
  /** Snapshot of the underlying map for observability. */
  snapshot(): ReadonlyMap<string, ReadonlySet<string>>;
}

export const createExternalContextDependencyRegistry =
  (): ExternalContextDependencyRegistry => {
    const byContextId = new Map<string, Set<string>>();
    const invalidatesByContextId = new Map<string, Map<string, boolean>>();
    return {
      add(topic, deps) {
        for (const entry of deps) {
          let topics = byContextId.get(entry.id);
          if (!topics) {
            topics = new Set();
            byContextId.set(entry.id, topics);
          }
          topics.add(topic);
          let invalidates = invalidatesByContextId.get(entry.id);
          if (!invalidates) {
            invalidates = new Map();
            invalidatesByContextId.set(entry.id, invalidates);
          }
          // If ANY consumer declares invalidates_on_pulse_change=true
          // we treat the context_id as cascade-firing. Per-topic gate
          // happens at the cascade's per-topic walk so a non-firing
          // declarer doesn't get its rows recomputed.
          invalidates.set(topic, entry.invalidates_on_pulse_change);
        }
      },
      consumersOf(context_id) {
        return byContextId.get(context_id) ?? new Set();
      },
      invalidatingConsumersOf(context_id) {
        const flags = invalidatesByContextId.get(context_id);
        if (!flags) return new Set();
        const out = new Set<string>();
        for (const [topic, invalidates] of flags) {
          if (invalidates) out.add(topic);
        }
        return out;
      },
      clear() {
        byContextId.clear();
        invalidatesByContextId.clear();
      },
      snapshot() {
        return byContextId;
      },
    };
  };

// ────────────────────────────────────────────────────────────────
// Helper: filter the consumers to just the topics that opted into
// invalidation. Used by the cascade primitive to honour the
// declarative `invalidates_on_pulse_change: false` knob.
// ────────────────────────────────────────────────────────────────

export const filterInvalidatingConsumers = (
  reg: ExternalContextDependencyRegistry,
  context_id: string,
  declarations: ReadonlyArray<{
    topic: string;
    deps: ReadonlyArray<ConsumesExternalContextEntry>;
  }>,
): ReadonlySet<string> => {
  // The registry's primary surface (consumersOf) returns all topics
  // that declared the id, including those with invalidates=false.
  // The fan-out caller wants the invalidating subset. We re-walk the
  // raw declarations to build it — the registry stores the
  // declarations only by-topic so a per-(context, topic) lookup
  // avoids the snapshot pass when the cascade engine carries the
  // declarations array directly.
  const out = new Set<string>();
  const consumers = reg.consumersOf(context_id);
  for (const decl of declarations) {
    if (!consumers.has(decl.topic)) continue;
    if (decl.deps.some((d) => d.id === context_id && d.invalidates_on_pulse_change)) {
      out.add(decl.topic);
    }
  }
  return out;
};
