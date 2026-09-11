/** D-145 PA2 — Source primitive resolver substrate.
 *
 *  Thin facade over `WorkEntityStore` that exposes the polymorphic +
 *  scoped read shapes named in § A.2.2:
 *
 *  - `data.<kind>.*` polymorphic across all registered Sources for a
 *    kind — `listByKind(kind)` walks every Source's rows and unions
 *    them. The store's per-kind `list*` methods are already polymorphic
 *    (they don't filter by `source_id` unless one is supplied), so the
 *    substrate-level read is a one-line dispatch.
 *  - `data.<kind>.<source_id>.*` scoped to one Source — a polymorphic
 *    list with `query.source_id` set. Validates kind matching against
 *    the registry so a recipe scoping `data.task.recued.note.*` errors
 *    cleanly instead of silently returning empty.
 *
 *  Plus snapshot helpers that engine-prefetch wiring can call to seed
 *  `stores.data.<kind>.*` for recipe-time `{{ref}}` resolution.
 *
 *  ⛔ The default-Source passthrough is GONE (D-187 Sources half) — write
 *  routing is `explicit source_id ?? built-in local`, never a stored pin.
 *
 *  Spec: D-145 § A.2 + Phase PA2. */

import {
  WORK_ENTITY_KIND_SET,
  type SourceRegistration,
  type SourceTopTierKind,
  type WorkEntity,
  type WorkEntityKind,
  type WorkEntitySourceFreshness,
} from '@recued/contracts';

import {
  WorkEntityValidationError,
  type WorkEntityListQuery,
  type WorkEntityStore,
} from './storage/work-entity-store.js';
import type { WorkEntitySourceSyncState } from './storage/work-entity-source-mirror.js';
import { classifyWorkEntitySourceFreshness } from './work-entity-read-resolution.js';

/** Class of resolver-time error surfaces. The substrate raises typed
 *  errors so callers (engine prefetch / MCP / Settings UI) can choose
 *  fall-throughs vs hard rejections per surface. */
export class WorkEntityResolverError extends Error {
  readonly code: 'unknown_kind' | 'unknown_source' | 'kind_source_mismatch';
  readonly source_id?: string;
  readonly kind?: WorkEntityKind;
  constructor(
    code: 'unknown_kind' | 'unknown_source' | 'kind_source_mismatch',
    message: string,
    detail: { source_id?: string; kind?: WorkEntityKind } = {},
  ) {
    super(message);
    this.name = 'WorkEntityResolverError';
    this.code = code;
    if (detail.source_id !== undefined) this.source_id = detail.source_id;
    if (detail.kind !== undefined) this.kind = detail.kind;
  }
}

