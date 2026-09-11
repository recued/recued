// D-181 Slice 4 — the in-flight execution registry (server-side, in-memory).
//
// The single read-model + control authority for the live active-list. It does
// NOT own the lane queue (that's the `LaneSemaphore`, which it reads + delegates
// queue control to); it owns the **run-level** facts the semaphore can't know —
// each run's origin/source/session, the kill mechanism for its current heavy
// call, and a short-lived `terminated` map the execute-handler consults to stamp
// the audit anchor (`killed` / `cancelled_before_dispatch`).
//
// Fed by three writers:
//   - the **execute-handler** registers a run on start (with its abort handle)
//     and `completeRun`s it on settle;
//   - the **LaneSemaphore** is the source of the gated-call read model (running
//     slots + queued waiters) — read on demand, not pushed;
//   - the **cli executor** attaches a SIGKILL handle for the `service`
//     subprocess of the run it's currently executing.
//
// Control: `kill` (a running run — SIGKILL the subprocess if attached and
// abort the caller-facing await; a non-cancellable transport drains behind the
// killed terminal), `cancel` / `promote` (a queued call — delegated to
// the semaphore). Owner-only enforcement + the bridge-approval gate live in the
// rpc handler; this class is unauthenticated substrate. See D-181
// §7.

import type {
  ActiveExecutionEntry,
  ExecutionCancelStatus,
  ExecutionKillStatus,
  ExecutionLane,
  ExecutionPromoteStatus,
  ExecutionSource,
  KillDescriptor,
  LaneStatus,
  ProgressContract,
  RiskTier,
} from '@recued/contracts';
import { deriveChannelSessionId } from '@recued/gateway';

import type { GatedCallEntry, LaneSemaphore } from './lane-semaphore.js';

/** How the live-control surface terminated a run, as recorded by the registry.
 *  D-181 §7c — `'killed'`-only now: `kill()` is the sole writer; `cancel()` no
 *  longer records a run-level marker (the `cancelled_before_dispatch` LABEL is
 *  derived by the host from the engine's `slot_cancelled` step error instead). The
 *  execute-handler reads this after the run settles to stamp the audit anchor +
 *  error category. */
export type RunTermination = 'killed';

export interface RunRegistration {
  run_id: string;
  recipe_id: string;
  dish_id?: string;
  /** Host-derived declaration summary. Never caller data or run output. */
  intent?: string;
  risk?: RiskTier;
  effect?: string;
  source: ExecutionSource;
  /** Attended (a human is plausibly watching) vs unattended (scheduled /
   *  reactive / housekeeping / webhook). The caller derives it from the run's
   *  trigger source (mirrors the slice-3 stall monitor's origin). */
  origin: 'attended' | 'unattended';
  /** Session-scoping for the active list (§7b). Absent for unattended runs. */
  session_id?: string;
  started_at: number;
  /** Abort the caller-facing run await — the external-io/`ai` kill path (no
   *  inference cancel; the draining result is tombstoned by the commit
   *  Gateway). Invoked by `kill` after any subprocess SIGKILL. */
  abort: () => void;
  /** Optional durable chat projection, captured at registration so progress
   * observed outside the dispatch's async context keeps its exact call id. */
  onProgress?: (at: number, stalled: boolean) => boolean | undefined;
}

/** A running-twin never rejects its shared promise. Keeping failure as data
 *  prevents an unobserved leader failure from becoming an unhandled rejection
 *  when no duplicate happened to attach. */
export type RunningTwinOutcome =
  | { status: 'completed'; response: unknown }
  | { status: 'failed'; error: unknown };

export type RunningTwinClaim =
  | { leader: true }
  | { leader: false; run_id: string; outcome: Promise<RunningTwinOutcome> };

interface RunningTwinSlot {
  run_id: string;
  outcome: Promise<RunningTwinOutcome>;
  settle: (outcome: RunningTwinOutcome) => void;
}

export interface AgentStopCandidate {
  run_id: string;
  recipe_id: string;
  started_at: number;
}

