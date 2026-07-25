/** D-145 PB3 — `memory.recall` primitive.
 *
 *  Per § B.1 row 3 + § B.1.2 rule 2 (`memory.recall` runs before
 *  `ai.synthesize`). Reads from D-120 memory + audit + provenance +
 *  the `data.timeline()` MCP primitive. Caller-supplied
 *  `MemoryRecallAdapter` (typed read shape) keeps the primitive
 *  decoupled from the storage layer; tests substitute a mock without
 *  touching primitive code.
 *
 *  Privacy: `args_summary` carries query shape (filters + recency
 *  window) — never raw payload. `outcome_summary` carries row count +
 *  degraded-source signals. The full memory payload crosses to the
 *  orchestrator via `result.entries[]`; PB7 packet composer applies
 *  the per-content-class persist-policy gate before AI inclusion.
 *
 *  Spec: § B.1 + § B.1.2 + § B.5.1 + D-120. */

import {
  buildPrimitiveCall,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

/** Closed list of memory query axes per D-120 P7.5 + § B.5.1. The
 *  axis discriminates how the adapter sorts + paginates. */
export const MEMORY_RECALL_AXES = ['event', 'ingestion'] as const;
export type MemoryRecallAxis = (typeof MEMORY_RECALL_AXES)[number];
export const MEMORY_RECALL_AXIS_SET: ReadonlySet<MemoryRecallAxis> = new Set(MEMORY_RECALL_AXES);

export interface MemoryRecallRequest {
  /** Optional entity-id scope. When set, the adapter routes through
   *  `data.timeline(entity_id)` per D-120 P5; when omitted, the
   *  adapter performs a free-form recall over the recent window. */
  entity_id?: string;
  /** Optional kind filter (e.g. `'recipe_insight'` / `'recued_plan'`). */
  kinds?: string[];
  /** Inclusive lower bound. Unix-ms. */
  since?: number;
  /** Exclusive upper bound. Unix-ms. */
  until?: number;
  /** Per D-120 P7.5 — defaults to `'event'` (real-world chronology). */
  axis?: MemoryRecallAxis;
  /** Result cap. Adapter MUST honor; PB7 broker tightens later. */
  limit?: number;
}

export interface MemoryRecallEntry {
  memory_id: string;
  kind: string;
  /** Source-collection-specific summary projection. The adapter
   *  populates this with an audit-clean summary; raw payloads stay
   *  inside the entry's `payload` field for PB7 to gate on
   *  content-class. */
  summary: string;
  ts: number;
  event_at?: number;
  payload?: unknown;
}

export interface MemoryRecallResult {
  entries: MemoryRecallEntry[];
  total_count?: number;
  sources_degraded?: string[];
}

export interface MemoryRecallAdapter {
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResult>;
}

export interface MemoryRecallPrimitiveDeps {
  adapter: MemoryRecallAdapter;
}

export interface MemoryRecallPrimitiveInput extends MemoryRecallRequest {}
export interface MemoryRecallPrimitiveOutput extends MemoryRecallResult {}

const summarizeFilter = (req: MemoryRecallRequest): string => {
  const parts: string[] = [];
  if (req.entity_id !== undefined) parts.push('entity_scoped');
  if (req.kinds && req.kinds.length > 0) parts.push(`kinds=${req.kinds.length}`);
  if (req.since !== undefined || req.until !== undefined) parts.push('windowed');
  if (req.axis !== undefined) parts.push(`axis=${req.axis}`);
  return parts.length === 0 ? 'free_form' : parts.join(',');
};

export const createMemoryRecallPrimitive = (
  deps: MemoryRecallPrimitiveDeps,
): EnginePrimitive<MemoryRecallPrimitiveInput, MemoryRecallPrimitiveOutput> => {
  return {
    primitive: 'memory.recall',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<MemoryRecallPrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      if (input.axis !== undefined && !MEMORY_RECALL_AXIS_SET.has(input.axis)) {
        const completedAt = now();
        return {
          result: { entries: [], total_count: 0 },
          call: buildPrimitiveCall({
            primitive: 'memory.recall',
            call_id,
            args_summary: `axis=<unknown:${input.axis}> ${summarizeFilter(input)}`,
            outcome_summary: 'error unknown_axis',
            status: 'error',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }

      try {
        const result = await deps.adapter.recall(input);
        const completedAt = now();
        const degraded = result.sources_degraded ?? [];
        const status = degraded.length > 0 ? 'ok_partial' : 'ok';
        return {
          result,
          call: buildPrimitiveCall({
            primitive: 'memory.recall',
            call_id,
            args_summary: `${summarizeFilter(input)} limit=${input.limit ?? 'unbounded'}`,
            outcome_summary: `entries=${result.entries.length} total=${result.total_count ?? '?'} degraded=${degraded.length}`,
            status,
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        return {
          result: { entries: [], total_count: 0 },
          call: buildPrimitiveCall({
            primitive: 'memory.recall',
            call_id,
            args_summary: summarizeFilter(input),
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