export interface WorkEntityResolver {
  /** Polymorphic list across all registered Sources for `kind`.
   *  Default `sync_states` filter is applied by the underlying store
   *  (`live` + `stale_unreachable` only — tombstoned + orphaned
   *  excluded). ⛔ There is NO `enabled` filter — read is always FAN-OUT
   *  over every registered Source (D-187 Sources half). Pass `query.source_id` to scope
   *  to one Source — same shape as `listByKindScoped` but lets
   *  generic callers stay on one method. */
  listByKind(kind: WorkEntityKind, query?: WorkEntityListQuery): WorkEntity[];
  /** Scoped list against one Source. Validates the Source is
   *  registered + matches `kind` so the error surface is explicit
   *  instead of silent-empty. Pass-through to `listByKind` once
   *  validation succeeds. */
  listByKindScoped(
    kind: WorkEntityKind,
    source_id: string,
    query?: Omit<WorkEntityListQuery, 'source_id'>,
  ): WorkEntity[];
  /** Read one entity by id. Source-agnostic — any registered Source's
   *  row matches. Returns `null` when no row exists or the row is
   *  tombstoned (the store's `read*` methods exclude tombstones). */
  /** Text-search one kind through the FTS index, returning VISIBLE entities
   *  newest-updated first.
   *
   *  ⛔ NOT a `listByKind` with a filter. The list reads a bounded window
   *  (`ORDER BY updated_at DESC LIMIT n`) and would re-impose exactly the
   *  recency ceiling the index exists to remove — matching in the index reaches
   *  every row, then this re-reads only the hits. Same tombstone/orphan
   *  visibility as `readEntity`, applied per hit, so a stale index entry is
   *  dropped rather than served. */
  searchByText(kind: WorkEntityKind, query: string, limit: number): WorkEntity[];
  /** How many VISIBLE records of one kind exist, optionally within one Source.
   *  Feeds `work.search`'s query-miss hint, which must distinguish "you have no
   *  notes" from "your query matched none of your notes" — and with matching
   *  moved into the index there is no pre-filter list left to measure. */
  countByKind(kind: WorkEntityKind, source_id?: string): number;
  /** Match arbitrary texts under the index's own rule — see the store's
   *  `matchTextsByQuery`. The read tool's read-through half runs through this
   *  so live items and local rows are judged by ONE matcher. */
  matchTextsByQuery(texts: readonly string[], query: string): number[];
  readEntity(kind: WorkEntityKind, id: string): WorkEntity | null;
  /** Read one mirrored entity by its stable Source-native identity. This is
   *  the lookup half of an AI-facing qualified id; it applies the same
   *  tombstone/orphan visibility rules as `readEntity`. */
  readEntityBySourceIdentity(
    kind: WorkEntityKind,
    source_id: string,
    source_record_id: string,
  ): WorkEntity | null;
  /** Sources for one kind (or all kinds when `kind` is omitted).
   *  Returns the registry rows in registration order, unfiltered — the
   *  same set a polymorphic read draws from, since reads fan out over
   *  everything registered. */
  listSources(kind?: SourceTopTierKind): SourceRegistration[];
  /** Snapshot the polymorphic union under a kind into a flat
   *  `{ [entity_id]: WorkEntity }` map suitable for splicing into
   *  `stores.data.<kind>` ahead of recipe-time ref resolution.
   *  PA2's substrate read; engine prefetch lands later. */
  snapshotByKind(
    kind: WorkEntityKind,
    query?: WorkEntityListQuery,
  ): Record<string, WorkEntity>;
  /** Same shape as `snapshotByKind` but scoped to one Source. */
  snapshotByKindScoped(
    kind: WorkEntityKind,
    source_id: string,
    query?: Omit<WorkEntityListQuery, 'source_id'>,
  ): Record<string, WorkEntity>;
  /** D-192 read resolution — per-Source freshness verdicts for the
   *  Sources a polymorphic read under `kind` can draw from — i.e. every
   *  registered Source, optionally narrowed to one by `source_id`, since
   *  reads fan out. Computed from each connection Source's sync-state row;
   *  built-in Sources report `local`. Rides read-result metadata so
   *  callers surface staleness honestly (spec § Read resolution policy
   *  — poll is the freshness baseline). Null when no sync-state store
   *  is wired (distinct from an empty verdict set on an empty scope). */
  sourceFreshness(
    kind: WorkEntityKind,
    opts?: { source_id?: string },
  ): WorkEntitySourceFreshness[] | null;
}

/** Optional resolver capabilities beyond the store — threading the
 *  D-192 sync-state store lights up `sourceFreshness`. */
export interface WorkEntityResolverDeps {
  syncState?: { get(source_id: string): WorkEntitySourceSyncState | null };
  now?: () => number;
}

/** Validate `kind` is a known top-tier work-entity kind. Caller
 *  contract is "task | note | commitment | project"; the broader
 *  `SOURCE_TOP_TIER_KINDS` set (which includes mail / calendar /
 *  contact for future Source-backed surfaces) is intentionally NOT
 *  the resolver's domain at PA2. */
const requireWorkEntityKind = (kind: WorkEntityKind): void => {
  if (!WORK_ENTITY_KIND_SET.has(kind)) {
    throw new WorkEntityResolverError(
      'unknown_kind',
      `unknown work entity kind '${kind}'`,
      { kind },
    );
  }
};

/** Validate the Source is registered and bound to `kind` — the scoped-read
 *  path, where the validation gives a typed error instead of an empty list. */
const requireSourceForKind = (
  store: WorkEntityStore,
  kind: WorkEntityKind,
  source_id: string,
): void => {
  const reg = store.getSource(source_id);
  if (reg === null) {
    throw new WorkEntityResolverError(
      'unknown_source',
      `source_id '${source_id}' is not registered in source_registry`,
      { source_id, kind },
    );
  }
  if (reg.top_tier_kind !== kind) {
    throw new WorkEntityResolverError(
      'kind_source_mismatch',
      `source_id '${source_id}' is registered for top_tier_kind '${reg.top_tier_kind}', not '${kind}'`,
      { source_id, kind },
    );
  }
};

