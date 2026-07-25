/** D-145 PA6 — Work-entity page substrate, contract-side types.
 *
 *  PA6 is the user-facing UI surface that turns the PA1 canonical
 *  schemas + PA2 Source primitive + PA3 CRUD ingredients + PA5 form
 *  renderer into a per-kind (task / note / commitment / project)
 *  list-search-create-edit surface with polymorphic-read "All Sources"
 *  mode + scoped-write through a Source dropdown.
 *
 *  Substrate exists at `packages/ui-shared/work-entity-page/` (HTML
 *  rendering) + `packages/contracts/src/work-entity-page/` (types,
 *  state machine, list filtering, source-dropdown options — pure
 *  logic). Same split pattern as PA5 form-renderer; pure logic here so
 *  recipe-install preflight + future MCP UI surfaces can consume the
 *  state shape without dragging in a DOM dependency.
 *
 *  Spec: D-145 § Phase PA6 (UI: icon entry points + Source
 *  dropdown + list/search/create) + § A.2 (Source primitive) + § A.3
 *  (form renderer substrate).
 */

import type { SourceKind } from '../source-primitive.js';
import type {
  BookingLifecycleState,
  CommitmentLifecycleState,
  ProjectState,
  WorkEntity,
  WorkEntityKind,
} from '../work-entities.js';

/** Icon names used by the work-entity primary nav. Each value is the
 *  `IconName` registered in `@recued/ui-shared/icons.generated`;
 *  layering is unchanged (both live in contracts — ui-shared imports
 *  contracts, never the reverse).
 *
 *  ⚠ ALIASED to `WorkEntityKind`, not re-spelled. This used to be a
 *  hand-copied `'task' | 'note' | 'commitment' | 'project'`, which is a
 *  SUBSET of the kind union — and a subset typechecks. A fifth kind
 *  left the copy stale with no error at all, so the kind simply had no
 *  legal icon name. One-to-one is also the real invariant: every kind
 *  in the nav needs exactly one icon, and the SVG entry in ui-shared's
 *  `icons.generated.ts` is what a new kind still has to add. */
export type WorkEntityIconName = WorkEntityKind;

/** Per-kind navigation specification — what icon represents the kind in
 *  primary nav, what plural / singular labels to render, what helper
 *  copy explains the surface to a first-time visitor. PA6 ships the
 *  closed map keyed on `WorkEntityKind`; future top_tier_kind UIs can
 *  layer their own specs after marketplace review. */
export interface WorkEntityNavSpec {
  kind: WorkEntityKind;
  /** Icon registered in `@recued/ui-shared/icons.generated`. */
  icon_name: WorkEntityIconName;
  /** "Tasks", "Notes", etc. — used in nav button label + page heading. */
  plural_label: string;
  /** "Task", "Note", etc. — used in the create-button label and edit
   *  dialog title. */
  singular_label: string;
  /** One-sentence empty-state copy shown when the kind has zero rows
   *  across every Source. Substrate supplies a default — host apps may
   *  override per surface. */
  empty_state_copy: string;
}

/** Sentinel value for the "All Sources" polymorphic-read dropdown
 *  option. The Source dropdown carries this as the first option; the
 *  state machine maps it onto `selected_source_id: null` so reads
 *  union across every registered Source for the kind (per § A.2.2). */
export const SOURCE_DROPDOWN_ALL_VALUE = '__all_sources__';

/** Options surfaced in the Source dropdown. Exactly one option per
 *  registered Source, prepended with the All-Sources sentinel. The
 *  `source_kind` includes a `'sentinel'` discriminator for the
 *  All-Sources option so callers can render it visually distinct
 *  without a separate code path. */
export interface SourceDropdownOption {
  /** `SOURCE_DROPDOWN_ALL_VALUE` for the All-Sources option;
   *  `SourceRegistration.id` otherwise. */
  id: string;
  /** Display label. The All-Sources option uses the static label
   *  `'All Sources'`; registered Sources use `source_label`. */
  label: string;
  /** `'sentinel'` for All-Sources; registration's `source_kind`
   *  otherwise. */
  source_kind: SourceKind | 'sentinel';
  /** Whether this Source can be the target of a create / update. The
   *  sentinel All-Sources option is `false` (caller must pick a
   *  concrete Source before creating). */
  write_capable: boolean;
  /** Whether this Source's rows are exposed via MCP. The sentinel
   *  option mirrors the union — `true` if any registered Source is
   *  exposed; otherwise `false`. */
  mcp_exposed: boolean;
}

/** Common dialog-state shape — every member of the discriminated
 *  union below carries these fields. */
interface WorkEntityPageDialogStateCommon {
  source_id: string;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  /** Bool flag the host flips after a successful submit dispatch.
   *  Lets the renderer disable the submit button while the rpc is in
   *  flight without the substrate having to model rpc state. */
  submitting?: boolean;
  /** Top-level error from the dispatched create / update rpc — e.g.
   *  storage failure. Distinct from per-field `errors` (which come
   *  from `validateForm` before submit). */
  submit_error?: string;
}

