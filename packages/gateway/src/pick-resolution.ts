/** Doc §4 close-out — >1-provider pick resolution (gateway-side leaf).
 *
 *  A connection-agnostic recipe binds each op-step to a connection SLOT
 *  (a `type:'connection'` variable) the run supplies in `config`
 *  (recipe-identity doc §1.3 — targeting is a property of the run).
 *  When a run arrives with a slot UNBOUND and more than one enrolled
 *  connection is capable of serving it, the run must pick — the
 *  pick-resolution half of §1.3's "pick → confirm → run" loop. This
 *  leaf is that pick as a D-158 `notification.ask`, mirroring the
 *  saga-reconciliation leaf's shape (build + answer-handler + register
 *  + raise; payload-driven, no closures).
 *
 *  The flow (re-run, never resume — §1.3):
 *
 *    dispatch resolve fails on an unbound slot + >1 capable candidate
 *      → gateway: notification.ask("Recipe X needs a connection for
 *        '<slot>' — N can serve it", [one option per candidate /
 *        Cancel], handler kind `gateway.pick`)
 *      → the original request FAILS with a typed `pick_required`
 *        error naming the candidates (an AI caller can simply re-run
 *        with `config.<slot> = <name>` itself — the ask is the durable
 *        owner-facing surface, not a coroutine pause)
 *      → user answers (any channel, durable across a restart)
 *      → on_answer → a FRESH run dispatches over the injected
 *        dispatcher with the binding merged into `config`; the run
 *        flows through the NORMAL door (dispatch-resolve → catalog
 *        gate → preflight approval). `cancel` records the answer and
 *        changes nothing.
 *
 *  Posture:
 *   - The pick ask DISAMBIGUATES; it never AUTHORIZES. The chosen
 *     binding still resolves, gates, and (for writes) pauses at
 *     preflight exactly like a hand-bound run — the gate is the gate.
 *   - Candidates are derived HOST-SIDE (they need the recipes-package
 *     slot walk — a layering boundary this leaf cannot cross, same as
 *     saga compensation derivation) and persist VERBATIM in the
 *     handler payload: the answer dispatches exactly what was offered,
 *     and an answer naming anything else is rejected.
 *   - A multi-slot recipe converges iteratively: each answer binds ONE
 *     slot and re-dispatches; a remaining unbound slot raises the next
 *     pick ask. No cartesian option lists.
 *   - Headless sources (actor `'system'`, e.g. schedule / reactive /
 *     webhook) NEVER reach this leaf — they require a pinned target
 *     and fail closed at the dispatcher (v3 spec §9
 *     "targeted-without-a-target → block"); an ask nobody is present
 *     to answer is not a control surface.
 */

import type {
  Answer,
  AskHandlerFn,
  AskHandlerKind,
  AskHandlerRef,
  AskOption,
  NotificationMessage,
} from '@recued/notification';

// ────────────────────────────────────────────────────────────────
// Vocabulary
// ────────────────────────────────────────────────────────────────

/** The `AskHandlerKind` for >1-provider pick answers. The block
 *  persists this slug + the JSON payload — never a closure — so the
 *  handler survives a restart between ask and answer. */
export const PICK_HANDLER_KIND: AskHandlerKind = 'gateway.pick';

/** The non-candidate answer every pick ask offers: record the
 *  decision, dispatch nothing. */
export const PICK_CANCEL_OPTION: AskOption = { id: 'cancel', label: 'Cancel' };

/** One capable connection for an unbound slot — derived host-side
 *  against the enrolled operation profiles (a connection qualifies iff
 *  its bound catalog can serve EVERY canonical op the slot's op-steps
 *  declare, via the registry crm_alias mapping). */
export interface PickCandidate {
  /** The enrolled connection name — what the answer binds. */
  connection_name: string;
  /** The candidate's bound catalog (`hubspot-catalog`, …) — display +
   *  audit context. */
  catalog_slug: string;
  /** The catalog's vendor (`hubspot`, `salesforce`) when the registry
   *  knows it — display only. */
  vendor?: string;
}

