/** D-145 PA6 — work-entity page state machine.
 *
 *  Pure transitions: each function takes the prior state + an input
 *  and returns the next state. Host app keeps the latest state and
 *  re-renders on patch. No side effects, no rpc calls — those live in
 *  the host glue layer.
 *
 *  State transitions encode the substrate's discipline:
 *    - Switching kind clears the dialog + search query (page reset).
 *    - Switching Source clears the search query (filter context
 *      changed) but preserves the dialog (mid-edit users shouldn't
 *      lose their work to a dropdown change). The host can choose to
 *      close-on-source-change but the substrate doesn't enforce it.
 *    - Closing the dialog clears all dialog state.
 *    - Submit-success closes the dialog. The host wires the close
 *      after the rpc returns.
 *
 *  Spec: docs/d-145-spec.md § Phase PA6 (Source switching / list /
 *  search / create / edit flow).
 */

import type { CanonicalSchema } from '../canonical-schemas/shape.js';
import type { WorkEntity, WorkEntityKind } from '../work-entities.js';
import {
  SOURCE_DROPDOWN_ALL_VALUE,
  type WorkEntityPageDialogState,
  type WorkEntityPageDialogStateCreate,
  type WorkEntityPageDialogStateEdit,
  type WorkEntityPageState,
} from './types.js';

export interface WorkEntityPageStateInit {
  kind: WorkEntityKind;
  selected_source_id?: string | null;
  search_query?: string;
}

/** Patch a dialog state while preserving its discriminated-union
 *  shape. The substrate-side TypeScript narrowing splits create vs
 *  edit by `mode`; merging via plain object spread loses the
 *  narrowing on the result type. This helper preserves it. */
const patchDialog = (
  dialog: WorkEntityPageDialogState,
  patch: Partial<{
    values: Record<string, unknown>;
    errors: Record<string, string>;
    submitting: boolean;
    submit_error: string;
    source_id: string;
  }>,
): WorkEntityPageDialogState => {
  if (dialog.mode === 'create') {
    const next: WorkEntityPageDialogStateCreate = { ...dialog, ...patch };
    return next;
  }
  const next: WorkEntityPageDialogStateEdit = { ...dialog, ...patch };
  return next;
};

export const initialWorkEntityPageState = (
  init: WorkEntityPageStateInit,
): WorkEntityPageState => ({
  kind: init.kind,
  selected_source_id: init.selected_source_id ?? null,
  search_query: init.search_query ?? '',
  dialog: null,
});

/** Switch the active kind. Clears search + dialog (kind change is a
 *  full-page context shift; users don't expect filter to carry). */
export const selectKindTransition = (
  state: WorkEntityPageState,
  kind: WorkEntityKind,
): WorkEntityPageState => {
  if (state.kind === kind) return state;
  return {
    kind,
    selected_source_id: null,
    search_query: '',
    dialog: null,
  };
};

/** Switch the selected Source. Sentinel `SOURCE_DROPDOWN_ALL_VALUE`
 *  maps to `null`. Concrete ids are pinned verbatim. Search query
 *  clears so list-view filtering reflects the new Source's rows;
 *  open dialogs are preserved (caller may close explicitly).
 *
 *  Optional `valid_dropdown_ids` (Codex P2 fold) — when supplied,
 *  rejects dropdown ids not in the set. Without this, hosts that
 *  bypass `dropdownIdToSelectedSourceId` could write stale or forged
 *  ids into page state. The set must include both the All-Sources
 *  sentinel AND any concrete Source ids the dropdown surfaces; pass
 *  the dropdown options' ids verbatim. */
export const selectSourceTransition = (
  state: WorkEntityPageState,
  dropdown_id: string,
  valid_dropdown_ids?: ReadonlySet<string>,
): WorkEntityPageState => {
  if (
    valid_dropdown_ids !== undefined &&
    !valid_dropdown_ids.has(dropdown_id)
  ) {
    return state;
  }
  const next: string | null =
    dropdown_id === SOURCE_DROPDOWN_ALL_VALUE ? null : dropdown_id;
  if (next === state.selected_source_id) return state;
  return {
    ...state,
    selected_source_id: next,
    search_query: '',
  };
};

/** Apply a search-query patch. Empty-string is meaningful (clears the
 *  filter); whitespace is preserved verbatim — `filterEntitiesBySearch`
 *  trims at filter time. */
export const applySearchTransition = (
  state: WorkEntityPageState,
  search_query: string,
): WorkEntityPageState => {
  if (state.search_query === search_query) return state;
  return { ...state, search_query };
};

/** Open the create dialog. The host supplies the resolved `source_id`
 *  (typically via `resolveCreateDialogSourceId`) + the canonical
 *  schema's defaults pre-projected into form values. */
export const openCreateDialogTransition = (
  state: WorkEntityPageState,
  source_id: string,
  initial_values: Record<string, unknown> = {},
): WorkEntityPageState => ({
  ...state,
  dialog: {
    mode: 'create',
    source_id,
    values: { ...initial_values },
    errors: {},
  },
});

