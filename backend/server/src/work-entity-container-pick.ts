/** D-192 Slice 6b — work-entity container-pick as a D-158 `notification.ask`.
 *
 *  A work-entity CREATE can depend on a vendor CONTAINER Recued doesn't model
 *  (Linear `team`, an Asana `workspace`). When that container is AMBIGUOUS —
 *  more than one option and none named / stored — the create can't proceed until
 *  a human picks one. The dispatcher throws `WorkEntityContainerPickRequiredError`
 *  carrying a `ContainerPickDetail`; the engine preserves it onto the step
 *  error's `details.container_pick`; `handleExecute` reads it and RAISES this ask.
 *
 *  This leaf mirrors the connection-slot pick (`packages/gateway/pick-resolution.ts`
 *  + `pick-server-wiring.ts`) — build + answer-handler + register + raise,
 *  payload-driven, no closures — so the ask survives a restart between raise and
 *  answer. The re-run half (the `ContainerPickRerunDispatcher` seam) lands in
 *  `work-entity-container-pick-wiring.ts`, which owns the `handleExecute` import
 *  (keeping THIS module free of it so `execute-handler` can import the raise side
 *  without an import cycle — the exact split the pick leaves use).
 *
 *  The flow (re-run, never resume — D-158 is fire-and-continue, no checkpoint):
 *
 *    a create's container dependency resolves ambiguous mid-run
 *      → the engine fails the create step with `details.container_pick`
 *      → `handleExecute`: notification.ask("Creating a task needs a 'team'
 *        chosen — N can hold it", [one option per container / Cancel],
 *        handler kind `work_entity.container_pick`) + a terminal
 *        `container_pick_required` result (the run FAILED; a fresh run will
 *        re-do the create once the pick is stored — NOT a resume)
 *      → user answers (any channel, durable across a restart)
 *      → on_answer → the dispatcher PERSISTS the pick as this Source's stored
 *        default (`store.select`) then dispatches a FRESH run of the SAME
 *        request; the re-run's `resolveCreateDependencies` now auto-resolves off
 *        the stored selection (no `named` threading), the create flows through
 *        the NORMAL gate. `cancel` records the answer and changes nothing.
 *
 *  Posture (identical to the connection pick):
 *   - The pick DISAMBIGUATES; it never AUTHORIZES. The re-run's vendor create
 *     still resolves, gates, and pauses at preflight exactly like any create —
 *     the gate is the gate.
 *   - The choice set persists VERBATIM in the handler payload: the answer selects
 *     exactly what was offered, and an answer naming anything else is rejected.
 *   - Headless sources (schedule / reactive / webhook) never reach this leaf —
 *     an ask nobody is present to answer is not a control surface. `handleExecute`
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
import type { ContainerPickOption } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Vocabulary
// ────────────────────────────────────────────────────────────────

/** The `AskHandlerKind` for container-pick answers. The block persists this slug
 *  + the JSON payload — never a closure — so the handler survives a restart
 *  between ask and answer. */
export const CONTAINER_PICK_HANDLER_KIND: AskHandlerKind = 'work_entity.container_pick';

/** The non-option answer every container-pick ask offers: record the decision,
 *  dispatch nothing (the user re-issues the create when ready). */
export const CONTAINER_PICK_CANCEL_OPTION: AskOption = { id: 'cancel', label: 'Cancel' };

// ────────────────────────────────────────────────────────────────
// Injected seams
// ────────────────────────────────────────────────────────────────

/** The host-side dispatcher a chosen answer fires — implemented in
 *  `work-entity-container-pick-wiring.ts` over `handleExecute` (kept out of this
 *  module to avoid the execute-handler import cycle).
 *
 *  Contract the implementation MUST honor:
 *   - PERSIST the pick as the Source's stored selection BEFORE the re-run, so the
 *     re-run's create auto-resolves the container off the store (not `named`);
 *   - dispatch a FRESH run of the SAME request through the NORMAL gate path —
 *     never a bypass; the re-run's write pauses at preflight like any create;
 *   - IDEMPOTENT per pick: `on_answer` is at-least-once (D-158 crash-recovery),
 *     so a replay after a crash must not mint a second run for one pick — derive
 *     a deterministic run id from `pick_id` and check the existing audit anchor
 *     (mirroring the pick / saga dispatchers' at-entry guard). */
