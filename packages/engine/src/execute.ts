import { isPreflightRequiredSignal, recipeOutputSections, resolveValue } from '@recued/contracts';
import { hashRecipe, parseRecipe, type ValidationIssue } from '@recued/recipes';
import type { OutputSection, RecipeStep } from '@recued/contracts';
import { estimateSize, type CacheEntry } from '@recued/cache';
import { createPiiLedgerStore } from '@recued/transforms';
import type { ExecutionContext, ExecutionResult, StepLog, ProgressEvent } from './types.js';
import { requireRecipe } from './require-recipe.js';
import {
  injectContextRecipe,
  snapshotContextRecipe,
} from './context-recipe.js';
import { findRoleRestrictions } from './preflight.js';
import { runPrefetch } from './prefetch.js';
import { runStep, trackContextSize } from './step-runner.js';
import { analyzeSteps, type StepSeed } from './step-seed.js';
import { assignOwnSafe, hasOwnSafe, setNamespaceValue } from './store-safety.js';

/** D-115 Phase 5 — magic step id whose numeric result (epoch ms) is
 *  surfaced as `ExecutionResult.next_run_at` for dynamic-interval
 *  `auto_run` recipes. Any other shape (undefined, NaN, non-finite,
 *  non-numeric) is ignored — static interval applies. */
const NEXT_RUN_AT_STEP_ID = 'next_run_at';

const emptyOutput = (): ExecutionResult['output'] => ({ render: [], sidebar: [] });

const renderOutput = (
  sections: ({ type: string; data: unknown } & Record<string, unknown>)[],
): ExecutionResult['output'] => ({
  render: sections,
  sidebar: sections,
});

// D-207 slice 2c — `recipeOutputSections` moved to @recued/contracts. It was
// private here, and the reception submit path now needs the SAME answer: whether
// a paired recipe's response carries anything decides whether a rejected visitor
// may still be told "Submission received". Two copies of this rule could
// disagree, and the disagreement would be a lie told to a real person.

const outputSourceStepId = (source: string): string | null => {
  const trimmed = source.trim();
  if (!trimmed.startsWith('step.')) return null;
  const rest = trimmed.slice('step.'.length);
  if (rest.length === 0) return null;
  const dot = rest.indexOf('.');
  return dot === -1 ? rest : rest.slice(0, dot);
};

/** Execute a recipe end-to-end.
 *
 *  Zero-retry policy:
 *  - Any error halts execution immediately (prefetch error → no sequential
 *    steps; sequential step error → break the loop). No recovery, no
 *    continuation, no silent retries, no cooldown state.
 *  - The user decides when to re-run: by navigating back to the page,
 *    ticking a scheduled trigger, or pressing the manual Run button.
 *    The engine doesn't gate anything.
 *  - Write/admin/destructive errors in the HTTP/MCP layer surface as
 *    ACTION_DELIVERY_UNCERTAIN, which the UI should display with an
 *    explicit "please verify in your CRM before retrying" prompt — the
 *    executor does NOT auto-retry such calls.
 *
 *  Progress reporting:
 *  - The optional `ctx.onProgress` callback receives `ProgressEvent`s
 *    in real time as prefetch steps arrive and sequential steps run.
 *    Consumers compute the "current cursor" from the event stream:
 *    `[all_prefetch − arrived_prefetch]` during prefetch, then the
 *    latest `sequential_step_started` step id during the sequential
 *    phase. Callback exceptions are swallowed — UI bugs never break
 *    execution. */