/** Internal result keeps `not_yours` distinct for audit. The MCP wire collapses
 * it to `not_found` so a guessed run id cannot become an ownership oracle. */
export type AgentStopResult =
  | ({ status: 'stopped' } & AgentStopCandidate)
  | { status: 'ambiguous'; candidates: AgentStopCandidate[] }
  | { status: 'already_terminal'; run_id?: string }
  | { status: 'not_found' }
  | { status: 'not_yours' };

interface TerminalRunAddress extends AgentStopCandidate {
  origin: RunRegistration['origin'];
  source: ExecutionSource;
  completed_at: number;
}

const TERMINAL_ADDRESS_LIMIT = 256;
const TERMINAL_ADDRESS_TTL_MS = 60 * 60 * 1_000;

/** A minimal narrow emit hook so the registry can fan live deltas onto the
 *  D-121 execution bus without importing the bus module (keeps this substrate
 *  testable + decoupled). Best-effort: the caller swallows throws. */
export type ExecutionDeltaEmit = (args: {
  recipe_id: string;
  run_id: string;
  op: 'queued' | 'slot_acquired' | 'stalled' | 'promoted' | 'cancelled' | 'killed' | 'retired';
  queued_call_id?: string;
  /** The governor lane the queued entry occupies/waits on — present on the
   *  queue-lifecycle ops (`promoted` / `cancelled`); absent on `killed` /
   *  `stalled` / `retired` (run-level, no single lane). */
  lane?: ExecutionLane;
}) => void;

export interface InFlightRegistryOptions {
  emit?: ExecutionDeltaEmit;
}

interface SubprocessHandle {
  pid: number;
  kill: () => void;
}

interface RunProgress {
  contract: ProgressContract;
  last_signal_at: number;
}

export class InFlightRegistry {
  private readonly runs = new Map<string, RunRegistration>();
  /** D-259 — exact D-157 action identity to one pre-dispatch leader. The slot
   *  intentionally outlives active-list retirement until the handler has built
   *  its final response, so a late duplicate receives that same response. */
  private readonly runningTwins = new Map<string, RunningTwinSlot>();
  private readonly runningTwinKeyByRun = new Map<string, string>();
  /** Recent addressability only, for D-259's `already_terminal` response. The
   * durable audit log remains authoritative history; this bounded cache holds
   * no args, outputs, config, or control handle. */
  private readonly terminalRuns = new Map<string, TerminalRunAddress>();
  /** run_id → (child_id → handle). Keyed per CHILD, not per run: a run can have
   *  several `service` subprocesses live at once (parallel prefetch), and a kill
   *  must reach every one while each child detaches only its own handle. */
  private readonly subprocesses = new Map<string, Map<string, SubprocessHandle>>();
  /** Owner-kill callers may abandon an external/AI await immediately, but a
   * finite CLI tree must finish its close/error cleanup first. These waiters
   * resolve when the last attached child for a run detaches. */
  private readonly subprocessDrainWaiters = new Map<string, Set<() => void>>();
  private readonly terminated = new Map<string, RunTermination>();
  /** Latest host-observed liveness for each run. This is deliberately only a
   *  contract + timestamp: progress payloads, arguments, and results never
   *  enter the next-turn prompt context. */
  private readonly progressByRun = new Map<string, RunProgress>();
  /** Runs whose current heavy call the stall monitor flagged — surfaced as
   *  `progress.stalled` in the snapshot + fanned as a `stalled` delta. Cleared
   *  by `completeRun`. */
  private readonly stalledRuns = new Set<string>();
  private childSeq = 0;
  private readonly emit?: ExecutionDeltaEmit;

  constructor(
    private readonly semaphore: Pick<
      LaneSemaphore,
      'gatedEntries' | 'laneStatus' | 'cancel' | 'promote'
    >,
    opts: InFlightRegistryOptions = {},
  ) {
    this.emit = opts.emit;
  }

  // ── run lifecycle (execute-handler) ──────────────────────────────

  registerRun(reg: RunRegistration): void {
    this.runs.set(reg.run_id, reg);
    // A fresh registration clears any stale termination from a prior run that
    // reused the (random) id — defensive; run ids are unique in practice.
    this.terminated.delete(reg.run_id);
  }

