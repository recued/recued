import type {
  AccessKind,
  Actor,
  CanonicalOpStep,
  EntityTouch,
  ExecutionSource,
  IngredientManifest,
  RecipeStep,
  StepMeta,
  StepOptions,
  PreflightApprovedTarget,
  ForeachCheckpointProgress,
  ForeachCheckpointResult,
} from '@recued/contracts';
import {
  cliFailureErrorCode,
  collectRefs,
  ERR,
  isCanonicalOpStep,
  isCatalogForm,
  isCliFailureDetail,
  isContainerPickDetail,
  isCreatePlanDetail,
  isPeerAnswerRequiredSignal,
  isPreflightRequiredSignal,
  isRef,
  hashForeachCheckpointSource,
  parseDataEntityRef,
  resolveDeep,
  resolveValue,
  preapprovalStepPath,
  recipeCodeForRpcRefusal,
  shouldLink,
  SLOT_CANCELLED_ERROR_CODE,
  stepType,
} from '@recued/contracts';
import { runCatalogOperation } from './catalog-gateway.js';
import { invokeGoverned, throwIfRunKilled } from './lane.js';
import type { CliFailureDetail, ContainerPickDetail, CreatePlanDetail, RecipeError, RecipeErrorCode } from '@recued/contracts';
import { getTransform } from '@recued/transforms';
import { estimateSize } from '@recued/cache';
import type { ExecutionContext, StepLog } from './types.js';
import { requireRecipe } from './require-recipe.js';
import { evaluateCondition } from './condition.js';
import { createTransformContext } from './context.js';
import {
  classifyKind,
  inferExternalCallHost,
  stepEmitsLinks,
  type StepTouchDescriptor,
} from '@recued/provenance';
import { prefetchSharedRefs } from './shared-prefetch.js';
import { isPrototypeSensitiveKey, setNamespaceValue } from './store-safety.js';
import { recipesEqual } from '@recued/recipes';

/** Execute a single recipe step. Returns a StepLog.
 *
 *  D-103 step-level `foreach`: when `step.foreach` is set, the step
 *  body runs once per item in the resolved array. `item` is injected
 *  into `ctx.stores.item` for the duration of each iteration, so
 *  `{{item.*}}` refs inside input/key templates resolve via the same
 *  sync pipeline everything else uses. Continue-on-error — per-item
 *  failures accumulate into the result array without aborting the
 *  step. Output is an array of per-iteration results
 *  `{ ok, result?, error? }`. */
