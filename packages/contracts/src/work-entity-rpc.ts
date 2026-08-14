/** D-174 #22 — Data warehouse pair-RPC request / response shapes.
 *
 *  The webclient Data route (D-174 D11 — "own it" kinds are editable,
 *  "mirror it" kinds are read-only drill-down via `data.timeline()`)
 *  talks the pair-WS-rpc channel, NOT MCP / recipe. These four
 *  `work_entity.*` entity-CRUD shapes give it a list / get / upsert /
 *  delete surface over the four own-it work-entity kinds (task / note /
 *  commitment / project), mirroring the existing `contact.*` warehouse-
 *  CRUD family exactly (shape + gating + channel treatment). The
 *  `data.timeline` read pair-RPC (the mirror-it drill-down feed) reuses
 *  the canonical `TimelineRequest` / `TimelineResponse` shapes directly
 *  — no new type, the third isolated channel alongside MCP + recipe.
 *
 *  Reuse-not-redefine: the per-kind create / update field sets ARE the
 *  existing PA3 ingredient input types (`TaskCreateInput` etc.) so the
 *  pair-RPC contract can never drift from the dispatcher it routes to.
 *  The upsert payload is a `kind`-discriminated union; `create` carries
 *  the kind's required fields (no `id`), `update` carries `id` + the
 *  mutable subset. Lifecycle moves (commitment fulfil / cancel, project
 *  archive, task mark-done) are deliberately NOT upsert targets — they
 *  are distinct semantic operations on the ingredient/recipe path.
 *
 *  Spec: D-174 D11 + D-145 § A.1 / A.2. */

import type {
  WorkEntity,
  WorkEntityKind,
  SyncState,
  TaskCreateInput,
  TaskUpdateInput,
  NoteCreateInput,
  NoteUpdateInput,
  CommitmentCreateInput,
  CommitmentUpdateInput,
  ProjectCreateInput,
  ProjectUpdateInput,
  BookingCreateInput,
  BookingUpdateInput,
  BookingHistorySummary,
  BookingLifecycleState,
  WorkEntityDeleteOutput,
} from './work-entities.js';
import type { WorkEntitySourceFreshness } from './work-entity-sources.js';
import type { WorkEntityEdgeView } from './work-entity-edges.js';

/** List one own-it kind, polymorphic across the kind's registered
 *  Sources (or scoped to one via `source_id`). Mirrors the resolver's
 *  `listByKind` default filters: `live` + `stale_unreachable` only.
 *  ⛔ No `include_disabled` — reads always fan out over every registered
 *  Source (D-187 Sources half); there is no disabled state to opt past. */
export interface WorkEntityListRpcRequest {
  kind: WorkEntityKind;
  source_id?: string;
  sync_states?: readonly SyncState[];
  include_deleted?: boolean;
  limit?: number;
  offset?: number;
  /** Booking-only, server-side search across the complete result set. */
  search?: string;
  /** Booking-only business lifecycle filter. */
  booking_lifecycle_states?: readonly BookingLifecycleState[];
}

export interface WorkEntityListRpcResponse {
  /** Tagged records (`_kind` discriminator on each) so the caller can
   *  render a mixed list without re-deriving the kind. */
  entities: WorkEntity[];
  /** Count matching the query's Source / sync filters (ignores
   *  `limit` / `offset`), for the list view's pagination. */
  total: number;
  /** D-192 read resolution — per-Source freshness for every Source the
   *  result can draw from (the query's scope, same filter composition
   *  as the rows), so the client renders staleness honestly instead of
   *  presenting a warm mirror as current (D-190
   *  `truncated`/`pages_fetched` precedent). Absent when the server has
   *  no sync substrate wired (older composition); an EMPTY array means
   *  the substrate is wired but the scope matched no Sources. */
  source_freshness?: WorkEntitySourceFreshness[];
}

/** Read one entity by `(kind, id)`. `null` when no `live` /
 *  `stale_unreachable` row exists (tombstoned + orphaned excluded —
 *  mirrors the resolver's `readEntity` filter). */
export interface WorkEntityGetRpcRequest {
  kind: WorkEntityKind;
  id: string;
}

export interface WorkEntityGetRpcResponse {
  entity: WorkEntity | null;
  /** D-192 read resolution — the entity's own Source freshness (absent
   *  when `entity` is null or the sync substrate isn't wired). A
   *  `stale` / `degraded` / `never_synced` verdict means the row is a
   *  poll mirror that may trail the vendor. */
  source_freshness?: WorkEntitySourceFreshness;
  /** D-192 P5 — the row's live work-graph edges (declared relationship
   *  references, scoped + resolved per the edge substrate). Absent when
   *  the edge substrate isn't wired or `entity` is null; an EMPTY array
   *  means the substrate is wired and the row has no edges — the two
   *  stay distinguishable on the wire (the `source_freshness`
   *  precedent). Contact edges carry the read-time survivor display
   *  identity (`target_display`). */
  relationship_edges?: WorkEntityEdgeView[];
  /** Owner-only prior completed/no-show history for a booking's opaque
   *  counterparty. Absent for every other kind and for unlinked bookings. */
  booking_history?: BookingHistorySummary;
}

/** Create (no `id`) or update (`id` present) one entity. The per-kind
 *  field set is the existing PA3 ingredient input — `create` requires
 *  the kind's required fields (`title` / `body` / `direction` …) and
 *  may carry `source_id`; `update` carries `id` + the mutable subset.
 *  Routed by `(kind, id-presence)` to the matching create / update
 *  dispatcher so the write fans the same `emitWorkEntityEvent` the
 *  recipe / MCP ingredient path does (reactive / trigger semantics
 *  hold). */
export type WorkEntityUpsertRpcRequest =
  | ({ kind: 'task' } & (TaskCreateInput | TaskUpdateInput))
  | ({ kind: 'note' } & (NoteCreateInput | NoteUpdateInput))
  | ({ kind: 'commitment' } & (CommitmentCreateInput | CommitmentUpdateInput))
  | ({ kind: 'project' } & (ProjectCreateInput | ProjectUpdateInput))
  | ({ kind: 'booking' } & (BookingCreateInput | BookingUpdateInput));

export interface WorkEntityUpsertRpcResponse {
  /** Tagged canonical record (`_kind` discriminator) for the
   *  created / updated entity. */
  entity: WorkEntity;
}

/** Delete one entity by `(kind, id)`. Default tombstone (`sync_state:
 *  'tombstoned'`) per § A.1.6 so cascade history + audit references
 *  resolve; `tombstone: false` hard-deletes (escape hatch). */
export interface WorkEntityDeleteRpcRequest {
  kind: WorkEntityKind;
  id: string;
  tombstone?: boolean;
}

/** Reuses the canonical `{ ok, id, tombstoned }` write-delete shape. */
export type WorkEntityDeleteRpcResponse = WorkEntityDeleteOutput;
