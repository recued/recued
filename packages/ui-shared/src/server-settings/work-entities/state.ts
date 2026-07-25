/** D-145 PA11 — Settings → Work Entities panel state.
 *
 *  Drives the panel renderer + the host's `work_entity.source.*`
 *  rpc dispatcher. Mount loads `work_entity.source.list` once; every
 *  toggle / default-change rpc returns the post-write Source row +
 *  the renderer patches it into `sources` without a follow-up read.
 *
 *  Spec: D-145 § PA11 + § A.2. */

import type {
  SourceRegistration,
  WorkEntityKind,
} from '@recued/contracts';

/** Per-Source pending-write slot. The host sets `pending: true` while
 *  an `enabled` / `mcp_exposed` toggle rpc is in-flight; the row
 *  renderer disables both checkboxes and surfaces the error inline
 *  on rpc failure. Slot is keyed by `source_id`. */
export interface WorkEntitySourceRowPending {
  pending: boolean;
  /** Inline error from the most recent toggle attempt. Cleared when
   *  the next attempt starts; survives across renders so the user
   *  sees the failure even on a stale layout. */
  error: string | null;
}

/** Per-kind pending-write slot for default-Source pin / clear. The
 *  set / clear rpcs share the slot — only one default-Source change
 *  can be in flight per kind at a time. */
export interface WorkEntityDefaultSourcePending {
  pending: boolean;
  error: string | null;
}

export interface WorkEntitiesPanelState {
  /** True while the initial `work_entity.source.list` rpc is in
   *  flight. The renderer shows a placeholder; subsequent reloads
   *  keep the prior `sources` visible (no flicker). */
  loading: boolean;
  /** Inline page-level error from a failed read. Per-toggle / per-
   *  default errors live in the per-Source / per-kind slots. */
  error: string | null;
  /** Most recent `work_entity.source.list` response. Empty array
   *  before first read. */
  sources: ReadonlyArray<SourceRegistration>;
  /** Per-kind default-Source map. The renderer reads this to drive
   *  the per-kind "Default Source" dropdown's selected value. */
  defaults_by_kind: Readonly<
    Partial<Record<WorkEntityKind, string>>
  >;
  /** Per-Source pending-write slots — keyed by source_id. The
   *  renderer omits the slot for any Source that doesn't have one. */
  pending_by_source: Readonly<
    Record<string, WorkEntitySourceRowPending>
  >;
  /** Per-kind default-Source pending-write slots — keyed by kind. */
  pending_by_default: Readonly<
    Partial<Record<WorkEntityKind, WorkEntityDefaultSourcePending>>
  >;
}

export const EMPTY_WORK_ENTITIES_PANEL_STATE: WorkEntitiesPanelState = {
  loading: true,
  error: null,
  sources: [],
  defaults_by_kind: {},
  pending_by_source: {},
  pending_by_default: {},
};