export const runStep = async (step: RecipeStep, ctx: ExecutionContext): Promise<StepLog> => {
  const start = Date.now();
  const type = stepType(step as unknown as Record<string, unknown>) as StepLog['type'];
  const id = step.id;
  throwIfRunKilled(ctx);

  // Connection-agnostic op-steps are rewritten to a concrete catalog fetch +
  // projection at install (R1, `resolveConnectionAgnosticRecipe`). The engine has
  // no op→ingredient dispatch (`stepType` reports such a step as `'unknown'`, which
  // would otherwise be silently stored as `null`), so one reaching here means the
  // install-time rewrite was skipped — a bug. The install paths reject unresolved
  // op-steps (validator + marketplace safety net), so under R1 this is unreachable;
  // throw loudly rather than swallow it.
  if (isCanonicalOpStep(step)) {
    throw new Error(
      `canonical op-step '${id}' (op '${(step as CanonicalOpStep).op}') reached the engine unresolved — ` +
        'connection-agnostic recipes must be resolved to concrete bindings at install (R1 rewrite)',
    );
  }

  const foreachRef = (step as unknown as { foreach?: unknown }).foreach;
  if (foreachRef !== undefined && foreachRef !== null) {
    // ⛔⛔ A `skip_when` ON A FOREACH STEP MEANS ONE OF TWO THINGS, and which one
    // is decided by whether it mentions `{{item.*}}`.
    //
    //   per-ITEM  (`{{item.should_notify}} not_equal true`) — a filter inside
    //     the loop. 220 shipped recipes rely on it; it must stay per-iteration,
    //     and evaluating it here would read `item` unset and answer wrongly.
    //   per-STEP  (`{{step.has_companies}} equal false`) — "do not run this at
    //     all". This dispatched straight to the loop, the inner step KEPT the
    //     condition, and every iteration skipped — so the step yielded an ARRAY
    //     OF NULLS instead of being skipped. 53 shipped recipes are written
    //     this way.
    //
    // The array-of-nulls is the dangerous half: it is truthy, so a `coalesce`
    // between two mutually-exclusive foreach steps picks the one that was meant
    // to be skipped, and the page shows blanks with no error anywhere. Found by
    // driving `combined-balance` end to end.
    //
    // ⚠ Discriminating on the REF, not on a new field, because both shapes are
    // already in the corpus and neither author was wrong to write what they
    // wrote — the reading of each is unambiguous, only the behaviour was.
    const skip = step.skip_when;
    if (typeof skip === 'string' && skip.length > 0 && !ITEM_REF_IN_CONDITION.test(skip)
      && evaluateCondition(skip, ctx.stores)) {
      setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, null);
      return {
        id, type, skipped: true,
        skip_reason: `skip_when: ${skip}`,
        result: null, error: null, duration_ms: Date.now() - start,
      };
    }
    return runForeach(step, ctx, foreachRef, type, start);
  }

  // D-103: pre-fetch any `{{shared.*}}` / `{{data.shared.*}}` refs into
  // `stores.shared` / `stores.data.shared` so the sync resolver pipeline
  // can walk them. No-op when no resolvers are wired. Failures degrade
  // silently — missing keys surface as undefined via walkPath.
  if (ctx.sharedResolvers) {
    try {
      await prefetchSharedRefs(step, ctx.stores, ctx.sharedResolvers);
    } catch { /* best-effort pre-fetch */ }
  }

  // skip_when check
  if (step.skip_when && evaluateCondition(step.skip_when, ctx.stores)) {
    setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, null);
    return {
      id, type, skipped: true,
      skip_reason: `skip_when: ${step.skip_when}`,
      result: null, error: null, duration_ms: Date.now() - start,
    };
  }

  try {
    // `await` tolerates non-Promise values, so sync transforms pass
    // through unchanged. D-116 `wait` is the first async transform.
    const result = type === 'transform' ? await runTransform(step, ctx)
      : type === 'ingredient' ? await runIngredient(step, ctx)
      : type === 'guard' ? runGuard(step, ctx)
      : null;

    // A host may already have returned the killed result while a non-cancellable
    // provider/AI call drained. Its late value must never enter step state or
    // unlock a later side effect.
    throwIfRunKilled(ctx);

    setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, result);
    // ⛔ A `defaults` step ALSO publishes each field under its own name, so
    // `{{step.<field>}}` keeps resolving after N `default` steps fold into one.
    //
    // Step ids are an INTERFACE at three levels — refs inside recipes, ref
    // strings asserted in tests, and `step('<id>')` reads in the pack-audit
    // harnesses that execute a recipe and inspect intermediate outputs. Folding
    // without this broke 121 tests across 62 files; with it the fold is
    // invisible to all three. The step's own id still holds the whole object,
    // so `{{step.<id>.<field>}}` works and checkpoint capture
    // (`stores.step[s.id]`) is unaffected.
    //
    // Collision-free by construction: the field names ARE the step ids the fold
    // removed, and those were unique step ids already (verified 0 collisions
    // across the corpus).
    if ((step as { transform?: string }).transform === 'defaults' && result !== null && typeof result === 'object'
      && !Array.isArray(result)) {
      for (const [field, value] of Object.entries(result as Record<string, unknown>)) {
        setNamespaceValue(ctx.stores.step as Record<string, unknown>, field, value);
      }
    }
    trackContextSize(ctx, result);

    // fail_on check
    if (step.fail_on && evaluateCondition(step.fail_on, ctx.stores)) {
      // D-232 § 21 — a guard that says WHAT it is says so in `details.fail_kind`.
      // ⛔ The CODE stays `RECIPE_FAIL_ON_TRIGGERED` for every guard, deliberately:
      // that code is load-bearing across the corpus (`errorsContainCode`, failure
      // handlers, the D-159 surface), and re-coding a refusal would break readers
      // that have nothing to do with exchanges. The classification rides ALONGSIDE
      // it, so a consumer that knows to look finds it and every existing consumer
      // is unaffected.
      // ⚠ `fail_kind` is authorable but its type admits only `policy` / `config`
      // — never `unavailable`, the one value worth lying about. See StepFailureKind.
      const failKind = (step as { fail_kind?: string }).fail_kind;
      const error = makeError(
        ctx,
        id,
        'RECIPE_FAIL_ON_TRIGGERED',
        `fail_on triggered on step ${id}`,
        failKind === 'policy' || failKind === 'config' ? { fail_kind: failKind } : {},
      );
      return { id, type, skipped: false, result, error, duration_ms: Date.now() - start };
    }

    // D-120 Phase 3 — emit provenance links for successful side-effecting
    // ingredient steps. Skipped on foreach iterations (parent scan
    // carries causality), pure reads / transforms / guards
    // (non-causal), and recipes with `provenance: false`.
    if (type === 'ingredient') {
      maybeEmitLinks(step, id, ctx, result);
    }

    return { id, type, skipped: false, result, error: null, duration_ms: Date.now() - start };
  } catch (e) {
    // D-157 P1 slice 3 — a preflight pause signal must not be captured
    // as a step error. It is a control-flow signal raised by the
    // gateway wrapper around `ctx.ingredientExecutor` when the policy
    // matrix yields `'ask'`; the engine's step loop catches it and ends
    // the run with `awaiting_approval`. Re-throw so the signal reaches
    // that loop instead of landing in `StepLog.error`.
    if (isPreflightRequiredSignal(e)) throw e;
    // D-234 § 234.4 — same treatment, same reason. A peer-answer pause is a
    // CONTROL-FLOW SIGNAL, not a step failure. ⛔ WITHOUT THIS RE-THROW THE
    // FEATURE IS INERT AND LOOKS BROKEN: the signal lands in `StepLog.error`,
    // the step-loop never sees it, and the run FAILS with an opaque message
    // instead of pausing — a hold that presents as a crash.
    if (isPeerAnswerRequiredSignal(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    // D-181 §12 — preserve a long-op executor's structured kill telemetry into
    // the step error's `details` so the audit-anchor write can derive a display
    // category structurally (a stall-monitor SIGKILL throws a `heavy_op`-bearing
    // error from the cli `service` path). Only this carrier survives; no message
    // string-matching. Other thrown errors carry no `heavy_op` → details stay {}.
    const heavyOp =
      e !== null && typeof e === 'object' && 'heavy_op' in e
        ? (e as { heavy_op?: unknown }).heavy_op
        : undefined;
    // D-181 §7c — a gated call whose queued slot was dropped (`execution.cancel`
    // / kill-signal abort) rejects with `SLOT_CANCELLED_ERROR_CODE`. Preserve a
    // `slot_cancelled` marker into the step error details (same carrier pattern
    // as `heavy_op`) so the host can label the run `cancelled_before_dispatch`
    // from the engine outcome — no run-level registry marker. The code survives
    // here because `invokeGoverned` lets the `acquire` rejection propagate raw.
    const slotCancelled =
      e !== null && typeof e === 'object'
      && (e as { code?: unknown }).code === SLOT_CANCELLED_ERROR_CODE;
    // D-182 — a classified cli (local-binary) failure. The executor attaches a
    // `cli_failure` carrier (missing binary / ran-and-failed / timed-out — same
    // carrier pattern as `heavy_op`). Preserve it into `details`, code the step
    // from `reason` instead of the catch-all NETWORK_ERROR (which read to an agent
    // as a network problem), and name the failing op in `ingredient_slug`.
    const cliFailureRaw =
      e !== null && typeof e === 'object' && 'cli_failure' in e
        ? (e as { cli_failure?: unknown }).cli_failure
        : undefined;
    const cliFailure: CliFailureDetail | undefined = isCliFailureDetail(cliFailureRaw)
      ? cliFailureRaw
      : undefined;
    // D-192 Slice 6b — a work-entity CREATE whose vendor container dependency is
    // ambiguous rejects with a `container_pick` carrier (same carrier pattern as
    // `cli_failure`). Preserve it into `details.container_pick` and code the step
    // `CONTAINER_PICK_REQUIRED` (not the catch-all NETWORK_ERROR) so `handleExecute`
    // reads the choice set off the step error, raises the D-158 pick ask, and
    // surfaces a terminal `container_pick_required` instead of a silent failure.
    const containerPickRaw =
      e !== null && typeof e === 'object' && 'container_pick' in e
        ? (e as { container_pick?: unknown }).container_pick
        : undefined;
    const containerPick: ContainerPickDetail | undefined = isContainerPickDetail(containerPickRaw)
      ? containerPickRaw
      : undefined;
    // D-192 Slice 6c — a work-entity CREATE that DECIDED to create a named vendor
    // container rejects with a `create_plan` carrier (same carrier pattern as
    // `container_pick`). Preserve it into `details.create_plan` and code the step
    // `CREATE_PLAN_REQUIRED` so `handleExecute` reads the plan, raises ONE create-
    // plan confirm, and surfaces a terminal `create_plan_required`.
    const createPlanRaw =
      e !== null && typeof e === 'object' && 'create_plan' in e
        ? (e as { create_plan?: unknown }).create_plan
        : undefined;
    const createPlan: CreatePlanDetail | undefined = isCreatePlanDetail(createPlanRaw)
      ? createPlanRaw
      : undefined;
    // D-200 Slice 6i.9 — the LLM executor distinguishes an explicit provider
    // safety/refusal stop from an unavailable model or malformed response.
    // Preserve that one typed code and its bounded diagnostic through the
    // engine boundary; otherwise every refused D-200 draft becomes the false
    // NETWORK_ERROR story and the owner cannot distinguish the static fallback.
    const modelRefusalCandidate =
      e !== null && typeof e === 'object'
      && (e as { code?: unknown }).code === 'AI_MODEL_REFUSED';
    const modelRefusalDetailsRaw = modelRefusalCandidate && 'details' in e
      ? (e as { details?: unknown }).details
      : undefined;
    const modelRefusalDetails =
      modelRefusalDetailsRaw !== null
      && typeof modelRefusalDetailsRaw === 'object'
      && !Array.isArray(modelRefusalDetailsRaw)
        ? modelRefusalDetailsRaw as Record<string, unknown>
        : undefined;
    const localModelRefusalSlug = modelRefusalCandidate && type === 'ingredient'
      ? extractIngredientSlug(step, ctx)
      : '';
    const modelRefusalSlug =
      localModelRefusalSlug.length > 0
      && localModelRefusalSlug.length <= 128
        ? localModelRefusalSlug
        : undefined;
    const modelRefused = modelRefusalCandidate
      && (e as { retryable?: unknown }).retryable === false
      && modelRefusalDetails?.finish_reason === 'content_filter'
      && modelRefusalDetails?.slug === modelRefusalSlug;
    // An adapter's OWN typed code, when it names a real `RecipeErrorCode`.
    // Before this, the four carriers above were the only codes that survived the
    // step seam and EVERY other throw became the catch-all `NETWORK_ERROR` —
    // including `ACTION_DELIVERY_UNCERTAIN`, whose whole point is "the write may
    // have landed, verify before retrying". Erasing it rewrote the owner-facing
    // remedy from "check your CRM before retrying so you do not duplicate the
    // write" into `NETWORK_ERROR`'s "check your connection and try again" — the
    // exact double-write the code exists to prevent. 33 of the 39 codes adapters
    // throw are already `RecipeErrorCode` members; they were simply never read.
    //
    // ⚠ MEMBERSHIP IS REQUIRED, not cosmetic. `IngredientError.code` is typed
    // `string`, so a raw passthrough would let an arbitrary token escape into a
    // field typed as a closed union (6 thrown codes are outside it today —
    // `BAD_INPUT`, `UPSTREAM_ERROR`, `URL_REF_INVALID`, …). `ERR` is
    // `Record<RecipeErrorCode, ErrorSeverity>`, so its OWN keys are exactly the
    // union and the typechecker keeps them that way — deriving the test from it
    // cannot drift the way a hand-copied list would. `Object.hasOwn`, not `in`:
    // `in` would admit inherited keys and accept a code of `'toString'`.
    //
    // ⛔ NOT applied to transforms (they keep `TRANSFORM_ERROR`) and NOT to
    // `AI_MODEL_REFUSED`, which keeps its own branch above: D-200 honours that
    // code only with its bounded diagnostic attached, and a generic passthrough
    // would silently promote a bare `code` that failed that validation.
    //
    // ⛔ THE CODE ONLY — `details` stays dropped, deliberately. Adapter details
    // carry values: `MAIL_SEND_SELF_LOOP_TO` attaches `{ account_email,
    // offending }`, both real addresses. The four carriers above are bounded,
    // reviewed shapes; `IngredientError.details` is `Record<string, unknown>`
    // from 41 throw sites, so admitting it wholesale would push unreviewed PII
    // into audit rows and onto model-bound cards. A code is a closed vocabulary
    // and safe to render; its details are not.
    const adapterCodeRaw = type !== 'transform'
      && e !== null && typeof e === 'object'
      ? (e as { code?: unknown }).code
      : undefined;
    const adapterCode: RecipeErrorCode | undefined =
      typeof adapterCodeRaw === 'string'
      && adapterCodeRaw !== 'AI_MODEL_REFUSED'
      && Object.hasOwn(ERR, adapterCodeRaw)
        ? adapterCodeRaw as RecipeErrorCode
        // A server handler behind a kernel op refuses with an rpc code and,
        // most often, an HTTP-like status: the same refusal an adapter names
        // with a recipe code, never a network error (D-313; `rpc-refusal.ts`
        // says in what order the code and the status are read).
        : typeof adapterCodeRaw === 'string'
          ? recipeCodeForRpcRefusal(adapterCodeRaw, (e as { status?: unknown }).status)
          : undefined;
    const code: RecipeErrorCode = cliFailure
      ? cliFailureErrorCode(cliFailure.reason)
      : containerPick
        ? 'CONTAINER_PICK_REQUIRED'
        : createPlan
          ? 'CREATE_PLAN_REQUIRED'
          : modelRefused
            ? 'AI_MODEL_REFUSED'
            : type === 'transform'
              ? 'TRANSFORM_ERROR'
              : adapterCode ?? 'NETWORK_ERROR';
    const details: Record<string, unknown> = {
      ...(heavyOp !== undefined ? { heavy_op: heavyOp } : {}),
      ...(slotCancelled ? { slot_cancelled: true } : {}),
      ...(cliFailure ? { cli_failure: cliFailure } : {}),
      ...(containerPick ? { container_pick: containerPick } : {}),
      ...(createPlan ? { create_plan: createPlan } : {}),
      ...(modelRefused ? {
        model_refusal: {
          finish_reason: 'content_filter',
          ...(modelRefusalSlug !== undefined
            ? { ingredient_slug: modelRefusalSlug }
            : {}),
        },
      } : {}),
    };
    const error = makeError(
      ctx, id, code, msg,
      Object.keys(details).length > 0 ? details : undefined,
      cliFailure?.slug
        ?? (modelRefused ? modelRefusalSlug : undefined)
        ?? null,
    );
    setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, null);
    return { id, type, skipped: false, result: null, error, duration_ms: Date.now() - start };
  }
};

