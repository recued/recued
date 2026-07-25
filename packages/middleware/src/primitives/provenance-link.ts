/** D-145 PB3 — `provenance.link` primitive.
 *
 *  Per § B.1 row 10 + § B.1.2 rule 8 (`provenance.link` is
 *  fire-and-forget — emitted after each primitive that creates a new
 *  entity / annotation; linking failures don't block the engine).
 *  D-120 link-graph emission (engagement → contact, etc.).
 *
 *  Failure semantics: the primitive ALWAYS resolves with `ok` status
 *  even when the underlying adapter rejects. The PrimitiveCall's
 *  `outcome_summary` carries `errored=yes` when the adapter throws so
 *  audit retains the failure attribution; the orchestrator never
 *  blocks on link emission per § B.1.2 rule 8.
 *
 *  Dry Run discipline (§ B.5.4): when `ctx.preview === true`, the
 *  primitive records `preview_no_op` and skips the adapter call —
 *  link emission is a fire-and-forget mutation.
 *
 *  Privacy: `args_summary` carries link-kind + entity-id count —
 *  never raw entity-id strings (kind only).
 *
 *  Spec: § B.1 + § B.1.2 + § B.5.4 + D-120. */

import {
  buildPrimitiveCall,
  projectAdapterDetailForAudit,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

export interface ProvenanceLinkRequest {
  /** Source memory_id (the plan's plan_id is typical). */
  memory_id: string;
  /** Target entity ids — closed list of edges to write. */
  entity_ids: string[];
  /** Closed-list link kind per the existing D-120 `LinkKind` union.
   *  PB3 keeps the field open; the adapter validates against the
   *  current LinkKind set. */
  kind: string;
  /** D-120 P7.5 bistemporal stamp. */
  event_at?: number;
}

export interface ProvenanceLinkResult {
  /** True when at least one edge was written. */
  ok: boolean;
  /** Edges actually written (may be < `entity_ids.length` when some
   *  entities are missing). */
  edges_written: number;
  /** Adapter-stamped detail when the call partially failed; never
   *  raw entity-id strings. */
  detail?: string;
}

export interface ProvenanceLinkAdapter {
  link(request: ProvenanceLinkRequest): Promise<ProvenanceLinkResult>;
}

export interface ProvenanceLinkPrimitiveDeps {
  adapter: ProvenanceLinkAdapter;
}

export interface ProvenanceLinkPrimitiveInput extends ProvenanceLinkRequest {}
export interface ProvenanceLinkPrimitiveOutput extends ProvenanceLinkResult {}

const summarizeRequest = (req: ProvenanceLinkRequest): string =>
  `kind=${req.kind} entities=${req.entity_ids.length}${req.event_at !== undefined ? ' event_at_set' : ''}`;

export const createProvenanceLinkPrimitive = (
  deps: ProvenanceLinkPrimitiveDeps,
): EnginePrimitive<ProvenanceLinkPrimitiveInput, ProvenanceLinkPrimitiveOutput> => {
  return {
    primitive: 'provenance.link',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<ProvenanceLinkPrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      // PB13 Dry Run: skip the adapter, record preview_no_op.
      if (ctx.preview) {
        const completedAt = now();
        return {
          result: { ok: true, edges_written: 0, detail: 'preview_no_op' },
          call: buildPrimitiveCall({
            primitive: 'provenance.link',
            call_id,
            args_summary: `preview ${summarizeRequest(input)}`,
            outcome_summary: 'preview no edges',
            status: 'preview_no_op',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }

      // Fire-and-forget per § B.1.2 rule 8 — failures don't block
      // the engine. We always resolve `ok` from the orchestrator's
      // perspective; the `outcome_summary` records the actual
      // adapter result (or error) for audit.
      try {
        const result = await deps.adapter.link(input);
        const completedAt = now();
        const safeDetail = projectAdapterDetailForAudit(result.detail);
        return {
          result,
          call: buildPrimitiveCall({
            primitive: 'provenance.link',
            call_id,
            args_summary: summarizeRequest(input),
            outcome_summary: `edges_written=${result.edges_written}${safeDetail ? ` detail=${safeDetail}` : ''}`,
            status: 'ok',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        const errClass = projectErrorClass(e);
        return {
          result: { ok: false, edges_written: 0, detail: errClass },
          call: buildPrimitiveCall({
            primitive: 'provenance.link',
            call_id,
            args_summary: summarizeRequest(input),
            outcome_summary: `errored=yes detail=${errClass}`,
            // Per rule 8, the engine MUST not surface this as a
            // blocking failure. We retain `'ok'` status so callers'
            // composition checks pass; the audit row preserves the
            // error in `outcome_summary` for replay.
            status: 'ok',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }
    },
  };
};