export const executeRecipe = async (inputCtx: ExecutionContext): Promise<ExecutionResult> => {
  // D-167 P4 — secure one run-local PII alias ledger store for the WHOLE run. It
  // holds real PII values in process RAM (the reverse alias→value map that
  // bridges a `pii-protect` step and its later `pii-restore` step). Reuse a
  // caller-supplied store if present (lets a host own the ledger itself), else
  // mint one per run.
  //
  // OWNERSHIP GUARD (`ownsStore`): executeRecipe disposes ONLY a store it minted
  // itself. A minted store is disposed when the run resolves — INCLUDING when a
  // budget timeout makes the caller abandon a still-running inner run — so real
  // values never outlive the run from the caller's perspective. A caller-supplied
  // store is the CALLER's to dispose; executeRecipe never disposes state it did
  // not create. This is purely an ownership boundary — it does NOT relax the
  // spec's hard rule that a ledger is never shared across runs / recipes /
  // sessions: a supplied store must STILL be per-run, because output restore
  // (resolveOutputRender -> restoreAll, which runs regardless of ownership) resolves a
  // run's output against the store's WHOLE alias namespace — so a store carried
  // into a second run would let that run's restore surface the FIRST run's real
  // PII. The guard does not make reuse safe; it stops the engine owning what it
  // didn't create. Its value: the old always-dispose behavior tore down a
  // caller's store on settle, and — worse — if such a store were (wrongly) shared
  // across CONCURRENT runs, the first to resolve would clear the alias maps out
  // from under a still-executing run, whose restore would then leak aliases. Not
  // disposing unowned state removes that engine-side failure mode. Today no
  // production caller supplies a store — the server always lets us mint here.
  const ownsStore = !inputCtx.piiLedgerStore;
  // § 7 follow-on (pii-ledger-in-checkpoint) — a preflight RESUME threads the
  // consumed checkpoint's ledger snapshot through `resumeFrom.pii_ledgers`;
  // minting the store FROM it (rather than accepting a live store) keeps the
  // ownership/dispose discipline above intact: the engine still owns what it
  // created, and the hydrated maps die with this run like any fresh store's.
  const ctx: ExecutionContext = ownsStore
    ? {
        ...inputCtx,
        piiLedgerStore: createPiiLedgerStore(inputCtx.resumeFrom?.pii_ledgers),
      }
    : inputCtx;
  // D-182 §10 step 7 — `executeRecipe` is the recipe-run entry; the recipe is
  // required (a raw op never enters here). `requireRecipe` narrows the optional
  // `recipe` once; the body + the budget-timer closure read this local.
  const recipe = requireRecipe(ctx);
  const piiStore = ctx.piiLedgerStore;

  // Optional-chain `metadata`: a malformed recipe with no `metadata` object
  // must reach `executeRecipeInner`'s validation (which emits the clean
  // `metadata_required` error) rather than crashing here on
  // `undefined.budget_ms` before validation ever runs.
  const budgetMs = recipe.metadata?.budget_ms;
  if (!budgetMs || budgetMs <= 0) {
    try {
      return await executeRecipeInner(ctx);
    } finally {
      if (ownsStore) piiStore?.dispose();
    }
  }
  // Race the full run against the declared wall-clock budget. On
  // budget exhaustion, in-flight steps are left to their own
  // cancellation (engine has no kill switch for an executor) — the
  // budget signal tells the caller the run is over and its output
  // should be ignored. Approvals sit outside the engine boundary
  // (the host wakes the engine only once granted) so they do
  // not count against this timer. D-116 adds the same treatment for
  // deliberate in-engine pauses via `ctx.extendBudget`: the `wait`
  // transform reports its sleep here so the timer is re-armed with
  // the extra ms added on top.
  const recipe_hash = hashRecipe(recipe);
  const start = Date.now();
  let extraMs = 0;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveBudget: ((r: ExecutionResult) => void) | undefined;
  const arm = (): void => {
    const remaining = Math.max(0, (budgetMs + extraMs) - (Date.now() - start));
    budgetTimer = setTimeout(() => {
      fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });
      // Coarse-resolution timers + worker scheduling can land Date.now()
      // a hair before the scheduled `remaining`, so report at least the
      // configured budget — saying elapsed < budget would misrepresent
      // why the recipe was killed.
      const elapsed = Math.max(Date.now() - start, budgetMs + extraMs);
      resolveBudget?.({
        recipe_id: recipe.recipe_id,
        recipe_hash,
        success: false,
        output: emptyOutput(),
        steps: [],
        errors: [buildBudgetExceededError(recipe.recipe_id, budgetMs, elapsed)],
        duration_ms: elapsed,
        validation_issues: [],
      });
    }, remaining);
  };
  const budgetSignal = new Promise<ExecutionResult>((resolve) => {
    resolveBudget = resolve;
    arm();
  });
  const innerCtx: ExecutionContext = {
    ...ctx,
    extendBudget: (ms: number) => {
      if (!Number.isFinite(ms) || ms <= 0) return;
      extraMs += ms;
      if (budgetTimer) clearTimeout(budgetTimer);
      arm();
    },
  };
  // Dispose the run's real-PII ledger (only when we own it — see the ownership
  // guard above) as the INNER run settles — NOT when the race resolves. On a
  // budget timeout the caller gets the failure, but the abandoned inner run
  // keeps executing (the engine has no kill switch); its later `pii-restore`
  // steps must still find the ledger, otherwise the alias surface would bleed
  // into a user-facing side effect (e.g. a notification rendered after the
  // budget cutoff). Disposing on inner-settle still drops the real PII the
  // moment the run actually ends. (The no-budget path above disposes in its own
  // `finally`, which is likewise inner-settle.)
  const run = executeRecipeInner(innerCtx).finally(() => { if (ownsStore) piiStore?.dispose(); });
  try {
    return await Promise.race([run, budgetSignal]);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
};