/** Iterate the step body over the resolved `foreach` array, collecting
 *  per-iteration results. The inner step runs with its `foreach` stripped
 *  so we don't recurse; `item` is placed on `ctx.stores.item` for each
 *  iteration and cleaned up at the end. */
const runForeach = async (
  step: RecipeStep,
  ctx: ExecutionContext,
  foreachRef: unknown,
  type: StepLog['type'],
  start: number,
): Promise<StepLog> => {
  const id = step.id;
  const resolved = resolveValue(foreachRef, ctx.stores);

  if (!Array.isArray(resolved)) {
    const error = makeError(ctx, id, 'TRANSFORM_ERROR',
      `foreach expected array, got ${resolved === null ? 'null' : typeof resolved}`);
    setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, null);
    return { id, type, skipped: false, result: null, error, duration_ms: Date.now() - start };
  }

  const innerStep: RecipeStep = { ...step } as RecipeStep;
  delete (innerStep as unknown as Record<string, unknown>).foreach;

  // Stash + restore any pre-existing `item` binding. Nested foreach
  // would shadow via save/restore.
  const storesMut = ctx.stores as unknown as Record<string, unknown>;
  const prevItem = storesMut.item;
  // Each entry echoes its source `item` so downstream steps can build
  // per-item envelopes (`map` over the foreach output pairing
  // `{{item.item.<field>}}` with `{{item.result.<field>}}`) — there is
  // no index-join transform, so without the echo an ingredient whose
  // output mapping drops its inputs (e.g. a search wrapper) loses the
  // association between what was asked and what came back.
  let results: ForeachCheckpointResult[] = [];
  let startIndex = 0;
  // ⛔ THE CHECKPOINT DESCRIBES ONE STEP: THE GATED ONE. `ctx.resumeFrom` stays
  // set for the rest of a resumed run (only a chunked gate consumes it, below),
  // so every foreach the run reaches AFTER the gated step also sees it. Reading
  // the progress here unconditionally made a LATER foreach compare itself
  // against the gated step's progress and refuse with
  // `checkpoint_foreach_progress_mismatch` — a resumed run that approved one
  // fan-out could never reach a second. A foreach that is not the gated step
  // never ran (the engine resumes AT the gated step), so it starts at zero
  // like any fresh step; the guards below apply to the gated step alone.
  const resumingThisStep = (ctx.executionPhase ?? 'sequential') === (ctx.resumeFrom?.execution_phase ?? 'sequential')
    && ctx.resumeFrom?.gated_step_id === id;
  const progress = resumingThisStep ? ctx.resumeFrom?.foreach_progress : undefined;
  if (resumingThisStep && progress === undefined) {
    // Pre-progress checkpoints cannot identify which items already crossed the
    // boundary. Starting again at index zero could repeat external effects;
    // fail closed and require a fresh run instead.
    const error = makeError(
      ctx,
      id,
      'RECIPE_VALIDATION_FAILED',
      `Checkpoint for foreach step '${id}' has no item progress — re-run the recipe.`,
      { reason: 'checkpoint_foreach_progress_missing' },
    );
    setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, null);
    return {
      id, type, skipped: false, result: null, error,
      duration_ms: Date.now() - start,
    };
  }
  if (progress !== undefined) {
    let sourceHash: string | undefined;
    try {
      sourceHash = hashForeachCheckpointSource(resolved);
    } catch {
      sourceHash = undefined;
    }
    let prefixMatches = progress.step_id === id
      && progress.source_length === resolved.length
      && sourceHash !== undefined
      && progress.source_hash === sourceHash
      && progress.next_index === progress.results.length
      && progress.next_index >= 0
      && progress.next_index < resolved.length;
    if (prefixMatches) {
      try {
        prefixMatches = progress.results.every((entry, index) =>
          recipesEqual(entry.item, resolved[index]));
      } catch {
        prefixMatches = false;
      }
    }
    if (!prefixMatches) {
      const error = makeError(
        ctx,
        id,
        'RECIPE_VALIDATION_FAILED',
        `Checkpoint foreach progress no longer matches step '${id}' — re-run the recipe.`,
        { reason: 'checkpoint_foreach_progress_mismatch' },
      );
      setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, null);
      return {
        id, type, skipped: false, result: null, error,
        duration_ms: Date.now() - start,
      };
    }
    results = structuredClone(progress.results);
    startIndex = progress.next_index;
  }

  // D-120 Phase 3 — bracket inner-iteration link emission. Inner
  // steps see depth > 0 in `maybeEmitLinks` and skip emission;
  // per-spec "foreach iteration over a source collection: link the
  // source scan, not each item." (The source-scan ref itself has no
  // entity_id — it's a collection root — so foreach loops emit zero
  // links by design.)
  enterForeach(ctx);
  try {
    for (let index = startIndex; index < resolved.length; index++) {
      const item = resolved[index];
      storesMut.item = item;
      const previousAddressing = ctx.preapprovalAddressing;
      if (previousAddressing) ctx.preapprovalAddressing = { ...previousAddressing,
        iteration_indices: [...previousAddressing.iteration_indices, index] };
      try {
        const log = await runStep(innerStep, ctx);
        if (log.error) {
          results.push({ ok: false, error: log.error, item });
        } else {
          results.push({
            ok: true,
            ...(log.skipped ? { skipped: true } : {}),
            result: log.result,
            item,
          });
        }
      } catch (e) {
        // D-157 P1 slice 3 — same as `runStep`'s outer catch: a
        // preflight pause signal mid-foreach must not be swallowed as
        // a per-iteration error; it has to reach the step loop. Skip
        // the `leaveForeach`/restore in `finally` is still correct —
        // the finally block runs on a re-throw too.
        if (isPreflightRequiredSignal(e) || isPeerAnswerRequiredSignal(e)) {
          const foreachProgress: ForeachCheckpointProgress = {
            step_id: id,
            next_index: index,
            source_length: resolved.length,
            source_hash: hashForeachCheckpointSource(resolved),
            results: structuredClone(results),
          };
          e.foreach_progress = foreachProgress;
          throw e;
        }
        results.push({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          item,
        });
      } finally {
        if (previousAddressing) ctx.preapprovalAddressing = previousAddressing;
      }
      // An ordinary foreach gate approves the remaining same-target aggregate,
      // so its resume marker remains available to later iterations. A chunked
      // gate is narrower: its request/byte bound was computed from THIS item.
      // Once that item returns (successfully, skipped, or failed), consume the
      // marker so the next item must be independently evaluated and, when the
      // policy still says `ask`, held under a new bounded receipt. Clearing the
      // whole marker is intentional: edits/grants/claims were approved for the
      // same item and must not leak forward either. Engine phase selection was
      // already fixed before this loop, and PII ledgers were hydrated at entry.
      if (
        resumingThisStep && ctx.resumeFrom?.gated_step_id === id
        && ctx.resumeFrom.egress_bound !== undefined
      ) {
        ctx.resumeFrom = undefined;
      }
    }
  } finally {
    leaveForeach(ctx);
    if (prevItem === undefined) delete storesMut.item;
    else storesMut.item = prevItem;
  }

  setNamespaceValue(ctx.stores.step as Record<string, unknown>, id, results);
  // Foreach output (now carrying per-iteration `item` echoes) lands on
  // step state like any other result — count it toward the context-size
  // budget the non-foreach path already tracks.
  trackContextSize(ctx, results);
  // ⛔ The tally rides on the step log, NOT in `errors[]`. Pushing a warn there
  // would give every partially-failing run an `error_category` in history
  // (`history-handler.ts` reads `errors[0].code` unconditionally) and print it
  // in console output — turning a silence bug into a noise bug. `success` and
  // `errors[]` keep meaning exactly what they meant.
  return {
    id,
    type,
    skipped: false,
    result: results,
    error: null,
    duration_ms: Date.now() - start,
    foreach: { items: results.length, failed: results.filter((r) => !r.ok).length },
  };
};

