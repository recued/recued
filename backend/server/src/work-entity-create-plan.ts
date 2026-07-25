/** D-192 Slice 6c — work-entity create-plan as a `notification.ask` (one confirm).
 *
 *  A work-entity CREATE can NAME a vendor CONTAINER that doesn't exist yet (an
 *  Asana `project`). When its `create_op` is granted, the create-assist DECIDES to
 *  create it (`resolvePromptDependency` → a `PlannedDependencyCreate`) but does NOT
 *  execute it. The write can't dispatch until the container exists, so the
 *  dispatcher throws `WorkEntityCreatePlanRequiredError` carrying a
 *  `CreatePlanDetail`; the engine preserves it onto the step error's
 *  `details.create_plan`; `handleExecute` reads it and RAISES this ask.
 *
 *  ONE confirm covers the WHOLE plan (the container create(s) + the pending write)
 *  — "Create project 'Roadmap' and add the task 'Ship it'?". On approval the
 *  container(s) are created (`executeCreatePlan` — persisting each as the Source's
 *  stored selection) then a FRESH run re-does the write off the stored selection.
 *  On DENY nothing is created — no orphan (the design's "side effects shown up
 *  front, never a per-level create-approval" contract).
 *
 *  This leaf mirrors `work-entity-container-pick.ts` — build + answer-handler +
 *  register + raise, payload-driven, no closures — so the ask survives a restart
 *  between raise and answer. The execute-on-approve half (the
 *  `CreatePlanApprovedDispatcher` seam) lands in `work-entity-create-plan-wiring.ts`,
 *  which owns the `handleExecute` import (keeping THIS module free of it so
 *  `execute-handler` can import the raise side without an import cycle — the exact
 *  split the pick leaves use).
 *
 *  Posture (identical to the container pick):
 *   - The confirm AUTHORIZES this specific instance; the create_op grant authorized
 *     the CAPABILITY. The re-run's write still resolves + gates like any create.
 *   - The plan persists VERBATIM in the handler payload: approval executes exactly
 *     what was shown.
 *   - Headless sources (schedule / reactive / webhook) never reach this leaf — an
 *     ask nobody is present to answer is not a control surface. `handleExecute`
 *     raises it only for an owner/interactive run without vault/context.
 */

import type {
  Answer,
  AskHandlerFn,
  AskHandlerKind,
  AskHandlerRef,
  AskOption,
  NotificationMessage,
} from '@recued/notification';
import type { PlannedDependencyCreate } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Vocabulary
// ────────────────────────────────────────────────────────────────

/** The `AskHandlerKind` for create-plan answers. The block persists this slug +
 *  the JSON payload — never a closure — so the handler survives a restart between
 *  ask and answer. */
export const CREATE_PLAN_HANDLER_KIND: AskHandlerKind = 'work_entity.create_plan';

/** Approve = create the container(s) + finish the write; Cancel = create nothing. */
export const CREATE_PLAN_APPROVE_OPTION: AskOption = { id: 'approve', label: 'Create and continue' };
export const CREATE_PLAN_CANCEL_OPTION: AskOption = { id: 'cancel', label: 'Cancel' };

// ────────────────────────────────────────────────────────────────
// Injected seams
// ────────────────────────────────────────────────────────────────

/** The host-side dispatcher an approved answer fires — implemented in
 *  `work-entity-create-plan-wiring.ts` over `executeCreatePlan` + `handleExecute`
 *  (kept out of this module to avoid the execute-handler import cycle).
 *
 *  Contract the implementation MUST honor:
 *   - EXECUTE each planned container create (persisting its id as the Source's
 *     stored selection) BEFORE the re-run, so the re-run's create auto-resolves the
 *     container off the store (a pick, not a plan);
 *   - dispatch a FRESH run of the SAME request through the NORMAL gate path;
 *   - IDEMPOTENT per plan: `on_answer` is at-least-once (D-158 crash-recovery), so a
 *     replay after a crash must not mint a second run NOR a second container — derive
 *     a deterministic run id from `plan_id` and check the existing audit anchor
 *     (mirroring the pick / saga dispatchers' at-entry guard). */
export interface CreatePlanApprovedDispatcher {
  dispatchApprovedPlan(rerun: CreatePlanRerunRef): Promise<void>;
}

