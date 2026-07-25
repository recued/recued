/** D-115 Phase 2 — Auto-run scheduler core.
 *
 *  Platform-agnostic orchestrator for reactive recipes. Owns the live
 *  roster (recipe_id → AutoRunEntry), the RAM-only `starting` set
 *  that gates concurrency=1 per process, and the circuit-breaker
 *  counter that auto-disables a recipe after N consecutive failures.
 *
 *  The extension wires this to `chrome.alarms` (Phase 3); the server
 *  wires it to `setTimeout` (Phase 4). Neither wiring reaches into
 *  this module — the caller just ticks on its own cadence, reads
 *  `report.fired`, dispatches, and calls `markStarting` / `markFinished`
 *  around each run.
 *
 *  Lifecycle:
 *    1. Install / uninstall / enable / disable triggers a roster
 *       rebuild via `rosterAllAutoRun` → `scheduler.setRoster`.
 *    2. Every alarm/timer calls `scheduler.tick(now)`. Ticks are
 *       idempotent; they advance `next_run_at` preemptively so a
 *       second tick inside the same interval is a no-op.
 *    3. For each `fired` entry, the caller calls `markStarting`
 *       before dispatching the recipe. This lands the recipe in the
 *       `starting` set; a subsequent tick drops it as `skipped_overlap`
 *       instead of re-firing.
 *    4. When the run finishes, `markFinished` clears the starting
 *       flag, updates `consecutive_failures`, and commits the next
 *       fire time (from the dynamic hint if the recipe opted in).
 *    5. Hitting `CIRCUIT_BREAKER_THRESHOLD` consecutive failures
 *       auto-disables the entry — it stays in the roster but ticks
 *       report it under `skipped_circuit` until the user calls
 *       `resetCircuit`, which mints a fresh `process_id` and rearms.
 *
 *  Spec: docs/d-115-spec.md §3.1 (scheduler core).
 */

import type { AutoRunSpec, RecipeStatus } from '@recued/contracts';
import { CIRCUIT_BREAKER_THRESHOLD } from '@recued/contracts';

/** Live state for one reactive install. Lives in the scheduler's
 *  in-RAM roster; on extension it's rebuilt from the install
 *  registry on every SW revive, on the server it's durable via the
 *  scheduler persistence (Phase 4). */
export interface AutoRunEntry {
  recipe_id: string;
  publisher_id: string;
  interval_ms: number;
  dynamic: boolean;
  /** UUID grouping every tick of this install. Retired on stop /
   *  pause / uninstall / version_bump / circuit_broken — the runtime
   *  mints a fresh id and threads it through audit rows. */
  process_id: string;
  consecutive_failures: number;
  auto_disabled: boolean;
  last_started_at?: number;
  last_finished_at?: number;
  /** Epoch ms. Ticks fire when `next_run_at <= now`; tick preemptively
   *  advances this to `now + interval_ms` so a second tick inside the
   *  same interval is a silent no-op. */
  next_run_at: number;
}

/** Outcome classifier the executor reports back to `markFinished`.
 *   - `success` resets the failure counter.
 *   - `skipped` (trigger gate returned false) leaves it unchanged.
 *   - `failed` increments it toward the circuit breaker. */
export type AutoRunOutcome = 'success' | 'skipped' | 'failed';

/** Result of one `tick(now)` call. `fired` names the recipes the
 *  caller should dispatch; the other two fields classify drops so
 *  the UI / audit surface can explain why a tick did nothing. */
export interface TickReport {
  fired: Array<{ recipe_id: string; process_id: string }>;
  /** Dropped because a prior run is still in `starting`. */
  skipped_overlap: string[];
  /** Dropped because the circuit breaker has auto-disabled the entry. */
  skipped_circuit: string[];
}