const executeRecipeInner = async (ctx: ExecutionContext): Promise<ExecutionResult> => {
  const start = Date.now();
  const logs: StepLog[] = [];
  const errors: ExecutionResult['errors'] = [];
  // D-182 §10 step 7 — recipe-run path; narrow the optional `recipe` once.
  const recipe = requireRecipe(ctx);
  const recipe_hash = hashRecipe(recipe);

  // Optional preflight validation. When strict mode is on, any
  // error-severity finding short-circuits execution before the engine
  // touches the ingredient executor. Warnings and info are not surfaced
  // here — consumers that want them should call `parseRecipe` themselves.
  if (ctx.strict) {
    const parsed = parseRecipe(recipe);
    if (!parsed.ok) {
      const errorIssues = parsed.issues.filter((i) => i.severity === 'error');
      fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });
      return {
        recipe_id: recipe.recipe_id,
        recipe_hash,
        success: false,
        output: emptyOutput(),
        steps: [],
        errors: [buildValidationError(recipe.recipe_id, errorIssues)],
        duration_ms: Date.now() - start,
        validation_issues: errorIssues,
      };
    }
  }

  // Role-based adapter restriction: reject recipes with browser-only
  // ingredients (DOM) when running on the server.
  if (ctx.manifestGetter) {
    const restricted = findRoleRestrictions(recipe, ctx.manifestGetter);
    if (restricted.length > 0) {
      const slugs = restricted.map(r => `${r.slug} (${r.adapter})`).join(', ');
      fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });
      return {
        recipe_id: recipe.recipe_id,
        recipe_hash,
        success: false,
        output: emptyOutput(),
        steps: [],
        errors: [{
          error_id: `role-${Date.now().toString(36)}`,
          code: 'ROLE_RESTRICTION',
          message: `Recipe uses browser-only ingredients that cannot run on the server: ${slugs}`,
          severity: 'fatal',
          source: { recipe_id: recipe.recipe_id, step_id: null, ingredient_slug: restricted[0].slug },
          details: { restricted },
          timestamp: new Date().toISOString(),
          retryable: false,
        }],
        duration_ms: Date.now() - start,
        validation_issues: [],
      };
    }
  }

  // Populate meta from recipe metadata. `recipe_id` is mirrored onto
  // `meta.recipe_id` so recipes can reference it in trigger-step /
  // prefetch inputs — used by D-117 `calendar-watcher` to key its
  // per-recipe cursor (see `CALENDAR_WATCHER_CURSOR_PREFIX`). Author-
  // declared `metadata.recipe_id` wins if present (never likely; kept
  // for forward-compatibility).
  assignOwnSafe(
    ctx.stores.meta as Record<string, unknown>,
    // `?? {}`: a malformed recipe with no `metadata` (strict validation off,
    // or a non-server caller) must not crash this Object copy on `undefined`.
    (recipe.metadata ?? {}) as unknown as Record<string, unknown>,
  );
  if (!hasOwnSafe(ctx.stores.meta as Record<string, unknown>, 'recipe_id')) {
    setNamespaceValue(ctx.stores.meta as Record<string, unknown>, 'recipe_id', recipe.recipe_id);
  }

  // Populate config from recipe variables (defaults)
  for (const [key, val] of Object.entries(recipe.variables)) {
    if (!hasOwnSafe(ctx.stores.config as Record<string, unknown>, key)) {
      setNamespaceValue(ctx.stores.config as Record<string, unknown>, key, extractDefault(val));
    }
  }

  // D-120 Phase 4.5 — inject prior-run `context.recipe.*` snapshot.
  // Idempotent: caller-set value wins (mirrors the `context.server`
  // injection rule). When the host didn't supply a snapshot, the
  // namespace populates as empty `{}` so `{{context.recipe.X}}` refs
  // resolve to undefined and `coalesce` wrappers fall through to
  // first-run defaults. The snapshot at this point is whatever the
  // host loaded from prefs — engine doesn't care about reactive vs
  // cron timing here; that decision lives in the host's snapshot
  // commit policy.
  injectContextRecipe(ctx.stores, ctx.contextRecipeSnapshot ?? null);

  // D-157 P1 slice 3 — resume from a preflight checkpoint. The host
  // pre-seeded `ctx.stores.step` with `Checkpoint.step_state` (outputs
  // of every step that completed before the gate); we now find where
  // in `recipe.steps` to pick up. Trigger steps + prefetch are skipped
  // on resume — they ran before the gate, their outputs are recipe-
  // static (`config` / `meta`) or live in the seeded `step.*`. The
  // gated step itself re-runs: its boundary-crossing call now dispatches
  // exactly once, with approval threaded by the gateway (slice 4) so it
  // does not re-raise `PreflightRequiredSignal`.
  const sequentialSteps = recipe.steps;
  let startIndex = 0;
  if (ctx.resumeFrom) {
    const gated = ctx.resumeFrom.gated_step_id;
    startIndex = sequentialSteps.findIndex(
      (s) => (s as { id?: string }).id === gated,
    );
    if (startIndex < 0) {
      // The recipe drifted between pause and resume — the checkpoint
      // names a step the current recipe doesn't have. Fatal: the run
      // cannot be resumed (the gated call's identity is lost).
      fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });
      return {
        recipe_id: recipe.recipe_id,
        recipe_hash,
        success: false,
        output: emptyOutput(),
        steps: [],
        errors: [{
          error_id: `resume-${Date.now().toString(36)}`,
          code: 'CHECKPOINT_STEP_NOT_FOUND',
          message:
            `Checkpoint references step '${gated}' which is not present in recipe '${recipe.recipe_id}' — `
              + 'the recipe may have changed since the run was paused.',
          severity: 'fatal',
          source: {
            recipe_id: recipe.recipe_id,
            step_id: gated,
            ingredient_slug: null,
          },
          details: { gated_step_id: gated },
          timestamp: new Date().toISOString(),
          retryable: false,
        }],
        duration_ms: Date.now() - start,
        validation_issues: [],
      };
    }
  }

  // D-115 Phase 5 — trigger phase. Runs BEFORE prefetch on reactive
  // ticks: every step's output must satisfy `TriggerOutput` with
  // `should_run: true` for the tick to proceed. Any false is a silent
  // skip — no audit entry, no sidebar, no prefetch/steps. An error
  // inside a trigger step halts the run as a regular failure (halts
  // the counter toward circuit breaker).
  //
  // Skipped on resume — trigger steps ran before the gate (a resumed
  // run by definition already passed its trigger gate to reach the
  // sequential phase).
  if (!ctx.resumeFrom && recipe.trigger_steps && recipe.trigger_steps.length > 0) {
    const triggerResult = await runTriggerSteps(ctx);
    logs.push(...triggerResult.logs);
    if (triggerResult.error) {
      errors.push(triggerResult.error);
      fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });
      return buildResult(ctx, recipe_hash, false, logs, errors, start);
    }
    if (triggerResult.skipped) {
      fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });
      const result = buildResult(ctx, recipe_hash, true, logs, errors, start);
      result.trigger_skipped = true;
      return result;
    }
  }

  // Prefetch (parallel, per-step progress events fired from within runPrefetch).
  // Skipped on resume — prefetch outputs land in `step.*`, which the
  // host pre-seeded from `Checkpoint.step_state` (TR-5 — no step before
  // the gate runs twice).
  if (!ctx.resumeFrom) {
    const prefetchLogs = await runPrefetch(ctx);
    logs.push(...prefetchLogs);
    const fatal = prefetchLogs.find(l => l.error);
    if (fatal?.error) {
      errors.push(fatal.error);
      fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });
      return buildResult(ctx, recipe_hash, false, logs, errors, start);
    }
  }

  // Sequential steps — halt on first error. Each step gets focus_update
  // followed by sequential_step_started (one for display, one for audit).

  // L2 step cache (opt-in). When ctx.stepCache is set, analyze the
  // sequential steps once up front, then short-circuit runStep on hit.
  // Prefetch stays uncached at this level — L1 ingredient cache
  // handles it, and prefetch outputs flow into the sequential seeds'
  // dep hashes via the `prefetch` namespace in ctx.stores.
  const executeStep = ctx.stepCache
    ? await buildCachedStepRunner(ctx, sequentialSteps)
    : (step: RecipeStep) => runStep(step, ctx);

  // D-068 / D-195: Progressive output rendering. Track whether all output
  // render sources are available. Once the threshold is met, re-emit the full
  // render array after every step completion (later steps can transform data
  // referenced by earlier output sections).
  const renderSections = recipeOutputSections(recipe);
  const renderSourceIds = renderSections.map(s => outputSourceStepId(s.source));
  const hasRender = renderSections.length > 0;
  let allSourcesReady = false;

  // On resume, `startIndex` points at `gated_step_id` (the step the
  // checkpoint was minted at); fresh runs start at 0. Either way the
  // loop runs over `sequentialSteps[startIndex..]`.
  for (let i = startIndex; i < sequentialSteps.length; i++) {
    const step = sequentialSteps[i];
    const stepId = (step as { id?: string }).id ?? `step_${i}`;
    fireProgress(ctx, { type: 'focus_update', phase: 'sequential', step_id: stepId });
    fireProgress(ctx, {
      type: 'sequential_step_started',
      step_id: stepId,
      index: i,
      total: sequentialSteps.length,
    });
    let log: StepLog;
    try {
      log = await executeStep(step);
    } catch (e) {
      // D-157 P1 slice 3 — preflight pause. The gateway wrapper around
      // `ctx.ingredientExecutor` raised `PreflightRequiredSignal`; the
      // step-runner re-threw it (not a normal step error). Snapshot the
      // run's `step.*` and end the execution with `awaiting_approval`
      // (I-4 — no held call). The host mints + persists the
      // `Checkpoint` from the snapshot; on `Approve` it re-instantiates
      // a fresh execution with `ctx.resumeFrom = { gated_step_id }` and
      // `ctx.stores.step` seeded from the checkpoint.
      if (isPreflightRequiredSignal(e)) {
        fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });
        // § 7 follow-on (pii-ledger-in-checkpoint) — serialize the run's pii
        // ledgers BEFORE the execution ends (the caller disposes the store on
        // settle). Undefined for the ~all runs that never minted a ledger —
        // the checkpoint then carries no snapshot field at all.
        const piiSnapshot = ctx.piiLedgerStore?.serialize();
        // D-157 server-wiring — read the gateway-attached `(tool_slug,
        // risk_tier, reason)` trio off the caught signal (when present)
        // and surface it on `awaiting_approval` so the host can pass it
        // straight into `PreflightAskContext`. Each field is forwarded
        // only when set — a legacy raise site (no details) leaves them
        // undefined and the host falls back to a bare ask.
        return {
          recipe_id: recipe.recipe_id,
          recipe_hash,
          success: false,
          output: emptyOutput(),
          steps: logs,
          errors: [],
          duration_ms: Date.now() - start,
          validation_issues: [],
          awaiting_approval: {
            gated_step_id: stepId,
            step_state: structuredClone(ctx.stores.step as Record<string, unknown>),
            ...(e.tool_slug !== undefined ? { tool_slug: e.tool_slug } : {}),
            ...(e.risk_tier !== undefined ? { risk_tier: e.risk_tier } : {}),
            ...(e.reason !== undefined ? { reason: e.reason } : {}),
            // D-165 follow-on (op-identity binding) — forward the resolved
            // identity so the host persists it on `Checkpoint.approved_target`
            // for resume-time re-verification.
            ...(e.ingredient_slug !== undefined
              ? { ingredient_slug: e.ingredient_slug }
              : {}),
            ...(e.operation_id !== undefined
              ? { operation_id: e.operation_id }
              : {}),
            ...(e.connection_name !== undefined
              ? { connection_name: e.connection_name }
              : {}),
            // D-177 P5a (N.10) — forward the gateway-attached action-identity
            // hashes + resolved-args preview so the host can register the
            // hold as a batch-ask member. Absent on a non-canonicalizable
            // payload (per-hold ask fallback).
            ...(e.arg_shape_hash !== undefined
              ? { arg_shape_hash: e.arg_shape_hash }
              : {}),
            ...(e.canonical_payload_hash !== undefined
              ? { canonical_payload_hash: e.canonical_payload_hash }
              : {}),
            ...(e.args_preview !== undefined
              ? { args_preview: e.args_preview }
              : {}),
            // D-177 P5b (N.11) — forward the open-projection preview: the
            // host's `grant_mode: 'open'` offer-feasibility marker + the
            // ask body's pinned/varies rendering. Absent on a refused walk
            // (the offer stays exact).
            ...(e.open_projection_preview !== undefined
              ? { open_projection_preview: e.open_projection_preview }
              : {}),
            // D-202 Slice 1b — forward the quality-relevance marker so the host
            // persists it onto `Checkpoint.quality_relevant` and the answer-path
            // resumer records the owner's reject-driven quality signal. Absent on
            // every non-quality ask ⇒ no signal (behaviour-preserving).
            ...(e.quality_relevant !== undefined
              ? { quality_relevant: e.quality_relevant }
              : {}),
            // § 7 follow-on — the run's pii ledgers ride the pause so a
            // fresh-process resume can still restore its aliases.
            ...(piiSnapshot !== undefined ? { pii_ledgers: piiSnapshot } : {}),
          },
        };
      }
      // Non-preflight exceptions are wrapped by `runStep` into a
      // `StepLog.error` — they never reach this catch in practice.
      // Defensive re-throw preserves the originating stack so a
      // genuine engine bug surfaces.
      throw e;
    }
    logs.push(log);
    fireProgress(ctx, {
      type: 'sequential_step_finished',
      step_id: stepId,
      index: i,
      total: sequentialSteps.length,
      skipped: log.skipped,
      error: log.error,
    });

    // D-068 / D-195: Check threshold, emit render_ready when all sources resolved.
    if (hasRender) {
      if (!allSourcesReady) {
        allSourcesReady = renderSourceIds.every(
          src => src !== null
            && hasOwnSafe(ctx.stores.step as Record<string, unknown>, src),
        );
      }
      if (allSourcesReady) {
        fireProgress(ctx, { type: 'render_ready', render: resolveOutputRender(renderSections, ctx.stores, ctx.piiLedgerStore) });
      }
    }

    if (log.error) {
      errors.push(log.error);
      break;
    }
  }

  // Resolve output (final, authoritative render data)
  const render = resolveOutputRender(renderSections, ctx.stores, ctx.piiLedgerStore);

  // Final focus signal: recipe is done (success or error — either way,
  // nothing is "in focus" anymore).
  fireProgress(ctx, { type: 'focus_update', phase: 'done', step_id: null });

  const result = buildResult(ctx, recipe_hash, errors.length === 0, logs, errors, start, render);

  // D-115 Phase 5 — dynamic-interval hint. Authors opt into this path
  // by writing a step with id `next_run_at` whose result is an epoch
  // ms number; the scheduler picks it up via `markFinished`'s
  // nextRunHint. Static-interval recipes leave the step absent and
  // this stays undefined. Non-finite / negative / non-numeric values
  // are ignored rather than surfaced as an error — a malformed value
  // would wedge the scheduler. `auto_run.dynamic` gating lives in the
  // scheduler (which ignores the hint when false); the engine always
  // surfaces what the recipe computed.
  const nextRunAt = hasOwnSafe(ctx.stores.step as Record<string, unknown>, NEXT_RUN_AT_STEP_ID)
    ? (ctx.stores.step as Record<string, unknown>)[NEXT_RUN_AT_STEP_ID]
    : undefined;
  if (typeof nextRunAt === 'number' && Number.isFinite(nextRunAt) && nextRunAt > 0) {
    result.next_run_at = nextRunAt;
  }

  // D-120 Phase 4.5 — emit the snapshot the next run should see.
  // Only on success: a partial run shouldn't poison `context.recipe.*`
  // with mid-execution outputs. Reactive (`auto_run`) hosts buffer
  // this in memory and only commit at `ProcessRetireReason`; cron +
  // manual hosts persist immediately. The engine doesn't know the
  // host's policy — it just emits the snapshot every time and lets
  // the host choose.
  if (result.success && ctx.onContextRecipeSnapshot) {
    try {
      const snapshotResult = snapshotContextRecipe(recipe, ctx.stores);
      ctx.onContextRecipeSnapshot(snapshotResult);
    } catch {
      // Snapshot is best-effort — never break the run path. A failed
      // snapshot leaves prior state intact (next run still reads the
      // last successful snapshot from the per-pair store).
    }
  }

  return result;
};

