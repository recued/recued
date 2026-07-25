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
 *  Plus default-Source memory passthrough (`getDefaultSource` /
 *  `setDefaultSource` / `clearDefaultSource`) and snapshot helpers
 *  that future engine-prefetch wiring (PA3 + later) can call to seed
 *  `stores.data.<kind>.*` for recipe-time `{{ref}}` resolution.
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
   *  excluded). Default `enabled` filter is also applied (PA11 —
   *  user-disabled Sources excluded; bypass via
   *  `query.include_disabled: true`). Pass `query.source_id` to scope
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
  readEntity(kind: WorkEntityKind, id: string): WorkEntity | null;
  /** Sources for one kind (or all kinds when `kind` is omitted).
   *  Returns the registry rows in registration order. PA11 — surface
   *  carries the `enabled` field; Settings UI consumes it directly.
   *  No filtering at the resolver layer — all Sources visible so the
   *  Settings panel can manage them. Polymorphic recipe reads enforce
   *  the disabled filter at the storage layer (see `listByKind`). */
  listSources(kind?: SourceTopTierKind): SourceRegistration[];
  /** D-145 PA11 — flip the user-driven enable/disable toggle on one
   *  Source. Wrapper over the store mutation; surfaces the
   *  post-write registration row. */
  setSourceEnabled(source_id: string, enabled: boolean): SourceRegistration;
  /** D-145 PA11 — flip the per-Source MCP exposure boolean. */
  setSourceMcpExposed(
    source_id: string,
    mcp_exposed: boolean,
  ): SourceRegistration;
  /** Default-Source memory passthrough — `null` when no default
   *  pinned. Backs the `prefs.<kind>.last_used_source_id` recipe
   *  read path. */
  getDefaultSource(kind: WorkEntityKind): string | null;
  /** Pin a per-kind default. Re-validates the Source registration
   *  + kind match through the underlying store. */
  setDefaultSource(kind: WorkEntityKind, source_id: string, now?: number): void;
  /** Drop the per-kind default. Returns `true` when a row was
   *  cleared; `false` when nothing was pinned. */
  clearDefaultSource(kind: WorkEntityKind): boolean;
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
   *  Sources a polymorphic read under `kind` can draw from. The filter
   *  set COMPOSES exactly like the store's list filters (disabled
   *  Sources excluded unless `include_disabled` — also under an
   *  explicit `source_id` scope, matching the PA11 store fold), so the
   *  metadata never claims freshness for a Source the result cannot
   *  contain. Computed from each connection Source's sync-state row;
   *  built-in Sources report `local`. Rides read-result metadata so
   *  callers surface staleness honestly (spec § Read resolution policy
   *  — poll is the freshness baseline). Null when no sync-state store
   *  is wired (distinct from an empty verdict set on an empty scope). */
  sourceFreshness(
    kind: WorkEntityKind,
    opts?: { source_id?: string; include_disabled?: boolean },
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

/** Validate the Source is registered and bound to `kind`. The
 *  underlying `setDefaultSource` runs the same check at write time
 *  via `internal.sourceTopTierKind`; we re-run it here for the
 *  scoped-read path (where the validation gives a typed error
 *  instead of an empty list). */
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
    const row = store.readByKind(kind, id);
    if (row === null) return null;
    if (row.deleted_at !== undefined) return null;
    if (row.sync_state !== 'live' && row.sync_state !== 'stale_unreachable') {
      return null;
    }
    return row;
  };

  const listSources: WorkEntityResolver['listSources'] = (kind) =>
    store.listSources(kind);

  const setSourceEnabled: WorkEntityResolver['setSourceEnabled'] = (
    source_id,
    enabled,
  ) => store.setSourceEnabled(source_id, enabled);

  const setSourceMcpExposed: WorkEntityResolver['setSourceMcpExposed'] = (
    source_id,
    mcp_exposed,
  ) => store.setSourceMcpExposed(source_id, mcp_exposed);

  const getDefaultSource: WorkEntityResolver['getDefaultSource'] = (kind) => {
    requireWorkEntityKind(kind);
    return store.getDefaultSource(kind);
  };

  const setDefaultSource: WorkEntityResolver['setDefaultSource'] = (
    kind,
    source_id,
    now,
  ) => {
    requireWorkEntityKind(kind);
    // Defer the kind/Source-registration check to the store so the
    // resolver doesn't double-throw on the same condition; the store
    // raises `WorkEntityValidationError` which is the canonical error
    // for the storage-layer validation. Wrap in the resolver-error
    // shape for consistency at the substrate-facing boundary.
    try {
      store.setDefaultSource(kind, source_id, now);
    } catch (err) {
      if (err instanceof WorkEntityValidationError) {
        const isUnknown = err.message.includes('not registered');
        throw new WorkEntityResolverError(
          isUnknown ? 'unknown_source' : 'kind_source_mismatch',
          err.message,
          { source_id, kind },
        );
      }
      throw err;
    }
  };

  const clearDefaultSource: WorkEntityResolver['clearDefaultSource'] = (
    kind,
  ) => {
    requireWorkEntityKind(kind);
    return store.clearDefaultSource(kind);
  };

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
    // Compose the filters exactly like the store's list WHERE (codex
    // fold): the disabled filter applies even under an explicit
    // `source_id` scope — a scoped list on a disabled Source returns
    // zero rows, so it must report zero freshness too.
    if (opts?.include_disabled !== true) {
      sources = sources.filter((s) => s.enabled !== false);
    }
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
    readEntity,
    listSources,
    setSourceEnabled,
    setSourceMcpExposed,
    getDefaultSource,
    setDefaultSource,
    clearDefaultSource,
    snapshotByKind,
    snapshotByKindScoped,
    sourceFreshness,
  };
};