// ────────────────────────────────────────────────────────────────
// Injected seams
// ────────────────────────────────────────────────────────────────

/** The host-side dispatcher a candidate answer fires — over the
 *  server's `handleExecute`, with the chosen binding merged into the
 *  run's `config`.
 *
 *  Contract the implementation MUST honor:
 *   - the dispatch flows through the NORMAL gate path (dispatch-
 *     resolve → catalog gate → preflight approval) — never a bypass;
 *   - IDEMPOTENT per ask: `on_answer` is at-least-once, so a replay
 *     after a crash must not mint a second run for the same pick —
 *     derive a deterministic run id from `pick_id` and check the
 *     existing audit anchor (mirroring the saga dispatcher's at-entry
 *     guard). */
export interface PickRerunDispatcher {
  dispatchPickedRun(rerun: PickRerunRef): Promise<void>;
}

/** What the answer handler hands the dispatcher — the persisted run
 *  identity plus the chosen binding. `recipe_id` XOR `recipe` mirrors
 *  `ExecuteRequest`: a persisted recipe re-runs by id; an inline
 *  canonical recipe rides the payload verbatim (no secrets — the
 *  canonical pre-resolve JSON). */
export interface PickRerunRef {
  /** Mint-once pick identity — the dispatcher derives its
   *  deterministic run id (`pick-<pick_id>`) from this. */
  pick_id: string;
  recipe_id?: string;
  recipe?: unknown;
  /** The original run's config (vault/context never persist — a
   *  request carrying either is ineligible for a pick ask). */
  config: Record<string, unknown>;
  /** The unbound slot variable the answer binds. */
  variable: string;
  /** The chosen connection name (validated ∈ the persisted
   *  candidates before dispatch). */
  connection_name: string;
}

/** The narrow notification-block seam (same shape the saga / in-doubt
 *  leaves use — a `NotificationBlock` satisfies it structurally). */
