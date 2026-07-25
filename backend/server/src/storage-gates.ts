/** Phase B gate registry.
 *
 *  Central composition point for every gated surface. The registry owns
 *  the six Phase B gates (vault, account_store, shared_store, cache,
 *  audit, schedules), hands each one its quota + reserve% pulled from
 *  the runtime config, and primes each with the live on-disk usage so
 *  the gate is correct from the first write.
 *
 *  Downstream consumers:
 *   - Commit 6 wires each store's write path to the gate via
 *     `gate.canWrite(bytes)` + `gate.addUsed/subUsed(delta)`.
 *   - Commit 8 subscribes to every gate's `onStateChange` to drive the
 *     eviction cascade.
 *   - Commit 9 reads `gate.info()` per-surface to build the heartbeat
 *     + `server.getStatus` pressure_details envelope.
 *
 *  Wiring in `bin.ts`: compute each surface's initial usage with its
 *  store-specific recipe (generic collections are one COUNT(length(data))
 *  per table; shared_store / cache have dedicated size columns), pass
 *  the resulting usage map in, and the registry takes care of gate
 *  construction. A single registry instance is shared across the
 *  bootstrap handler, the cache deps, the shared-handler deps, etc. */

import {
  createStorageGate,
  type StorageGate,
} from '@recued/storage-gate';
import type { RuntimeConfigStore } from '@recued/config';

/** The six Phase B gated surfaces. Adding one here also requires a
 *  quota lookup + reserve multiplier below AND a new entry in
 *  `SurfaceUsageMap` so the boot-time initial-usage pass is
 *  exhaustive. */
export const GATED_SURFACES = [
  'vault',
  'account_store',
  'shared_store',
  'cache',
  'audit',
  'schedules',
] as const;

export type GatedSurface = (typeof GATED_SURFACES)[number];

/** Byte counts per surface as seen at registry construction time. */
export type SurfaceUsageMap = Record<GatedSurface, number>;

export interface CreateGateRegistryOptions {
  config: RuntimeConfigStore;
  /** Live byte totals per surface at boot. Each gate is primed with
   *  `setUsed(initialUsage[surface])` so its state is correct before
   *  the first write. */
  initialUsage: SurfaceUsageMap;
  /** Time source — injectable for deterministic tests. */
  now?: () => number;
}

/** Options passed to `GateRegistry.register` for a Phase D dynamic
 *  surface (collection gates). Unlike the static Phase B surfaces,
 *  dynamic gates don't have their config resolved from the shared
 *  runtime config — the caller (each collection's constructor) does
 *  that lookup once with the per-collection config key and passes
 *  concrete numbers. Reconfiguration after the fact goes through the
 *  gate's own `reconfigure` method, not the registry. */
export interface DynamicGateSpec {
  /** Byte ceiling for this surface. */
  quota: number;
  /** Reserve percentage (0–100). File collections pass 1 to keep the
   *  baseline reserve; mail/webhook do the same — retention handles
   *  the eviction, not the reserve tier. */
  reservePct: number;
  /** Live byte total at registration time, used to prime the gate
   *  so its state is correct from the first write. Collections get
   *  this from `CollectionTable.totalBytes()`. */
  initialUsage: number;
}

export interface GateRegistry {
  vault: StorageGate;
  account_store: StorageGate;
  shared_store: StorageGate;
  cache: StorageGate;
  audit: StorageGate;
  schedules: StorageGate;
  /** Iterate all registered gates in a stable order — static
   *  Phase B surfaces first (in `GATED_SURFACES` order), then
   *  dynamic Phase D collection surfaces in registration order. */
  all(): StorageGate[];
  /** Lookup by surface name — covers both static and dynamic gates.
   *  Used by `server.runPressureReclaim` / `server.setPressureOverride`
   *  / heartbeat envelope / eviction cascade. */
  get(surface: string): StorageGate | undefined;
  /** Re-read each gate's config from the `RuntimeConfigStore` and
   *  call `reconfigure` on any that changed. Touches static gates
   *  only — dynamic collection gates own their own config sources. */
  reconfigureFromConfig(): void;
  /** Register a dynamic (Phase D) surface. `name` must be globally
   *  unique and follow the `collection:{platform}:{slug}` shape so
   *  the eviction cascade can parse it. Throws on duplicate name or
   *  collision with a static Phase B surface. Returns the newly-
   *  created gate so the caller can plumb `setUsed` / `addUsed`
   *  hooks immediately. */
  register(name: string, spec: DynamicGateSpec): StorageGate;
  /** Remove a dynamic gate (Phase D). Returns `true` when a gate
   *  was present; `false` otherwise. Static Phase B gates can't be
   *  unregistered — the call is a no-op on those names. */
  unregister(name: string): boolean;
  /** Subscribe to dynamic-gate registrations. The cascade wires this
   *  to auto-subscribe its `onStateChange` listener so gates added
   *  after cascade construction still drive reclaims. Returns an
   *  unsubscribe handle. */
  onGateRegistered(listener: (gate: StorageGate, name: string) => void): () => void;
}

