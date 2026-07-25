// D-181 Slice 2/4 — the server-side two-lane concurrency semaphore.
//
// Implements the `LaneGovernor` port the engine depends on. One singleton per
// server bounds the heavy *calls* of every run: `local-heavy` (cli/`service`
// subprocess — RAM-scarce, small N) and `external-io` (http/mcp/connection/
// dom/chat — rate-limit-scarce, high N). Fast-path / ai-governor calls and
// inherited same-lane requests bypass instantly. Slots are released on settle
// (the engine's `finally`), so a crashed call never leaks one.
//
// Slice 2 scope: bypass + non-reentrant inheritance + FIFO queue + auto-sizing.
// Slice 4 adds the *control* surface over the queue: every gated call gets a
// `call_id`, the semaphore tracks running + queued entries as a read model
// (`gatedEntries`), and the queue gains `cancel` (drop before dispatch) +
// `promote` (move to head) + a promotion **starvation bound** (an over-age
// waiter auto-jumps the head so `promote` can't starve it) + queue-wait abort
// via `SlotRequest.signal`. The in-flight *run* registry, the kill mechanisms,
// and the `execution.*` rpc live in `in-flight-registry.ts` / the handler.
// See `docs/d-181-spec.md` §5/§7.

import { availableParallelism, freemem } from 'node:os';
import {
  BYPASS_LEASE,
  isGatedCallClass,
  SLOT_CANCELLED_ERROR_CODE,
  type ExecutionLane,
  type LaneGovernor,
  type LaneStatus,
  type SlotDescriptor,
  type SlotLease,
  type SlotRequest,
} from '@recued/contracts';

/** ~1.5 GB headroom budgeted per concurrent local-heavy slot — an ML pipeline
 *  (docling/whisper) OOMs well before it saturates CPU, so RAM is the real cap. */
const RAM_PER_LOCAL_HEAVY_SLOT_BYTES = 1.5 * 1024 * 1024 * 1024;
/** external-io is mostly *waiting* locally; a generous default that never
 *  throttles normal fan-out (the real bound is the AI/rate-limit governor, and
 *  `ai` calls bypass this lane entirely). */
const DEFAULT_EXTERNAL_IO_N = 64;
/** Promotion starvation bound (fold #7): a queued waiter older than this
 *  auto-promotes to the head of `pump`'s selection, so a stream of `promote`
 *  calls on newer entries cannot starve an old one forever. 5 minutes is far
 *  longer than any healthy queue wait — it only bites a pathologically
 *  saturated lane. */
const MAX_QUEUE_AGE_MS = 5 * 60 * 1000;

/** D-181 slice-4 follow-up #2 — the narrow emit hook the semaphore fans
 *  queue-lifecycle deltas through (`queued` when a heavy call blocks on slot
 *  acquisition, `slot_acquired` when a queued call wins its slot). Wired to the
 *  D-121 execution bus at boot so a subscribed client refreshes its active list
 *  the instant a call enqueues mid-run or dispatches — no client-side catch-up
 *  poll. Only fired for a call carrying a `run_id` (the bus event keys on it);
 *  best-effort (the semaphore swallows any throw). */
export type LaneDeltaEmit = (args: {
  recipe_id: string;
  run_id: string;
  op: 'queued' | 'slot_acquired';
  queued_call_id: string;
  lane: ExecutionLane;
}) => void;