const runTransform = (step: RecipeStep, ctx: ExecutionContext): unknown => {
  const { id: _, transform: name, skip_when: __, fail_on: ___, ...params } = step as Record<string, unknown>;
  const fn = getTransform(name as string);
  if (!fn) throw new Error(`Unknown transform: ${name}`);
  const resolved = resolveTransformParams(params, name as string, ctx);
  return fn(resolved, createTransformContext(ctx.stores, {
    extendBudget: ctx.extendBudget,
    readEnrichmentRow: ctx.readEnrichmentRow,
    piiLedgerStore: ctx.piiLedgerStore,
  }));
};

/** Resolve params but preserve condition strings in to_checklist items and any/all conditions. */
const resolveTransformParams = (params: Record<string, unknown>, name: string, ctx: ExecutionContext): Record<string, unknown> => {
  if (name === 'to_checklist' && Array.isArray(params.items)) {
    return {
      ...resolveDeep(params, ctx.stores) as Record<string, unknown>,
      items: (params.items as Record<string, unknown>[]).map(item => ({
        ...resolveDeep(item, ctx.stores) as Record<string, unknown>,
        issue: item.issue, // preserve raw condition string
      })),
    };
  }
  if ((name === 'any' || name === 'all') && Array.isArray(params.conditions)) {
    return {
      ...resolveDeep(params, ctx.stores) as Record<string, unknown>,
      conditions: params.conditions, // preserve raw condition strings
    };
  }
  // `map` (over `array`) and `project` (over a single `object`) both rebind `item`
  // per record and resolve `{{item.*}}` inside their `expression` themselves. Defer
  // item refs in the EXPRESSION ONLY so the engine doesn't clobber them against the
  // unset `item` store (it still resolves config/step/… there). Every OTHER param
  // (`array`/`object`, `output_field`, `apply`/`field`) resolves normally — e.g. a
  // nested map's `array: '{{item.children}}'` must still resolve against an enclosing
  // `foreach` item, and `project`'s `object: '{{step.x__raw.result}}'` is a plain
  // step ref that MUST resolve here. Without this, item refs in the expression
  // collapse to undefined/'' outside a `foreach` — silently breaking projection maps.
  if ((name === 'map' || name === 'project') && params.expression !== undefined) {
    const { expression, ...rest } = params;
    return {
      ...(resolveDeep(rest, ctx.stores) as Record<string, unknown>),
      expression: resolveDeep(expression, ctx.stores, { deferItem: true }),
    };
  }
  return resolveDeep(params, ctx.stores) as Record<string, unknown>;
};

/** Does a condition read the per-iteration binding? Decides whether a
 *  `foreach` step's `skip_when` gates the STEP or each ITEM. */
const ITEM_REF_IN_CONDITION = /\{\{\s*item(?:\.|\s*\}\})/;

/** Resolve step.ingredient to a concrete slug. Handles the kernel
 *  `run-ingredient` pattern where the slug is itself a ref like
 *  `{{config.ingredient_slug}}`. Returns empty string on failure. */
const extractIngredientSlug = (step: RecipeStep, ctx: ExecutionContext): string => {
  const rawIngredient = (step as Record<string, unknown>).ingredient;
  if (typeof rawIngredient !== 'string') return '';
  if (isRef(rawIngredient)) {
    return String(resolveValue(rawIngredient, ctx.stores) ?? '');
  }
  return rawIngredient;
};

/** D-165 P0 — resolve a catalog-form step's connection binding to a
 *  record name. The spec puts `connection` at STEP level
 *  (`{ ingredient, connection, input }`); we accept `input.connection`
 *  as a fallback for the existing connection-adapter convention. The
 *  value is typically a `{{ref}}` (e.g. `{{config.github_connection}}`)
 *  resolved against the stores. Only the string form is supported in P0
 *  — the multi-connection object form (`connection: { slot: ref }`, spec
 *  § Compatibility) resolves to `''` (fail-closed → `no_connection_profile`
 *  deny) and is deferred to P1+. */
export const resolveCatalogConnection = (
  s: Record<string, unknown>,
  input: Record<string, unknown>,
  ctx: ExecutionContext,
): string => {
  const raw = s.connection ?? input.connection;
  if (raw === undefined || raw === null) return '';
  const resolved = resolveValue(raw, ctx.stores);
  return typeof resolved === 'string' ? resolved : '';
};

/** D-157 N.5 — the two top-level catalog-step structural keys the catalog
 *  gateway reads directly off `input` (NOT out of `input.args`):
 *  `operation` (`extractCatalogCall`) and `connection`
 *  (`resolveCatalogConnection`'s `input.connection` fallback). An override on
 *  either re-points the call target itself and must stay top-level; every
 *  other override key is an args-payload field and descends into `input.args`
 *  for a catalog-op step. `args` is handled separately (a wholesale
 *  replacement of the payload — kept top-level). */
const CATALOG_STRUCTURAL_OVERRIDE_KEYS = new Set(['operation', 'connection']);

/** Detect the N.18 decomposer's catalog-op step shape at merge time: the
 *  resolved step `input` carries a (string) `operation` selector AND an `args`
 *  payload that is a plain object — the `{ operation, args }` shape the catalog
 *  gateway dispatches `asRecord(input.args)` from. A plain (non-catalog) step,
 *  or a catalog step whose `args` is still an unresolved `{{ref}}` string /
 *  absent / an array, returns false and takes the flat merge. */
const isCatalogOpInputShape = (input: Record<string, unknown>): boolean =>
  typeof input.operation === 'string'
  && input.operation.length > 0
  && input.args !== null
  && typeof input.args === 'object'
  && !Array.isArray(input.args);

/** D-157 N.5 — apply the checkpoint-sourced, already-allowlist-validated
 *  `arg_overrides` over the GATED step's authored/prefilled `input`, producing
 *  a NEW object (never mutating the step's `input` literal).
 *
 *  - PLAIN step → shallow flat merge over `input` (today's behavior, unchanged
 *    and byte-identical for a no-override resume).
 *  - CATALOG-OP step (`{ operation, args:{…} }`) → the two structural keys
 *    (`operation` / `connection`) and a wholesale `args` replacement stay
 *    top-level; every other override key descends INTO a fresh `input.args`
 *    object, where the catalog gateway reads it. Without this nesting a
 *    content edit (`title` / `body` / `source_id`) lands flat beside
 *    `input.args` and the gateway silently ignores it.
 *
 *  Prototype-sensitive override keys (`__proto__` / `constructor` /
 *  `prototype`) are dropped at BOTH levels (defense in depth behind the
 *  write-side allowlist + `isCheckpoint` narrowing). */
export const mergeArgOverrides = (
  input: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...input };
  if (!isCatalogOpInputShape(input)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!isPrototypeSensitiveKey(key)) merged[key] = value;
    }
    return merged;
  }
  // Catalog-op step: split the overrides into structural (top-level) and
  // content (into `args`). A wholesale `args` override (the legacy whole-
  // payload form) REPLACES the authored payload and becomes the base the
  // content keys then merge over; otherwise the authored `args` is cloned so
  // the step's payload literal is never mutated across re-runs.
  const wholesaleArgs = overrides.args;
  const mergedArgs: Record<string, unknown> =
    wholesaleArgs !== null && typeof wholesaleArgs === 'object' && !Array.isArray(wholesaleArgs)
      ? { ...(wholesaleArgs as Record<string, unknown>) }
      : { ...(input.args as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) {
    if (isPrototypeSensitiveKey(key)) continue;
    if (key === 'args') continue; // already folded into the args base above
    if (CATALOG_STRUCTURAL_OVERRIDE_KEYS.has(key)) {
      merged[key] = value;
    } else {
      mergedArgs[key] = value;
    }
  }
  merged.args = mergedArgs;
  return merged;
};

