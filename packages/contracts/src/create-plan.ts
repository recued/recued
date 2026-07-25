// D-192 Slice 6c — work-entity create-plan carrier.
//
// A work-entity CREATE can depend on a vendor CONTAINER Recued doesn't model
// (an Asana `project`). When the container is NAMED but doesn't exist AND its
// `create_op` is granted, the create-assist DECIDES to create it — but does not
// execute it. The write cannot dispatch until the container exists, so the
// decision surfaces as ONE create-plan `notification.ask` enumerating the
// container create(s) + the pending write ("Create project 'Roadmap' and add
// the task 'Ship it'?"). On approval the container is created, persisted as the
// Source's stored selection, and a fresh re-run resolves it as a pick + does the
// write. On deny nothing is created — no orphan.
//
// This module is the structural carrier that survives the engine seam (the same
// pattern as `container-pick.ts` / `cli_failure`): the dispatcher attaches a
// `create_plan` carrier to the thrown error; the engine preserves it onto
// `RecipeError.details.create_plan`; `handleExecute` reads it to raise the ask +
// surface a terminal `create_plan_required` — no message string-matching.

import type { RecipeErrorCode } from './errors.js';

/** A container create the resolver DECIDED but has NOT executed (decide-then-
 *  execute). Self-contained + plain JSON so it rides the ask handler payload
 *  across the engine seam: the resolved create-op wire args (parent-attribute
 *  args + the new name, already composed) + the create-response envelope for id
 *  extraction. Executed on approval by the write executor's `executeCreatePlan`. */
export interface PlannedDependencyCreate {
  /** The dependency ref this create satisfies (the store key the created id is
   *  selected under). */
  ref: string;
  /** The catalog create op (a gated WRITE). */
  create_op: string;
  /** The new entity's name — the human label + what `store.select` records. */
  name: string;
  /** The composed create-op wire args (parent args + name), ready to invoke. */
  args: Record<string, unknown>;
  /** The create-response envelope path + id field for extracting the created id
   *  (EXPLICIT on the create op — a create response can differ from a list row). */
  result_path: string;
  id_field: string;
}

/** Structured create-plan carrier the work-entity dispatcher attaches to the
 *  rejected error (`err.create_plan`); the engine preserves it onto
 *  `RecipeError.details.create_plan` so `handleExecute` raises the create-plan ask
 *  + builds the terminal `create_plan_required` result WITHOUT parsing the
 *  message. Carries everything the ask + the re-run need: which Source + kind the
 *  create targeted, the container create(s) to run, and a human summary of the
 *  write they unblock. */
export interface CreatePlanDetail {
  /** The Source the create targeted — the re-run re-scopes to it; each created
   *  container is stored per (source_id, plan.ref). */
  source_id: string;
  /** The work-entity kind being created (`task` / `note` / `project`) — display
   *  context for the ask body. */
  kind: string;
  /** The container create(s) to run, in dependency order (top-down). One for the
   *  common single-container case (Asana `project`). */
  plans: PlannedDependencyCreate[];
  /** One-line human summary of the pending write the containers unblock — the
   *  task/note being created ("task 'Ship the deck'"). */
  target_summary: string;
}

/** The `RecipeErrorCode` a decide-then-execute create carries — its own code so a
 *  step error / the Runs feed / the chat `errors[]` read "this create needs you to
 *  confirm creating a container" instead of the catch-all `NETWORK_ERROR`. The
 *  create-plan ask (raised by `handleExecute`) is the real recovery; the code is
 *  the honest label if the ask can't be raised (no notifier wired). */
export const CREATE_PLAN_REQUIRED_ERROR_CODE: RecipeErrorCode = 'CREATE_PLAN_REQUIRED';

const isPlannedDependencyCreate = (value: unknown): value is PlannedDependencyCreate => {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Partial<PlannedDependencyCreate>;
  return (
    typeof p.ref === 'string'
    && p.ref.length > 0
    && typeof p.create_op === 'string'
    && p.create_op.length > 0
    && typeof p.name === 'string'
    && typeof p.result_path === 'string'
    && p.result_path.length > 0
    && typeof p.id_field === 'string'
    && p.id_field.length > 0
    && p.args !== null
    && typeof p.args === 'object'
    && !Array.isArray(p.args)
  );
};

/** Narrow an unknown value (a thrown error's `create_plan`, or a
 *  `RecipeError.details.create_plan`) to the carrier — structural, so the
 *  downstream surfaces never string-match a message. `plans` must be a NON-EMPTY
 *  array of well-formed plans (the create set is load-bearing for the ask + the
 *  execute-on-approve); the other fields are validated as the non-empty strings
 *  the ask / re-run rely on. */
export const isCreatePlanDetail = (value: unknown): value is CreatePlanDetail => {
  if (value === null || typeof value !== 'object') return false;
  const d = value as Partial<CreatePlanDetail>;
  return (
    typeof d.source_id === 'string'
    && d.source_id.length > 0
    && typeof d.kind === 'string'
    && d.kind.length > 0
    && typeof d.target_summary === 'string'
    && Array.isArray(d.plans)
    && d.plans.length > 0
    && d.plans.every(isPlannedDependencyCreate)
  );
};