export interface ContainerPickRerunDispatcher {
  dispatchPickedCreate(rerun: ContainerPickRerunRef): Promise<void>;
}

/** What the answer handler hands the dispatcher — the persisted create identity
 *  plus the chosen container. `recipe_id` XOR `recipe` mirrors `ExecuteRequest`:
 *  a persisted recipe re-runs by id; an inline canonical recipe rides the payload
 *  verbatim (the chat Tier-3 `RUN_INGREDIENT_RECIPE` create is inline). */
export interface ContainerPickRerunRef {
  /** Mint-once pick identity — the dispatcher derives its deterministic run id
   *  (`container-pick-<pick_id>`) from this. */
  pick_id: string;
  /** The Source the create targeted — the store key the selection is written to. */
  source_id: string;
  /** The ambiguous dependency's ref — the second store key (a Source may depend
   *  on more than one container). */
  dependency_ref: string;
  /** The chosen container's vendor id (validated ∈ the persisted options before
   *  dispatch) — what `store.select` persists. */
  entity_pk: string;
  recipe_id?: string;
  recipe?: unknown;
  /** The original run's config, replayed VERBATIM (the container is resolved off
   *  the store now, not merged into config — unlike the connection pick). Vault /
   *  context never persist: a request carrying either is ineligible for the ask. */
  config: Record<string, unknown>;
}

/** The narrow notification-block seam (same shape the pick / saga / in-doubt
 *  leaves use — a `NotificationBlock` satisfies it structurally). */
