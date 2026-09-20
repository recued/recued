// D-181 Slice 3 — progress-based stall detection (the pure decision core).
//
// A fixed wall-clock cap is arbitrary: too short kills a legit 20-min docling,
// too long lets a hung op linger. Slice 3 replaces it with **progress-based
// stall detection** — "no signal for k·T = stuck" — split by **run origin**
// (a stable property of the run, NOT whether a UI is open):
//
//   - unattended (schedule / reactive / housekeeping / webhook) → progress
//     stall auto-kills + (slice 5) notifies; a generous wall-clock fail-safe
//     backstops a truly-silent op so it can't pin a slot forever.
//   - attended (chat / webclient / messenger / bridge fire) → the human
//     governs via the (slice 4) active list; progress stall only **flags** the
//     row ("running 14m, no progress"), it does NOT auto-kill. The generous
//     fail-safe still applies (covers "fired then walked away").
//
// This module is the **pure, deterministic core** (no clock, no timers, no
// fs) — `evaluateStall` takes the timestamps and returns a decision, so the
// kill/flag policy is unit-testable in isolation. The stateful monitor that
// drives it (poll loop, file-growth sampling, SIGKILL) lives server-side in
// `backend/server/src/execution/stall-monitor.ts` (it needs node fs + timers).
// See D-181 §6.

import type { IngredientKind } from './ingredient.js';
import type { ProgressContract } from './execution-lane.js';

/** Who is watching a run, for stall-governance purposes. Derived from the
 *  run's trigger / channel — a property the run already carries, *not* whether
 *  a client is currently connected. */
export type RunAttention = 'attended' | 'unattended';

/** Trigger sources whose runs nobody is interactively watching — progress
 *  stall on these **auto-kills** (the human can't). Mirrors the design's
 *  unattended channel set (`schedule` / `reactive` / `housekeeping` /
 *  `webhook`) widened to the concrete `trigger_source` strings the engine
 *  forwards (`auto_run` is reactive; `cron` / `scheduled` are schedule;
 *  `backfill` is an unwatched catch-up). Everything else — `manual`, `mcp`,
 *  `chat`, `slack`, `telegram`, `email`, undefined — is attended. */
export const UNATTENDED_TRIGGER_SOURCES: ReadonlySet<string> = new Set([
  'schedule',
  'scheduled',
  'cron',
  'reactive',
  'reactive-remote',
  'auto_run',
  'housekeeping',
  'webhook',
  'backfill',
]);

/** Classify a run's origin from its `trigger_source`. Unknown / absent →
 *  `attended` (fail *safe*: an attended op is never auto-killed on no-progress,
 *  only flagged — the conservative default for an unclassified run). */
export const runAttentionForTriggerSource = (triggerSource?: string): RunAttention =>
  triggerSource !== undefined && UNATTENDED_TRIGGER_SOURCES.has(triggerSource)
    ? 'unattended'
    : 'attended';

/** `k` in "no progress for k·T = stuck". Crude seed (§6 — refined from the
 *  execution-log harvest, §10); 6 expected-intervals of silence flags a
 *  signal-emitting op as stalled. */
export const STALL_FACTOR_K = 6;

/** Generous wall-clock fail-safe (§6) — a `silent`-contract op (no signal to
 *  detect) is bounded only by this, and it backstops every other contract too
 *  (the attended "fired then walked away" case). 30 minutes — long enough not
 *  to interrupt a legit heavy render, short enough that a hung silent op can't
 *  pin a slot indefinitely. */
export const SILENT_OP_HARD_CAP_MS = 30 * 60 * 1000;

/** Default progress-poll cadence for the stateful monitor (§6). */
export const DEFAULT_PROGRESS_POLL_MS = 2_000;

/** Crude seed expected-interval `T` per contract (§6 — "Seed T crude, refine
 *  as the log accrues"). `silent` has no `T` (it is bounded by the hard cap,
 *  never by progress detection). */
export const DEFAULT_EXPECTED_INTERVAL_MS: Record<ProgressContract, number> = {
  heartbeat: 5_000,
  'file-growth': 10_000,
  'provider-event': 15_000,
  silent: 0,
  // D-274 — one no-movement sample window. k=6 ⇒ flag after ~3 min during which
  // the process tree consumed no CPU and its RSS did not move.
  resource: 30_000,
};

/** Per-kind default progress contract (§4). The manifest's own
 *  `progress_contract` overrides this; the default reflects how the kind's
 *  executor surfaces progress.
 *
 *  ⛔ D-274 — `resolveProgressContract` STILL HAS NO NON-TEST CALLER. This map
 *  is a declared intention, not a wiring: nothing consults it at runtime, and
 *  `ingredient.ts` used to claim the monitor "falls back" to it, which it never
 *  did. The cli BINDING path is now covered instead by the host-assigned
 *  `resource` contract in `cli-invocation-executor.ts` — NOT by this map, whose
 *  `cli: 'silent'` row would impose a 30-minute kill if anyone wired it naively.
 *  Every other kind remains governed by its own executor. ⇒ If you need a
 *  per-kind default, WIRE this and decide the cap deliberately; do not assume
 *  it is already in force because a table exists.
 *
 *  Per-kind rationale:
 *    - `service` / `cli` → `silent`  (a cli subprocess may buffer stdout / write
 *      its output only at the end — opt into `heartbeat` / `file-growth` per op).
 *    - `http` / `mcp` / `connection` / `ai` → `provider-event` (streaming /
 *      response chunks).
 *    - `dom` / `chat` / `storage` → `silent` (no observable cadence). */