/** What the answer handler hands the dispatcher — the persisted create identity
 *  plus the plan to execute. `recipe_id` XOR `recipe` mirrors `ExecuteRequest`. */
export interface CreatePlanRerunRef {
  /** Mint-once plan identity — the dispatcher derives its deterministic run id
   *  (`create-plan-<plan_id>`) from this. */
  plan_id: string;
  /** The Source the create targeted — the store key each created container is
   *  written to. */
  source_id: string;
  /** The work-entity kind being created — display + the executor's `kind`. */
  kind: string;
  /** The container create(s) to execute, in dependency order (top-down). */
  plans: PlannedDependencyCreate[];
  recipe_id?: string;
  recipe?: unknown;
  /** The original run's config, replayed VERBATIM (the container is resolved off
   *  the store now, not merged into config). Vault / context never persist: a
   *  request carrying either is ineligible for the ask. */
  config: Record<string, unknown>;
  /** D-192 6c.2c — the id of the step that raised the plan (the write this confirm
   *  approves). The re-run pre-admits ONLY this step's vendor create, so a second
   *  `ask`-create elsewhere in the replayed recipe still gates. Absent → the re-run
   *  admits nothing (fail-closed; the write degrades like any un-admitted create).
   *
   *  NOTE: this rides `CreatePlanRerunRef` (the handler → dispatcher hand-off) AND
   *  `CreatePlanAskInput` (the host → ask build) — keep the two in sync. */
  raising_step_id?: string;
}

/** The narrow notification-block seam (same shape the pick / saga / container-pick
 *  leaves use). */
export interface CreatePlanNotifier {
  ask(
    message: NotificationMessage,
    options: readonly AskOption[],
    handler: AskHandlerRef,
  ): Promise<{ ask_id: string }>;
  registerAskHandler(kind: AskHandlerKind, handler: AskHandlerFn): void;
}

// ────────────────────────────────────────────────────────────────
// The ask
// ────────────────────────────────────────────────────────────────

/** What the host (`handleExecute`) supplies to build one create-plan ask. The
 *  identity + config fields are what the re-run needs; the detail fields
 *  (`source_id` / `kind` / `plans` / `target_summary`) come off the step error's
 *  `CreatePlanDetail`. */
export interface CreatePlanAskInput {
  /** Mint-once plan identity (host-minted; rides the payload so the at-least-once
   *  answer replay converges on one run id). */
  plan_id: string;
  /** Recipe identity for the re-run — id for a persisted recipe, verbatim JSON for
   *  an inline one. Exactly one must be present. */
  recipe_id?: string;
  recipe?: unknown;
  /** The run's config (replayed verbatim by the re-run). */
  config: Record<string, unknown>;
  /** The Source the create targeted. */
  source_id: string;
  /** The work-entity kind being created — display context. */
  kind: string;
  /** The container create(s) to run. */
  plans: PlannedDependencyCreate[];
  /** One-line human summary of the pending write the containers unblock. */
  target_summary: string;
  /** D-192 6c.2c — the id of the step whose vendor create this confirm approves
   *  (see `CreatePlanRerunRef.raising_step_id`). */
  raising_step_id?: string;
}

/** The three components of a create-plan `notification.ask`. */
export interface CreatePlanAsk {
  message: NotificationMessage;
  options: readonly AskOption[];
  handler: AskHandlerRef;
}

/** Build the `notification.ask` for one create plan. Two options (Create /
 *  Cancel); the handler payload persists the full re-run identity + the plans so
 *  approval executes exactly what was shown. */
export const buildCreatePlanAsk = (input: CreatePlanAskInput): CreatePlanAsk => {
  const containers = input.plans.map((p) => `${p.ref} '${p.name}'`).join(' + ');
  const message: NotificationMessage = {
    title: 'Create a new container?',
    text:
      `Adding ${input.target_summary} needs a new ${containers} that doesn't exist yet. `
      + `Create ${input.plans.length > 1 ? 'them' : 'it'} and finish adding the ${input.kind}? `
      + 'Nothing is created if you decline.',
  };
  const options: AskOption[] = [CREATE_PLAN_APPROVE_OPTION, CREATE_PLAN_CANCEL_OPTION];
  const handler: AskHandlerRef = {
    kind: CREATE_PLAN_HANDLER_KIND,
    payload: {
      plan_id: input.plan_id,
      source_id: input.source_id,
      kind: input.kind,
      ...(input.recipe_id !== undefined ? { recipe_id: input.recipe_id } : {}),
      ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
      config: input.config,
      plans: input.plans,
      ...(input.raising_step_id !== undefined ? { raising_step_id: input.raising_step_id } : {}),
    },
  };
  return { message, options, handler };
};