export interface ContainerPickNotifier {
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

/** What the host (`handleExecute`) supplies to build one container-pick ask.
 *  The identity + config fields are what the re-run needs; the detail fields
 *  (`source_id` / `dependency_ref` / `kind` / `options`) come off the step
 *  error's `ContainerPickDetail`. */
export interface ContainerPickAskInput {
  /** Mint-once pick identity (host-minted; rides the payload so the at-least-once
   *  answer replay converges on one run id). */
  pick_id: string;
  /** Recipe identity for the re-run — id for a persisted recipe, verbatim JSON
   *  for an inline one. Exactly one must be present. */
  recipe_id?: string;
  recipe?: unknown;
  /** Display name for the ask body (falls back to `recipe_id`). */
  recipe_label: string;
  /** The run's config (replayed verbatim by the re-run). */
  config: Record<string, unknown>;
  /** The Source the create targeted. */
  source_id: string;
  /** The ambiguous dependency ref — also the human noun in the ask ("a team"). */
  dependency_ref: string;
  /** The work-entity kind being created — display context ("Creating a task"). */
  kind: string;
  /** The choice set — one option per fetched container. */
  options: readonly ContainerPickOption[];
}

/** The three components of a container-pick `notification.ask`. */
export interface ContainerPickAsk {
  message: NotificationMessage;
  options: readonly AskOption[];
  handler: AskHandlerRef;
}

/** Build the `notification.ask` for one ambiguous container. One option per
 *  container (id = the vendor `entity_pk` — the string the answer selects) +
 *  Cancel. The handler payload persists the full re-run identity + the option
 *  ids so the answer selects exactly what was offered. */
export const buildContainerPickAsk = (input: ContainerPickAskInput): ContainerPickAsk => {
  const noun = input.dependency_ref;
  const labels = input.options.map((o) => `'${o.label}'`).join('; ');
  // Runtime hardening on a user-facing string: `recipe_label` is typed required,
  // but a host slip must never render "'undefined'" on an ask surface.
  const label =
    input.recipe_label
    ?? input.recipe_id
    ?? (input.recipe as { recipe_id?: string } | undefined)?.recipe_id
    ?? 'this run';
  const message: NotificationMessage = {
    title: 'Choose where this goes',
    text:
      `Creating a ${input.kind} (${label}) needs a ${noun} chosen`
      + (input.options.length > 0
        ? ` — ${input.options.length} can hold it: ${labels}. `
        : '. ')
      + `Choosing one saves it as the default ${noun} for future creates here and `
      + 'finishes this one. Writes still ask for approval before anything happens.',
  };
  const options: AskOption[] = [
    ...input.options.map((o) => ({ id: o.entity_pk, label: o.label })),
    CONTAINER_PICK_CANCEL_OPTION,
  ];
  const handler: AskHandlerRef = {
    kind: CONTAINER_PICK_HANDLER_KIND,
    payload: {
      pick_id: input.pick_id,
      source_id: input.source_id,
      dependency_ref: input.dependency_ref,
      kind: input.kind,
      ...(input.recipe_id !== undefined ? { recipe_id: input.recipe_id } : {}),
      ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
      config: input.config,
      option_pks: input.options.map((o) => o.entity_pk),
    },
  };
  return { message, options, handler };
};

// ────────────────────────────────────────────────────────────────
// The answer handler
// ────────────────────────────────────────────────────────────────

/** Build the durable `on_answer` handler for container-pick answers. `cancel`
 *  records the decision and dispatches nothing. A container answer hands the
 *  persisted re-run + the chosen id to the dispatcher (which persists the
 *  selection then re-runs); an answer naming anything OUTSIDE the persisted
 *  option set is rejected (a stale or forged option must never bind). */
export const createContainerPickAnswerHandler = (
  dispatcher: ContainerPickRerunDispatcher,
): AskHandlerFn => {
  return async (payload: Record<string, unknown>, answer: Answer) => {
    const pickId = payload.pick_id;
    const sourceId = payload.source_id;
    const dependencyRef = payload.dependency_ref;
    const recipeId = payload.recipe_id;
    const recipe = payload.recipe;
    const config = payload.config;
    const optionPks = payload.option_pks;
    if (
      typeof pickId !== 'string'
      || pickId.length === 0
      || typeof sourceId !== 'string'
      || sourceId.length === 0
      || typeof dependencyRef !== 'string'
      || dependencyRef.length === 0
      || config === null
      || typeof config !== 'object'
      || Array.isArray(config)
      || !Array.isArray(optionPks)
      || !optionPks.every((c): c is string => typeof c === 'string')
      || (recipeId === undefined) === (recipe === undefined)
      || (recipeId !== undefined && typeof recipeId !== 'string')
    ) {
      throw new Error(
        'container pick handler: malformed payload — expected '
          + '{ pick_id: string, source_id: string, dependency_ref: string, '
          + 'recipe_id XOR recipe, config: object, option_pks: string[] }',
      );
    }

    if (answer.option === CONTAINER_PICK_CANCEL_OPTION.id) return;

    if (!optionPks.includes(answer.option)) {
      throw new Error(
        `container pick handler: answer '${answer.option}' is not one of the `
          + `offered containers (${optionPks.join(', ')})`,
      );
    }

    await dispatcher.dispatchPickedCreate({
      pick_id: pickId,
      source_id: sourceId,
      dependency_ref: dependencyRef,
      entity_pk: answer.option,
      ...(typeof recipeId === 'string' ? { recipe_id: recipeId } : {}),
      ...(recipe !== undefined ? { recipe } : {}),
      config: config as Record<string, unknown>,
    });
  };
};

/** Register the `work_entity.container_pick` `on_answer` handler with the
 *  notification block. Call once at boot, before live traffic. */
export const registerContainerPickHandler = (
  notifier: ContainerPickNotifier,
  dispatcher: ContainerPickRerunDispatcher,
): void => {
  notifier.registerAskHandler(
    CONTAINER_PICK_HANDLER_KIND,
    createContainerPickAnswerHandler(dispatcher),
  );
};

/** Raise the container-pick ask for one ambiguous dependency. Thin — the host
 *  mints the pick id + owns the best-effort posture around the raise. */
export const raiseContainerPickAsk = async (
  notifier: ContainerPickNotifier,
  input: ContainerPickAskInput,
): Promise<{ ask_id: string }> => {
  const { message, options, handler } = buildContainerPickAsk(input);
  return notifier.ask(message, options, handler);
};