const runIngredient = async (step: RecipeStep, ctx: ExecutionContext): Promise<unknown> => {
  const s = step as Record<string, unknown>;
  const ingredientSlug = extractIngredientSlug(step, ctx);

  // Pass raw input — resolution normally happens in the dispatch layer
  // after merging with manifest defaults (so manifest refs get resolved
  // too). One exception: when the whole `step.input` field is a ref
  // (e.g. the kernel `run-ingredient` recipe does `"input": "{{config.input}}"`
  // to forward an opaque object supplied as a recipe variable), resolve
  // it eagerly here so the dispatch layer sees the real object to merge
  // with manifest defaults. Non-object resolution falls back to `{}`.
  const rawInput = s.input;
  let input: Record<string, unknown>;
  if (typeof rawInput === 'string' && isRef(rawInput)) {
    const resolved = resolveValue(rawInput, ctx.stores);
    input = (resolved && typeof resolved === 'object' && !Array.isArray(resolved))
      ? (resolved as Record<string, unknown>)
      : {};
  } else {
    input = (rawInput as Record<string, unknown>) ?? {};
  }

  // D-173 N.5 — edit-aware resume merge. When the run is resuming from a
  // preflight checkpoint that carried `arg_overrides` (the admin-only
  // `reception.inbox.approve` rpc approved-with-edits), shallow-merge the
  // overrides over THIS step's authored/prefilled args — but ONLY for the
  // GATED STEP (`s.id === ctx.resumeFrom.gated_step_id`). Every other step
  // on the resume path is left byte-identical to today's binary-gate
  // resume, and a resume with no `arg_overrides` at all is untouched.
  //
  // Boundary (D-173 N.5 MUST). `ctx.resumeFrom.arg_overrides` is the ONLY
  // source read here; the host populates it EXCLUSIVELY from the consumed
  // checkpoint (`buildResumeInputs` off `checkpoint.arg_overrides`), never
  // from caller / channel / context input — so no non-inbox path can reach
  // this merge. The override values were already allowlist-validated by
  // `reception.inbox.approve` against the operation's `ArgEditSchema`
  // (N.6), so the merge is wholesale (no re-allowlisting here).
  //
  // The merge produces a NEW object — it never mutates the step's authored
  // `input` literal (which would corrupt the recipe definition across
  // re-runs). Override keys win over authored keys; `__proto__` /
  // `constructor` / `prototype` override keys are dropped (a corrupted /
  // hostile on-disk checkpoint can never inject prototype pollution into
  // the dispatched payload — defense in depth behind isCheckpoint's
  // narrowing). Override values are concrete (the user typed them at
  // approve time), so they are NOT re-resolved as `{{ref}}`s downstream.
  //
  // D-157 N.5 (args-aware) — a CATALOG-OP step nests its operation's
  // editable args INSIDE `input.args` (the N.18 decomposer compiles the
  // gated step as `{ operation, args }`, and the catalog gateway dispatches
  // `asRecord(input.args)`). The inbox's `reception.inbox.approve` writes
  // the validated edits as FLAT allowlist keys (`title` / `body` /
  // `source_id` / …) — the args payload's OWN field names, not wrapped in an
  // `args` envelope. So for a catalog-op step the overrides are merged INTO
  // `input.args` (a fresh args object), where the gateway reads them, rather
  // than landing flat BESIDE `input.args` (where the gateway would ignore
  // them). The two top-level catalog-structural keys the gateway reads off
  // `input` directly — `operation` (`extractCatalogCall`) and `connection`
  // (`resolveCatalogConnection`'s `input.connection` fallback) — plus a
  // wholesale `args` replacement stay TOP-LEVEL; only the remaining
  // (content) override keys descend into `args`. A PLAIN (non-catalog) step
  // keeps the flat merge unchanged. This changes ONLY the nesting of where
  // an allowlisted override lands — never the Boundary: overrides are still
  // read solely from `resumeFrom.arg_overrides` (checkpoint-sourced),
  // already allowlist-validated, gated-step-only, prototype-safe, and a
  // no-override resume is byte-identical.
  const resumeFrom = (ctx.executionPhase ?? 'sequential') === (ctx.resumeFrom?.execution_phase ?? 'sequential')
    ? ctx.resumeFrom : undefined;
  // D-173 capstone — resume-time prefill re-seed (the gated step's resolved
  // input). The N.18-compiled gated step authors `input.args` as the STRING ref
  // `'{{context.event.payload}}'`. On a FRESH fire that resolves from the
  // reactive trigger's `context.event`; but a preflight resume re-instantiates
  // the run with NO `context.event` (the resumer feeds back `config_snapshot` /
  // `execution_source` provenance, never the trigger payload), so the ref would
  // resolve to undefined and the projection payload would vanish. The engine
  // captured the RESOLVED projection args into the held checkpoint's `step_state`
  // under this gated step id at hold time (the catalog branch below), and the
  // host re-seeds `stores.step` from `checkpoint.step_state` before resume — so
  // here we substitute that captured prefill for the ref-shaped `args`. This
  // runs ONLY for the GATED STEP on resume, ONLY when `args` is a ref (a literal
  // payload is left untouched), and reads EXCLUSIVELY from the checkpoint-seeded
  // `stores.step` — never from caller / channel input — so it is a faithful
  // re-seed of what the run already resolved, not a new override conduit. With
  // `input.args` now a concrete object, the N.5 args-aware merge nests the
  // admin's per-key edits INTO it (`isCatalogOpInputShape` → catalog-op path).
  if (
    typeof s.id === 'string'
    && s.id === resumeFrom?.gated_step_id
    && input.args !== undefined
    && typeof input.args === 'string'
    && isRef(input.args)
  ) {
    const captured = (ctx.stores.step as Record<string, unknown>)[s.id];
    const capturedInput =
      captured && typeof captured === 'object' && !Array.isArray(captured)
        ? (captured as { input?: unknown }).input
        : undefined;
    if (capturedInput && typeof capturedInput === 'object' && !Array.isArray(capturedInput)) {
      input = { ...input, args: capturedInput };
    }
  }
  if (
    resumeFrom?.arg_overrides !== undefined
    && typeof s.id === 'string'
    && s.id === resumeFrom.gated_step_id
  ) {
    input = mergeArgOverrides(input, resumeFrom.arg_overrides);
  }

  const output = s.output as Record<string, string> | undefined;
  const piiFields = s.pii_fields as string[] | undefined;
  const stepOptions: StepOptions | undefined = ((): StepOptions | undefined => {
    const options: StepOptions = ctx.preapprovalAddressing ? { cache: 'fresh' }
      : s.cache !== undefined ? { cache: s.cache as 'fresh' | 'acceptable' | 'any' } : {};
    // `pages: "all"` rides beside `cache` to the gateway, which reads a Records
    // search page by page (`StepPages`). Validated authoring-side; only "all".
    if (s.pages === 'all') options.pages = 'all';
    return Object.keys(options).length > 0 ? options : undefined;
  })();
  const stepMeta = buildStepMeta(
    s,
    requireRecipe(ctx).recipe_id,
    ctx.trigger_source,
    resumeFrom?.gated_step_id,
    resumeFrom?.approved_target,
    ctx.actor,
    ctx.contract_id,
    resumeFrom?.session_grant,
    resumeFrom?.batch_claim,
    ctx.run_id,
    ctx.work_entity_write_preadmitted_step_id,
    ctx.execution_source,
  );
  if (ctx.governing_recipe_grant !== undefined) stepMeta.governing_recipe_grant = ctx.governing_recipe_grant;
  if (ctx.entry_tool_name !== undefined) stepMeta.entry_tool_name = ctx.entry_tool_name;
  if (ctx.preapprovalAddressing) stepMeta.invocation_path = preapprovalStepPath(
    ctx.preapprovalAddressing.recipe_path, ctx.preapprovalAddressing.phase,
    stepMeta.step_id, ctx.preapprovalAddressing.iteration_indices);

  // D-165 P0 — catalog-form routing. When the resolved manifest carries a
  // non-empty `operations` map, the call dispatches through the D-157
  // gateway with operation-level policy (effective risk derived from the
  // catalog operation, not the wrapper's static `risk_tier`) + per-call
  // audit, instead of the plain adapter path below. Simple-form
  // ingredients fall through unchanged. Requires `ctx.manifestGetter`;
  // when unwired (it's optional), every ingredient is treated as
  // simple-form — backward compatible.
  const requestedVersion = stepIngredientVersion(step);
  const manifest = ctx.manifestGetter?.(ingredientSlug, requestedVersion);
  if (ctx.manifestGetter && requestedVersion !== undefined && !manifest) {
    throw new Error(
      `Ingredient '${ingredientSlug}' version ${requestedVersion} not found in registry`,
    );
  }
  if (isCatalogForm(manifest) && manifest) {
    // D-173 capstone — resolve the catalog op's `args` payload BEFORE the
    // gateway reads it. The N.18 decomposer compiles the gated step as
    // `input: { operation, args: '{{context.event.payload}}' }` — a STRING
    // `{{ref}}`, not a literal object. The catalog gateway reads
    // `asRecord(input.args)` directly (it does NOT resolve refs — refs are a
    // dispatch-layer concern), so a ref-shaped `args` would coerce to `{}` and
    // the projection payload (title/body/…) would be silently dropped at the
    // gateway — on a fresh dispatch AND on every resume. Resolving here makes
    // `input.args` the concrete payload object the gateway dispatches and the
    // N.5 args-aware merge nests edits into (`isCatalogOpInputShape` now sees an
    // object). A literal-object `args` (the simple-form / pre-resolved case)
    // round-trips unchanged through `resolveDeep`; `operation` / `connection`
    // are read off `input` directly and left untouched. The wholesale
    // `arg_overrides.args` an inbox approve writes was already merged over
    // `input` above, so its concrete object wins and resolveDeep is a no-op on
    // it (the values are user-typed literals, not refs).
    // Resolve the catalog op's `args` payload BEFORE the gateway reads it,
    // whether it is a STRING `{{ref}}` (the N.18 decomposer's
    // `'{{context.event.payload}}'` form) OR a literal OBJECT whose values are
    // refs (a hand-authored op step like `{ file_id: '{{step.pick.id}}' }`).
    // `resolveDeep` recurses object values (resolving inner refs, preserving
    // type) and is a no-op on a concrete object with no refs — so a wholesale
    // `arg_overrides.args` of user-typed literals round-trips unchanged. Without
    // resolving the object case, every ref VALUE in an authored `args` object
    // reached the adapter as a literal `{{…}}` string (Codex review).
    const resolvedInput =
      input.args !== undefined
        ? { ...input, args: resolveDeep(input.args, ctx.stores) }
        : input;
    const connectionName = resolveCatalogConnection(s, resolvedInput, ctx);
    // D-173 capstone — capture the resolved projection `args` into the gated
    // step's `step.*` snapshot so a HOLD's checkpoint carries the prefill. The
    // gate throws `PreflightRequiredSignal` BEFORE the step output is stored
    // (line ~86), and the resolved `args` source (`context.event.payload`) is
    // NOT re-seeded on resume — so without this capture the held checkpoint's
    // `step_state` would have no record of what the visitor submitted, leaving
    // the inbox's `item.args` empty and approve with no prefill to union with
    // the user's edits. Recording the resolved projection args under the gated
    // step id (as `{ input: <args> }` — the shape `defaultResolveInboxSource`
    // reads) makes the inbox prefill correct; on resume the gated step re-runs
    // and overwrites this transient capture with its real result.
    try {
      return await runCatalogOperation(
        ctx, manifest, ingredientSlug, resolvedInput, connectionName, output, stepOptions, stepMeta,
      );
    } catch (e) {
      if (isPreflightRequiredSignal(e) && typeof s.id === 'string') {
        const resolvedArgs =
          resolvedInput.args && typeof resolvedInput.args === 'object'
            && !Array.isArray(resolvedInput.args)
            ? (resolvedInput.args as Record<string, unknown>)
            : {};
        setNamespaceValue(
          ctx.stores.step as Record<string, unknown>,
          s.id,
          { input: resolvedArgs },
        );
      }
      throw e;
    }
  }

  // ── Simple-form (non-catalog) dispatch — `invokeGoverned`. PERMANENT, not
  //    "legacy to delete" (D-182 §10.4's "delete the ingredient: resolution
  //    branch" premise was corrected — see the spec note). This branch is the
  //    execution engine for EVERY kernel op: `core.ai.*` / `core.mail.*` /
  //    `core.notification.*` / `core.storage.*` lower to kernel `IngredientStep`s
  //    whose manifests carry NO `operations` map, so they land here (the
  //    catalog-form branch above is Tier-P pack ops only). It is also the dynamic
  //    target of the kernel `run-ingredient` recipe — itself a permanent kernel
  //    primitive: it backs the ingredient-keyed MCP/door tool catalog (one tool
  //    per installed ingredient) via a `{{config.ingredient_slug}}` ref that
  //    cannot be a static op-step. `runIngredient` as a whole is also the lowering
  //    target for ALL op-steps (`lowerOpStepRecipe` → ingredient-form). So neither
  //    this branch nor the function is removable.
  // Auto hash_replace → ingredient → hash_restore when pii_fields is set.
  // Only meaningful on AI ingredients — but we apply unconditionally here
  // (non-AI ingredients just pass through hashed values, which is harmless).
  if (Array.isArray(piiFields) && piiFields.length > 0) {
    const hashReplace = getTransform('hash_replace');
    const hashRestore = getTransform('hash_restore');
    if (hashReplace && hashRestore) {
      const tctx = createTransformContext(ctx.stores, {
    extendBudget: ctx.extendBudget,
    readEnrichmentRow: ctx.readEnrichmentRow,
    piiLedgerStore: ctx.piiLedgerStore,
  });
      const replaced = hashReplace({ data: input, fields: piiFields }, tctx) as {
        data: Record<string, unknown>; mapping: Record<string, string>;
      };
      input = replaced.data;
      const result = await invokeGoverned(ctx, ingredientSlug, input, output, stepOptions, stepMeta);
      return hashRestore({ data: result, mapping: replaced.mapping }, tctx);
    }
  }

  // D-173 capstone, SECOND HALF — the same gated-args capture the catalog-form
  // branch does above, for the simple-form branch.
  //
  // ⛔ Its absence was NOT cosmetic, and it was the MAJORITY path: every kernel
  // op lowers here (their manifests carry no `operations` map), so a held
  // kernel op left `step_state[gated_step_id]` absent entirely and
  // `defaultResolveInboxSource` — which reads exactly that to build the inbox
  // prefill — saw `{}`. The sharpest symptom: `d-192-e3`'s held commitment
  // proposal declares `counterparty_contact_id` / `statement` / `promised_for_at`
  // on its EDITABLE allowlist, so the owner was offered edit fields for values
  // the form could not show them.
  //
  // 🔑 Surfacing these to the owner is settled, not assumed: `InboxItem.args`
  // is contracted as *"concrete values — what the held op will dispatch"*, and
  // `InboxItem.preview` is the field carrying the I-3 redaction obligation.
  // The owner ruled the same way for the same reason — for a custom intake
  // there is no way to know in advance which fields someone needs in order to
  // approve, so the substrate lays them out rather than guessing.
  try {
    return await invokeGoverned(ctx, ingredientSlug, input, output, stepOptions, stepMeta);
  } catch (e) {
    // ⛔ THREE GUARDS, each learned by breaking something:
    //
    // 1. NOT inside a `foreach`. Every iteration's inner `runStep` writes to
    //    `step.<same id>`, so a capture here would clobber the last-completed
    //    iteration's result that the pause path documents as its observed
    //    artifact — and "which iteration's input?" has no answer. A gated step
    //    needing a prefill is never a fan-out.
    // 2. RESOLVE first. Object-shaped `input` reaches this branch RAW (the
    //    dispatch layer resolves it), so capturing verbatim would put literal
    //    `{{item}}` / `{{step.x}}` strings into the inbox prefill — the owner
    //    would review templates instead of values. `resolveDeep` is a no-op on
    //    a concrete object, exactly as in the catalog branch.
    // 3. Only record something worth recording. A gated step with no resolvable
    //    input has no prefill to offer, and stamping `{ input: {} }` would add
    //    a key carrying no information — churn on every inputless gate, and a
    //    reader could mistake the empty object for "the args were empty"
    //    rather than "there were none". Absent stays absent.
    if (
      isPreflightRequiredSignal(e)
      && typeof s.id === 'string'
      && !isInsideForeach(ctx)
    ) {
      const resolved = resolveDeep(input, ctx.stores);
      const heldInput =
        resolved && typeof resolved === 'object' && !Array.isArray(resolved)
          ? (resolved as Record<string, unknown>)
          : {};
      if (Object.keys(heldInput).length > 0) {
        setNamespaceValue(
          ctx.stores.step as Record<string, unknown>,
          s.id,
          { input: heldInput },
        );
      }
    }
    throw e;
  }
};