/** D-115 Phase 5 — run the `trigger_steps` phase.
 *
 *  Each trigger step executes via the same `runStep` path as sequential
 *  steps (so `transform` / `ingredient` / `guard` / `skip_when` /
 *  `fail_on` / `foreach` all work the same way). The step's result is
 *  stored under both `stores.step.<id>` (for in-phase refs like a later
 *  trigger step referencing an earlier one) and `stores.trigger.<id>`
 *  with `should_run` stripped so downstream prefetch + steps read
 *  `{{trigger.<id>.<field>}}` without the gate flag leaking through.
 *
 *  Outcomes:
 *    - step error          → treated like any sequential step error
 *                            (counter increments toward circuit breaker).
 *    - `should_run` absent  → defaulted to `false`; silent-skip. (Defensive
 *                            path — the validator shape-checks watchers
 *                            declaring `should_run: "boolean"` but refs
 *                            can produce surprises at runtime.)
 *    - any `should_run: false` → silent-skip, NO further trigger steps run.
 *    - all true            → proceed; `stores.trigger` stays populated. */
const runTriggerSteps = async (
  ctx: ExecutionContext,
): Promise<{ logs: StepLog[]; skipped: boolean; error?: ExecutionResult['errors'][number] }> => {
  const recipe = requireRecipe(ctx);
  const triggerSteps = recipe.trigger_steps ?? [];
  const logs: StepLog[] = [];
  const storesMut = ctx.stores as { trigger?: Record<string, unknown> };
  if (!storesMut.trigger) storesMut.trigger = Object.create(null) as Record<string, unknown>;

  for (const step of triggerSteps) {
    const log = await runStep(step, ctx);
    logs.push(log);

    if (log.error) {
      return { logs, skipped: false, error: log.error };
    }

    if (log.skipped) {
      // `skip_when` or D-101 account gate zeroed the step result; treat
      // as should_run=false (the author's skip_when expresses "don't
      // run this tick", which is exactly the silent-skip semantics).
      return { logs, skipped: true };
    }

    const out = log.result;
    const shouldRun = isTriggerShouldRun(out);
    const triggerStore = storesMut.trigger as Record<string, unknown>;
    setNamespaceValue(triggerStore, step.id, stripShouldRun(out));

    if (!shouldRun) {
      return { logs, skipped: true };
    }
  }

  return { logs, skipped: false };
};