/** Create-mode dialog. `entity_id` is statically forbidden in create
 *  mode (the row doesn't exist yet). `source_id` defaults to the
 *  per-kind default-Source memory, then the Recued built-in. */
export interface WorkEntityPageDialogStateCreate extends WorkEntityPageDialogStateCommon {
  mode: 'create';
  entity_id?: undefined;
}

/** Edit-mode dialog. `entity_id` is statically required (the row
 *  must exist). `source_id` is the row's Source — read-only at PA6
 *  (the substrate doesn't move rows between Sources). */
export interface WorkEntityPageDialogStateEdit extends WorkEntityPageDialogStateCommon {
  mode: 'edit';
  entity_id: string;
}

/** Dialog state the page renders on top of the list view. `null` when
 *  no dialog is open. Discriminated by `mode` (Codex P2 fold —
 *  pre-fold flat union typed `entity_id?` on a non-discriminated
 *  shape, which let `mode: 'edit'` rows omit the id without a
 *  compile error).
 *
 *  `values` carries the in-flight form values (host app reads back
 *  via `readFormValues`); `errors` carries per-field validation
 *  errors (host app feeds via `validateForm`). Both are pass-through
 *  to PA5 form-renderer. */
export type WorkEntityPageDialogState =
  | WorkEntityPageDialogStateCreate
  | WorkEntityPageDialogStateEdit;

/** Page state — what the renderer reads from. Pure data; transitions
 *  produce a new value rather than mutating in place. Host app keeps
 *  the latest state and re-renders on patch. */
export interface WorkEntityPageState {
  /** Active work-entity kind. The nav highlights this kind; the page
   *  body renders the list / dialog for it. */
  kind: WorkEntityKind;
  /** Selected Source id, or `null` for All-Sources polymorphic-read
   *  mode. Substrate: the dropdown sentinel `SOURCE_DROPDOWN_ALL_VALUE`
   *  maps to `null` here; concrete Source ids map verbatim. */
  selected_source_id: string | null;
  /** Free-text search query over the visible entity list. Empty
   *  string means "no filter". Substrate filtering is case-insensitive
   *  + trims whitespace; matching applies per-kind (see
   *  `filterEntitiesBySearch`). */
  search_query: string;
  /** Open dialog; `null` when no dialog is up. */
  dialog: WorkEntityPageDialogState | null;
}

/** List-view sort direction. Closed list at PA6 — most kinds want a
 *  single canonical sort; ascending vs descending matches "next thing
 *  the user wants to act on first" per kind (§ A.6.1 alert recipes). */
export type WorkEntityListSortDirection = 'asc' | 'desc';

/** Per-kind list-view sort spec. Surface a closed-list at PA6 + leave
 *  room for a future user-pickable sort menu (post-PA6 follow-up; not
 *  in scope here). */
export interface WorkEntityListSortSpec {
  /** Field name on the canonical entity row. */
  field: string;
  direction: WorkEntityListSortDirection;
}

/** Lifecycle order for commitment list-view sorting. Pending +
 *  expired (still actionable per § A.1.3 — `escalate_overdue` keeps
 *  monetary commitments live past the deadline) sort ahead of
 *  fulfilled / cancelled terminal rows. */
export const COMMITMENT_LIFECYCLE_LIST_ORDER: Readonly<
  Record<CommitmentLifecycleState, number>
> = Object.freeze({
  pending: 0,
  expired: 1,
  fulfilled: 2,
  cancelled: 3,
});

/** Project state order for list-view sorting. Active first (the kind
 *  the user wants to see top), paused next, completed / archived
 *  trailing. */
export const PROJECT_STATE_LIST_ORDER: Readonly<Record<ProjectState, number>> =
  Object.freeze({
    active: 0,
    paused: 1,
    completed: 2,
    archived: 3,
  });

/** A list row shape carries the entity plus the dropdown option of
 *  the Source it came from, so renderers in All-Sources mode can
 *  surface the Source label per row. The host app builds these via
 *  `joinEntitiesWithSources`. */
export interface WorkEntityListRow {
  entity: WorkEntity;
  source: SourceDropdownOption;
}

/** Renderer-side props for the list view. `rows` is the already
 *  filtered + sorted union; `kind` drives per-kind rendering
 *  (which fields to surface as primary / secondary / metadata). */
export interface WorkEntityListViewProps {
  kind: WorkEntityKind;
  rows: readonly WorkEntityListRow[];
  /** When `true`, list view renders the Source label per row.
   *  Typically true in All-Sources mode + false when scoped to one
   *  Source. */
  show_source_label: boolean;
  /** Per-kind empty-state copy when `rows.length === 0`. Falls back
   *  to `WorkEntityNavSpec.empty_state_copy` if omitted. */
  empty_state_copy?: string;
  /** Search query for echo + clear button. */
  search_query: string;
  /** Booking-only server-side lifecycle filter. */
  booking_lifecycle_filter?: BookingLifecycleState | 'all';
}

/** Re-export commonly composed types so consumers grab the full
 *  surface from one barrel import. */
export type { SourceRegistration } from '../source-primitive.js';
export type { WorkEntityKind, WorkEntity } from '../work-entities.js';
