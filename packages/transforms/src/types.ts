import type { Condition, EnrichmentScope, RecipeOutputAction } from '@recued/contracts';
import type { PiiLedgerStore } from './pii-alias.js';

export type TransformFn = (params: Record<string, unknown>, context: TransformContext) => unknown;

/** D-125 P6.2 — row snapshot returned by the `readEnrichmentRow` hook.
 *  Mirrors the `data_enrichment` columns the transform's freshness +
 *  trust gate read. `confidence` is optional — sourced from
 *  `value.confidence` when the producer wrote it, else `null`. */
export interface EnrichmentRowSnapshot {
  value: unknown;
  /** Real-world event time (D-120 P7.5 bistemporal). NULL when the
   *  producer didn't supply one. */
  event_at: number | null;
  /** Ingestion-time fallback for freshness when `event_at` is NULL. */
  ingested_at: number;
  /** Stale flag. Cascade-marks-stale paths set this on source-record
   *  updates / recipe upgrade. Stale rows fail the freshness gate
   *  unconditionally regardless of `max_age_ms`. */
  stale: boolean;
  /** Producer-supplied trust score in `[0, 1]`. NULL when the producer
   *  didn't write `value.confidence`. */
  confidence: number | null;
}

export interface TransformContext {
  resolve: (ref: string) => unknown;
  evaluate: (condition: string | Condition) => boolean;
  now: () => Date;
  getTransform?: (name: string) => TransformFn | undefined;
  /** D-116 — Engine-provided hook for excluding deliberate pauses from
   *  `metadata.budget_ms`. Transforms that pause deliberately (e.g.
   *  `wait`) call this before sleeping so the wall-clock budget timer
   *  is extended by the same amount. Same exclusion model as D-094
   *  approval waits. Omitted by hosts that don't enforce a budget. */
  extendBudget?: (ms: number) => void;
  /** D-125 P6.2 — server-only hook for `enrichment-or-fetch`. Reads
   *  the freshest enrichment row keyed on `(topic, scope, target_id)`
   *  including row-level metadata (event_at, ingested_at, stale,
   *  confidence). Undefined on client-side hosts (no warehouse
   *  access) — the transform returns `source: 'no_runtime'` so the
   *  recipe falls back gracefully. */
  readEnrichmentRow?: (
    topic: string,
    scope: EnrichmentScope,
    target_id: string,
  ) => EnrichmentRowSnapshot | null;
  /** D-167 P4 — run-local PII alias ledger store backing the recipe-mode
   *  `pii-protect` / `pii-restore` transforms. The host (recued-server engine)
   *  mints one per recipe run so the real PII values bridge a `pii-protect`
   *  step and its later `pii-restore` step in pure process RAM, then drop when
   *  the run ends. Undefined on hosts that don't thread a store — the
   *  transforms fall back to a process singleton. */
  piiLedgerStore?: PiiLedgerStore;
}

export type ReduceOp = 'sum' | 'count' | 'avg' | 'min' | 'max';
export type MathOp = 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo' | 'abs' | 'ceil' | 'floor';
export type DateUnit = 'days' | 'hours' | 'minutes' | 'seconds';
export type SortDirection = 'asc' | 'desc';

export interface SortField { field: string; direction: SortDirection }
export interface TableColumn { field: string; label: string; format?: string; type?: 'text' | 'action' }
export interface ChecklistItem {
  label: string;
  issue: string;
  detail_ok: string;
  detail_issue: string;
  detail_null?: string;
  action?: RecipeOutputAction;
  actions?: RecipeOutputAction[];
}
export interface SummaryField { label: string; value: unknown }