export interface LaneSemaphoreConfig {
  /** Override the auto-detected `local-heavy` capacity. */
  local_heavy_n?: number;
  /** Override the default `external-io` capacity. */
  external_io_n?: number;
  /** Override the promotion starvation bound (tests). */
  max_queue_age_ms?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
  /** D-181 slice-4 follow-up #2 — queue-lifecycle bus emit (see `LaneDeltaEmit`).
   *  Absent ⇒ no deltas fan out (the dbless / unit path; the active list still
   *  reads correctly from an `execution.active` snapshot, just not live). */
  emit?: LaneDeltaEmit;
  /** Injectable free-memory probe — read to re-baseline the `local-heavy` RAM
   *  reservation at each idle→busy edge (the first acquire when the lane is
   *  empty), so a daemon that grows its RSS after boot (ollama lazy-loads its
   *  model on first inference) shrinks the lane instead of being invisible to a
   *  frozen boot capacity. Default `os.freemem`. No effect when `local_heavy_n`
   *  pins the lane. */
  freemem?: () => number;
  /** Injectable CPU-count probe, paired with `freemem` for the `local-heavy`
   *  baseline (tests). Default `os.availableParallelism`. */
  cores?: () => number;
}

/** A snapshot of one lane's occupancy (slice-2 tests + the slice-5 server-status line). */
export interface LaneOccupancy {
  lane: ExecutionLane;
  capacity: number;
  in_use: number;
  queued: number;
}

/** The slice-4 read model for one gated call the semaphore tracks. */
export interface GatedCallEntry {
  call_id: string;
  state: 'running' | 'waiting_slot';
  lane: ExecutionLane;
  descriptor: SlotDescriptor;
  enqueued_at: number;
  slot_acquired_at?: number;
  last_signal_at?: number;
  stalled: boolean;
}

interface Waiter {
  call_id: string;
  descriptor: SlotDescriptor;
  enqueued_at: number;
  resolve: (lease: SlotLease) => void;
  reject: (err: Error) => void;
  /** Detaches the `SlotRequest.signal` abort listener once the waiter leaves
   *  the queue (granted / cancelled / aborted), so a long-lived signal doesn't
   *  leak listeners. No-op when the request carried no signal. */
  detachSignal: () => void;
}

interface RunningEntry {
  call_id: string;
  descriptor: SlotDescriptor;
  enqueued_at: number;
  slot_acquired_at: number;
  last_signal_at?: number;
  stalled: boolean;
}

class Lane {
  inUse = 0;
  readonly queue: Waiter[] = [];
  readonly running = new Map<string, RunningEntry>();
  constructor(
    readonly name: ExecutionLane,
    /** `local-heavy` re-baselines this at each idle→busy edge (the first acquire
     *  when the lane is empty — the dynamic RAM reservation); `external-io` is
     *  set once. */
    public capacity: number,
  ) {}
}

/** Thrown when a queued waiter is dropped before it ever dispatches — by an
 *  `execution.cancel` or a `SlotRequest.signal` abort. The engine surfaces it as
 *  the gated step's error AND (recognising `SLOT_CANCELLED_ERROR_CODE` as it
 *  propagates through `invokeGoverned`) preserves a `slot_cancelled` marker into
 *  the step error's details, so the host labels the run `cancelled_before_dispatch`
 *  from the engine outcome — no run-level registry marker (D-181 §7c). */
export class SlotCancelledError extends Error {
  readonly code = SLOT_CANCELLED_ERROR_CODE;
  constructor(readonly call_id: string) {
    super(`lane slot acquisition cancelled before dispatch (call ${call_id})`);
    this.name = 'SlotCancelledError';
  }
}