/** Build the D-113 StepMeta envelope from a step's raw fields. The
 *  approval wrapper consumes `step_id` + `timeout_ms` + `on_timeout` +
 *  `prompt` when running in gossip mode; other wrappers forward it
 *  unchanged. Unrecognised or malformed fields are dropped silently —
 *  the wrapper applies its own defaults.
 *
 *  D-127 follow-on — `recipe_id` is sourced from
 *  `ExecutionContext.recipe.recipe_id` and threaded so kernel storage
 *  adapters that emit per-call audit rows (`mail_send`) can attribute
 *  back to the originating recipe + step. Empty string is treated as
 *  absent so direct-rpc callers (no engine context) keep producing
 *  audit rows without recipe / step ids. */
const buildStepMeta = (
  s: Record<string, unknown>,
  recipe_id: string,
  trigger_source?: string,
  resumed_gated_step_id?: string,
  resumed_approved_target?: PreflightApprovedTarget,
  actor?: Actor,
  contract_id?: string,
  resumed_session_grant?: {
    ttl_ms: number;
    max_uses: number;
    risk_tier: string;
    grant_mode?: string;
  },
  resumed_batch_claim?: { contract_id: string; member_id: string },
  run_id?: string,
  work_entity_write_preadmitted_step_id?: string,
  execution_source?: ExecutionSource,
): StepMeta => {
  const out: StepMeta = { step_id: typeof s.id === 'string' ? s.id : '' };
  if (typeof recipe_id === 'string' && recipe_id.length > 0) {
    out.recipe_id = recipe_id;
  }
  // D-181 slice 4 — forward the run's anchor id so the cli executor can register
  // its subprocess SIGKILL handle keyed by run for the owner's `execution.kill`.
  if (typeof run_id === 'string' && run_id.length > 0) {
    out.run_id = run_id;
  }
  if (typeof s.timeout_ms === 'number' && Number.isFinite(s.timeout_ms) && s.timeout_ms > 0) {
    out.timeout_ms = s.timeout_ms;
  }
  if (s.on_timeout === 'fail' || s.on_timeout === 'approve' || s.on_timeout === 'reject') {
    out.on_timeout = s.on_timeout;
  }
  if (typeof s.prompt === 'string' && s.prompt.length > 0) {
    out.prompt = s.prompt;
  }
  // D-136 P7.E — surface the engine's recorded trigger_source so kernel
  // storage adapters reading the enrichment substrate (e.g.
  // `enrichment-list`) can apply MCP-trigger policy gates without
  // widening their own contracts.
  if (typeof trigger_source === 'string' && trigger_source.length > 0) {
    out.trigger_source = trigger_source;
  }
  // D-161 P1 — forward the run's actor + contract_id so kernel
  // write-handlers (`enrichment-upsert` / `annotation-create` / `link-create`)
  // can stamp the `origin_actor` provenance facet propagated from the
  // run's `ExecutionSource` (I-6). Mirrors `trigger_source` above.
  if (typeof actor === 'string' && actor.length > 0) {
    out.actor = actor;
  }
  if (typeof contract_id === 'string' && contract_id.length > 0) {
    out.contract_id = contract_id;
  }
  // D-192 baseline-admission (S2) — forward the run's FULL execution source so the
  // kernel work-entity create adapter can compute the actor-aware contract-grant
  // admission (`opAdmissionGate.isOpGranted` needs the channel too, not just
  // actor+contract_id). Propagated verbatim; `withCreateOrigin` re-sets it from
  // here after stripping any recipe-supplied value.
  if (execution_source !== undefined) {
    out.execution_source = execution_source;
  }
  // D-192 6c.2c — mark THIS step as pre-admitted iff it is the exact step whose
  // create the create-plan confirm approved (`ctx.work_entity_write_preadmitted_
  // step_id`, the step that raised `create_plan_required`). Per-step, not run-wide:
  // a second `ask`-create elsewhere in the replayed recipe never inherits the
  // admission. Engine-set from `ctx` (never recipe JSON) → unforgeable.
  if (
    typeof work_entity_write_preadmitted_step_id === 'string'
    && work_entity_write_preadmitted_step_id.length > 0
    && typeof s.id === 'string'
    && s.id === work_entity_write_preadmitted_step_id
  ) {
    out.work_entity_write_preadmitted = true;
  }
  // D-157 P1 slice 4 — mark the gated step on resume so the gateway's
  // per-call admission probe admits a fresh `'ask'` verdict for THIS
  // boundary-crossing call (the approval the user just granted). Set
  // strictly when `ctx.resumeFrom.gated_step_id` matches this step's
  // id; absent on every other step (including the gated step on a
  // *fresh* run). Narrow by design — does NOT bypass `'deny'`
  // verdicts; a policy mutated between pause and resume that now
  // hard-denies the same tool still blocks (TR-5 spec semantics).
  if (
    typeof resumed_gated_step_id === 'string'
    && resumed_gated_step_id.length > 0
    && typeof s.id === 'string'
    && s.id === resumed_gated_step_id
  ) {
    out.preflight_admitted = true;
    // D-165 follow-on (op-identity binding) — thread the approved identity
    // onto the gated step so the catalog gate honors `preflight_admitted`
    // only when the re-resolved (ingredient, operation, connection) matches
    // it. Absent ⇒ the catalog gate re-asks (fail closed) rather than
    // trusting the position alone.
    if (resumed_approved_target !== undefined) {
      out.preflight_approved_target = resumed_approved_target;
    }
    // D-177 P3 — thread the `allow_session` answer's mint instruction onto
    // the gated step (and only the gated step) so the commit Gateway mints
    // a session grant from the resume dispatch's own envelope (D9). Absent
    // on a plain-approve resume — the marker exists exactly when the human
    // chose "Allow this session" (the resumer is the sole writer; N.5).
    if (resumed_session_grant !== undefined) {
      out.preflight_session_grant = resumed_session_grant;
    }
    // D-177 P5a — thread the batched approve's member-claim instruction
    // onto the gated step (and only the gated step) so the commit Gateway
    // atomically claims the named `grant_mode: 'batch'` member at the
    // proceed point (N.10/N.4 — the claim is the consumption). Absent on
    // every non-batch resume; the batch answer flow is the sole writer.
    if (resumed_batch_claim !== undefined) {
      out.preflight_batch_claim = resumed_batch_claim;
    }
  }
  return out;
};