  /** Non-claiming fast path for a duplicate that arrives after the leader has
   *  crossed its dispatch boundary. A miss is only a hint; callers must still
   *  use `claimRunningTwin` at their own boundary to close the race. */
  runningTwin(identity_key: string): { run_id: string; outcome: Promise<RunningTwinOutcome> } | null {
    const slot = this.runningTwins.get(identity_key);
    return slot === undefined ? null : { run_id: slot.run_id, outcome: slot.outcome };
  }

  /** Atomically become the one effect-producing leader for an action identity,
   *  or attach to the already-running leader. JavaScript's synchronous Map
   *  mutation makes the check+insert indivisible within this process. */
  claimRunningTwin(identity_key: string, run_id: string): RunningTwinClaim {
    const existing = this.runningTwins.get(identity_key);
    if (existing !== undefined) {
      return { leader: false, run_id: existing.run_id, outcome: existing.outcome };
    }
    let settle!: (outcome: RunningTwinOutcome) => void;
    const outcome = new Promise<RunningTwinOutcome>((resolve) => {
      settle = resolve;
    });
    this.runningTwins.set(identity_key, { run_id, outcome, settle });
    this.runningTwinKeyByRun.set(run_id, identity_key);
    return { leader: true };
  }

  /** Resolve and retire a leader slot. Idempotent and ownership-checked: a stale
   *  run can never settle a newer leader that reused the same identity. */
  settleRunningTwin(run_id: string, outcome: RunningTwinOutcome): void {
    const key = this.runningTwinKeyByRun.get(run_id);
    if (key === undefined) return;
    const slot = this.runningTwins.get(key);
    this.runningTwinKeyByRun.delete(run_id);
    if (slot === undefined || slot.run_id !== run_id) return;
    this.runningTwins.delete(key);
    slot.settle(outcome);
  }

  /** Drop a run from the live list. Call AFTER the handler has read any
   *  termination (`takeTermination`) — this also clears the `terminated` marker
   *  so a killed-then-thrown run can't leak it. */
  completeRun(run_id: string): void {
    const reg = this.runs.get(run_id);
    if (reg !== undefined) this.rememberTerminal(reg);
    this.runs.delete(run_id);
    this.subprocesses.delete(run_id);
    this.resolveSubprocessDrain(run_id);
    this.terminated.delete(run_id);
    this.progressByRun.delete(run_id);
    this.stalledRuns.delete(run_id);
    // D-181 slice-4 follow-up #2 — a run leaving the active list is a membership
    // change that, on the durable-pause / trigger-skipped exit paths, carries NO
    // other delta (the engine emits `complete`/`error` only for true terminals).
    // Fan a `retired` delta so a subscribed client drops the entry without
    // polling. Only when the run was actually registered — the execute-handler's
    // `finally` calls this twice, so the second call (run already gone) is silent
    // (emit-once). A pure membership signal: the Bridge result list ignores it.
    if (reg) this.tryEmit({ recipe_id: reg.recipe_id, run_id, op: 'retired' });
  }

  /** Whether a run is still on the killable active-list (i.e. not yet retired by
   *  `completeRun`). The execute-handler uses this to retire a run the instant
   *  the engine returns, before any post-engine await. */
  isActive(run_id: string): boolean {
    return this.runs.has(run_id);
  }

  /** Count of runs currently on the active-list — every owner / MCP / chat /
   *  reactive / scheduled run between `registerRun` and `completeRun`. Cheap
   *  (a Map size). The D-178 auto-apply quiesce gate (I-5: "no active runs")
   *  reads this alongside the housekeeping engine-busy signal, which only sees
   *  the auto-run scheduler's own in-flight counter + adapter drains. */
  activeRunCount(): number {
    return this.runs.size;
  }

