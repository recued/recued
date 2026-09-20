// D-181 Slice 3 — the stateful progress / stall monitor (server-side).
//
// The pure decision (`evaluateStall`) lives in `@recued/contracts`; this is the
// stateful driver that needs a clock, a timer, and (for `file-growth`) node fs.
// A monitor wraps one heavy call: it records progress signals (stdout cadence
// for `heartbeat`, output-file growth for `file-growth`), polls the decision on
// a fixed cadence, and invokes a callback the FIRST time the call crosses a
// threshold — `onStall` when the op should be killed (origin-dependent), or
// `onFlag` when an attended op went no-progress (surfaced on the slice-4 active
// list, not killed). The executor owns the actual kill (SIGKILL the child it
// spawned). See D-181 §6.

import { statSync } from 'node:fs';
import {
  evaluateStall,
  DEFAULT_PROGRESS_POLL_MS,
  type ProgressContract,
  type RunAttention,
  type StallDecision,
} from '@recued/contracts';

/** Something the monitor can poll for forward progress between ticks. The
 *  `file-growth` contract supplies one over the op's output file; `heartbeat`
 *  signals directly from the stdout stream (no source needed). */
export interface ProgressSource {
  /** True iff the watched artifact advanced since the previous call. A call
   *  that returns true is treated as a progress signal. */
  grewSince(): boolean;
}

export interface StallMonitorOptions {
  contract: ProgressContract;
  origin: RunAttention;
  /** Optional poll-driven progress source (e.g. `file-growth`). */
  source?: ProgressSource;
  /** Override the per-contract expected interval `T` (seed; §6/§10). */
  expectedIntervalMs?: number;
  /** Override the generous wall-clock fail-safe. */
  silentHardCapMs?: number;
  /** Override the `k` factor. */
  factorK?: number;
  /** D-259 explicit stall thresholds kill attended work too. */
  killOnNoProgress?: boolean;
  /** D-274 — REPORT ONLY: never kill on either origin, flag alone. Set by the
   *  host-assigned `resource` contract, whose signal is universal but noisy. */
  flagOnly?: boolean;
  /** Best-effort observer for a real semantic progress signal. It receives
   *  only the signal timestamp; progress bytes never cross this seam. */
  onSignal?: (at: number) => void;
  /** Poll cadence; default `DEFAULT_PROGRESS_POLL_MS`. */
  pollMs?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
  /** Injectable timer (tests). Defaults to `setTimeout`/`clearTimeout`.
   *  `setTimer` returns an opaque handle passed back to `clearTimer`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class StallMonitor {
  private readonly contract: ProgressContract;
  private readonly origin: RunAttention;
  private readonly source?: ProgressSource;
  private readonly expectedIntervalMs?: number;
  private readonly silentHardCapMs?: number;
  private readonly factorK?: number;
  private readonly killOnNoProgress?: boolean;
  private readonly flagOnly?: boolean;
  private readonly onSignal?: (at: number) => void;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly startedAt: number;
  private lastSignalAt: number;
  private signals = 0;
  private flaggedFired = false;
  private timer: unknown = undefined;
  private stopped = false;

  constructor(opts: StallMonitorOptions) {
    this.contract = opts.contract;
    this.origin = opts.origin;
    this.source = opts.source;
    this.expectedIntervalMs = opts.expectedIntervalMs;
    this.silentHardCapMs = opts.silentHardCapMs;
    this.factorK = opts.factorK;
    this.killOnNoProgress = opts.killOnNoProgress;
    this.flagOnly = opts.flagOnly;
    this.onSignal = opts.onSignal;
    this.pollMs = opts.pollMs ?? DEFAULT_PROGRESS_POLL_MS;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.startedAt = this.now();
    this.lastSignalAt = this.startedAt;
  }

  /** Record a progress signal (a stdout chunk, an output-file growth, a moving
   *  process tree). */
  signal(): void {
    this.lastSignalAt = this.now();
    this.signals += 1;
    // ⛔ D-274 — RESET THE FLAG LATCH. `flaggedFired` used to be set once per
    // monitor LIFETIME, while the registry's own latch (`stalledRuns`) is
    // CLEARED by this same signal via `reportProgress`. The two disagreed: after
    // one stall and a recovery, the registry showed "not stalled" and the
    // monitor could never say otherwise again — a second stall was silent
    // forever.
    //
    // Harmless while only two declared-contract ops had a monitor; D-274 gives
    // one to all 457, where the realistic shape is a long op that pauses
    // briefly, resumes, and LATER wedges for real. The transient blip would
    // consume the only flag and the real wedge would never surface, which
    // inverts the feature. The latch is now per EPISODE: one `onFlag` per
    // no-progress episode, bounded by k·T (3 min in production), not one ever.
    this.flaggedFired = false;
    try {
      this.onSignal?.(this.lastSignalAt);
    } catch {
      /* telemetry/read-model observers never become execution authority */
    }
  }