// ────────────────────────────────────────────────────────────────
// Per-surface configuration lookup
// ────────────────────────────────────────────────────────────────

/** Fallback quotas applied when a surface's config key isn't in the
 *  runtime schema yet (new Phase B keys ship in Commit 11). Once the
 *  schema carries every key, these fallbacks are dead code — kept here
 *  so boot doesn't crash if an older config TOML is pointed at a newer
 *  daemon. */
const QUOTA_FALLBACKS: Readonly<Record<GatedSurface, number>> = {
  vault: 50 * 1024 * 1024,
  account_store: 10 * 1024 * 1024,
  shared_store: 100 * 1024 * 1024,
  cache: 200 * 1024 * 1024,
  audit: 50 * 1024 * 1024,
  schedules: 5 * 1024 * 1024,
};

/** Reserve percentage applied per surface. Surfaces that need reserved
 *  headroom for diagnostic / identity writes at `writes_blocked` pick
 *  it up from `storage.reserve_pct`; audit doubles it so pressure-
 *  transition rows always land. Fully user-evictable surfaces (cache,
 *  shared_store) run with 0 reserve — the user sees the full quota. */
const RESERVE_MULTIPLIER: Readonly<Record<GatedSurface, number>> = {
  vault: 1,
  account_store: 1,
  shared_store: 0,
  cache: 0,
  audit: 2,
  schedules: 1,
};

interface SurfaceResolvedConfig {
  quota: number;
  reservePct: number;
}

/** Resolve a surface's live `{ quota, reservePct }` from the runtime
 *  config. Reads `storage.reserve_pct` for the base reserve and
 *  multiplies per `RESERVE_MULTIPLIER`. Reads the surface's own quota
 *  key with a fallback to `QUOTA_FALLBACKS[surface]`. */
const resolveSurfaceConfig = (
  config: RuntimeConfigStore,
  surface: GatedSurface,
): SurfaceResolvedConfig => {
  const quotaKey = QUOTA_KEY[surface];
  let quota: number;
  try {
    quota = config.get(quotaKey) as number;
  } catch {
    quota = QUOTA_FALLBACKS[surface];
  }
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) {
    quota = QUOTA_FALLBACKS[surface];
  }
  let baseReserve: number;
  try {
    baseReserve = config.get('storage.reserve_pct') as number;
  } catch {
    baseReserve = 2;
  }
  if (typeof baseReserve !== 'number' || !Number.isFinite(baseReserve)) {
    baseReserve = 2;
  }
  const reservePct = Math.min(
    100,
    Math.max(0, baseReserve * RESERVE_MULTIPLIER[surface]),
  );
  return { quota, reservePct };
};

/** Map each surface to its runtime-config quota key. Lives here so a
 *  single change site adds a new surface (entry here + entry in
 *  `RESERVE_MULTIPLIER` + entry in `QUOTA_FALLBACKS` + entry in
 *  `SurfaceUsageMap`). */
const QUOTA_KEY: Readonly<Record<GatedSurface, string>> = {
  vault: 'vault.quota.total_bytes',
  account_store: 'account.quota.bytes',
  shared_store: 'data.shared.quota.bytes',
  cache: 'cache.max_bytes',
  audit: 'audit.quota.bytes',
  schedules: 'scheduler.quota.bytes',
};

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

