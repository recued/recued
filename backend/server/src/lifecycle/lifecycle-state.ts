/** Lifecycle state machine + `server_state` persistence (Phase C).
 *
 *  Two pieces live here:
 *
 *    1. `LifecycleStateStore` — typed read/write helpers for the
 *       `lifecycle.*` keys in the existing `server_state` table.
 *       Plaintext JSON; persistence is for crash-loop detection and
 *       cross-restart continuity, not sensitive data.
 *
 *    2. `LifecycleStateMachine` — in-memory `LifecycleState` with
 *       transition validation. Observers subscribe to state-change
 *       events; composition-root code (Phase C commit 9) uses these
 *       to wire the store, heartbeat, and audit emitter.
 *
 *  The state machine is intentionally simple — linear transitions,
 *  no re-entry, no retries. A drain orchestrator (commit 4) drives
 *  the transitions; the state machine just enforces the shape. */

import type Database from 'better-sqlite3';
import type {
  DrainState,
  LifecycleLastCrash,
  LifecycleState,
  ResolvedSupervisorMode,
} from '@recued/contracts';
import { LIFECYCLE_STATE_RANK } from '@recued/contracts';

const TABLE = 'server_state';

const KEY_BOOT_AT = 'lifecycle.boot_at';
const KEY_RESTART_COUNT = 'lifecycle.restart_count';
const KEY_SHUTDOWN_AT = 'lifecycle.shutdown_at';
const KEY_LAST_CRASH = 'lifecycle.last_crash';
const KEY_RESTART_PENDING = 'lifecycle.restart_pending';

// ────────────────────────────────────────────────────────────────
// Store
// ────────────────────────────────────────────────────────────────

export interface LifecycleStateStore {
  getBootAt(): number | null;
  setBootAt(ts: number): void;

  getRestartCount(): number;
  incrementRestartCount(): number;
  resetRestartCount(): void;

  /** Unix-ms of the last clean exit. Present iff the previous process
   *  exited cleanly (via drain → `restarting` or `shutting_down`).
   *  Absent iff the process crashed, was SIGKILL'd, or died before
   *  reaching the end of the drain pipeline. */
  getShutdownAt(): number | null;
  markCleanShutdown(ts: number): void;
  clearShutdownAt(): void;

  getLastCrash(): LifecycleLastCrash | null;
  setLastCrash(crash: LifecycleLastCrash): void;
  clearLastCrash(): void;

  /** SIGHUP reload can include `[bootstrap]` keys that require a
   *  restart to apply. This flag is separate from `stageBootstrap`'s
   *  pending patch — both contribute to the heartbeat `restart_pending`
   *  signal, but they have independent lifecycles. */
  getRestartPending(): boolean;
  setRestartPending(pending: boolean): void;
}

export const createLifecycleStateStore = (
  db: Database.Database,
): LifecycleStateStore => {
  // Table is created by `createServerStateStore` in Phase A; this
  // module reuses the same table. Still run CREATE IF NOT EXISTS so
  // a standalone use (tests) doesn't require the other store.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const get = (key: string): string | undefined => {
    const row = db.prepare(`SELECT value FROM ${TABLE} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  const put = (key: string, value: string, updatedAt: number): void => {
    db.prepare(
      `INSERT OR REPLACE INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run(key, value, updatedAt);
  };

  const del = (key: string): void => {
    db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).run(key);
  };

  const parseInt10 = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };

  return {
    getBootAt: () => parseInt10(get(KEY_BOOT_AT)),
    setBootAt(ts) {
      put(KEY_BOOT_AT, String(ts), ts);
    },

    getRestartCount: () => parseInt10(get(KEY_RESTART_COUNT)) ?? 0,
    incrementRestartCount() {
      const next = (parseInt10(get(KEY_RESTART_COUNT)) ?? 0) + 1;
      put(KEY_RESTART_COUNT, String(next), Date.now());
      return next;
    },
    resetRestartCount() {
      del(KEY_RESTART_COUNT);
    },

    getShutdownAt: () => parseInt10(get(KEY_SHUTDOWN_AT)),
    markCleanShutdown(ts) {
      put(KEY_SHUTDOWN_AT, String(ts), ts);
    },
    clearShutdownAt() {
      del(KEY_SHUTDOWN_AT);
    },

    getLastCrash: () => {
      const raw = get(KEY_LAST_CRASH);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.at === 'number' &&
          typeof parsed.reason === 'string' &&
          typeof parsed.exit_code === 'number'
        ) {
          return parsed as LifecycleLastCrash;
        }
      } catch {
        /* malformed — treat as absent */
      }
      return null;
    },
    setLastCrash(crash) {
      put(KEY_LAST_CRASH, JSON.stringify(crash), crash.at);
    },
    clearLastCrash() {
      del(KEY_LAST_CRASH);
    },

    getRestartPending: () => get(KEY_RESTART_PENDING) === '1',
    setRestartPending(pending) {
      if (pending) put(KEY_RESTART_PENDING, '1', Date.now());
      else del(KEY_RESTART_PENDING);
    },
  };
};

