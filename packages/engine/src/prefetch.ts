import type { PrefetchOpStep, PrefetchStep, StepMeta } from '@recued/contracts';
import {
  isCatalogForm,
  isPrefetchOpStep,
  isRef,
  resolveDeep,
  resolveValue,
  preapprovalStepPath,
  SLOT_CANCELLED_ERROR_CODE,
  isPreflightRequiredSignal,
  isPeerAnswerRequiredSignal,
} from '@recued/contracts';
import type { ExecutionContext, StepLog } from './types.js';
import { requireRecipe } from './require-recipe.js';
import { evaluateCondition } from './condition.js';
import { fireProgress } from './execute.js';
import { mergeArgOverrides, resolveCatalogConnection, trackContextSize } from './step-runner.js';
import { runCatalogOperation } from './catalog-gateway.js';
import { setNamespaceValue } from './store-safety.js';
import { invokeGoverned } from './lane.js';

const MAX_CONCURRENT = 20;
export class PrefetchPause extends Error {
  constructor(readonly step_id: string, readonly signal: unknown, readonly logs: StepLog[]) {
    super('Prefetch requires a durable owner or peer decision.');
  }
}
const isHold = (error: unknown): boolean => isPreflightRequiredSignal(error) || isPeerAnswerRequiredSignal(error);

/** Run prefetch steps in parallel, batched by concurrency limit.
 *
 *  Progress reporting:
 *  - `prefetch_dispatched` fires once at start with every prefetch step id.
 *  - `focus_update` fires immediately after dispatch, pointing at the first
 *    declared prefetch step.
 *  - `prefetch_arrived` fires ONCE PER INDIVIDUAL STEP as its promise
 *    resolves (success, skip, or error) — not after the whole batch.
 *  - `focus_update` fires again whenever the currently-focused step arrives,
 *    advancing to the next non-arrived prefetch step in declaration order.
 *    If a step that is NOT the current focus arrives (because others are
 *    faster), focus stays on whichever step the user is actually waiting on. */
export const runPrefetch = async (ctx: ExecutionContext): Promise<StepLog[]> => {
  // `prefetch_steps` is OPTIONAL in the recipe schema (a recipe may have none —
  // e.g. a connection-agnostic op-step recipe whose only fetch is a `steps` op).
  // The validator permits it absent, so the engine must too: default to `[]`
  // rather than dereferencing `undefined.length`.
  const completed = new Set(ctx.resumeFrom?.execution_phase === 'prefetch' ? ctx.resumeFrom.prefetch_completed ?? [] : []);
  const steps = (requireRecipe(ctx).prefetch_steps ?? []).filter(step => !completed.has(step.id));
  ctx.prefetchCompleted = [...completed];
  const total = steps.length;
  const declarationOrder = steps.map((s) => s.id);

  fireProgress(ctx, {
    type: 'prefetch_dispatched',
    step_ids: declarationOrder,
    total,
  });

  // Track pending set in a way that preserves declaration order.
  const pending = new Set(declarationOrder);
  let currentFocus: string | null = null;

  const advanceFocus = (): void => {
    // Find the first declared step that's still pending.
    let next: string | null = null;
    for (const id of declarationOrder) {
      if (pending.has(id)) { next = id; break; }
    }
    // When prefetch is done (next === null), don't emit a terminal
    // prefetch focus — the sequential phase fires its own focus events.
    // Only emit when there's an actual prefetch step to focus on AND
    // it differs from the currently-focused step.
    if (next !== null && next !== currentFocus) {
      currentFocus = next;
      fireProgress(ctx, { type: 'focus_update', phase: 'prefetch', step_id: next });
    }
  };

  // Fire the initial focus (first non-arrival = first declared step).
  if (total > 0) advanceFocus();

  // Pre-allocate logs in declaration order so the result array is
  // deterministic regardless of actual arrival order.
  const logs: (StepLog | undefined)[] = new Array(total);
  let arrived = 0;

  for (let i = 0; i < steps.length; i += MAX_CONCURRENT) {
    const batchStart = i;
    const batch = steps.slice(i, i + MAX_CONCURRENT);
    const pauses: Array<{ index: number; step_id: string; signal: unknown }> = [];

    // Launch all batch promises simultaneously with a per-promise
    // arrival hook so progress fires as each resolves.
    await Promise.all(
      batch.map((ps, j) => {
        const index = batchStart + j;
        return executePrefetchStep(ps, ctx)
          .then(
            (log) => { logs[index] = log; if (!log.error) completed.add(ps.id); },
            (reason) => {
              if (isHold(reason)) pauses.push({ index, step_id: ps.id, signal: reason });
              else logs[index] = makeErrorLog(ps, ctx, reason);
            },
          )
          .then(() => {
            const log = logs[index];
            arrived++;
            fireProgress(ctx, {
              type: 'prefetch_arrived',
              step_id: ps.id,
              index: arrived,
              total,
              error: log?.error ?? null,
              skipped: log?.skipped ?? false,
            });
            pending.delete(ps.id);
            // Only advance focus if the step that just arrived was the
            // one the user was looking at — otherwise focus stays put.
            if (ps.id === currentFocus) advanceFocus();
          });
      }),
    );
    ctx.prefetchCompleted = [...completed];
    if (pauses.length) {
      const finished = logs.filter((log): log is StepLog => log !== undefined);
      // A completed failure is terminal; approval cannot fix it. Otherwise
      // wait for the whole parallel batch before snapshotting its successes.
      if (finished.some(log => log.error)) return finished;
      const paused = pauses.sort((a, b) => a.index - b.index)[0]!;
      throw new PrefetchPause(paused.step_id, paused.signal, finished);
    }
  }

  return logs as StepLog[];
};