/** Open the edit dialog seeded from an existing entity. The
 *  substrate flattens the entity row into form values via
 *  `entityToFormValues` (caller supplies the canonical schema for
 *  per-field projection). */
export const openEditDialogTransition = (
  state: WorkEntityPageState,
  entity: WorkEntity,
  schema: CanonicalSchema,
): WorkEntityPageState => ({
  ...state,
  dialog: {
    mode: 'edit',
    entity_id: entity.id,
    source_id: entity.source_id,
    values: entityToFormValues(entity, schema),
    errors: {},
  },
});

/** Switch the create-dialog Source target. Edit-mode dialogs reject
 *  the transition (substrate doesn't move rows between Sources at
 *  PA6) — host should ignore the `select-create-source` action when
 *  dialog.mode === 'edit'. Closes a Codex P2 fold gap: pre-fold the
 *  dialog rendered `data-action="select-create-source"` but no
 *  transition wrote `dialog.source_id`, so a Source change in create
 *  mode left the submit dispatch targeting the prior Source. */
export const setDialogSourceTransition = (
  state: WorkEntityPageState,
  source_id: string,
): WorkEntityPageState => {
  if (state.dialog === null) return state;
  if (state.dialog.mode !== 'create') return state;
  if (state.dialog.source_id === source_id) return state;
  const nextDialog: WorkEntityPageDialogStateCreate = {
    ...state.dialog,
    source_id,
  };
  return { ...state, dialog: nextDialog };
};

/** Update dialog values without changing dialog mode / id. Pass the
 *  full next-values map (the renderer reads back via
 *  `readFormValues`; the host hands it to this transition). */
export const setDialogValuesTransition = (
  state: WorkEntityPageState,
  values: Record<string, unknown>,
): WorkEntityPageState => {
  if (state.dialog === null) return state;
  return {
    ...state,
    dialog: patchDialog(state.dialog, { values }),
  };
};

/** Update per-field error map. Pass `{}` to clear. */
export const setDialogErrorsTransition = (
  state: WorkEntityPageState,
  errors: Record<string, string>,
): WorkEntityPageState => {
  if (state.dialog === null) return state;
  return {
    ...state,
    dialog: patchDialog(state.dialog, { errors }),
  };
};

/** Mark the dialog as submitting (rpc in flight). Host flips this
 *  before dispatching; flips back via `setDialogErrorsTransition` +
 *  `closeDialogTransition` on response. */
export const setDialogSubmittingTransition = (
  state: WorkEntityPageState,
  submitting: boolean,
): WorkEntityPageState => {
  if (state.dialog === null) return state;
  const patch: { submitting?: boolean } = {};
  if (submitting) patch.submitting = true;
  const next = patchDialog(state.dialog, patch);
  if (!submitting && next.submitting !== undefined) {
    delete (next as { submitting?: boolean }).submitting;
  }
  return { ...state, dialog: next };
};

/** Surface a top-level submit error (rpc-side failure, not per-field
 *  validation). Call with `null` to clear. */
export const setDialogSubmitErrorTransition = (
  state: WorkEntityPageState,
  submit_error: string | null,
): WorkEntityPageState => {
  if (state.dialog === null) return state;
  const patch: { submit_error?: string } = {};
  if (submit_error !== null && submit_error !== '') {
    patch.submit_error = submit_error;
  }
  const next = patchDialog(state.dialog, patch);
  if ((submit_error === null || submit_error === '') && next.submit_error !== undefined) {
    delete (next as { submit_error?: string }).submit_error;
  }
  return { ...state, dialog: next };
};

/** Close the dialog. */
export const closeDialogTransition = (
  state: WorkEntityPageState,
): WorkEntityPageState => {
  if (state.dialog === null) return state;
  return { ...state, dialog: null };
};

/** Project a canonical entity row into the form-renderer's value
 *  map. Walks the schema's fields + relationships; fields are copied
 *  verbatim; relationships of cardinality 'one' surface as the
 *  scalar id stored on the row (e.g., `assigned_contact_id` →
 *  `assigned_contact`); relationships of cardinality 'many' surface
 *  as the id-array stored on the row (e.g., `blocks_task_ids` →
 *  `blocks_task`).
 *
 *  Convention for the row→form name mapping:
 *    - relationship name + `_id` for cardinality 'one' (e.g.
 *      `assigned_contact_id` on the row maps to the form's
 *      `assigned_contact` field).
 *    - relationship name + `_ids` for cardinality 'many' (e.g.
 *      `blocks_task_ids` on the row maps to the form's `blocks_task`
 *      field).
 *
 *  Fields not present on the row resolve to `undefined` so the
 *  form-renderer falls back to the canonical default. */
export const entityToFormValues = (
  entity: WorkEntity,
  schema: CanonicalSchema,
): Record<string, unknown> => {
  const row = entity as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (row[f.name] !== undefined) out[f.name] = row[f.name];
  }
  for (const r of schema.relationships) {
    if (r.cardinality === 'many') {
      const key = `${r.name}_ids`;
      if (row[key] !== undefined) out[r.name] = row[key];
    } else {
      const key = `${r.name}_id`;
      if (row[key] !== undefined) out[r.name] = row[key];
    }
  }
  return out;
};