const isTriggerShouldRun = (result: unknown): boolean => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const v = (result as Record<string, unknown>).should_run;
  return v === true;
};

const stripShouldRun = (result: unknown): unknown => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const { should_run: _, ...rest } = result as Record<string, unknown>;
  return rest;
};

const buildBudgetExceededError = (
  recipeId: string,
  budgetMs: number,
  elapsedMs: number,
): ExecutionResult['errors'][number] => ({
  error_id: `budget-${Date.now().toString(36)}`,
  code: 'RECIPE_BUDGET_EXCEEDED',
  message: `Recipe exceeded its ${budgetMs}ms budget (elapsed ${elapsedMs}ms).`,
  severity: 'error',
  source: {
    recipe_id: recipeId,
    step_id: null,
    ingredient_slug: null,
  },
  details: {
    budget_ms: budgetMs,
    elapsed_ms: elapsedMs,
  },
  timestamp: new Date().toISOString(),
  retryable: false,
});

/** Synthesize a RecipeError from a list of validation issues. Uses the
 *  first error as the primary message and lists the rest in details. */
const buildValidationError = (
  recipeId: string,
  issues: ValidationIssue[],
): ExecutionResult['errors'][number] => {
  const first = issues[0];
  const message = first
    ? `Recipe failed preflight validation: [${first.code}] ${first.path || '<root>'} — ${first.message}`
    : 'Recipe failed preflight validation';
  return {
    error_id: `val-${Date.now().toString(36)}`,
    code: 'RECIPE_VALIDATION_FAILED',
    message,
    severity: 'fatal',
    source: {
      recipe_id: recipeId,
      step_id: null,
      ingredient_slug: null,
    },
    details: {
      issue_count: issues.length,
      issues: issues.map((i) => ({
        code: i.code, path: i.path, message: i.message, severity: i.severity,
      })),
    },
    timestamp: new Date().toISOString(),
    retryable: false,
  };
};

