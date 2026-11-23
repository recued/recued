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
 *  are distinct semantic operations. Task completion also has an explicit
 *  paired-client RPC below for the Today actions.
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
  Commitment,
} from './work-entities.js';
import type { WorkEntitySourceFreshness } from './work-entity-sources.js';
import type { WorkEntityEdgeView } from './work-entity-edges.js';
import type { TaskListFilter } from './task-data-view.js';
import type { CommitmentViewFilters } from './commitment-data-view.js';

export const WORK_ENTITY_SEARCH_KINDS = ['task', 'note', 'project', 'commitment', 'booking'] as const;
export type WorkEntitySearchKind = typeof WORK_ENTITY_SEARCH_KINDS[number];

/** Owner-only, local indexed search. Omitting kind searches all five kinds.
 *  A single kind may be paged; visibility is applied before limit/offset. */
export interface WorkEntitySearchRpcRequest {
  query: string;
  kind?: WorkEntitySearchKind;
  limit?: number;
  offset?: number;
}

export interface WorkEntitySearchMatch {
  id: string;
  title: string;
  excerpt: string;
  source_id: string;
  source_label: string;
  updated_at: number;
  stale: boolean;
  source_incomplete?: true;
  pending_write: boolean;
}

export interface WorkEntitySearchGroup {
  kind: WorkEntitySearchKind;
  matches: WorkEntitySearchMatch[];
  offset: number;
  more: boolean;
  /** The kind failed independently; other groups remain usable. */
  error?: string;
}

export interface WorkEntitySearchRpcResponse {
  groups: WorkEntitySearchGroup[];
}

/** Incoming links in saved Notes and task notes, scoped to one webclient URL. */
export interface WorkEntityLinkedFromRpcRequest {
  url: string; limit?: number; offset?: number;
  /** Independently paged saved calendar events explicitly linking this email. */
  calendar_offset?: number;
  /** Refuse a Contact page whose identity changed while it was open. */
  contact_identity?: { id: string; created_at: number };
  /** Bind a source reader to the current account and stored record. */
  source_identity?: { source_id: string; received_at: number; incarnation: string | null };
}
export interface WorkEntityLinkedFromItem extends WorkEntitySearchMatch {
  kind: 'task' | 'note';
  created_at: number;
  source_record_id?: string;
}
export interface LinkedCalendarEvent {
  slug: string; record_id: string; source_id: string; received_at: number; incarnation: string;
  calendar_id: string; calendar_name: string; title: string; start_at: number; end_at: number;
  timezone: string; is_all_day: boolean; status: 'confirmed' | 'tentative' | 'cancelled'; updated_at: number;
  stale: boolean;
}
export interface LinkedCalendarPage {
  items: LinkedCalendarEvent[]; offset: number; more: boolean; unavailable_sources: string[];
}
export interface WorkEntityLinkedFromRpcResponse {
  /** Current contact group, resolved without rewriting saved link text. */
  contact_target?: { id: string; created_at: number; reference_ids: string[] };
  source_target?: NonNullable<WorkEntityLinkedFromRpcRequest['source_identity']>;
  items: WorkEntityLinkedFromItem[];
  offset: number;
  more: boolean;
  /** These sources retain no saved bodies locally and cannot be indexed. */
  provider_only_sources?: string[];
  /** Present only when saved calendar-link discovery is supported for Mail. */
  calendar?: LinkedCalendarPage;
}

