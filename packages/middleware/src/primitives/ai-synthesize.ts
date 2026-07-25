/** D-145 PB3 — `ai.synthesize` primitive.
 *
 *  Per § B.1 row 6. Invokes `packages/llm` with tier hint + bounded
 *  packet + per-pool policy (D-132). Returns structured response +
 *  events array per § B.7. PB6 widens the events composer. One
 *  synthesis call per request composes the user-facing response.
 *
 *  Privacy: `args_summary` carries packet shape (size + tier + pool)
 *  — never the prompt text. `outcome_summary` carries token usage +
 *  status — never the response text.
 *
 *  Spec: § B.1 + § B.7 + § B.5.1. */

import type { ModelTier } from '@recued/contracts';

import {
  buildPrimitiveCall,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

export const AI_POOL_POLICIES = ['free_only', 'free_then_byok', 'byok_only'] as const;
export type AIPoolPolicy = (typeof AI_POOL_POLICIES)[number];
export const AI_POOL_POLICY_SET: ReadonlySet<AIPoolPolicy> = new Set(AI_POOL_POLICIES);

export interface AISynthesizeRequest {
  tier: ModelTier;
  pool_policy: AIPoolPolicy;
  /** Opaque packet — primitives don't introspect; the LLM adapter
   *  composes the actual prompt. PB7 broker is responsible for
   *  content-class filtering BEFORE the packet reaches here. */
  packet: unknown;
  /** Token-budget cap. Adapter MUST honor; the broker tightens later. */
  max_tokens?: number;
}

export interface AISynthesizeEvent {
  kind: string;
  payload?: unknown;
}

export interface AISynthesizeResult {
  /** Free-text response. PB7 packet composer renders to the user. */
  response: string;
  /** Structured events array per § B.7.1. PB6 widens the closed-list
   *  taxonomy; PB3 keeps the envelope open so primitives can emit
   *  events without the closed list landing first. */
  events: AISynthesizeEvent[];
  /** Resolved provider + model id (per `packages/llm` config). */
  provider: string;
  model_id: string;
  /** Total tokens used by this call (input + output). */
  total_tokens?: number;
  /** Total cost in cents. */
  cost_cents?: number;
  /** True when the adapter dropped the call to a lower tier (e.g.
   *  pool quota exhausted). Plumbs through to plan IR + Transparency
   *  Stream (no live caller emits `engine.budget_exceeded` yet). */
  tier_demoted?: boolean;
}

export interface AISynthesizeAdapter {
  synthesize(request: AISynthesizeRequest): Promise<AISynthesizeResult>;
}

export interface AISynthesizePrimitiveDeps {
  adapter: AISynthesizeAdapter;
}

export interface AISynthesizePrimitiveInput extends AISynthesizeRequest {}
export interface AISynthesizePrimitiveOutput extends AISynthesizeResult {}

const packetSizeBytes = (packet: unknown): number => {
  try {
    return JSON.stringify(packet).length;
  } catch {
    return -1;
  }
};

export const createAISynthesizePrimitive = (
  deps: AISynthesizePrimitiveDeps,
): EnginePrimitive<AISynthesizePrimitiveInput, AISynthesizePrimitiveOutput> => {
  return {
    primitive: 'ai.synthesize',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<AISynthesizePrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      if (!AI_POOL_POLICY_SET.has(input.pool_policy)) {
        const completedAt = now();
        return {
          result: { response: '', events: [], provider: '', model_id: '' },
          call: buildPrimitiveCall({
            primitive: 'ai.synthesize',
            call_id,
            args_summary: `tier=${input.tier} pool=<unknown:${input.pool_policy}>`,
            outcome_summary: 'error unknown_pool_policy',
            status: 'error',
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      }

      try {
        const result = await deps.adapter.synthesize(input);
        const completedAt = now();
        const status = result.tier_demoted ? 'ok_partial' : 'ok';
        return {
          result,
          call: buildPrimitiveCall({
            primitive: 'ai.synthesize',
            call_id,
            args_summary: `tier=${input.tier} pool=${input.pool_policy} packet_bytes=${packetSizeBytes(input.packet)} max_tokens=${input.max_tokens ?? 'unbounded'}`,
            outcome_summary: `provider=${result.provider} model=${result.model_id} tokens=${result.total_tokens ?? '?'} demoted=${result.tier_demoted ? 'yes' : 'no'} events=${result.events.length}`,
            status,
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        return {
          result: { response: '', events: [], provider: '', model_id: '' },
          call: buildPrimitiveCall({
            primitive: 'ai.synthesize',
            call_id,
            args_summary: `tier=${input.tier} pool=${input.pool_policy}`,
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