/** Fire a progress event if the caller supplied a callback. Swallows
 *  callback exceptions so a bad UI listener can never break a run. */
export const fireProgress = (ctx: ExecutionContext, event: ProgressEvent): void => {
  if (!ctx.onProgress) return;
  try {
    ctx.onProgress(event);
  } catch {
    // Intentional: progress delivery is best-effort. A broken listener
    // is a UI bug, not an execution bug.
  }
};

/** Extract default value from a recipe variable (primitive shorthand or ValueHint object).
 *  Exported as `extractVariableDefault` (engine index) so the held-action
 *  idempotency identity can resolve a recipe's variable defaults the SAME way
 *  the engine does — the audit anchor's `config_snapshot` carries resolved
 *  defaults, so the dedup key must resolve them too or it never matches. */
export const extractDefault = (val: unknown): unknown => {
  if (Array.isArray(val)) return val[0];
  if (val != null && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (hasOwnSafe(obj, 'default')) return obj.default;
    // A plain object here is a ValueHint by the VariableDefault contract
    // (same `label` discriminant as ui-shared's isValueHint). A hint with
    // no `default` must NOT materialize the hint object itself into
    // config — an optional unset variable stays undefined so `is_null`
    // guards and `coalesce` fallbacks behave. Enum hints fall back to
    // their first option (the documented ValueHint contract).
    if (hasOwnSafe(obj, 'label') && typeof obj.label === 'string') {
      if (
        hasOwnSafe(obj, 'type') && obj.type === 'enum' &&
        hasOwnSafe(obj, 'options') && Array.isArray(obj.options)
      ) {
        return obj.options[0];
      }
      return undefined;
    }
  }
  return val;
};