  /** D-259 §7.4.3–4 — correlate intent and stop exactly one live run owned by
   * this caller. The caller supplies recipe OR run intent; authority is derived
   * from the STORED source, never from request fields.
   *
   * 🔑 Scoped by `channel_session_id`, not by a per-channel field, so ONE
   * method serves every door: `mcp:<token>` for an agent, `chat:<session>` for
   * the chat model, `messenger:<vendor>:<from>` for messenger. The arity rule
   * (§7.4.3) — one match stops, more than one REFUSES rather than picks — is
   * the part that must not be re-implemented per channel, which is why this
   * generalised instead of growing a twin. */
  stopOwnRun(
    channel_session_id: string,
    intent: { recipe_id: string } | { run_id: string },
  ): AgentStopResult {
    this.pruneTerminalAddresses();
    const owns = (reg: Pick<RunRegistration, 'origin' | 'source'>): boolean =>
      reg.origin === 'attended'
      && deriveChannelSessionId(reg.source) === channel_session_id;
    const candidate = (reg: Pick<RunRegistration, 'run_id' | 'recipe_id' | 'started_at'>): AgentStopCandidate => ({
      run_id: reg.run_id,
      recipe_id: reg.recipe_id,
      started_at: reg.started_at,
    });

    if ('run_id' in intent) {
      const live = this.runs.get(intent.run_id);
      if (live !== undefined) {
        if (!owns(live)) return { status: 'not_yours' };
        const status = this.kill(live.run_id);
        return status === 'killed'
          ? { status: 'stopped', ...candidate(live) }
          : { status: 'already_terminal', run_id: live.run_id };
      }
      const terminal = this.terminalRuns.get(intent.run_id);
      if (terminal !== undefined) {
        return owns(terminal)
          ? { status: 'already_terminal', run_id: terminal.run_id }
          : { status: 'not_yours' };
      }
      return { status: 'not_found' };
    }

    const liveForRecipe = [...this.runs.values()].filter(
      (reg) => reg.recipe_id === intent.recipe_id && owns(reg),
    );
    if (liveForRecipe.length > 1) {
      return {
        status: 'ambiguous',
        candidates: liveForRecipe.map(candidate).sort((a, b) => a.started_at - b.started_at),
      };
    }
    if (liveForRecipe.length === 1) {
      const live = liveForRecipe[0]!;
      const status = this.kill(live.run_id);
      return status === 'killed'
        ? { status: 'stopped', ...candidate(live) }
        : { status: 'already_terminal', run_id: live.run_id };
    }
    const ownTerminal = [...this.terminalRuns.values()]
      .filter((reg) => reg.recipe_id === intent.recipe_id && owns(reg))
      .sort((a, b) => b.completed_at - a.completed_at)[0];
    if (ownTerminal !== undefined) {
      return { status: 'already_terminal', run_id: ownTerminal.run_id };
    }
    const existsButNotOwned = [...this.runs.values()].some(
      (reg) => reg.recipe_id === intent.recipe_id,
    ) || [...this.terminalRuns.values()].some(
      (reg) => reg.recipe_id === intent.recipe_id,
    );
    return existsButNotOwned ? { status: 'not_yours' } : { status: 'not_found' };
  }

  /** The control-driven termination for a settled run, if any (`killed` /
   *  `cancelled_before_dispatch`). Consuming it clears the marker. */
  takeTermination(run_id: string): RunTermination | undefined {
    const t = this.terminated.get(run_id);
    if (t !== undefined) this.terminated.delete(run_id);
    return t;
  }

  // ── subprocess attach (cli executor) ─────────────────────────────

  /** The cli executor attaches its child's SIGKILL handle while one `service`
   *  subprocess runs, and detaches it (via the returned child id) on settle. A
   *  run may have several live at once (parallel prefetch), so each is tracked
   *  separately; `kill` reaches all of them. Returns the child id for `detach`. */
  attachSubprocess(run_id: string, pid: number, kill: () => void): string {
    const child_id = `child_${++this.childSeq}`;
    let inner = this.subprocesses.get(run_id);
    if (!inner) {
      inner = new Map();
      this.subprocesses.set(run_id, inner);
    }
    inner.set(child_id, { pid, kill });
    return child_id;
  }