// ────────────────────────────────────────────────────────────────
// The answer handler
// ────────────────────────────────────────────────────────────────

const isPlan = (v: unknown): v is PlannedDependencyCreate => {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Partial<PlannedDependencyCreate>;
  return (
    typeof p.ref === 'string' && p.ref.length > 0
    && typeof p.create_op === 'string' && p.create_op.length > 0
    && typeof p.name === 'string'
    && typeof p.result_path === 'string' && p.result_path.length > 0
    && typeof p.id_field === 'string' && p.id_field.length > 0
    && p.args !== null && typeof p.args === 'object' && !Array.isArray(p.args)
  );
};

/** Build the durable `on_answer` handler for create-plan answers. `cancel` (or any
 *  non-approve option) records the decision and dispatches nothing — no container
 *  is created. `approve` hands the persisted re-run + the plans to the dispatcher
 *  (which creates the container(s) then re-runs the write). */
export const createCreatePlanAnswerHandler = (
  dispatcher: CreatePlanApprovedDispatcher,
): AskHandlerFn => {
  return async (payload: Record<string, unknown>, answer: Answer) => {
    const planId = payload.plan_id;
    const sourceId = payload.source_id;
    const kind = payload.kind;
    const recipeId = payload.recipe_id;
    const recipe = payload.recipe;
    const config = payload.config;
    const plans = payload.plans;
    const raisingStepId = payload.raising_step_id;
    if (
      typeof planId !== 'string'
      || planId.length === 0
      || typeof sourceId !== 'string'
      || sourceId.length === 0
      || typeof kind !== 'string'
      || kind.length === 0
      || config === null
      || typeof config !== 'object'
      || Array.isArray(config)
      || !Array.isArray(plans)
      || plans.length === 0
      || !plans.every(isPlan)
      || (recipeId === undefined) === (recipe === undefined)
      || (recipeId !== undefined && typeof recipeId !== 'string')
      || (raisingStepId !== undefined && typeof raisingStepId !== 'string')
    ) {
      throw new Error(
        'create plan handler: malformed payload — expected '
          + '{ plan_id: string, source_id: string, kind: string, recipe_id XOR '
          + 'recipe, config: object, plans: PlannedDependencyCreate[] }',
      );
    }

    // Only the explicit approve executes; cancel (or any other option) creates
    // nothing.
    if (answer.option !== CREATE_PLAN_APPROVE_OPTION.id) return;

    await dispatcher.dispatchApprovedPlan({
      plan_id: planId,
      source_id: sourceId,
      kind,
      plans,
      ...(typeof recipeId === 'string' ? { recipe_id: recipeId } : {}),
      ...(recipe !== undefined ? { recipe } : {}),
      config: config as Record<string, unknown>,
      ...(typeof raisingStepId === 'string' ? { raising_step_id: raisingStepId } : {}),
    });
  };
};

/** Register the `work_entity.create_plan` `on_answer` handler with the notification
 *  block. Call once at boot, before live traffic. */
export const registerCreatePlanHandler = (
  notifier: CreatePlanNotifier,
  dispatcher: CreatePlanApprovedDispatcher,
): void => {
  notifier.registerAskHandler(
    CREATE_PLAN_HANDLER_KIND,
    createCreatePlanAnswerHandler(dispatcher),
  );
};

/** Raise the create-plan ask. Thin — the host mints the plan id + owns the
 *  best-effort posture around the raise. */
export const raiseCreatePlanAsk = async (
  notifier: CreatePlanNotifier,
  input: CreatePlanAskInput,
): Promise<{ ask_id: string }> => {
  const { message, options, handler } = buildCreatePlanAsk(input);
  return notifier.ask(message, options, handler);
};