const runGuard = (step: RecipeStep, ctx: ExecutionContext): null => {
  const s = step as Record<string, unknown>;
  if (evaluateCondition(s.guard as string, ctx.stores)) {
    throw Object.assign(new Error('Guard triggered'), { code: 'RECIPE_GUARD_TRIGGERED' });
  }
  return null;
};

// Raised 10MB -> 50MB (2026-08-24, owner decision) for large-job headroom.
// ⚠ CONTEXT FOR WHOEVER TOUCHES THIS NEXT: the run that motivated the change
// was hitting the cap for the WRONG reason — it pulled a 563KB CSV inline and
// retained the text plus the parsed rows plus six derived copies, which is
// exactly the route `core.storage.csv.filter` / `file-persist` / `file-put-ref`
// exist to replace ("the source bytes never enter recipe step state").
// A recipe that keeps bytes out of step state does not need this headroom.
// So treat a run approaching even the OLD 10MB as a shape smell first, and only
// then as a limit — raising the ceiling does not make the retained-copies
// pattern correct, it just defers where it fails.
export const MAX_CONTEXT_BYTES = 50 * 1024 * 1024; // 50MB

/** Per-recipe cumulative byte count of `ctx.stores.step` results.
 *  Prior implementation re-serialized the whole step store after every
 *  write, paying O(cumulative-size) per step → O(N²) total. This is
 *  O(new-result-size) per step instead. WeakMap keys by ExecutionContext
 *  so concurrent recipes don't share state and entries GC with the ctx.
 *
 *  Minor under-protection edge case: when a step stores a result that
 *  checkContextSize-accepts, then errors in fail_on and nulls the value,
 *  we don't deduct — so the counter slightly over-counts. That only
 *  makes the cap fire *earlier*, which is the safe direction for a
 *  pathological-protection guard. */
const contextSizeByCtx = new WeakMap<ExecutionContext, number>();

/** Accumulate a newly-stored step result's byte size against the
 *  recipe-level running total and throw CONTEXT_SIZE_EXCEEDED if
 *  `MAX_CONTEXT_BYTES` is breached. Called after every
 *  `ctx.stores.step[id] = result` assignment (both sequential and prefetch).
 *  Null results are skipped — they contribute ~0 bytes and skipping keeps the
 *  counter stable when a step is nulled on error.
 *
 *  ⛔ The thrown message DERIVES its ceiling from the constant. It read a
 *  hardcoded `(max 10MB)` from the 2026-08-24 raise to 50MB until 2026-09-18,
 *  so a run that tripped the REAL cap reported a number contradicting the cap
 *  it had just hit — and that message, quoted verbatim, is what four other
 *  sites cited as evidence the cap was 10MB. A drifting literal in an error
 *  string does not just misinform the reader in front of it; it becomes the
 *  source everyone else copies. */
export const trackContextSize = (ctx: ExecutionContext, result: unknown): void => {
  if (result == null) return;
  const next = (contextSizeByCtx.get(ctx) ?? 0) + estimateSize(result);
  contextSizeByCtx.set(ctx, next);
  if (next > MAX_CONTEXT_BYTES) {
    throw Object.assign(
      new Error(`step context is ${(next / 1024 / 1024).toFixed(1)}MB `
        + `(max ${MAX_CONTEXT_BYTES / 1024 / 1024}MB)`),
      { code: 'CONTEXT_SIZE_EXCEEDED' },
    );
  }
};

const makeError = (
  ctx: ExecutionContext,
  stepId: string,
  code: RecipeErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  // D-182 — the failing ingredient/op slug. Defaults `null` (the historical value
  // for every non-cli path); the cli-failure branch passes the carrier's `slug`
  // so a tool failure names WHICH op failed.
  ingredientSlug: string | null = null,
): RecipeError => ({
  error_id: `${requireRecipe(ctx).recipe_id}:${stepId}:${Date.now()}`,
  code,
  message,
  severity: ERR[code],
  source: { recipe_id: requireRecipe(ctx).recipe_id, step_id: stepId, ingredient_slug: ingredientSlug },
  details,
  timestamp: new Date().toISOString(),
  retryable: false,
});

// ────────────────────────────────────────────────────────────────
// D-120 Phase 3 — provenance link emission
// ────────────────────────────────────────────────────────────────