const executePrefetchStep = async (
  ps: PrefetchStep | PrefetchOpStep,
  ctx: ExecutionContext,
): Promise<StepLog> => {
  const start = Date.now();
  const id = ps.id;

  // D-182 Slice 4 — a `PrefetchOpStep` (a two-tier `op` id) is concretized to a
  // `PrefetchStep` by the op-step lowering (`lowerOpStepRecipe`) BEFORE execution.
  // One surviving to the runner means lowering was skipped upstream — fail loud
  // rather than silently dispatch a slug-less ingredient call (which would surface
  // a confusing INGREDIENT_NOT_FOUND). After this guard `ps` is a `PrefetchStep`.
  if (isPrefetchOpStep(ps)) {
    throw new Error(
      `prefetch op-step '${ps.id}' (op '${ps.op}') reached the engine un-lowered — ` +
        `prefetch op-steps must be lowered to a concrete fetch (lowerOpStepRecipe) before execution`,
    );
  }

  if (ps.skip_when && evaluateCondition(ps.skip_when as string, ctx.stores)) {
    setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, null);
    return { id, type: 'prefetch', skipped: true, result: null, error: null, duration_ms: Date.now() - start };
  }

  try {
    // Resolve ps.ingredient when it's a ref (parity with step-runner;
    // kernel-style recipes may pass the slug via a variable).
    const rawIngredient = ps.ingredient as unknown;
    const ingredientSlug = (typeof rawIngredient === 'string' && isRef(rawIngredient))
      ? String(resolveValue(rawIngredient, ctx.stores) ?? '')
      : ps.ingredient;

    // Pass raw input + output — dispatch layer merges with manifest and
    // resolves refs. Mirror step-runner's special-case: when `ps.input`
    // is a bare ref (`"{{config.input}}"`), resolve eagerly so the
    // dispatch layer sees the resulting object to merge against.
    const rawInput = ps.input as unknown;
    let input: Record<string, unknown>;
    if (typeof rawInput === 'string' && isRef(rawInput)) {
      const resolved = resolveValue(rawInput, ctx.stores);
      input = (resolved && typeof resolved === 'object' && !Array.isArray(resolved))
        ? (resolved as Record<string, unknown>)
        : {};
    } else {
      input = (rawInput as Record<string, unknown>) ?? {};
    }
    const stepOptions = ctx.preapprovalAddressing ? { cache: 'fresh' as const }
      : ps.cache !== undefined ? { cache: ps.cache } : undefined;
    // Read-tier calls may still require approval (for example an always rule).
    // The resumed decision stays on this exact prefetch occurrence.
    const recipe = requireRecipe(ctx);
    const stepMeta: StepMeta = { step_id: id };
    if (ctx.resumeFrom?.execution_phase === 'prefetch' && ctx.resumeFrom.gated_step_id === id) {
      stepMeta.preflight_admitted = true;
      if (ctx.resumeFrom.approved_target) stepMeta.preflight_approved_target = ctx.resumeFrom.approved_target;
      if (ctx.resumeFrom.session_grant) stepMeta.preflight_session_grant = ctx.resumeFrom.session_grant;
      if (ctx.resumeFrom.batch_claim) stepMeta.preflight_batch_claim = ctx.resumeFrom.batch_claim;
    }
    if (ctx.governing_recipe_grant !== undefined) stepMeta.governing_recipe_grant = ctx.governing_recipe_grant;
    if (ctx.entry_tool_name !== undefined) stepMeta.entry_tool_name = ctx.entry_tool_name;
    if (ctx.preapprovalAddressing) stepMeta.invocation_path = preapprovalStepPath(
      ctx.preapprovalAddressing.recipe_path, 'prefetch', id, ctx.preapprovalAddressing.iteration_indices);
    if (recipe.recipe_id.length > 0) stepMeta.recipe_id = recipe.recipe_id;
    // D-181 slice 4 — run id for the cli executor's kill-handle registration.
    if (ctx.run_id !== undefined && ctx.run_id.length > 0) stepMeta.run_id = ctx.run_id;
    // D-182 Slice 4 (Codex review HIGH) — a catalog-form prefetch read now crosses
    // the D-165 gateway (below), so thread the run's execution-source context the
    // gateway AUDITS, the D-161 origin-actor stamps, and the D-136 MCP-trigger
    // policy reads off `StepMeta` — parity with the sequential `buildStepMeta`,
    // which the prefetch path previously skipped because it never reached the
    // gateway. Additive + read-tier, so it also enriches the simple-form kernel
    // read path (e.g. a lowered `enrichment-list`) with the same attribution.
    if (ctx.trigger_source !== undefined && ctx.trigger_source.length > 0) {
      stepMeta.trigger_source = ctx.trigger_source;
    }
    if (ctx.actor !== undefined && ctx.actor.length > 0) stepMeta.actor = ctx.actor;
    if (ctx.contract_id !== undefined && ctx.contract_id.length > 0) {
      stepMeta.contract_id = ctx.contract_id;
    }

    // D-182 Slice 4 — catalog-form routing for a lowered Tier-P prefetch op-step.
    // A Tier-P prefetch read lowers to `{ ingredient: <catalog>, input: { operation,
    // args } }` — a CATALOG op. The prefetch runner's default `invokeGoverned` path
    // DELIBERATELY bypasses the D-165 gateway (lane.ts), and `ctx.ingredientExecutor`
    // can't resolve a catalog op's `operation`→binding, so a catalog-form step must
    // take the SAME `runCatalogOperation` branch step-runner does (operation→binding
    // resolution + per-call gateway audit/policy). Simple-form ingredients (the
    // common prefetch case) fall through to `invokeGoverned` unchanged. Requires
    // `ctx.manifestGetter` (optional) — when unwired every step is simple-form.
    // Prefetch is read-tier by construction, so the sequential path's
    // PreflightRequiredSignal capture is not needed here.
    // (Codex review MEDIUM) — honour a pinned `ingredient_version` and fail closed
    // when it can't resolve, mirroring `runIngredient` (a version-pinned catalog
    // prefetch must not silently run against the latest manifest).
    const requestedVersion = ps.ingredient_version;
    const manifest = ctx.manifestGetter?.(ingredientSlug, requestedVersion);
    if (ctx.manifestGetter && requestedVersion !== undefined && !manifest) {
      throw new Error(
        `Ingredient '${ingredientSlug}' version ${requestedVersion} not found in registry`,
      );
    }
    if (ctx.resumeFrom?.execution_phase === 'prefetch' && ctx.resumeFrom.gated_step_id === id && ctx.resumeFrom.arg_overrides) {
      input = mergeArgOverrides(input.args === undefined ? input : { ...input, args: resolveDeep(input.args, ctx.stores) }, ctx.resumeFrom.arg_overrides);
    }
    if (isCatalogForm(manifest) && manifest) {
      // Resolve the op's `args` payload refs BEFORE the gateway reads it (the
      // gateway reads `input.args` raw — refs are a dispatch-layer concern; mirror
      // step-runner). `operation` / `connection` are read off `input` directly.
      const resolvedInput =
        input.args !== undefined
          ? { ...input, args: resolveDeep(input.args, ctx.stores) }
          : input;
      const connectionName = resolveCatalogConnection(
        ps as unknown as Record<string, unknown>,
        resolvedInput,
        ctx,
      );
      const catalogResult = await runCatalogOperation(
        ctx, manifest, ingredientSlug, resolvedInput, connectionName, ps.output, stepOptions, stepMeta,
      );
      setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, catalogResult);
      trackContextSize(ctx, catalogResult);
      return { id, type: 'prefetch', skipped: false, result: catalogResult, error: null, duration_ms: Date.now() - start };
    }

    const result = await invokeGoverned(ctx, ingredientSlug, input, ps.output, stepOptions, stepMeta);
    setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, result);
    trackContextSize(ctx, result);
    return { id, type: 'prefetch', skipped: false, result, error: null, duration_ms: Date.now() - start };
  } catch (e) {
    if (isHold(e)) throw e;
    setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, null);
    if (ps.optional) {
      return { id, type: 'prefetch', skipped: false, result: null, error: null, duration_ms: Date.now() - start };
    }
    throw e;
  }
};

const makeErrorLog = (
  ps: PrefetchStep | PrefetchOpStep,
  ctx: ExecutionContext,
  reason: unknown,
): StepLog => {
  // D-181 §7c — preserve the `slot_cancelled` marker for a non-optional prefetch
  // whose gated slot was cancelled (mirrors the step-runner sequential path), so
  // the host labels the run `cancelled_before_dispatch` rather than a generic
  // failure. Only this carrier survives the code → NETWORK_ERROR normalization.
  const slotCancelled =
    reason !== null && typeof reason === 'object'
    && (reason as { code?: unknown }).code === SLOT_CANCELLED_ERROR_CODE;
  return {
    id: ps.id, type: 'prefetch', skipped: false, result: null, duration_ms: 0,
    error: { error_id: '', code: 'NETWORK_ERROR', message: String(reason), severity: 'error',
      source: { recipe_id: requireRecipe(ctx).recipe_id, step_id: ps.id, ingredient_slug: null },
      details: slotCancelled ? { slot_cancelled: true } : {},
      timestamp: new Date().toISOString(), retryable: false },
  };
};
