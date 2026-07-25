// D-192 Slice 6b — work-entity container-pick carrier.
//
// A work-entity CREATE can depend on a vendor CONTAINER Recued doesn't model
// (Linear `team`, an Asana `workspace`/`project`). When that container is
// AMBIGUOUS — more than one option and none named / stored / a lone auto-pick —
// the create cannot proceed until a human chooses one. On the pair-RPC path the
// dispatcher's `WorkEntityContainerPickRequiredError` is caught directly (its
// typed fields feed a `container_pick_required` rpc error). But the chat / MCP
// path runs the create INSIDE an engine run (`handleExecute`), and the engine
// swallows every non-preflight throw into a generic `NETWORK_ERROR` step error —
// so the structured choice set would be lost.
//
// This module is the structural carrier that survives the engine seam. The
// dispatcher attaches a `container_pick` carrier to the thrown error; the engine
// preserves it onto `RecipeError.details.container_pick` (the same carrier
// pattern as `details.cli_failure` / `details.heavy_op`), and `handleExecute`
// reads it off the step error to raise the D-158 pick ask + surface a terminal
// `container_pick_required` — no message string-matching anywhere.

import type { RecipeErrorCode } from './errors.js';

/** One selectable vendor container for an ambiguous dependency — the vendor-
 *  native id that flows into the bound create arg + a display label. */
export interface ContainerPickOption {
  entity_pk: string;
  label: string;
}

/** Structured container-pick carrier the work-entity dispatcher attaches to the
 *  rejected error (`err.container_pick`); the engine preserves it onto
 *  `RecipeError.details.container_pick` so `handleExecute` can raise the pick ask
 *  and build the terminal `container_pick_required` result WITHOUT parsing the
 *  message. Carries everything the ask + the re-run need: which Source + kind the
 *  create targeted, which dependency is ambiguous, and the choice set. */
export interface ContainerPickDetail {
  /** The Source the create targeted — the re-run re-scopes to it, and the pick
   *  is stored per (source_id, dependency_ref). */
  source_id: string;
  /** The work-entity kind being created (`task` / `note` / `project`) — display
   *  context for the ask body. */
  kind: string;
  /** The ambiguous dependency's declared ref (Linear `team`, Asana `workspace`)
   *  — the store key the answer selects against. */
  dependency_ref: string;
  /** The choice set — one option per fetched container. Empty only when the
   *  dependency has a create op but no existing options (`can_create` true). */
  options: ContainerPickOption[];
  /** Whether a NEW container could be created (a create-op-bearing dependency
   *  with the write authorized). Slice 6b is pick-only, so this is informational
   *  today; the ask never offers a create branch until Slice 6c. */
  can_create: boolean;
  /** S4 — the RESOLVED `operation_id` of the container's create op
   *  (`recued-core/asana.project.create`), present iff the dependency declares a
   *  `create_op`. The chat surface's catch site (`handleExecute`) grant-checks it
   *  against the ACTING contract (`admitVendorWrite` → `isOpGranted`) to tell the
   *  agent whether it may create a NEW container (the `container_names` fast-track
   *  / a create tool) or is pick-only. ABSENT ⇒ the container type has no create op
   *  at all (inherently pick-only, e.g. Linear `team`) — a distinct case from
   *  present-but-ungranted (`no_new_project_permission`). Separate authorization
   *  axes: this id enables the grant CHECK; the pick only disambiguates. */
  create_op?: string;
  /** S4 fold — the RESOLVED `operation_id` of the TARGET write (the task/note/project
   *  create the agent is doing). The chat catch site requires BOTH `create_op` AND this
   *  granted before it tells the agent the one-step `container_names` create will
   *  succeed — mirroring the fast-track, which admits the whole plan (target write +
   *  container create). Present whenever a target write op resolved (always, for a
   *  create-driven pick); absent ⇒ the grant branch fails closed (no over-promise). */
  target_write_op?: string;
}

/** The `RecipeErrorCode` an ambiguous-container create carries — its own code so
 *  a step error / the Runs feed / the chat `errors[]` read "this create needs a
 *  container chosen" instead of the catch-all `NETWORK_ERROR`. The eventual pick
 *  ask (raised by `handleExecute`) is the real recovery; the code is the honest
 *  label if the ask can't be raised (no notifier wired). */
export const CONTAINER_PICK_REQUIRED_ERROR_CODE: RecipeErrorCode =
  'CONTAINER_PICK_REQUIRED';

/** Narrow an unknown value (a thrown error's `container_pick`, or a
 *  `RecipeError.details.container_pick`) to the carrier — structural, so the
 *  downstream surfaces never string-match a message. `options` must be an array
 *  (the choice set is load-bearing for the ask); the other fields are validated
 *  as the non-empty strings the ask/re-run rely on. */
export const isContainerPickDetail = (
  value: unknown,
): value is ContainerPickDetail => {
  if (value === null || typeof value !== 'object') return false;
  const d = value as Partial<ContainerPickDetail>;
  return (
    typeof d.source_id === 'string'
    && d.source_id.length > 0
    && typeof d.kind === 'string'
    && d.kind.length > 0
    && typeof d.dependency_ref === 'string'
    && d.dependency_ref.length > 0
    && Array.isArray(d.options)
    && d.options.every(
      (o) =>
        o !== null
        && typeof o === 'object'
        && typeof (o as ContainerPickOption).entity_pk === 'string'
        && typeof (o as ContainerPickOption).label === 'string',
    )
    && typeof d.can_create === 'boolean'
    // `create_op` is OPTIONAL (a create-op-less dependency omits it) — when
    // present it must be the non-empty resolved operation_id the grant check keys on.
    && (d.create_op === undefined
      || (typeof d.create_op === 'string' && d.create_op.length > 0))
    // `target_write_op` is likewise OPTIONAL + a non-empty resolved operation_id.
    && (d.target_write_op === undefined
      || (typeof d.target_write_op === 'string' && d.target_write_op.length > 0))
  );
};
