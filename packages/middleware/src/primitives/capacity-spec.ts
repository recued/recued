/** D-145 PB3 — `capacity_spec` primitive.
 *
 *  Per § B.1 row 1 + § B.4. Wraps the PB1 walker (`walkCapacities`)
 *  so the orchestrator can invoke it as a typed primitive that
 *  emits a `PrimitiveCall` row. Halt-on-first-gap semantics are
 *  preserved; the primitive translates the walker's
 *  `CapacityCheckResult` into the PrimitiveCall.status discipline:
 *
 *    walker `{ ok: true }`          → PrimitiveCall.status = 'ok'
 *    walker `{ ok: false, gap }`    → PrimitiveCall.status = 'capacity_gap'
 *    walker throws                  → PrimitiveCall.status = 'error'
 *
 *  PB1 already wraps every probe in try/catch + per-probe timeout so
 *  the walker resolves cleanly in normal use. The defensive `error`
 *  branch covers contract-validator failures (malformed spec) +
 *  unexpected runtime exceptions.
 *
 *  Spec: § B.1 + § B.4. */

import type {
  CapacityCheck,
  CapacityCheckResult,
  CapacityRequirement,
  CapacitySpec,
} from '@recued/contracts';

import { walkCapacities } from '../capacity/walker.js';
import type {
  CapacityCache,
  CapacityProbeRegistry,
  CapacityWalkContext,
} from '../capacity/types.js';

import {
  buildPrimitiveCall,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
} from './types.js';

export interface CapacitySpecPrimitiveDeps {
  registry: CapacityProbeRegistry;
  cache: CapacityCache;
  /** PB1.7 composer-built context (audit + transparency emitter +
   *  counters). The primitive merges per-call fields (run_id,
   *  intent_id, primitive name) on top. */
  walkContext: Omit<CapacityWalkContext, 'run_id' | 'intent_id' | 'primitive'>;
}

export interface CapacitySpecPrimitiveInput {
  spec: CapacitySpec;
  /** Optional override of the per-call walk context. Tests use this
   *  to swap in a capturing transparency emitter; production paths
   *  rely on the deps' shared `walkContext`. */
  walk_context_override?: Partial<CapacityWalkContext>;
}

export interface CapacitySpecPrimitiveOutput {
  /** The walker's result. Orchestrator inspects `ok` before
   *  dispatching downstream primitives; per § B.1.2 rule 6 a
   *  `bridge.dispatch` call halts when `ok === false`. */
  walk_result: CapacityCheckResult;
  /** Convenience accessor — the rows the walker traversed. */
  checks: CapacityCheck[];
}

const summarizeKindCounts = (reqs: CapacityRequirement[]): string => {
  if (reqs.length === 0) return 'no checks';
  const counts: Record<string, number> = {};
  for (const r of reqs) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, n]) => `${k}=${n}`)
    .join(',');
};

const summarizeOutcome = (result: CapacityCheckResult): string => {
  if (result.ok) {
    const cached = result.checks.filter((c) => c.cached).length;
    return `ok checks=${result.checks.length} cached=${cached}`;
  }
  return `gap kind=${result.gap.kind} remediation=${result.remediation.action}`;
};

export const createCapacitySpecPrimitive = (
  deps: CapacitySpecPrimitiveDeps,
): EnginePrimitive<CapacitySpecPrimitiveInput, CapacitySpecPrimitiveOutput> => {
  return {
    primitive: 'capacity_spec',
    async execute(input, ctx): Promise<PrimitiveExecuteResult<CapacitySpecPrimitiveOutput>> {
      const now = resolveNow(ctx);
      const mintId = resolveMintCallId(ctx);
      const started_at = now();
      const call_id = mintId();

      const baseWalkContext: CapacityWalkContext = {
        ...deps.walkContext,
        run_id: ctx.run_id,
        ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
        primitive: 'capacity_spec',
        ...input.walk_context_override,
      };

      try {
        const walkResult = await walkCapacities({
          spec: input.spec,
          registry: deps.registry,
          cache: deps.cache,
          ctx: baseWalkContext,
        });

        const completedAt = now();
        const status = walkResult.ok ? 'ok' : 'capacity_gap';

        return {
          result: {
            walk_result: walkResult,
            checks: walkResult.checks,
          },
          call: buildPrimitiveCall({
            primitive: 'capacity_spec',
            call_id,
            args_summary: `spec capacities=${input.spec.capacities.length} kinds=${summarizeKindCounts(input.spec.capacities)}`,
            outcome_summary: summarizeOutcome(walkResult),
            status,
            started_at,
            duration_ms: completedAt - started_at,
            ...(ctx.intent_id !== undefined ? { intent_id: ctx.intent_id } : {}),
          }),
        };
      } catch (e) {
        const completedAt = now();
        return {
          result: {
            walk_result: {
              ok: false,
              gap: input.spec.capacities[0] ?? { kind: 'bridge_online' },
              gap_key: 'walker_error',
              remediation: { action: 'noop', user_facing_copy: '' },
              checks: [],
              correlation: { walk_id: call_id },
            },
            checks: [],
          },
          call: buildPrimitiveCall({
            primitive: 'capacity_spec',
            call_id,
            args_summary: `spec capacities=${input.spec.capacities.length}`,
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
