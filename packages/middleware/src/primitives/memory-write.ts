/** D-145 PB3 — `memory.write` primitive.
 *
 *  Per § B.1 row 4 + § B.1.2 rule 5 (`memory.write` runs after the
 *  final response — or after each round in multi-turn). Writes a
 *  D-120 memory entry with provenance + reason code. Caller-supplied
 *  `MemoryWriteAdapter` keeps the primitive decoupled from storage.
 *
 *  Dry Run discipline (§ B.5.4): when `ctx.preview === true`, the
 *  primitive records `preview_no_op` status WITHOUT calling the
 *  adapter. No live caller wires the orchestrator to surface these
 *  preview-only results to the user yet; once wired, the user
 *  confirms and the orchestrator re-runs the request with
 *  `preview === false`.
 *
 *  Privacy: `args_summary` carries kind + reason_code + provenance
 *  count. The `payload` crosses through the adapter; PB7 packet
 *  composer is responsible for content-class gating BEFORE writes
 *  hit this primitive.
 *
 *  Spec: § B.1 + § B.1.2 + § B.5.4 + § B.5.1 + D-120. */

import {
  buildPrimitiveCall,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

export interface MemoryWriteRequest {
  kind: string;
  /** Audit-clean summary the adapter persists alongside the payload. */
  summary: string;
  /** Closed-list reason code for the write. The orchestrator stamps
   *  this from the calling primitive's outcome (e.g. `'extraction_committed'`,
   *  `'response_synthesized'`). The adapter is allowed to reject
   *  writes that don't carry a reason — the substrate enforces
   *  every-write-has-a-reason. */
  reason_code: string;
  /** Bistemporal stamping per D-120 P7.5 — `event_at` is the
   *  underlying real-world event time. */
  event_at?: number;
  /** Opaque to the primitive. PB7 broker is responsible for
   *  content-class gating before the payload reaches here. */
  payload?: unknown;
  /** Provenance link entity ids (D-120). Adapter records edges from
   *  the new memory_id back to these entities. */
  provenance_entity_ids?: string[];
}

export interface MemoryWriteResult {
  memory_id: string;
  /** Adapter-reported provenance edges actually written (may be a
   *  subset of `provenance_entity_ids` when some entities are
   *  missing). */
  provenance_edges_written: number;
}

export interface MemoryWriteAdapter {
  write(request: MemoryWriteRequest): Promise<MemoryWriteResult>;
}

export interface MemoryWritePrimitiveDeps {
  adapter: MemoryWriteAdapter;
  /** Injectable for tests; defaults to `crypto.randomUUID()` for the
   *  preview-mode fake memory_id. */
  mint_preview_memory_id?: () => string;
}

export interface MemoryWritePrimitiveInput extends MemoryWriteRequest {}
export interface MemoryWritePrimitiveOutput extends MemoryWriteResult {}

const summarizeRequest = (req: MemoryWriteRequest): string => {
  const parts: string[] = [`kind=${req.kind}`, `reason=${req.reason_code}`];
  if (req.event_at !== undefined) parts.push('event_at_set');
  if (req.provenance_entity_ids && req.provenance_entity_ids.length > 0) {
    parts.push(`provenance=${req.provenance_entity_ids.length}`);
  }
  return parts.join(' ');
};

export const createMemoryWritePrimitive = (
  deps: MemoryWritePrimitiveDeps,
): EnginePrimitive<MemoryWritePrimitiveInput, MemoryWritePrimitiveOutput> => {
  const mintPreviewId = deps.mint_preview_memory_id ?? (() => `preview_${Date.now()}`);

  return {
    primitive: 'memory.write',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<MemoryWritePrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      // PB13 Dry Run: skip the adapter, record preview_no_op.
      if (ctx.preview) {
        const completedAt = now();
        const preview_id = mintPreviewId();
        return {
          result: {
            memory_id: preview_id,
            provenance_edges_written: 0,
          },
          call: buildPrimitiveCall({
            primitive: 'memory.write',
            call_id,
            args_summary: `preview ${summarizeRequest(input)}`,
            outcome_summary: `preview memory_id=${preview_id} no side effects`,
            status: 'preview_no_op',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }

      try {
        const result = await deps.adapter.write(input);
        const completedAt = now();
        return {
          result,
          call: buildPrimitiveCall({
            primitive: 'memory.write',
            call_id,
            args_summary: summarizeRequest(input),
            outcome_summary: `memory_id=${result.memory_id} provenance_edges=${result.provenance_edges_written}`,
            status: 'ok',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        return {
          result: { memory_id: '', provenance_edges_written: 0 },
          call: buildPrimitiveCall({
            primitive: 'memory.write',
            call_id,
            args_summary: summarizeRequest(input),
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