/** Resolve all output render sections against the current stores. Shared by
 *  the progressive render_ready emitter and the final output resolution.
 *
 *  D-167 P4 Slice 3 — engine output guarantee. A `pii-protect` step swaps
 *  tagged PII for run-local alias tokens (`pii.Person1`, `m1@d1.invalid`) an LLM
 *  step can reason over; the matching `pii-restore` step swaps them back. If
 *  that restore is missing, skipped, or the run halted before it, the output
 *  would otherwise surface the aliases to the user. We restore each section's
 *  DATA against the run's still-live ledger right here, at the single helper
 *  behind BOTH user-facing renders — the progressive `render_ready` event and
 *  the final `ExecutionResult.output` — so neither can carry a run-local alias
 *  even when the recipe author forgot the restore step. Only `data` is restored:
 *  `type` / `label` come from the recipe's static output config (never a step
 *  output) so they can't hold an alias, and walking them would risk a false
 *  regex match. `restoreAll` short-circuits to the same value when the run never
 *  aliased anything, so the ~all recipes that don't use `pii-protect` pay
 *  nothing (no deep walk). This runs inside `executeRecipeInner`, before the
 *  run-local store is disposed (see `executeRecipe`). Mid-run egress that ACTS
 *  on aliased data (a notify / durable-write step) is deliberately NOT covered
 *  here — that is the `missing_pii_restore` validator warning's remaining job. */
const resolveOutputRender = (
  sections: { type: string; source: string; label?: string }[],
  stores: ExecutionContext['stores'],
  piiStore?: ExecutionContext['piiLedgerStore'],
) =>
  sections.map(section => {
    const data = resolveValue(`{{step.${section.source.replace('step.', '')}}}`, stores);
    return {
      type: section.type,
      data: piiStore ? piiStore.restoreAll(data) : data,
      ...(section.label ? { label: section.label } : {}),
    };
  });

const buildResult = (
  ctx: ExecutionContext, recipe_hash: string, success: boolean, steps: StepLog[],
  errors: ExecutionResult['errors'], start: number,
  render?: { type: string; data: unknown }[],
): ExecutionResult => ({
  recipe_id: requireRecipe(ctx).recipe_id,
  recipe_hash,
  success,
  // PII aliases were already restored when `render` was resolved (see
  // `resolveOutputRender`), so the output is alias-free by construction.
  output: renderOutput(render ?? []),
  steps,
  errors,
  duration_ms: Date.now() - start,
  validation_issues: [],
});

// ────────────────────────────────────────────────────────────────
// L2 step-cache integration
// ────────────────────────────────────────────────────────────────

/** TTL floor for pure-transform + guard step-cache entries. Pure
 *  functions have no data-freshness bound — the content-addressable
 *  key encodes every input that can affect the output, so a stale
 *  entry is literally impossible unless transform code itself changes
 *  (caller can clear the store on an engine-code upgrade to handle
 *  that). The only real bound on a pure entry's lifetime is storage
 *  pressure, handled by LRU. We set a generous floor so recipes with
 *  short recipe.ttl still get meaningful cache coverage. */
const STEP_CACHE_PURE_TTL_SECONDS = 24 * 60 * 60; // 24h

type StepCache = NonNullable<ExecutionContext['stepCache']>;
type CachePolicy = { seed: StepSeed; ttlSec: number; entryCategory: string | undefined };

/** Decide whether a step should hit the L2 cache and, if so, its
 *  effective TTL + broadcast category. Emits `skipped` status with a
 *  reason for every non-cacheable branch so observers see the decision
 *  even when we bypass. Returns null when the step must bypass. */
const decideCachePolicy = (
  seed: StepSeed | undefined,
  step: RecipeStep,
  ingredientPolicy: StepCache['ingredientPolicy'],
  recipeTtl: number,
  onStatus: StepCache['onStatus'],
  stepId: string,
): CachePolicy | null => {
  if (!seed) {
    onStatus?.('skipped', { step_id: stepId, reason: 'non-cacheable' });
    return null;
  }
  if (seed.cacheable) {
    // Transforms + guards are pure — content-addressable key captures
    // every input that affects output, so the only bound on lifetime
    // is storage pressure (LRU). 24h floor keeps short-ttl recipes
    // useful for replay.
    return {
      seed,
      ttlSec: Math.max(recipeTtl, STEP_CACHE_PURE_TTL_SECONDS),
      entryCategory: 'step',
    };
  }
  if (seed.ingredientCandidate) {
    const slug = (step as { ingredient?: string }).ingredient;
    if (!slug) {
      onStatus?.('skipped', { step_id: stepId, reason: 'no-manifest' });
      return null;
    }
    const policy = ingredientPolicy(slug);
    if (!policy?.cacheable) {
      onStatus?.('skipped', { step_id: stepId, reason: policy ? 'ingredient-policy' : 'no-manifest' });
      return null;
    }
    return {
      seed,
      ttlSec: Math.max(recipeTtl, policy.ttl_seconds),
      entryCategory: policy.category,
    };
  }
  onStatus?.('skipped', { step_id: stepId, reason: 'non-cacheable' });
  return null;
};

/** Replay a cache hit: populate `stores.step` so downstream refs
 *  resolve, bump LRU (sliding TTL for pure steps — the content-
 *  addressable key guarantees correctness; ingredient steps keep
 *  fixed expiry to match L1's freshness contract), and synthesize
 *  the StepLog the uncached path would have produced. */
