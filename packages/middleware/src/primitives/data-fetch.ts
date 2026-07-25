/** D-145 PB3 — `data.fetch` primitive.
 *
 *  Per § B.1 row 2. Reads from the warehouse — `data.mail` /
 *  `data.calendar` / `data.contact` / `data.engagement` /
 *  `data.task` / `data.note` / `data.commitment` / `data.project` /
 *  `data.shared`. The primitive is collection-agnostic — the caller
 *  supplies a typed `WarehouseFetchAdapter` keyed on collection +
 *  ref pattern + filter; the primitive enforces the PrimitiveCall
 *  discipline + emits a redacted `args_summary` (no payload bytes).
 *
 *  Privacy contract: `args_summary` and `outcome_summary` carry only
 *  collection name + row count + ref-shape projection — never raw
 *  payload, never full id strings (per § B.5.1). The full results
 *  cross back to the orchestrator via `result.rows[]` typed as
 *  `unknown[]` so the broker layer (PB7 packet composer) makes the
 *  AI-packet inclusion decision per § B.2.3 content-class rules.
 *
 *  Spec: § B.1 + § B.2.3 + § B.5.1. */

import {
  buildPrimitiveCall,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

/** Closed list of warehouse collections the engine reads through this
 *  primitive. PB3 ratchet pins the list — adding a new collection
 *  requires a substrate D-spec. The orchestrator validates `input.collection`
 *  against this set before dispatching the adapter. */
export const DATA_FETCH_COLLECTIONS = [
  'mail',
  'calendar',
  'contact',
  'engagement',
  'task',
  'note',
  'commitment',
  'project',
  'shared',
] as const;
export type DataFetchCollection = (typeof DATA_FETCH_COLLECTIONS)[number];
export const DATA_FETCH_COLLECTION_SET: ReadonlySet<DataFetchCollection> = new Set(
  DATA_FETCH_COLLECTIONS,
);

export interface WarehouseFetchRequest {
  collection: DataFetchCollection;
  /** Caller-supplied filter projection. Engine treats as opaque;
   *  adapter validates against its own schema. */
  filter?: Record<string, unknown>;
  /** Caller-supplied result cap. Adapter MUST honor; the broker
   *  layer (PB7 packet composer) tightens when the AI-packet budget
   *  bites. */
  limit?: number;
  /** Engine-internal hint — orchestrator may set to indicate the
   *  request comes from a per-intent capacity walk + which intent. */
  intent_id?: string;
}

export interface WarehouseFetchResult {
  rows: unknown[];
  /** Total rows matched before `limit` capping. The broker uses this
   *  to surface "X more results available" hints in Transparency
   *  Stream summaries (PB7). */
  total_count?: number;
  /** Adapter-reported degraded-coverage signals (e.g. one Source
   *  errored). Plumbs through to plan IR's `selection_trace` for
   *  audit visibility. */
  sources_degraded?: string[];
}

export interface WarehouseFetchAdapter {
  fetch(request: WarehouseFetchRequest): Promise<WarehouseFetchResult>;
}

export interface DataFetchPrimitiveDeps {
  adapter: WarehouseFetchAdapter;
}

export interface DataFetchPrimitiveInput extends WarehouseFetchRequest {}

export interface DataFetchPrimitiveOutput extends WarehouseFetchResult {}

const summarizeFilter = (filter: Record<string, unknown> | undefined): string => {
  if (!filter || Object.keys(filter).length === 0) return 'no filter';
  return `keys=${Object.keys(filter).sort().join(',')}`;
};

export const createDataFetchPrimitive = (
  deps: DataFetchPrimitiveDeps,
): EnginePrimitive<DataFetchPrimitiveInput, DataFetchPrimitiveOutput> => {
  return {
    primitive: 'data.fetch',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<DataFetchPrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      // Defensive collection gate. The orchestrator should validate
      // before dispatch but this catches direct primitive callers
      // (e.g. tests + future PB12 peer-MCP consumers).
      if (!DATA_FETCH_COLLECTION_SET.has(input.collection)) {
        const completedAt = now();
        return {
          result: { rows: [], total_count: 0 },
          call: buildPrimitiveCall({
            primitive: 'data.fetch',
            call_id,
            args_summary: `collection=<unknown:${input.collection}> ${summarizeFilter(input.filter)}`,
            outcome_summary: 'error unknown_collection',
            status: 'error',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }

      try {
        const result = await deps.adapter.fetch(input);
        const completedAt = now();
        const degraded = result.sources_degraded ?? [];
        const status = degraded.length > 0 ? 'ok_partial' : 'ok';
        return {
          result,
          call: buildPrimitiveCall({
            primitive: 'data.fetch',
            call_id,
            args_summary: `collection=${input.collection} ${summarizeFilter(input.filter)} limit=${input.limit ?? 'unbounded'}`,
            outcome_summary: `rows=${result.rows.length} total=${result.total_count ?? '?'} degraded=${degraded.length}`,
            status,
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        return {
          result: { rows: [], total_count: 0 },
          call: buildPrimitiveCall({
            primitive: 'data.fetch',
            call_id,
            args_summary: `collection=${input.collection} ${summarizeFilter(input.filter)}`,
            outcome_summary: `error ${projectErrorClass(e)}`,
            status: 'error',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }
    },
  };
};
