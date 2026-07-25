/** Pressure-state persistence (Phase B).
 *
 *  Gates live in RAM, but their *pressure history* persists across
 *  daemon restarts via the shared `server_state` table. On boot, each
 *  surface's `entered_at` row tells the heartbeat builder how long the
 *  surface has been non-`running` — so the UI can render "cache has
 *  been under pressure for 4h 12m" even when the daemon was bounced
 *  mid-window.
 *
 *  Two row families:
 *   - `pressure.{surface}.entered_at` — unix-ms the surface first left
 *     `running`. Cleared when the surface returns to `running`.
 *   - `pressure.{surface}.last_reclaim` — JSON with `at`, `bytes_freed`,
 *     `success`, `steps`. Written by the eviction cascade (Commit 8).
 *     Cleared when the surface returns to `running`.
 *
 *  Namespace isolation: pressure-state rows share the `server_state`
 *  table with crash_halt / staged-bootstrap rows (same lifecycle:
 *  toggles more often than config, pair-local only per D-097). Row
 *  keys are prefixed `pressure.` to keep the namespace flat. */

import type Database from 'better-sqlite3';

const TABLE = 'server_state';

/** Shape of the JSON-encoded `last_reclaim` row value. */
export interface PressureLastReclaim {
  /** Unix-ms of the reclaim attempt. */
  at: number;
  /** Bytes reclaimed across every pipeline step on this surface. */
  bytes_freed: number;
  /** True when the reclaim returned the surface to `running`. */
  success: boolean;
  /** Step identifiers the cascade actually ran. Used for audit /
   *  heartbeat diagnostics — renderers may display them or leave them
   *  collapsed. */
  steps: string[];
}

export interface PressureStateStore {
  /** Read the surface's entered_at unix-ms, or null if it's not in a
   *  non-`running` state (or the row was cleared). */
  getEnteredAt(surface: string): number | null;
  /** Write the surface's entered_at. Called on the first
   *  running → pressure_managed / writes_blocked transition; a
   *  subsequent re-entry during the same pressure window is expected
   *  to call this again — same semantics as `setCrashHalt(true)` on
   *  a kill switch that's already active: the earliest timestamp wins
   *  so "halted since 12:03" isn't reset by internal flaps. */
  setEnteredAt(surface: string, at: number): void;
  /** Drop both entered_at + last_reclaim rows for a surface — called
   *  on the transition back to `running`. */
  clearSurface(surface: string): void;
  /** Read the most recent reclaim snapshot for a surface. Null when
   *  no reclaim has run this pressure window. */
  getLastReclaim(surface: string): PressureLastReclaim | null;
  /** Write a reclaim snapshot. The cascade calls this after every
   *  pipeline pass regardless of success so the heartbeat can show
   *  "tried to reclaim at HH:MM, freed 0 bytes". */
  setLastReclaim(surface: string, snapshot: PressureLastReclaim): void;
  /** List every persisted surface key. Used by the boot-time
   *  reconciliation pass to align rows with current gate state (drop
   *  stale rows when a surface is back to `running`, keep otherwise). */
  listSurfaces(): string[];
}

const enteredKey = (surface: string): string => `pressure.${surface}.entered_at`;
const reclaimKey = (surface: string): string => `pressure.${surface}.last_reclaim`;

/** Live view onto the `server_state` table — no new table created,
 *  keyed by `pressure.{surface}.*`. Assumes the table already exists
 *  (ServerStateStore constructs it; this helper is always wired in
 *  composition roots that also wire the ServerStateStore). */