const replayCachedEntry = async (
  ctx: ExecutionContext,
  store: StepCache['store'],
  cached: CacheEntry,
  key: string,
  seed: StepSeed,
  stepId: string,
  ttlSec: number,
  nowMs: number,
  onStatus: StepCache['onStatus'],
): Promise<StepLog> => {
  setNamespaceValue(ctx.stores.step as Record<string, unknown>, stepId, cached.value);
  // Cache-hit replays bypass runStep, so the per-ctx size counter
  // wouldn't see the write otherwise — leaving a recipe that's 100%
  // cache hits uncharged against the 10MB cap. Track it here too.
  trackContextSize(ctx, cached.value);
  const nextExpires = seed.cacheable ? nowMs + ttlSec * 1000 : undefined;
  if (store.touch) {
    await store.touch(key, {
      last_accessed_at: nowMs,
      ...(nextExpires !== undefined ? { expires_at: nextExpires } : {}),
    });
  } else {
    // Fallback — full set() path (broadcasts for peer-wrapped stores).
    await store.set({
      ...cached,
      last_accessed_at: nowMs,
      ...(nextExpires !== undefined ? { expires_at: nextExpires } : {}),
    });
  }
  onStatus?.('hit', { step_id: stepId, key, age_ms: nowMs - cached.created_at });
  return {
    id: stepId,
    type: seedKindToStepLogType(seed.kind),
    skipped: false,
    result: cached.value,
    error: null,
    duration_ms: 0,
  };
};

/** Persist a successful step result to the L2 store. Caller guarantees
 *  the step produced a real value (no error, not skipped, not null). */
const writeMissToCache = async (
  store: StepCache['store'],
  key: string,
  log: StepLog,
  seed: StepSeed,
  step: RecipeStep,
  recipeId: string,
  ttlSec: number,
  entryCategory: string | undefined,
  nowMs: number,
): Promise<void> => {
  await store.set({
    key,
    value: log.result,
    expires_at: nowMs + ttlSec * 1000,
    recipe_id: recipeId,
    ingredient_slug: seed.kind === 'ingredient'
      ? ((step as { ingredient?: string }).ingredient ?? `step:${seed.kind}`)
      : `step:${seed.kind}`,
    size_bytes: estimateSize(log.result),
    created_at: nowMs,
    last_accessed_at: nowMs,
    ...(entryCategory ? { category: entryCategory as 'data' | 'ai' | 'step' } : {}),
    risk_tier: 'read',
  });
};

/** Build the sequential-step executor with cache lookup + write.
 *
 *  Separated from the loop so the happy path stays in execute(); when
 *  ctx.stepCache is omitted, we skip all of this and use raw runStep.
 *
 *  The cache lookup/write is inlined here because it needs the full
 *  run context: on a cache hit we populate `ctx.stores.step[id]` (so
 *  downstream steps see the replayed value) and synthesize a StepLog
 *  (so the trace + error surface stay consistent with the uncached
 *  path). A generic step-runner wrapper could reach neither without a
 *  side-channel. */
const buildCachedStepRunner = async (
  ctx: ExecutionContext,
  steps: readonly RecipeStep[],
): Promise<(step: RecipeStep) => Promise<StepLog>> => {
  const recipe = requireRecipe(ctx);
  const { store, ingredientPolicy, onStatus, getIngredientVersion } = ctx.stepCache!;
  const seeds = await analyzeSteps([...steps], { getIngredientVersion });
  const seedById = new Map(seeds.filter((s) => s.id).map((s) => [s.id, s]));
  const recipe_ttl = recipe.ttl ?? 0;
  const recipe_id = recipe.recipe_id;

  const { computeStepCacheKey } = await import('./step-seed.js');
  const { resolveRef } = await import('@recued/contracts');

  return async (step: RecipeStep): Promise<StepLog> => {
    const stepId = (step as { id?: string }).id ?? '';

    // Step-level cache freshness (`BaseStep.cache`). L2 honours the same
    // `CacheFreshness` contract L1 (`withIngredientCache`) does:
    //   - `fresh`      → bypass L2 entirely: neither read nor write.
    //   - `any`        → replay a cached entry even past its TTL.
    //   - `acceptable` → (default) replay only an unexpired entry.
    const freshness = step.cache ?? 'acceptable';

    // `fresh` bypasses the cache before any lookup — matches L1 and the
    // `CacheFreshness` contract ("Cache is neither read nor written").
    if (freshness === 'fresh') {
      onStatus?.('skipped', { step_id: stepId, reason: 'fresh' });
      return runStep(step, ctx);
    }

    const policy = decideCachePolicy(
      seedById.get(stepId), step, ingredientPolicy, recipe_ttl, onStatus, stepId,
    );
    if (!policy) return runStep(step, ctx);

    // Content-addressable key — resolver walks live stores so refs
    // like `{{step.prev.field}}` read from steps that already ran.
    const resolver = {
      resolve: (ref: { ns: string; path: string }) =>
        resolveRef(`{{${ref.ns}.${ref.path}}}`, ctx.stores),
    };
    const key = await computeStepCacheKey(policy.seed, resolver);
    const nowMs = Date.now();
    const cached = await store.get(key);

    // `acceptable` replays only an unexpired entry; `any` replays a
    // cached entry regardless of TTL (progressive render — staleness is
    // acceptable, a later pass re-runs expired steps).
    if (cached && (cached.expires_at > nowMs || freshness === 'any')) {
      return replayCachedEntry(
        ctx, store, cached, key, policy.seed, stepId, policy.ttlSec, nowMs, onStatus,
      );
    }

    onStatus?.('miss', { step_id: stepId, key });
    const log = await runStep(step, ctx);
    if (!log.error && !log.skipped && log.result !== null && log.result !== undefined) {
      await writeMissToCache(
        store, key, log, policy.seed, step, recipe_id,
        policy.ttlSec, policy.entryCategory, nowMs,
      );
    }
    return log;
  };
};

const seedKindToStepLogType = (kind: string): StepLog['type'] =>
  kind === 'transform' || kind === 'ingredient' || kind === 'guard'
    ? kind
    : 'transform';