// ────────────────────────────────────────────────────────────────
// State machine
// ────────────────────────────────────────────────────────────────

/** Valid transitions out of each state. Rank-preserving (see
 *  `LIFECYCLE_STATE_RANK`) except that `crashed` is reachable from
 *  any non-terminal state — unhandled exceptions can fire at any time.
 *  Terminal states (`restarting` / `shutting_down` / `crashed`) have
 *  no outgoing transitions; the process exits shortly after. */
const VALID_TRANSITIONS: Readonly<Record<LifecycleState, ReadonlySet<LifecycleState>>> = {
  booting: new Set(['running', 'crashed']),
  running: new Set(['draining', 'crashed']),
  draining: new Set(['restarting', 'shutting_down', 'crashed']),
  restarting: new Set(),
  shutting_down: new Set(),
  crashed: new Set(),
};

export class InvalidTransitionError extends Error {
  constructor(from: LifecycleState, to: LifecycleState) {
    super(`invalid lifecycle transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export type LifecycleStateChangeHandler = (
  prev: LifecycleState,
  next: LifecycleState,
) => void;

export interface LifecycleStateMachine {
  readonly state: LifecycleState;
  /** Transition to `next`. Throws `InvalidTransitionError` when the
   *  transition isn't permitted (see `VALID_TRANSITIONS`). Observers
   *  are notified synchronously, in registration order, AFTER the
   *  state flips — so a handler reading `machine.state` sees `next`. */
  transition(next: LifecycleState): void;
  /** Subscribe to every state change. Returns an unsubscribe function. */
  onStateChange(handler: LifecycleStateChangeHandler): () => void;
  /** True when `state` is at or past `target` in `LIFECYCLE_STATE_RANK`. */
  isAtLeast(target: LifecycleState): boolean;
}

export const createLifecycleStateMachine = (
  initial: LifecycleState = 'booting',
): LifecycleStateMachine => {
  let state: LifecycleState = initial;
  const handlers: LifecycleStateChangeHandler[] = [];

  return {
    get state() {
      return state;
    },

    transition(next) {
      if (state === next) return;   // idempotent same-state flip
      const allowed = VALID_TRANSITIONS[state];
      if (!allowed.has(next)) {
        throw new InvalidTransitionError(state, next);
      }
      const prev = state;
      state = next;
      for (const h of handlers) {
        try {
          h(prev, next);
        } catch {
          /* swallow — a broken observer can't break state flow */
        }
      }
    },

    onStateChange(handler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },

    isAtLeast(target) {
      return LIFECYCLE_STATE_RANK[state] >= LIFECYCLE_STATE_RANK[target];
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Snapshot builder — combines store + machine + runtime inputs
// ────────────────────────────────────────────────────────────────

/** Inputs to `buildLifecycleSnapshot` that vary per-call. The
 *  heartbeat emitter + `server.getLifecycleState` both use this so
 *  one source of truth builds the wire shape. */
export interface LifecycleSnapshotInputs {
  store: LifecycleStateStore;
  machine: LifecycleStateMachine;
  supervisor_mode: ResolvedSupervisorMode;
  /** Live drain state. Omitted when `state !== 'draining'`. */
  drain?: DrainState;
  /** External contribution to `restart_pending` — the rpc-level
   *  `stageBootstrap` check (whether a pending patch exists). Phase C
   *  OR's this with the SIGHUP-driven `restart_pending` flag from the
   *  store. */
  stagedBootstrapPending?: boolean;
  now?: () => number;
}

export const buildLifecycleSnapshot = (
  inputs: LifecycleSnapshotInputs,
): import('@recued/contracts').LifecycleStatus => {
  const now = (inputs.now ?? (() => Date.now()))();
  const bootAt = inputs.store.getBootAt() ?? 0;
  const uptime_s = bootAt && bootAt <= now
    ? Math.max(0, Math.floor((now - bootAt) / 1000))
    : 0;
  const crash = inputs.store.getLastCrash();
  const restartPendingFromStore = inputs.store.getRestartPending();
  const staged = inputs.stagedBootstrapPending ?? false;

  const snapshot: import('@recued/contracts').LifecycleStatus = {
    state: inputs.machine.state,
    boot_at: bootAt,
    uptime_s,
    restart_count: inputs.store.getRestartCount(),
    restart_pending: restartPendingFromStore || staged,
    supervisor_mode: inputs.supervisor_mode,
  };
  if (crash) snapshot.last_crash = crash;
  if (inputs.machine.state === 'draining' && inputs.drain) {
    snapshot.drain = inputs.drain;
  }
  return snapshot;
};