export type ProjectWorkKind = 'task' | 'note' | 'commitment';
export type ProjectAttentionScope = 'overdue_tasks' | 'due_soon_tasks' | 'blocking_commitments';
export interface WorkEntityProjectAttentionRpcRequest {
  project_id: string;
  time_zone: string;
  project_identity?: { source_id: string; source_record_id?: string | null; created_at: number };
  scope?: ProjectAttentionScope;
  limit?: number;
  offset?: number;
  /** Reuse the returned window while paging. Expires after fifteen minutes. */
  as_of?: number;
}
export interface ProjectAttentionIssue {
  kind: 'project' | 'task' | 'commitment';
  source_label: string;
  reason: 'provider_only' | 'stale' | 'incomplete' | 'pending_project';
}
export interface WorkEntityProjectAttentionRpcResponse {
  project: Extract<WorkEntity, { _kind: 'project' }>;
  as_of: number;
  checked_at: number;
  time_zone: string;
  upcoming_before: number;
  counts: { open_tasks: number; completed_tasks: number; overdue_tasks: number; due_soon_tasks: number; blocking_commitments: number };
  coverage: { issues: ProjectAttentionIssue[]; omitted: number };
  scope?: ProjectAttentionScope;
  items: WorkEntityProjectItem[];
  offset: number;
  total: number;
  more: boolean;
}

export interface WorkEntityProjectItemsRpcRequest {
  project_id: string;
  kind: ProjectWorkKind;
  /** Literal text in linked titles, note/task bodies or commitment statements;
   * trimmed, at most 200 characters, applied before paging and counts. */
  query?: string;
  limit?: number;
  offset?: number;
  /** Commitment-only; defaults to outstanding promises. */
  commitment_status?: 'open' | 'all';
  /** Task-only; defaults to all for existing clients. Applied before paging. */
  task_completion?: 'all' | 'open' | 'completed';
}
/** A display preview; opening an item still reads its current canonical row. */
export interface WorkEntityProjectItem extends WorkEntitySearchMatch {
  /** Task identity for guarded inline completion; absent on older servers. */
  created_at?: number;
  source_record_id?: string;
  done?: boolean;
  due_at?: number;
  commitment?: Pick<Commitment, 'direction' | 'lifecycle_state' | 'due_status' | 'promised_for_at'> & {
    counterparty_label?: string;
  };
}
export interface WorkEntityProjectItemsRpcResponse {
  project_id: string;
  kind: ProjectWorkKind;
  items: WorkEntityProjectItem[];
  total: number;
  offset: number;
  /** Echoes the applied text, including empty text. Absent on older servers. */
  query?: string;
  /** Present only for tasks; counts visible project tasks matching the query,
   * before the completion filter. Empty query counts the complete project. */
  open_tasks?: number;
  total_tasks?: number;
  /** Echoes the applied task scope; absent on servers without task filtering. */
  task_completion?: 'all' | 'open' | 'completed';
  /** Echoes the applied commitment scope so mixed or older replies cannot masquerade as a filtered page. */
  commitment_status?: 'open' | 'all';
  /** Provider-only sources do not contribute local rows or counts. */
  provider_only_sources?: string[];
}

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
  /** Task/booking/commitment search across the complete result set, before pagination. */
  search?: string;
  /** Task-only completion, resolved date window, and ordering. */
  task_filter?: TaskListFilter;
  commitment_filter?: CommitmentViewFilters;
  /** Booking-only business lifecycle filter. */
  booking_lifecycle_states?: readonly BookingLifecycleState[];
}

export interface WorkEntityListRpcResponse {
  /** Owner display only, keyed by the stored counterparty id and forward-resolved after contact merges. */
  counterparty_labels?: Record<string, string>;
  /** Tagged records (`_kind` discriminator on each) so the caller can
   *  render a mixed list without re-deriving the kind. */
  entities: WorkEntity[];
  /** Count matching all query and visibility filters, ignoring limit/offset. */
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
  counterparty_labels?: Record<string, string>;
  entity: WorkEntity | null;
  /** Present for stored notes when conditional edits are supported. */
  note_edit_revision?: string;
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
  | ({ kind: 'asset' } & (import('./assets.js').AssetCreateInput | import('./assets.js').AssetUpdateInput))
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

/** Completion stays a separate semantic operation, including its reactive event. */
export interface WorkEntityTaskMarkDoneRpcRequest {
  id: string;
  done: boolean;
}
export interface WorkEntityTaskMarkDoneRpcResponse {
  entity: Extract<WorkEntity, { _kind: 'task' }>;
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
