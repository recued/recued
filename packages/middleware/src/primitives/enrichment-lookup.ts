/** D-145 PB3 — `enrichment.lookup` primitive.
 *
 *  Per § B.1 row 5 + § B.1.2 rule 3 (`enrichment.lookup` runs before
 *  `ai.synthesize`). Reads D-122 / D-128 / D-130 / D-136 enrichment
 *  rows with cascade-walker awareness. Caller-supplied
 *  `EnrichmentLookupAdapter` keeps the primitive decoupled from the
 *  enrichment registry.
 *
 *  Privacy: `args_summary` carries scope shape (collection / topic /
 *  id projection) — never raw payload. Topic + visibility gate is the
 *  adapter's responsibility — the primitive trusts the adapter to
 *  honor `mcp_exposed` per D-136 P7.E + the per-(bound contract, topic)
 *  `contract.enrichment.*` read-visibility override (D-187).
 *
 *  Spec: § B.1 + § B.1.2 + D-136 + D-187. */

import {
  buildPrimitiveCall,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

export interface EnrichmentLookupRequest {
  /** Topic name per the D-136 enrichment registry (e.g.
   *  `'preferred_channel_by_contact'`). Closed list at registry-load
   *  time; the adapter rejects unknown topics. */
  topic: string;
  /** Optional scope filter — adapter-specific. May carry per-record
   *  filters (`{ contact_id: ... }`) or per-collection sweeps
   *  (`{ collection: 'contact' }`). */
  scope?: Record<string, unknown>;
  /** Result cap. */
  limit?: number;
}

export interface EnrichmentRow {
  /** Topic-scoped key (e.g. `<contact_id>` for per-contact enrichments,
   *  `<vendor>_<entity>_<id>` for platform-reference). */
  target_id: string;
  topic: string;
  value: unknown;
  /** Confidence score from the producer (when applicable). */
  confidence?: number;
  /** D-136 bistemporal stamp. */
  event_at?: number;
  ts?: number;
}

export interface EnrichmentLookupResult {
  rows: EnrichmentRow[];
  total_count?: number;
  /** True when the adapter dropped rows because the topic isn't
   *  MCP-exposed in this caller's permission scope. The orchestrator
   *  surfaces this in `selection_trace.recipe_candidates_dropped[]`
   *  with `reason_code: 'privacy_class'`. */
  visibility_filtered?: boolean;
}

export interface EnrichmentLookupAdapter {
  lookup(request: EnrichmentLookupRequest): Promise<EnrichmentLookupResult>;
}

export interface EnrichmentLookupPrimitiveDeps {
  adapter: EnrichmentLookupAdapter;
}

export interface EnrichmentLookupPrimitiveInput extends EnrichmentLookupRequest {}
export interface EnrichmentLookupPrimitiveOutput extends EnrichmentLookupResult {}

const summarizeFilter = (req: EnrichmentLookupRequest): string => {
  const parts: string[] = [`topic=${req.topic}`];
  if (req.scope && Object.keys(req.scope).length > 0) {
    parts.push(`scope_keys=${Object.keys(req.scope).sort().join(',')}`);
  }
  return parts.join(' ');
};

export const createEnrichmentLookupPrimitive = (
  deps: EnrichmentLookupPrimitiveDeps,
): EnginePrimitive<EnrichmentLookupPrimitiveInput, EnrichmentLookupPrimitiveOutput> => {
  return {
    primitive: 'enrichment.lookup',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<EnrichmentLookupPrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      try {
        const result = await deps.adapter.lookup(input);
        const completedAt = now();
        const status = result.visibility_filtered ? 'ok_partial' : 'ok';
        return {
          result,
          call: buildPrimitiveCall({
            primitive: 'enrichment.lookup',
            call_id,
            args_summary: `${summarizeFilter(input)} limit=${input.limit ?? 'unbounded'}`,
            outcome_summary: `rows=${result.rows.length} total=${result.total_count ?? '?'} filtered=${result.visibility_filtered ? 'yes' : 'no'}`,
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
            primitive: 'enrichment.lookup',
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