export const createGateRegistry = (
  opts: CreateGateRegistryOptions,
): GateRegistry => {
  const { config, initialUsage, now } = opts;

  const buildGate = (surface: GatedSurface): StorageGate => {
    const { quota, reservePct } = resolveSurfaceConfig(config, surface);
    const gate = createStorageGate({ quota, reservePct, surface, now });
    const used = initialUsage[surface];
    if (typeof used === 'number' && used >= 0) {
      gate.setUsed(used);
    }
    return gate;
  };

  const byName: Record<GatedSurface, StorageGate> = {
    vault: buildGate('vault'),
    account_store: buildGate('account_store'),
    shared_store: buildGate('shared_store'),
    cache: buildGate('cache'),
    audit: buildGate('audit'),
    schedules: buildGate('schedules'),
  };

  const lookup = new Map<string, StorageGate>();
  for (const surface of GATED_SURFACES) {
    lookup.set(surface, byName[surface]);
  }

  // Dynamic gates (Phase D collection surfaces). Insertion order
  // preserved so `all()` returns a stable sequence; the `lookup` map
  // above also carries these entries for O(1) `get`.
  const dynamicGates = new Map<string, StorageGate>();
  type RegisteredListener = (gate: StorageGate, name: string) => void;
  const registeredListeners = new Set<RegisteredListener>();

  const reconfigureFromConfig = (): void => {
    for (const surface of GATED_SURFACES) {
      const { quota, reservePct } = resolveSurfaceConfig(config, surface);
      byName[surface].reconfigure({ quota, reservePct });
    }
  };

  return {
    ...byName,
    all() {
      return [
        ...GATED_SURFACES.map((s) => byName[s]),
        ...dynamicGates.values(),
      ];
    },
    get(surface) {
      return lookup.get(surface);
    },
    reconfigureFromConfig,
    register(name, spec) {
      if (name.length === 0) {
        throw new Error('GateRegistry.register: name is required');
      }
      if (lookup.has(name)) {
        throw new Error(
          `GateRegistry.register: duplicate surface name '${name}'`,
        );
      }
      const gate = createStorageGate({
        quota: spec.quota,
        reservePct: spec.reservePct,
        surface: name,
        now,
      });
      if (spec.initialUsage >= 0) gate.setUsed(spec.initialUsage);
      dynamicGates.set(name, gate);
      lookup.set(name, gate);
      for (const listener of registeredListeners) {
        try { listener(gate, name); } catch { /* never break a register */ }
      }
      return gate;
    },
    unregister(name) {
      if (!dynamicGates.has(name)) return false;
      dynamicGates.delete(name);
      lookup.delete(name);
      return true;
    },
    onGateRegistered(listener) {
      registeredListeners.add(listener);
      return () => { registeredListeners.delete(listener); };
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Boot-time initial-usage helpers
// ────────────────────────────────────────────────────────────────

/** Internal: sum the UTF-8 byte length of every `data` cell in a
 *  generic `createSQLiteCollection` table. Used by `computeInitialUsage`
 *  for vault / audit / account_store / schedules. */
export const tableDataBytes = (
  db: import('better-sqlite3').Database,
  table: string,
): number => {
  // Existence check — the table only exists once its owning
  // collection is constructed, which bin.ts does before this helper
  // runs. Return 0 defensively otherwise so tests that skip certain
  // stores don't crash.
  const exists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table) as { name: string } | undefined;
  if (!exists) return 0;
  const row = db
    .prepare(`SELECT COALESCE(SUM(length(data)), 0) AS total FROM ${table}`)
    .get() as { total: number };
  return row.total;
};

/** Sum the byte length of every row across two columns of a specialised
 *  table. Used by `shared_store` + `cache` whose schemas carry their
 *  own `size_bytes` column (populated at write time). */
export const tableSizeColumn = (
  db: import('better-sqlite3').Database,
  table: string,
): number => {
  const exists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table) as { name: string } | undefined;
  if (!exists) return 0;
  const row = db
    .prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS total FROM ${table}`)
    .get() as { total: number };
  return row.total;
};

export interface ComputeInitialUsageDeps {
  db: import('better-sqlite3').Database;
}

/** Compute the boot-time usage total for every Phase B surface.
 *  Conservative: missing tables return 0 (e.g. an ephemeral server
 *  without an audit log). The resulting map can be passed directly
 *  into `createGateRegistry({ initialUsage })`. */
export const computeInitialUsage = (
  deps: ComputeInitialUsageDeps,
): SurfaceUsageMap => {
  const { db } = deps;
  return {
    // `server_vault` (backed by `createSQLiteCollection`) — row `data`
    // column holds the encrypted entry envelope, which is already the
    // on-disk byte cost.
    vault: tableDataBytes(db, 'server_vault'),
    account_store: tableDataBytes(db, 'account_store'),
    // shared_store carries its own `size_bytes` column (populated by
    // its write path so inline + CAS rows both contribute the post-
    // serialisation size).
    shared_store: tableSizeColumn(db, 'shared_store'),
    // Cache uses a `size_bytes` column too; the blob filesystem's
    // contribution is the blob's byte count stored in that column.
    cache: tableSizeColumn(db, 'cache_entries'),
    audit:
      tableDataBytes(db, 'audit_entries') +
      tableDataBytes(db, 'audit_activities'),
    schedules: tableDataBytes(db, 'schedules'),
  };
};