/** Per-recipe foreach-iteration depth counter. WeakMap keyed by
 *  ExecutionContext so concurrent recipes don't share state and
 *  entries GC with the ctx. Bumped on entry to `runForeach`,
 *  decremented on exit; `maybeEmitLinks` reads it to skip emission
 *  for inner-iteration steps (per spec: "link the source scan, not
 *  each item"). */
const foreachDepthByCtx = new WeakMap<ExecutionContext, number>();

const enterForeach = (ctx: ExecutionContext): void => {
  foreachDepthByCtx.set(ctx, (foreachDepthByCtx.get(ctx) ?? 0) + 1);
};

const leaveForeach = (ctx: ExecutionContext): void => {
  const next = (foreachDepthByCtx.get(ctx) ?? 1) - 1;
  if (next <= 0) foreachDepthByCtx.delete(ctx);
  else foreachDepthByCtx.set(ctx, next);
};

const isInsideForeach = (ctx: ExecutionContext): boolean =>
  (foreachDepthByCtx.get(ctx) ?? 0) > 0;

const stepIngredientVersion = (step: RecipeStep): number | undefined => {
  const v = (step as unknown as { ingredient_version?: unknown }).ingredient_version;
  return typeof v === 'number' ? v : undefined;
};

/** Build the per-step descriptor `stepEmitsLinks` + `classifyKind`
 *  consume. Returns null when the step's ingredient slug can't be
 *  resolved (kernel `run-ingredient` forwarding gone wrong, or the
 *  manifest getter isn't wired). */
const buildStepDescriptor = (
  step: RecipeStep,
  ctx: ExecutionContext,
): StepTouchDescriptor | null => {
  const slug = extractIngredientSlug(step, ctx);
  if (!slug) return null;
  const manifest: IngredientManifest | undefined =
    ctx.manifestGetter?.(slug, stepIngredientVersion(step)) ?? undefined;
  const desc: StepTouchDescriptor = {
    ingredient_slug: slug,
    source_collection: pickSourceCollection(step),
  };
  if (manifest) desc.manifest = manifest;
  const host = inferExternalCallHost(manifest);
  if (host) desc.external_call = host;
  return desc;
};

/** First `data.<collection>` segment the step's input references in
 *  declaration order. Drives the cross-collection branch of
 *  `classifyKind` (`execution.derived`). Undefined when the step
 *  reads no warehouse data. */
const pickSourceCollection = (step: RecipeStep): string | undefined => {
  const input = (step as { input?: unknown }).input;
  if (input === undefined) return undefined;
  for (const ref of collectRefs(input)) {
    const parsed = parseDataEntityRef(ref.ns, ref.path);
    if (parsed) return parsed.collection;
  }
  return undefined;
};

/** Walk the step's input refs, parse `data.<col>.<id>` patterns into
 *  `EntityTouch`es, dedupe by `(collection, entity_id)`. Skip-rule
 *  filtering and kind classification happen at the caller — this
 *  helper just enumerates the candidates the spec calls
 *  `step.touches`. */
const collectStepTouches = (
  step: RecipeStep,
  access: AccessKind,
): EntityTouch[] => {
  const input = (step as { input?: unknown }).input;
  if (input === undefined) return [];
  const seen = new Set<string>();
  const touches: EntityTouch[] = [];
  for (const ref of collectRefs(input)) {
    const parsed = parseDataEntityRef(ref.ns, ref.path);
    if (!parsed) continue;
    const key = `${parsed.collection}:${parsed.entity_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    touches.push({
      collection: parsed.collection,
      entity_id: parsed.entity_id,
      access,
    });
  }
  return touches;
};

/** Emit one `EmittedLink` per side-effecting touch the step
 *  performed. Short-circuits in priority order:
 *
 *    1. Recipe declared `provenance: false` — full opt-out.
 *    2. No `linkSink` wired — the host isn't capturing provenance links.
 *    3. Inside a foreach iteration — parent scan carries causality.
 *    4. Step descriptor unavailable (slug forwarding failure).
 *    5. Step is observational (`stepEmitsLinks` returns false:
 *       transforms / guards / `category: 'data'` reads / contracted
 *       `ai-*` analyses).
 *    6. Per-touch sidecar / scan filter via `shouldLink`.
 *
 *  Caller wraps this in a try/catch path? No — the function never
 *  throws. Sink failures are the caller's responsibility (server
 *  buffers + writes post-run; bad sink impl can swallow). */
const maybeEmitLinks = (
  step: RecipeStep,
  stepId: string,
  ctx: ExecutionContext,
  result: unknown,
): void => {
  if (requireRecipe(ctx).provenance === false) return;
  const sink = ctx.linkSink;
  if (!sink) return;
  if (isInsideForeach(ctx)) return;
  const desc = buildStepDescriptor(step, ctx);
  if (!desc) return;
  const ts = Date.now();
  // D-120 Phase 7.5 — bistemporal stamping. The step's input may
  // carry an `event_at` field — recipes processing historical data
  // pass through the source record's date_header so the link row
  // captures the event's wall-clock time alongside ingestion `ts`.
  // The extraction is opportunistic: we look at well-known shapes
  // (top-level `event_at`, then `record.event_at`) so authors don't
  // have to thread a new field through their step input. Anything
  // else falls back to undefined and `COALESCE(event_at, ts)` in
  // SQL preserves pre-7.5 behavior.
  const event_at = extractEventAt(step);
  const emit = (touch: EntityTouch): void => {
    sink({
      step_id: stepId,
      collection: touch.collection,
      entity_id: touch.entity_id,
      access: touch.access,
      kind: classifyKind(desc, touch),
      ts,
      ...(event_at !== undefined ? { event_at } : {}),
    });
  };
  // Read links — ONLY for side-effecting steps. A pure transform / guard /
  // `category: 'data'` read / contracted `ai-*` analysis is observational, so
  // the entities it read are not causal edges (`stepEmitsLinks` gate).
  if (stepEmitsLinks(desc)) {
    for (const touch of collectStepTouches(step, 'read')) {
      if (shouldLink(touch.collection, touch.access)) emit(touch);
    }
  }
  // D-210 step 3 — write link. A `writes` declaration means the step MUTATED a
  // warehouse entity whose id is in its RESULT (never in a `data.*` input ref,
  // so the read loop never surfaces it). A write IS side-effecting by
  // definition, so this emits INDEPENDENTLY of `stepEmitsLinks` — a `writes`
  // declaration must never silently no-op on a non-`action` category (a
  // declared-but-unbacked provenance edge). Keyed on `<collection>:<id>` so
  // `data.timeline(<collection>:<id>)` shows every mutation (the calendar move
  // history — §6.2). First consumer of `classifyKind`'s dormant write branch:
  // no source collection → `execution.write`; a step that also read a different
  // collection → `execution.derived`. `shouldLink` still filters sidecars.
  const writes = desc.manifest?.writes;
  if (writes) {
    const writtenId = readWriteEntityId(result, writes.id_output_field);
    if (writtenId !== undefined && shouldLink(writes.collection, 'write')) {
      emit({ collection: writes.collection, entity_id: writtenId, access: 'write' });
    }
  }
};

/** D-210 step 3 — read a written entity's id from a step result for the
 *  `writes` provenance link. The id must be a non-empty scalar
 *  (string / finite number) at the declared key of an object result;
 *  anything else (missing key, null, object, empty string) yields
 *  `undefined` so the emitter skips rather than keying a link on a
 *  malformed subject. Numbers stringify — the timeline entity_id is a
 *  string (`<collection>:<id>`) and warehouse ids are strings in
 *  practice, but a numeric id round-trips cleanly rather than being
 *  dropped. */
const readWriteEntityId = (
  result: unknown,
  field: string,
): string | undefined => {
  // ⛔ A DOTTED PATH, because the flat assumption was an accident of which ops
  // happened to declare `writes` first. Mail and calendar return the written id
  // as a TOP-LEVEL scalar (`record_id` / `source_id`), so a bare key was enough
  // — and every work-entity op returns `{ <kind>: { id, … } }`, putting the id
  // one level down and out of reach. The format could not express the shape of
  // the ops that most need it. A path with no dot behaves exactly as before.
  let value: unknown = result;
  for (const segment of field.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

/** D-120 Phase 7.5 — opportunistic `event_at` extraction. Backfill
 *  recipes pass `event_at` either as a top-level step-input field or
 *  via the record they read from (`record.event_at`); the engine
 *  forwards whichever it finds. Returns `undefined` for the
 *  overwhelming common case where the step doesn't carry an event
 *  date — link emission then stamps only `ts` and ordering queries
 *  fall back via `COALESCE(event_at, ts)`. */
const extractEventAt = (step: RecipeStep): number | undefined => {
  const input = (step as { input?: Record<string, unknown> }).input;
  if (input && typeof input === 'object') {
    const direct = input.event_at;
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    const rec = input.record as Record<string, unknown> | undefined;
    if (rec && typeof rec === 'object') {
      const nested = rec.event_at;
      if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
    }
  }
  return undefined;
};