  /** Number of progress signals observed (telemetry — `progress_signal_count`). */
  get signalCount(): number {
    return this.signals;
  }

  /** Evaluate the decision at the current clock, sampling the source first.
   *  Pure-ish (advances `lastSignalAt` only via a real source growth). */
  poll(): StallDecision {
    if (this.source?.grewSince()) this.signal();
    return evaluateStall({
      contract: this.contract,
      origin: this.origin,
      started_at: this.startedAt,
      last_signal_at: this.lastSignalAt,
      now: this.now(),
      ...(this.expectedIntervalMs !== undefined ? { expected_interval_ms: this.expectedIntervalMs } : {}),
      ...(this.factorK !== undefined ? { factor_k: this.factorK } : {}),
      ...(this.silentHardCapMs !== undefined ? { silent_hard_cap_ms: this.silentHardCapMs } : {}),
      ...(this.killOnNoProgress !== undefined ? { kill_on_no_progress: this.killOnNoProgress } : {}),
      ...(this.flagOnly !== undefined ? { flag_only: this.flagOnly } : {}),
    });
  }

  /** Begin the poll loop. `onStall` fires at most once (then the monitor
   *  stops — the executor kills the child). `onFlag` fires at most once for an
   *  attended op that crossed the no-progress threshold without being killed
   *  (the slice-4 active-list flag). */
  start(onStall: (decision: StallDecision) => void, onFlag?: (decision: StallDecision) => void): void {
    const tick = (): void => {
      if (this.stopped) return;
      const decision = this.poll();
      if (decision.stalled) {
        this.stop();
        onStall(decision);
        return;
      }
      if (decision.flagged && !this.flaggedFired) {
        this.flaggedFired = true;
        onFlag?.(decision);
      }
      this.timer = this.setTimer(tick, this.pollMs);
    };
    this.timer = this.setTimer(tick, this.pollMs);
  }

  /** Stop the poll loop. Idempotent — safe to call from the executor's
   *  cleanup `finally` even after `onStall` already stopped it. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}

interface StatSample {
  size: number;
  mtimeMs: number;
}

/** A `file-growth` progress source over an output file the op writes
 *  incrementally. `grewSince` returns true when the file's size OR mtime
 *  advanced since the last sample. A missing file (the op hasn't created its
 *  output yet) reads as "no growth" — the generous fail-safe still backstops a
 *  file that never appears. Injectable `statFn` for tests. */
export const createFileGrowthSource = (
  watchPath: string,
  opts: { statFn?: (path: string) => StatSample | null } = {},
): ProgressSource => {
  const statFn = opts.statFn ?? ((p: string): StatSample | null => {
    try {
      const s = statSync(p);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null; // not created yet (or vanished) → treat as no growth
    }
  });
  // Prime a baseline at construction so a PRE-EXISTING (stale) output file from
  // a prior run doesn't read as growth on the first poll. A not-yet-created
  // file primes to -1, so its first appearance correctly counts as growth.
  const primed = statFn(watchPath);
  let lastSize = primed?.size ?? -1;
  let lastMtime = primed?.mtimeMs ?? -1;
  return {
    grewSince(): boolean {
      const sample = statFn(watchPath);
      if (sample === null) return false;
      const grew = sample.size > lastSize || sample.mtimeMs > lastMtime;
      lastSize = Math.max(lastSize, sample.size);
      lastMtime = Math.max(lastMtime, sample.mtimeMs);
      return grew;
    },
  };
};