const DEFAULT_PROGRESS_CONTRACT_BY_KIND: Record<IngredientKind, ProgressContract> = {
  service: 'silent',
  // D-182 — a cli subprocess (whisper / docling) typically writes its output
  // only at the end; mirror `service` → silent, opt into file-growth per op.
  cli: 'silent',
  http: 'provider-event',
  mcp: 'provider-event',
  connection: 'provider-event',
  ai: 'provider-event',
  dom: 'silent',
  chat: 'silent',
  storage: 'silent',
};

/** Resolve an op's effective progress contract: the manifest's explicit
 *  declaration wins, else the per-kind default. */
export const resolveProgressContract = (manifest: {
  kind: IngredientKind;
  progress_contract?: ProgressContract;
}): ProgressContract =>
  manifest.progress_contract ?? DEFAULT_PROGRESS_CONTRACT_BY_KIND[manifest.kind];

/** Why an op is past a stall threshold.
 *  - `no_progress` — a signal-emitting op went silent for ≥ k·T.
 *  - `silent_cap`  — the generous wall-clock fail-safe was exceeded. */
export type StallReason = 'no_progress' | 'silent_cap';

export interface StallEvalInput {
  contract: ProgressContract;
  origin: RunAttention;
  /** When the heavy call began running (slot-acquired / spawn). */
  started_at: number;
  /** When the most recent progress signal was observed. Seeded to
   *  `started_at` (a call that never signals is "idle since start"). */
  last_signal_at: number;
  /** The current clock reading the decision is evaluated against. */
  now: number;
  /** Expected progress interval `T`; defaults to the per-contract seed. */
  expected_interval_ms?: number;
  /** D-274 § 6b — evaluate for REPORTING ONLY: `stalled` is forced false on
   *  BOTH origins and `flagged` alone carries the signal. Set by the `resource`
   *  contract, whose signal is universal but noisy (work outside the process
   *  tree, GPU-resident work, iowait all read as idle). A false "looks idle"
   *  costs the watching human one glance; a false KILL costs them the whole
   *  completed run — so the noisy signal is admissible for the first and not
   *  the second. The three DECLARED contracts never set this. */
  flag_only?: boolean;
  /** `k` factor; defaults to `STALL_FACTOR_K`. */
  factor_k?: number;
  /** Generous wall-clock fail-safe; defaults to `SILENT_OP_HARD_CAP_MS`. */
  silent_hard_cap_ms?: number;
  /** D-259 explicit semantic-progress declarations are author-chosen kill
   * thresholds, including on attended runs. Legacy D-181 declarations omit
   * this and keep the attended flag-only policy. */
  kill_on_no_progress?: boolean;
}

export interface StallDecision {
  /** The op should be **killed** now (origin-dependent — see `evaluateStall`). */
  stalled: boolean;
  /** The op is past the no-progress threshold — surfaced as a flag on the
   *  active list (slice 4) even when `stalled` is false (the attended case). */
  flagged: boolean;
  /** Milliseconds since the last progress signal. */
  idle_ms: number;
  /** Milliseconds since the call began. */
  run_ms: number;
  /** The active threshold condition, or `null` when neither is met. */
  reason: StallReason | null;
}

/** The pure stall decision (§6). Deterministic — same inputs, same output.
 *
 *  - A **signal-emitting** contract is `flagged` once it has been idle for
 *    ≥ k·T (no stdout / no output-file growth / no provider chunk).
 *  - The **generous wall-clock fail-safe** trips once the call has run for
 *    ≥ the silent hard cap (the only bound a `silent` op ever has).
 *  - **Kill policy by origin:** an `unattended` op is killed on *either*
 *    condition (no human to intervene); an `attended` op is killed *only* by
 *    the fail-safe — its no-progress condition merely `flagged`s the active
 *    list for the watching human to act on (design §6 table). */
export const evaluateStall = (input: StallEvalInput): StallDecision => {
  const k = input.factor_k ?? STALL_FACTOR_K;
  const t = input.expected_interval_ms ?? DEFAULT_EXPECTED_INTERVAL_MS[input.contract];
  const cap = input.silent_hard_cap_ms ?? SILENT_OP_HARD_CAP_MS;

  const idleMs = Math.max(0, input.now - input.last_signal_at);
  const runMs = Math.max(0, input.now - input.started_at);

  const progressStalled = input.contract !== 'silent' && t > 0 && idleMs >= k * t;
  const silentExceeded = runMs >= cap;

  // D-274 — `flag_only` is checked FIRST so no origin can route around it: the
  // unattended arm below is `progressStalled || silentExceeded` unconditionally,
  // so a report-only contract could not otherwise be expressed without lying
  // about `origin`.
  const stalled = input.flag_only === true
    ? false
    : input.kill_on_no_progress === true
    ? progressStalled || silentExceeded
    : input.origin === 'unattended'
    ? progressStalled || silentExceeded
    : silentExceeded; // attended: only the fail-safe kills; no-progress flags

  // D-274 — under `flag_only` the wall-clock cap is not in play at all (the
  // caller disables it; the authored `timeout_ms` is the real backstop), so
  // reporting `silent_cap` here would name a bound that never applied. The only
  // honest reason for a report-only contract is the no-progress one.
  const reason: StallReason | null = input.flag_only === true
    ? (progressStalled ? 'no_progress' : null)
    : silentExceeded
    ? 'silent_cap'
    : progressStalled
      ? 'no_progress'
      : null;

  return { stalled, flagged: progressStalled, idle_ms: idleMs, run_ms: runMs, reason };
};