export interface AutoRunScheduler {
  readonly roster: ReadonlyMap<string, AutoRunEntry>;
  /** Replace the roster wholesale. Used on install / uninstall /
   *  enable / disable — the caller rebuilds via `rosterAllAutoRun`
   *  and passes the result here. Entries no longer in the new roster
   *  are also evicted from the `starting` set. */
  setRoster(entries: AutoRunEntry[]): void;
  /** Scan the roster for due entries. Preemptively advances
   *  `next_run_at` for every fired entry so subsequent ticks inside
   *  the same interval are no-ops. Does NOT add to `starting` — the
   *  caller commits to dispatch via `markStarting`. */
  tick(now: number): TickReport;
  /** Record that a dispatched recipe has started executing. Drops
   *  stale calls where the passed `process_id` no longer matches the
   *  live entry (e.g. circuit reset minted a new id after tick). */
  markStarting(recipe_id: string, process_id: string, now: number): void;
  markFinished(
    recipe_id: string,
    outcome: AutoRunOutcome,
    /** Epoch ms the dynamic recipe wants its next fire at — consumed
     *  only when `entry.dynamic === true`. Ignored otherwise. */
    nextRunHint: number | undefined,
    now: number,
  ): void;
  /** User-initiated rearm after circuit-breaker auto-disable. Zeros
   *  the failure counter, clears the disabled flag, mints a fresh
   *  `process_id` (previous was retired with reason `circuit_broken`),
   *  and sets `next_run_at` so the entry fires on the next tick. */
  resetCircuit(recipe_id: string, now: number): void;
}

/** D-115 Phase 8 — notification payload emitted once per
 *  recipe the moment its counter crosses the circuit-breaker
 *  threshold. Runtime wiring consumes this to surface a
 *  notification banner + options-page listing. Not fired on
 *  subsequent ticks while the recipe stays disabled; not fired on
 *  resetCircuit (reset → re-trip is a fresh event). */
export interface CircuitTripEvent {
  recipe_id: string;
  publisher_id: string;
  /** The process_id that was retired when the counter crossed. The
   *  scheduler does NOT mint a fresh id on trip — it mints on
   *  `resetCircuit`. The event carries the retired id so the
   *  notification can reference the terminated reactive process. */
  retired_process_id: string;
  consecutive_failures: number;
  /** Epoch ms when the trip happened. Same value `markFinished`
   *  received as `now`. */
  tripped_at: number;
}

export interface AutoRunSchedulerOptions {
  /** Overridable UUID minter — tests pass a deterministic sequence;
   *  production falls back to `crypto.randomUUID` with an RFC 4122
   *  v4 backup for environments lacking web crypto. */
  mintProcessId?: () => string;
  /** D-115 Phase 8 — fires exactly once per trip. The handler runs
   *  inside `markFinished` after the auto_disabled flag flips; any
   *  exception is swallowed so a broken listener can't wedge the
   *  scheduler. Tests use this to observe the transition without
   *  polling state. */
  onCircuitTripped?: (event: CircuitTripEvent) => void;
}

/** Minimal shape `rosterAllAutoRun` needs from each install record.
 *  Lives here instead of taking `InstalledRecipeRecord` directly so
 *  the scheduler doesn't depend on the full installation module — the
 *  caller extracts the fields it needs. */
export interface AutoRunInstallInput {
  recipe_id: string;
  publisher_id: string;
  status: RecipeStatus;
  /** Persisted by the runtime when the recipe first entered the
   *  reactive regime. `rosterAllAutoRun` uses it as the canonical
   *  id; if absent, the scheduler mints one and the caller is
   *  responsible for writing it back to the install record. */
  process_id?: string;
  auto_run?: AutoRunSpec;
}

export interface RosterBuildInput {
  installs: AutoRunInstallInput[];
  /** The scheduler's current roster, if any. Live state
   *  (`consecutive_failures`, `auto_disabled`, `next_run_at`, the
   *  active `process_id`) is preserved for entries that survive; new
   *  entries fire on the next tick and start with a fresh counter. */
  previousRoster?: ReadonlyMap<string, AutoRunEntry>;
  /** Epoch ms. Used as the `next_run_at` seed for brand-new entries. */
  now: number;
  mintProcessId?: () => string;
}

function defaultProcessId(): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof g?.randomUUID === 'function') return g.randomUUID();
  // RFC 4122 v4 fallback for environments without web crypto.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Rebuild the auto-run roster from a snapshot of install records.
 *  Pure function — returns new `AutoRunEntry[]`; the caller hands
 *  the result to `scheduler.setRoster`. */