export const createPressureStateStore = (db: Database.Database): PressureStateStore => {
  // Defensive — create the table if the caller composed us before
  // ServerStateStore. Idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const getValue = (key: string): string | undefined => {
    const row = db.prepare(`SELECT value FROM ${TABLE} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  const putValue = (key: string, value: string, at: number): void => {
    db.prepare(
      `INSERT OR REPLACE INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run(key, value, at);
  };

  const delValue = (key: string): void => {
    db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).run(key);
  };

  return {
    getEnteredAt(surface) {
      const raw = getValue(enteredKey(surface));
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    },

    setEnteredAt(surface, at) {
      if (!Number.isFinite(at) || at < 0) return;
      const existing = this.getEnteredAt(surface);
      // Earliest-wins — a surface that briefly recovers and re-enters
      // pressure should keep the first entered_at so the UI surface
      // time reflects the whole window. Callers that WANT to reset
      // should call `clearSurface` first.
      if (existing !== null && existing <= at) return;
      putValue(enteredKey(surface), String(at), at);
    },

    clearSurface(surface) {
      delValue(enteredKey(surface));
      delValue(reclaimKey(surface));
    },

    getLastReclaim(surface) {
      const raw = getValue(reclaimKey(surface));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed
          && typeof parsed === 'object'
          && typeof parsed.at === 'number'
          && typeof parsed.bytes_freed === 'number'
          && typeof parsed.success === 'boolean'
          && Array.isArray(parsed.steps)
        ) {
          return parsed as PressureLastReclaim;
        }
      } catch { /* malformed — treat as absent */ }
      return null;
    },

    setLastReclaim(surface, snapshot) {
      const serialized = JSON.stringify(snapshot);
      putValue(reclaimKey(surface), serialized, snapshot.at);
    },

    listSurfaces() {
      const rows = db
        .prepare(
          `SELECT key FROM ${TABLE} WHERE key LIKE 'pressure.%.entered_at'`,
        )
        .all() as Array<{ key: string }>;
      return rows
        .map((r) => r.key.slice('pressure.'.length, -'.entered_at'.length))
        .sort();
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Boot-time reconciliation
// ────────────────────────────────────────────────────────────────

/** Align persisted pressure-state rows with live gate state at boot.
 *
 *  For each surface:
 *    - gate `running` + row present → drop the row (stale: we
 *      restarted into a healthy state).
 *    - gate non-running + row absent → seed a row with `at = now()`
 *      so the window clock starts ticking.
 *    - gate non-running + row present → leave the row untouched
 *      (pressure continuity across the restart).
 *
 *  This is the inverse of the runtime write-path: the cascade keeps
 *  rows fresh while the daemon is live; the boot pass closes any
 *  divergence the prior shutdown left behind.
 *
 *  Also returns the set of surfaces that still have an active pressure
 *  window so callers can feed them into the heartbeat builder without
 *  re-reading the state store. */
export interface ReconcileDeps {
  state: PressureStateStore;
  /** Live gates — usually `gateRegistry.all()`. */
  gates: ReadonlyArray<{ info: () => { surface: string; state: string } }>;
  now?: () => number;
}

export interface ReconcileResult {
  /** Surfaces that kept (or gained) an entered_at row. */
  active: string[];
  /** Surfaces whose rows were dropped because the gate is running. */
  cleared: string[];
  /** Surfaces that gained a fresh entered_at row (non-running at
   *  boot, no prior row). */
  seeded: string[];
}

export const reconcilePressureStateAtBoot = (
  deps: ReconcileDeps,
): ReconcileResult => {
  const now = deps.now ?? (() => Date.now());
  const active: string[] = [];
  const cleared: string[] = [];
  const seeded: string[] = [];

  const seenSurfaces = new Set<string>();

  for (const gate of deps.gates) {
    const info = gate.info();
    seenSurfaces.add(info.surface);
    const existing = deps.state.getEnteredAt(info.surface);
    if (info.state === 'running') {
      if (existing !== null) {
        deps.state.clearSurface(info.surface);
        cleared.push(info.surface);
      }
    } else {
      if (existing === null) {
        deps.state.setEnteredAt(info.surface, now());
        seeded.push(info.surface);
      }
      active.push(info.surface);
    }
  }

  // Drop rows for surfaces the gate set no longer reports — e.g. a
  // surface name was removed in a server upgrade. The row would
  // otherwise linger forever.
  for (const surface of deps.state.listSurfaces()) {
    if (!seenSurfaces.has(surface)) {
      deps.state.clearSurface(surface);
      cleared.push(surface);
    }
  }

  return { active, cleared, seeded };
};