export const createWorkEntityResolver = (
  store: WorkEntityStore,
  deps: WorkEntityResolverDeps = {},
): WorkEntityResolver => {
  const visibleEntity = (row: WorkEntity | null): WorkEntity | null => {
    if (row === null || row.deleted_at !== undefined) return null;
    if (row.sync_state !== 'live' && row.sync_state !== 'stale_unreachable') {
      return null;
    }
    return row;
  };

  const listByKind: WorkEntityResolver['listByKind'] = (kind, query) => {
    requireWorkEntityKind(kind);
    return store.listByKind(kind, query);
  };

  const listByKindScoped: WorkEntityResolver['listByKindScoped'] = (
    kind,
    source_id,
    query,
  ) => {
    requireWorkEntityKind(kind);
    requireSourceForKind(store, kind, source_id);
    return store.listByKind(kind, { ...query, source_id });
  };

  const searchByText: WorkEntityResolver['searchByText'] = (kind, query, limit) => {
    requireWorkEntityKind(kind);
    const out: WorkEntity[] = [];
    for (const id of store.searchIdsByText(kind, query, limit)) {
      const entity = visibleEntity(store.readByKind(kind, id));
      if (entity !== null) out.push(entity);
    }
    out.sort((a, b) => b.updated_at - a.updated_at);
    return out;
  };

  const countByKind: WorkEntityResolver['countByKind'] = (kind, source_id) => {
    requireWorkEntityKind(kind);
    // Same default visibility filter the polymorphic list applies (live +
    // stale_unreachable; tombstoned + orphaned excluded), so the count cannot
    // claim records the search could never have returned.
    return store.countByKind(kind, source_id !== undefined ? { source_id } : undefined);
  };

  const matchTextsByQuery: WorkEntityResolver['matchTextsByQuery'] = (texts, query) =>
    store.matchTextsByQuery(texts, query);

  const readEntity: WorkEntityResolver['readEntity'] = (kind, id) => {
    requireWorkEntityKind(kind);
    // Codex P2 fold — `store.readByKind` (via the per-kind `read*`
    // methods) returns rows regardless of `sync_state` /
    // `deleted_at` because those methods drive Memory-style
    // by-id reads where the caller typically wants to surface
    // tombstoned + orphaned rows for audit. The resolver's
    // contract matches the polymorphic-list default-filter
    // (§ A.1.6 — "live + stale_unreachable only; tombstoned +
    // orphaned excluded"); apply the filter at the substrate
    // boundary so future engine prefetch + MCP reads that route
    // through the resolver cannot accidentally surface hidden
    // rows. Callers needing audit-visibility (PA9 producers,
    // future Memory reads) bypass the resolver and call
    // `store.readByKind` directly.
    return visibleEntity(store.readByKind(kind, id));
  };

  const readEntityBySourceIdentity:
    WorkEntityResolver['readEntityBySourceIdentity'] = (
      kind,
      source_id,
      source_record_id,
    ) => {
      requireWorkEntityKind(kind);
      return visibleEntity(
        store.readBySourceIdentity(kind, source_id, source_record_id),
      );
    };

  const listSources: WorkEntityResolver['listSources'] = (kind) =>
    store.listSources(kind);

  const snapshotByKind: WorkEntityResolver['snapshotByKind'] = (
    kind,
    query,
  ) => {
    const rows = listByKind(kind, query);
    const out: Record<string, WorkEntity> = Object.create(null);
    for (const row of rows) out[row.id] = row;
    return out;
  };

  const snapshotByKindScoped: WorkEntityResolver['snapshotByKindScoped'] = (
    kind,
    source_id,
    query,
  ) => {
    const rows = listByKindScoped(kind, source_id, query);
    const out: Record<string, WorkEntity> = Object.create(null);
    for (const row of rows) out[row.id] = row;
    return out;
  };

  const sourceFreshness: WorkEntityResolver['sourceFreshness'] = (
    kind,
    opts,
  ) => {
    requireWorkEntityKind(kind);
    const syncState = deps.syncState;
    if (syncState === undefined) return null;
    const now = (deps.now ?? Date.now)();
    let sources = store.listSources(kind);
    if (opts?.source_id !== undefined) {
      sources = sources.filter((s) => s.id === opts.source_id);
    }
    return sources.map((s) =>
      classifyWorkEntitySourceFreshness(s, syncState.get(s.id), now),
    );
  };

  return {
    listByKind,
    listByKindScoped,
    searchByText,
    countByKind,
    matchTextsByQuery,
    readEntity,
    readEntityBySourceIdentity,
    listSources,
    snapshotByKind,
    snapshotByKindScoped,
    sourceFreshness,
  };
};