  detachSubprocess(run_id: string, child_id: string): void {
    const inner = this.subprocesses.get(run_id);
    if (!inner) return;
    inner.delete(child_id);
    if (inner.size === 0) {
      this.subprocesses.delete(run_id);
      this.resolveSubprocessDrain(run_id);
    }
  }

  /** Await real finite-child cleanup after a kill. External/AI-only runs have
   * no attached child and resolve immediately, preserving abandon-await. */
  waitForSubprocessDrain(run_id: string): Promise<void> {
    if ((this.subprocesses.get(run_id)?.size ?? 0) === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let waiters = this.subprocessDrainWaiters.get(run_id);
      if (waiters === undefined) {
        waiters = new Set();
        this.subprocessDrainWaiters.set(run_id, waiters);
      }
      waiters.add(resolve);
    });
  }

  // ── progress (cli stall monitor) ─────────────────────────────────

  /** D-259 §7.4.2 — record one semantic liveness signal for the live
   *  run. The engine reports phase transitions as `provider-event`; the CLI
   *  monitor reports only adapter-validated heartbeat/file-growth signals.
   *  No-op after retirement, and a real signal clears a prior stall flag. */
  reportProgress(
    run_id: string,
    contract: Exclude<ProgressContract, 'silent'>,
    at: number = Date.now(),
  ): void {
    if (!this.runs.has(run_id)) return;
    this.progressByRun.set(run_id, { contract, last_signal_at: at });
    this.stalledRuns.delete(run_id);
    this.reportDurableProgress(run_id, at, false);
  }

  /** D-181 slice-4 follow-up #2 — the cli stall monitor raised a no-progress
   *  flag (attended) or an imminent auto-kill (unattended) on this run's current
   *  heavy call. Records it so the `execution.active` snapshot reflects
   *  `progress.stalled` AND fans a `stalled` delta so a subscribed client
   *  re-lists without polling. No-op for an unregistered run; idempotent — the
   *  delta fires once per stalled run (cleared on `completeRun`). */
  markStalled(run_id: string): void {
    const reg = this.runs.get(run_id);
    if (!reg) return;
    if (this.stalledRuns.has(run_id)) return; // already flagged — emit once
    this.stalledRuns.add(run_id);
    this.reportDurableProgress(run_id, Date.now(), true);
    this.tryEmit({ recipe_id: reg.recipe_id, run_id, op: 'stalled' });
  }

  // ── control ──────────────────────────────────────────────────────

  /** Kill a *running* run. Idempotent: a run ALREADY KILLED returns
   *  `already_terminal`; an unknown run returns `not_found`. SIGKILLs EVERY
   *  attached subprocess (forces the engine to fail fast) AND abandons the run's
   *  await (external-io has no subprocess to kill).
   *
   *  D-181 slice-4 #1 follow-up — the guard checks for a prior KILL only, NOT any
   *  `terminated` marker. A `cancelled_before_dispatch` marker (an
   *  `execution.cancel` of a QUEUED call) can sit on a still-LIVE run: an OPTIONAL
   *  prefetch / foreach cancel is swallowed by the engine, so the run keeps
   *  running and stays killable. Blocking on `.has()` made such a run
   *  permanently UNKILLABLE; gating on `=== 'killed'` lets the kill proceed and
   *  overwrite the stale cancel marker. */
  kill(run_id: string): ExecutionKillStatus {
    if (this.terminated.get(run_id) === 'killed') return 'already_terminal';
    const reg = this.runs.get(run_id);
    if (!reg) return 'not_found';
    this.terminated.set(run_id, 'killed');
    const inner = this.subprocesses.get(run_id);
    if (inner) {
      for (const sub of inner.values()) {
        try {
          sub.kill();
        } catch {
          /* process already exited */
        }
      }
    }
    try {
      reg.abort();
    } catch {
      /* abort handle already torn down */
    }
    this.tryEmit({ recipe_id: reg.recipe_id, run_id, op: 'killed' });
    return 'killed';
  }

  /** Cancel a *queued* call before it dispatches. Delegates to the semaphore +
   *  fans a `cancelled` delta so the active list re-lists. D-181 §7c — does NOT
   *  write a run-level `terminated` marker: a queued-call cancel does not reliably
   *  terminate the run (an OPTIONAL prefetch / foreach cancel is swallowed by the
   *  engine and the run keeps running), so a run-level marker mislabelled a
   *  later-succeeding / later-failing run as cancelled AND blocked a subsequent
   *  kill. The `cancelled_before_dispatch` LABEL is instead derived by the host
   *  from the engine outcome (the `slot_cancelled` step-error marker) only when
   *  the cancel actually failed the run. */
  cancel(queued_call_id: string): ExecutionCancelStatus {
    // Resolve the owning run BEFORE cancelling — the gated entry is gone after.
    const entry = this.findGated(queued_call_id);
    const status = this.semaphore.cancel(queued_call_id);
    if (status === 'cancelled_before_dispatch') {
      const run_id = entry?.descriptor.run_id;
      if (run_id !== undefined) {
        this.tryEmit({
          recipe_id: entry?.descriptor.recipe_id ?? '',
          run_id,
          op: 'cancelled',
          queued_call_id,
          ...(entry?.lane ? { lane: entry.lane } : {}),
        });
      }
    }
    return status;
  }

  /** Promote a queued call to its lane's head. Delegates to the semaphore. */
  promote(queued_call_id: string): ExecutionPromoteStatus {
    const entry = this.findGated(queued_call_id);
    const status = this.semaphore.promote(queued_call_id);
    if (status === 'promoted' && entry?.descriptor.run_id !== undefined) {
      this.tryEmit({
        recipe_id: entry.descriptor.recipe_id,
        run_id: entry.descriptor.run_id,
        op: 'promoted',
        queued_call_id,
        lane: entry.lane,
      });
    }
    return status;
  }

  // ── read model ───────────────────────────────────────────────────

  /** The `execution.active` snapshot. Session-scoped: with `session_id` only
   *  that session's attended entries + all unattended entries are returned; the
   *  full owner view omits the filter. */
  snapshot(session_id?: string): { entries: ActiveExecutionEntry[]; lanes: LaneStatus[] } {
    const gated = this.semaphore.gatedEntries();
    const runningByRun = new Map<string, GatedCallEntry>();
    for (const g of gated) {
      if (g.state === 'running' && g.descriptor.run_id !== undefined) {
        // First running call of a run sets the run entry's displayed lane.
        if (!runningByRun.has(g.descriptor.run_id)) runningByRun.set(g.descriptor.run_id, g);
      }
    }

    const entries: ActiveExecutionEntry[] = [];

    // One `run` entry per registered run.
    for (const reg of this.runs.values()) {
      const held = runningByRun.get(reg.run_id);
      // The displayed kill descriptor: `sigkill` of the first attached child
      // (illustrative — `kill(run_id)` SIGKILLs every child), else abandon.
      const firstChild = this.subprocesses.get(reg.run_id)?.values().next().value;
      const kill: KillDescriptor = firstChild
        ? { mechanism: 'sigkill', pid: firstChild.pid }
        : { mechanism: 'abandon_await', run_id: reg.run_id };
      const observedProgress = this.progressByRun.get(reg.run_id);
      const laneSignalAt = held?.last_signal_at;
      const lastSignalAt = observedProgress === undefined
        ? laneSignalAt
        : laneSignalAt === undefined
          ? observedProgress.last_signal_at
          : Math.max(observedProgress.last_signal_at, laneSignalAt);
      const progressContract: ProgressContract = observedProgress?.contract
        ?? (laneSignalAt === undefined ? 'silent' : 'provider-event');
      entries.push({
        entry_kind: 'run',
        run_id: reg.run_id,
        recipe_id: reg.recipe_id,
        ...(reg.dish_id !== undefined ? { dish_id: reg.dish_id } : {}),
        ...(reg.intent !== undefined ? { intent: reg.intent } : {}),
        ...(reg.risk !== undefined ? { risk: reg.risk } : {}),
        ...(reg.effect !== undefined ? { effect: reg.effect } : {}),
        ...(held?.descriptor.step_id !== undefined ? { step_id: held.descriptor.step_id } : {}),
        ...(held ? { lane: held.lane } : {}),
        // D-181 slice-4 #1 resolution — a run the owner KILLED but which has not
        // yet retired is unwinding: surface it as `stopping` so the live list
        // gives instant kill feedback (it drops on the later `retired` delta when
        // the engine actually returns). A non-consuming peek — the execute-handler
        // still `takeTermination`s the marker after the engine returns.
        //
        // ONLY the `killed` marker flips the state, NOT `cancelled_before_dispatch`
        // (codex HIGH fold): a kill is a RUN-level abort that always halts the run
        // at the next gated boundary (the sequential loop never swallows the
        // `RunKilledError`), so `stopping` is honest; but cancelling a queued call
        // drops only THAT call — and an OPTIONAL prefetch call swallows the
        // `SlotCancelledError` as a cache miss (`prefetch.ts`), so the run keeps
        // running. Showing such a run as `stopping` would be a long-lived lie, and
        // the registry can't tell an optional-prefetch cancel from a sequential
        // one here. The cancel's own feedback is the queued-call entry vanishing.
        state: this.terminated.get(reg.run_id) === 'killed' ? 'stopping' : 'running',
        origin: reg.origin,
        source: reg.source,
        ...(reg.session_id !== undefined ? { session_id: reg.session_id } : {}),
        started_at: reg.started_at,
        ...(held ? { slot_acquired_at: held.slot_acquired_at } : {}),
        progress: {
          contract: progressContract,
          ...(lastSignalAt !== undefined ? { last_signal_at: lastSignalAt } : {}),
          // The stall flag is owned by the cli monitor (`markStalled`), not the
          // lane running-entry — the run's heavy subprocess and its lane slot are
          // distinct layers — so the registry's per-run flag is authoritative.
          stalled: this.stalledRuns.has(reg.run_id) || (held?.stalled ?? false),
        },
        kill,
      });
    }

    // One `queued-call` entry per waiting gated call.
    for (const g of gated) {
      if (g.state !== 'waiting_slot') continue;
      const run_id = g.descriptor.run_id;
      const reg = run_id !== undefined ? this.runs.get(run_id) : undefined;
      entries.push({
        entry_kind: 'queued-call',
        queued_call_id: g.call_id,
        ...(run_id !== undefined ? { run_id } : {}),
        recipe_id: g.descriptor.recipe_id,
        ...(reg?.dish_id !== undefined ? { dish_id: reg.dish_id } : {}),
        ...(reg?.intent !== undefined ? { intent: reg.intent } : {}),
        ...(reg?.risk !== undefined ? { risk: reg.risk } : {}),
        ...(reg?.effect !== undefined ? { effect: reg.effect } : {}),
        ...(g.descriptor.step_id !== undefined ? { step_id: g.descriptor.step_id } : {}),
        lane: g.lane,
        state: 'waiting_slot',
        origin: reg?.origin ?? 'attended',
        // A queued call always has a registered run (the run started before the
        // call enqueued); `reg.source` is the authoritative origin. Falls back to
        // a synthetic owner source only if the run record is somehow absent.
        source: reg?.source ?? FALLBACK_OWNER_SOURCE,
        ...(reg?.session_id !== undefined ? { session_id: reg.session_id } : {}),
        started_at: g.enqueued_at,
        progress: { contract: 'silent', stalled: false },
        kill: { mechanism: 'abandon_await', run_id: run_id ?? '' },
      });
    }

    const filtered =
      session_id === undefined
        ? entries
        : entries.filter((e) => e.origin === 'unattended' || e.session_id === session_id);

    return { entries: filtered, lanes: this.semaphore.laneStatus() };
  }

  /** D-259 §7.4.2 — narrow model context for the caller's NEXT concurrent
   * turn. One bounded line per attended run, no queue-management view and no
   * caller arguments/results. Unattended work is deliberately excluded even
   * though the owner's `snapshot(session_id)` includes it. */
  promptContext(session_id: string): string | undefined {
    const rows = this.snapshot(session_id).entries
      .filter((entry) =>
        entry.entry_kind === 'run'
        && entry.origin === 'attended'
        && entry.session_id === session_id
        && entry.run_id !== undefined)
      .sort((a, b) => a.started_at - b.started_at);
    if (rows.length === 0) return undefined;
    const lines = rows.map((entry) => {
      const progress = [
        entry.progress.contract,
        entry.progress.last_signal_at === undefined
          ? 'last=none'
          : `last=${entry.progress.last_signal_at}`,
        `stalled=${String(entry.progress.stalled)}`,
      ].join(',');
      const line = [
        `run=${entry.run_id}`,
        `recipe=${entry.recipe_id}`,
        ...(entry.dish_id === undefined ? [] : [`dish=${entry.dish_id}`]),
        `state=${entry.state}`,
        `started_at=${entry.started_at}`,
        `progress=${progress}`,
        ...(entry.intent === undefined ? [] : [`intent=${JSON.stringify(entry.intent)}`]),
        ...(entry.risk === undefined ? [] : [`risk=${entry.risk}`]),
        ...(entry.effect === undefined ? [] : [`effect=${JSON.stringify(entry.effect)}`]),
      ].join('; ');
      return line.length <= 512 ? line : `${line.slice(0, 511)}…`;
    });
    return [
      'Work is already in flight. Prefer answering, inspecting, or stopping it before starting a matching or conflicting write.',
      ...lines,
    ].join('\n');
  }

  /** Per-lane occupancy snapshot — the slice-5 server-status lanes line
   *  (D-181 §12) reads this directly without building the full active-list
   *  entry set. Pure passthrough to the governor. */
  laneStatus(): LaneStatus[] {
    return this.semaphore.laneStatus();
  }

  private rememberTerminal(reg: RunRegistration): void {
    this.terminalRuns.delete(reg.run_id);
    this.terminalRuns.set(reg.run_id, {
      run_id: reg.run_id,
      recipe_id: reg.recipe_id,
      started_at: reg.started_at,
      origin: reg.origin,
      source: reg.source,
      completed_at: Date.now(),
    });
    this.pruneTerminalAddresses();
    while (this.terminalRuns.size > TERMINAL_ADDRESS_LIMIT) {
      const oldest = this.terminalRuns.keys().next().value;
      if (oldest === undefined) break;
      this.terminalRuns.delete(oldest);
    }
  }

  private resolveSubprocessDrain(run_id: string): void {
    const waiters = this.subprocessDrainWaiters.get(run_id);
    if (waiters === undefined) return;
    this.subprocessDrainWaiters.delete(run_id);
    for (const resolve of waiters) resolve();
  }

  private pruneTerminalAddresses(): void {
    const floor = Date.now() - TERMINAL_ADDRESS_TTL_MS;
    for (const [run_id, terminal] of this.terminalRuns) {
      if (terminal.completed_at >= floor) continue;
      this.terminalRuns.delete(run_id);
    }
  }

  private findGated(call_id: string): GatedCallEntry | undefined {
    return this.semaphore.gatedEntries().find((g) => g.call_id === call_id);
  }

  private reportDurableProgress(run_id: string, at: number, stalled: boolean): void {
    try { this.runs.get(run_id)?.onProgress?.(at, stalled); }
    catch (error) { console.error('[chat] tool progress persistence failed', error); }
  }

  private tryEmit(args: Parameters<ExecutionDeltaEmit>[0]): void {
    if (!this.emit) return;
    try {
      this.emit(args);
    } catch {
      /* best-effort — a bus failure never aborts a control action */
    }
  }
}

/** A synthetic owner source for the (practically unreachable) case of a queued
 *  call whose run record is missing — keeps the active-list row well-typed
 *  without inventing identity facts. */
const FALLBACK_OWNER_SOURCE: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: '',
  client_token_id: '',
};

/** Construct the server's singleton in-flight registry over the lane governor. */
export const createInFlightRegistry = (
  semaphore: LaneSemaphore,
  opts?: InFlightRegistryOptions,
): InFlightRegistry => new InFlightRegistry(semaphore, opts);