/** Auto-detected `local-heavy` capacity: min(cores−1, RAM headroom), floored at 1. */
export const autoLocalHeavyCapacity = (
  cores = availableParallelism(),
  free = freemem(),
): number => {
  const byCore = Math.max(1, cores - 1);
  const byRam = Math.max(1, Math.floor(free / RAM_PER_LOCAL_HEAVY_SLOT_BYTES));
  const n = Math.min(byCore, byRam);
  // NaN/Infinity-safe floor: a poisoned probe (an injected freemem()/cores()
  // returning NaN) would otherwise yield NaN, making every `inUse < capacity`
  // false → the lane deadlocks permanently. Never return below 1. (os.freemem /
  // availableParallelism never do this; the guard covers an injected seam.)
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

/** Coerce a capacity override to a finite positive *integer*. A non-finite
 *  value (`NaN` / `±Infinity`) falls back to the auto/default — a `NaN` capacity
 *  would make `inUse < capacity` false forever (every caller queues, the lane
 *  deadlocks); an `Infinity` capacity would silently disable the bound. A
 *  fractional override floors (`1.5 → 1`, else `inUse` could exceed it); `< 1`
 *  clamps to 1. */
const sanitizeCapacity = (value: number | undefined, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : 1;
};

export class LaneSemaphore implements LaneGovernor {
  private readonly lanes: Record<ExecutionLane, Lane>;
  private readonly now: () => number;
  private readonly freememFn: () => number;
  private readonly coresFn: () => number;
  /** True when `local-heavy` auto-sizes (no `local_heavy_n` pin) and so
   *  re-baselines its RAM reservation at each idle→busy edge. */
  private readonly localHeavyDynamic: boolean;
  private readonly maxQueueAgeMs: number;
  private readonly emit?: LaneDeltaEmit;
  private callSeq = 0;

  constructor(config: LaneSemaphoreConfig = {}) {
    this.freememFn = config.freemem ?? freemem;
    this.coresFn = config.cores ?? availableParallelism;
    this.localHeavyDynamic = config.local_heavy_n === undefined;
    const localN = sanitizeCapacity(
      config.local_heavy_n,
      autoLocalHeavyCapacity(this.coresFn(), this.freememFn()),
    );
    const externalN = sanitizeCapacity(config.external_io_n, DEFAULT_EXTERNAL_IO_N);
    this.lanes = {
      'local-heavy': new Lane('local-heavy', localN),
      'external-io': new Lane('external-io', externalN),
    };
    this.now = config.now ?? Date.now;
    this.maxQueueAgeMs = config.max_queue_age_ms ?? MAX_QUEUE_AGE_MS;
    this.emit = config.emit;
  }

  acquire(req: SlotRequest): Promise<SlotLease> {
    const cc = req.call_class;
    // Bypass: fast-path (cheap local) + ai-governor (its own free-pool/BYOK bound).
    if (!isGatedCallClass(cc)) return Promise.resolve(BYPASS_LEASE);
    const lane = this.lanes[cc];
    // Non-reentrant inheritance: a call already holding this lane (an ancestor in
    // the dispatch tree) takes no new slot — the guard that stops a same-lane
    // nested call deadlocking at N = 1 (fold #7).
    if (req.held_lanes?.has(lane.name)) return Promise.resolve(BYPASS_LEASE);

    const call_id = `call_${++this.callSeq}`;
    const descriptor = req.descriptor;
    const signal = req.signal;
    // A request already aborted before it enqueues never takes a slot.
    if (signal?.aborted) {
      return Promise.reject(new SlotCancelledError(call_id));
    }
    // Re-baseline the local-heavy RAM reservation at the idle→busy edge: the first
    // call after the lane has been empty re-measures free RAM, so a daemon that
    // grew its RSS WHILE the lane sat idle (ollama lazy-loads its model post-boot)
    // bounds THIS fresh burst — not only the steady state after some later drain
    // (codex MEDIUM: a release-time-only re-baseline lets the first post-growth
    // burst grant against the stale capacity). `inUse === 0` ⇒ no local-heavy slot
    // is resident ⇒ freemem is a clean baseline; mid-burst acquires keep the fixed
    // reservation, so a burst never re-reads freemem and over-commits ahead of the
    // granted processes' allocation.
    if (this.localHeavyDynamic && lane.name === 'local-heavy' && lane.inUse === 0) {
      lane.capacity = autoLocalHeavyCapacity(this.coresFn(), this.freememFn());
    }
    if (lane.inUse < lane.capacity) {
      return Promise.resolve(this.grant(lane, call_id, descriptor));
    }
    return new Promise<SlotLease>((resolve, reject) => {
      const enqueued_at = this.now();
      let detachSignal = (): void => {};
      const waiter: Waiter = {
        call_id,
        descriptor,
        enqueued_at,
        resolve,
        reject,
        detachSignal: () => detachSignal(),
      };
      if (signal) {
        const onAbort = (): void => {
          // Drop the waiter from the queue and reject — it never dispatched.
          const idx = lane.queue.indexOf(waiter);
          if (idx >= 0) {
            lane.queue.splice(idx, 1);
            waiter.detachSignal();
            reject(new SlotCancelledError(call_id));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        detachSignal = () => signal.removeEventListener('abort', onAbort);
      }
      lane.queue.push(waiter);
      // D-181 slice-4 follow-up #2 — the call blocked on a slot (`waiting_slot`).
      // Fan a `queued` delta so a subscribed client adds the queued-call entry
      // to its active list live, no catch-up poll. Emitted AFTER the push so a
      // re-list triggered by the delta sees the waiter in `gatedEntries()`.
      this.tryEmit('queued', call_id, descriptor, lane.name);
    });
  }

  /** Lane occupancy snapshot (slice-2 tests + server-status). */
  occupancy(): LaneOccupancy[] {
    return (Object.keys(this.lanes) as ExecutionLane[]).map((name) => {
      const l = this.lanes[name];
      return { lane: name, capacity: l.capacity, in_use: l.inUse, queued: l.queue.length };
    });
  }

  /** D-181 §4/§12 — per-lane status for the active list + the server-status
   *  lanes line (adds `oldest_wait_ms` over `occupancy()`). */
  laneStatus(): LaneStatus[] {
    const now = this.now();
    return (Object.keys(this.lanes) as ExecutionLane[]).map((name) => {
      const l = this.lanes[name];
      const oldest = l.queue.reduce((max, w) => Math.max(max, now - w.enqueued_at), 0);
      return {
        lane: name,
        capacity: l.capacity,
        in_use: l.inUse,
        queued: l.queue.length,
        oldest_wait_ms: oldest,
      };
    });
  }

  /** D-181 §7a — the running + queued gated calls as a flat read model, the
   *  source the in-flight registry merges with run-level metadata to build the
   *  `execution.active` snapshot. */
  gatedEntries(): GatedCallEntry[] {
    const out: GatedCallEntry[] = [];
    for (const name of Object.keys(this.lanes) as ExecutionLane[]) {
      const l = this.lanes[name];
      for (const r of l.running.values()) {
        out.push({
          call_id: r.call_id,
          state: 'running',
          lane: name,
          descriptor: r.descriptor,
          enqueued_at: r.enqueued_at,
          slot_acquired_at: r.slot_acquired_at,
          ...(r.last_signal_at !== undefined ? { last_signal_at: r.last_signal_at } : {}),
          stalled: r.stalled,
        });
      }
      for (const w of l.queue) {
        out.push({
          call_id: w.call_id,
          state: 'waiting_slot',
          lane: name,
          descriptor: w.descriptor,
          enqueued_at: w.enqueued_at,
          stalled: false,
        });
      }
    }
    return out;
  }

  /** D-181 §7 — drop a *queued* call before it dispatches. Returns the rpc
   *  status: `cancelled_before_dispatch` (was queued, now rejected),
   *  `already_dispatched` (already won a slot — use kill), or `not_found`. */
  cancel(call_id: string): 'cancelled_before_dispatch' | 'already_dispatched' | 'not_found' {
    for (const name of Object.keys(this.lanes) as ExecutionLane[]) {
      const l = this.lanes[name];
      const idx = l.queue.findIndex((w) => w.call_id === call_id);
      if (idx >= 0) {
        const [waiter] = l.queue.splice(idx, 1);
        waiter.detachSignal();
        waiter.reject(new SlotCancelledError(call_id));
        return 'cancelled_before_dispatch';
      }
      if (l.running.has(call_id)) return 'already_dispatched';
    }
    return 'not_found';
  }

  /** D-181 §7 — move a queued call to the head of its lane queue (ahead of a
   *  long-running blocker). The starvation bound still lets an over-age waiter
   *  jump it at grant time. Returns `promoted` / `not_found`. */
  promote(call_id: string): 'promoted' | 'not_found' {
    for (const name of Object.keys(this.lanes) as ExecutionLane[]) {
      const l = this.lanes[name];
      const idx = l.queue.findIndex((w) => w.call_id === call_id);
      if (idx > 0) {
        const [waiter] = l.queue.splice(idx, 1);
        l.queue.unshift(waiter);
        return 'promoted';
      }
      if (idx === 0) return 'promoted'; // already at head
    }
    return 'not_found';
  }

  private grant(lane: Lane, call_id: string, descriptor: SlotDescriptor): SlotLease {
    lane.inUse += 1;
    const slot_acquired_at = this.now();
    const entry: RunningEntry = {
      call_id,
      descriptor,
      enqueued_at: slot_acquired_at,
      slot_acquired_at,
      stalled: false,
    };
    lane.running.set(call_id, entry);
    let released = false;
    return {
      lane: lane.name,
      reportProgress: () => {
        entry.last_signal_at = this.now();
        entry.stalled = false;
      },
      release: () => {
        if (released) return; // idempotent — second release is a no-op
        released = true;
        lane.running.delete(call_id);
        lane.inUse -= 1;
        this.pump(lane);
      },
    };
  }

  /** Hand freed capacity to queued callers. Honors the promotion starvation
   *  bound first (an over-age waiter jumps the head), else FIFO / promote order. */
  private pump(lane: Lane): void {
    while (lane.inUse < lane.capacity && lane.queue.length > 0) {
      const idx = this.nextWaiterIndex(lane);
      const [waiter] = lane.queue.splice(idx, 1);
      waiter.detachSignal();
      waiter.resolve(this.grant(lane, waiter.call_id, waiter.descriptor));
      // D-181 slice-4 follow-up #2 — a previously-`queued` call won its slot and
      // is now folded into its run's entry. Fan a `slot_acquired` delta so the
      // client drops the queued-call entry without polling. Only `pump` emits it
      // (a fresh direct grant in `acquire` never queued, so there is no
      // queued-call entry to clear and the run already showed via `start`).
      this.tryEmit('slot_acquired', waiter.call_id, waiter.descriptor, lane.name);
    }
  }

  /** D-181 slice-4 follow-up #2 — fan one queue-lifecycle delta. Only a call that
   *  carries a `run_id` is surfaced (the bus event keys on it); best-effort — a
   *  bus failure never aborts slot acquisition / release. */
  private tryEmit(
    op: 'queued' | 'slot_acquired',
    call_id: string,
    descriptor: SlotDescriptor,
    lane: ExecutionLane,
  ): void {
    if (!this.emit) return;
    const run_id = descriptor.run_id;
    if (run_id === undefined) return;
    try {
      this.emit({ recipe_id: descriptor.recipe_id, run_id, op, queued_call_id: call_id, lane });
    } catch {
      /* best-effort — the active list still reads from a snapshot */
    }
  }

  /** Select the next waiter to grant: the oldest over-age waiter if any has
   *  starved past `maxQueueAgeMs`, otherwise the head (index 0 — which `promote`
   *  reorders). */
  private nextWaiterIndex(lane: Lane): number {
    const now = this.now();
    let starvedIdx = -1;
    let starvedAge = this.maxQueueAgeMs;
    for (let i = 0; i < lane.queue.length; i++) {
      const age = now - lane.queue[i].enqueued_at;
      if (age > starvedAge) {
        starvedAge = age;
        starvedIdx = i;
      }
    }
    return starvedIdx >= 0 ? starvedIdx : 0;
  }
}

/** Construct the server's singleton lane governor. */
export const createLaneSemaphore = (config?: LaneSemaphoreConfig): LaneSemaphore =>
  new LaneSemaphore(config);