export interface PickNotifier {
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

/** What the host supplies to build one pick ask. */
export interface PickAskInput {
  /** Mint-once pick identity (host-minted; rides the payload so the
   *  at-least-once answer replay converges on one run id). */
  pick_id: string;
  /** Recipe identity for the re-run — id for a persisted recipe,
   *  verbatim JSON for an inline one. Exactly one must be present. */
  recipe_id?: string;
  recipe?: unknown;
  /** Display name for the ask body (falls back to `recipe_id`). */
  recipe_label: string;
  /** The unbound slot variable. */
  variable: string;
  /** The canonical ops the slot's op-steps declare (`deal.search`) —
   *  ask-body context for what the pick unlocks. */
  operations: readonly string[];
  /** The run's config (the binding merges into this at dispatch). */
  config: Record<string, unknown>;
  candidates: readonly PickCandidate[];
}

/** The three components of a pick `notification.ask`. */
export interface PickAsk {
  message: NotificationMessage;
  options: readonly AskOption[];
  handler: AskHandlerRef;
}

/** Build the `notification.ask` for one unbound slot. One option per
 *  candidate (id = the connection name — the same string the answer
 *  binds) + Cancel. The handler payload persists the full re-run
 *  identity + the candidate names so the answer dispatches exactly
 *  what was offered. */
export const buildPickAsk = (input: PickAskInput): PickAsk => {
  const lines = input.candidates.map((c) =>
    c.vendor !== undefined
      ? `'${c.connection_name}' (${c.vendor})`
      : `'${c.connection_name}' (${c.catalog_slug})`,
  );
  const ops = [...input.operations].sort().join(', ');
  // Runtime hardening on a user-facing string: `recipe_label` is typed
  // required, but a host slip must never render "Recipe 'undefined'" on
  // an ask surface — fall back to the run identity.
  const label =
    input.recipe_label
    ?? input.recipe_id
    ?? (input.recipe as { recipe_id?: string } | undefined)?.recipe_id
    ?? 'recipe';
  const message: NotificationMessage = {
    title: 'Choose a connection',
    text:
      `Recipe '${label}' needs a connection for '${input.variable}'`
      + (ops.length > 0 ? ` (${ops})` : '')
      + `. ${input.candidates.length} can serve it: ${lines.join('; ')}. `
      + 'Choosing one runs the recipe against it — writes still ask for '
      + 'approval before anything happens.',
  };
  const options: AskOption[] = [
    ...input.candidates.map((c) => ({
      id: c.connection_name,
      label:
        c.vendor !== undefined
          ? `${c.connection_name} (${c.vendor})`
          : c.connection_name,
    })),
    PICK_CANCEL_OPTION,
  ];
  const handler: AskHandlerRef = {
    kind: PICK_HANDLER_KIND,
    payload: {
      pick_id: input.pick_id,
      ...(input.recipe_id !== undefined ? { recipe_id: input.recipe_id } : {}),
      ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
      variable: input.variable,
      config: input.config,
      candidate_names: input.candidates.map((c) => c.connection_name),
    },
  };
  return { message, options, handler };
};

// ────────────────────────────────────────────────────────────────
// The answer handler
// ────────────────────────────────────────────────────────────────

/** Build the durable `on_answer` handler for pick answers. `cancel`
 *  records the decision and dispatches nothing (the block marks the
 *  ask handled — honest history; the user re-runs when ready). A
 *  candidate answer dispatches the persisted re-run with the binding
 *  merged; an answer naming anything OUTSIDE the persisted candidate
 *  set is rejected (a stale or forged option must never bind). */
export const createPickAnswerHandler = (
  dispatcher: PickRerunDispatcher,
): AskHandlerFn => {
  return async (payload: Record<string, unknown>, answer: Answer) => {
    const pickId = payload.pick_id;
    const recipeId = payload.recipe_id;
    const recipe = payload.recipe;
    const variable = payload.variable;
    const config = payload.config;
    const candidates = payload.candidate_names;
    if (
      typeof pickId !== 'string'
      || pickId.length === 0
      || typeof variable !== 'string'
      || variable.length === 0
      || config === null
      || typeof config !== 'object'
      || Array.isArray(config)
      || !Array.isArray(candidates)
      || !candidates.every((c): c is string => typeof c === 'string')
      || (recipeId === undefined) === (recipe === undefined)
      || (recipeId !== undefined && typeof recipeId !== 'string')
    ) {
      throw new Error(
        'pick resolution handler: malformed payload — expected '
          + '{ pick_id: string, recipe_id XOR recipe, variable: string, '
          + 'config: object, candidate_names: string[] }',
      );
    }

    if (answer.option === PICK_CANCEL_OPTION.id) return;

    if (!candidates.includes(answer.option)) {
      throw new Error(
        `pick resolution handler: answer '${answer.option}' is not one of `
          + `the offered candidates (${candidates.join(', ')})`,
      );
    }

    await dispatcher.dispatchPickedRun({
      pick_id: pickId,
      ...(typeof recipeId === 'string' ? { recipe_id: recipeId } : {}),
      ...(recipe !== undefined ? { recipe } : {}),
      config: config as Record<string, unknown>,
      variable,
      connection_name: answer.option,
    });
  };
};

/** Register the `gateway.pick` `on_answer` handler with the
 *  notification block. Call once at boot, before live traffic. */
export const registerPickHandler = (
  notifier: PickNotifier,
  dispatcher: PickRerunDispatcher,
): void => {
  notifier.registerAskHandler(
    PICK_HANDLER_KIND,
    createPickAnswerHandler(dispatcher),
  );
};

/** Raise the pick ask for one unbound slot. Thin — the host derives
 *  the candidates + mints the pick id and owns the best-effort posture
 *  around the raise. */
export const raisePickAsk = async (
  notifier: PickNotifier,
  input: PickAskInput,
): Promise<{ ask_id: string }> => {
  const { message, options, handler } = buildPickAsk(input);
  return notifier.ask(message, options, handler);
};