export function rosterAllAutoRun(input: RosterBuildInput): AutoRunEntry[] {
  const mint = input.mintProcessId ?? defaultProcessId;
  const prev = input.previousRoster ?? new Map<string, AutoRunEntry>();
  const result: AutoRunEntry[] = [];

  for (const rec of input.installs) {
    if (!rec.auto_run) continue;
    if (rec.status !== 'enabled') continue;

    const existing = prev.get(rec.recipe_id);
    if (existing) {
      // Preserve live state; pick up interval / dynamic edits from the
      // fresh install record.
      result.push({
        ...existing,
        publisher_id: rec.publisher_id,
        interval_ms: rec.auto_run.interval_ms,
        dynamic: rec.auto_run.dynamic ?? false,
      });
    } else {
      result.push({
        recipe_id: rec.recipe_id,
        publisher_id: rec.publisher_id,
        interval_ms: rec.auto_run.interval_ms,
        dynamic: rec.auto_run.dynamic ?? false,
        process_id: rec.process_id ?? mint(),
        consecutive_failures: 0,
        auto_disabled: false,
        next_run_at: input.now,
      });
    }
  }

  return result;
}

export function createAutoRunScheduler(
  opts: AutoRunSchedulerOptions = {},
): AutoRunScheduler {
  const mintProcessId = opts.mintProcessId ?? defaultProcessId;
  const roster = new Map<string, AutoRunEntry>();
  const starting = new Set<string>();

  return {
    get roster() {
      return roster;
    },

    setRoster(entries) {
      const keep = new Set(entries.map((e) => e.recipe_id));
      for (const id of [...starting]) {
        if (!keep.has(id)) starting.delete(id);
      }
      roster.clear();
      for (const e of entries) roster.set(e.recipe_id, e);
    },

    tick(now) {
      const report: TickReport = {
        fired: [],
        skipped_overlap: [],
        skipped_circuit: [],
      };
      for (const [id, entry] of roster) {
        if (entry.auto_disabled) {
          report.skipped_circuit.push(id);
          continue;
        }
        if (entry.next_run_at > now) continue;
        if (starting.has(id)) {
          report.skipped_overlap.push(id);
          continue;
        }
        // Preemptive advance — a re-entry inside the same interval is
        // a silent no-op via the `next_run_at > now` check above.
        entry.next_run_at = now + entry.interval_ms;
        report.fired.push({ recipe_id: id, process_id: entry.process_id });
      }
      return report;
    },

    markStarting(recipe_id, process_id, now) {
      const entry = roster.get(recipe_id);
      if (!entry) return;
      // Stale call: the process_id was retired between tick and
      // dispatch (e.g. user paused, circuit reset minted a new one).
      // Drop so the caller doesn't wedge `starting` against a ghost.
      if (entry.process_id !== process_id) return;
      starting.add(recipe_id);
      entry.last_started_at = now;
    },

    markFinished(recipe_id, outcome, nextRunHint, now) {
      const entry = roster.get(recipe_id);
      if (!entry) return;
      starting.delete(recipe_id);
      entry.last_finished_at = now;

      // Track auto_disabled edge so we fire the notification exactly
      // once — the moment the counter crosses the threshold.
      const wasDisabled = entry.auto_disabled;

      if (outcome === 'success') {
        entry.consecutive_failures = 0;
      } else if (outcome === 'failed') {
        entry.consecutive_failures += 1;
        if (entry.consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD) {
          entry.auto_disabled = true;
        }
      }
      // outcome === 'skipped' leaves the counter unchanged.

      if (entry.dynamic && nextRunHint !== undefined) {
        entry.next_run_at = nextRunHint;
      } else {
        entry.next_run_at = now + entry.interval_ms;
      }

      // D-115 Phase 8 — edge-triggered notification. Fires only on
      // the transition `false → true`; re-ticks of an already-disabled
      // entry are silent. Exceptions from the listener are swallowed
      // so a broken UI can't wedge the scheduler.
      if (!wasDisabled && entry.auto_disabled && opts.onCircuitTripped) {
        try {
          opts.onCircuitTripped({
            recipe_id,
            publisher_id: entry.publisher_id,
            retired_process_id: entry.process_id,
            consecutive_failures: entry.consecutive_failures,
            tripped_at: now,
          });
        } catch {
          // Swallow — a bad listener is a UI bug, not a scheduler bug.
        }
      }
    },

    resetCircuit(recipe_id, now) {
      const entry = roster.get(recipe_id);
      if (!entry) return;
      entry.consecutive_failures = 0;
      entry.auto_disabled = false;
      entry.next_run_at = now;
      entry.process_id = mintProcessId();
    },
  };
}
