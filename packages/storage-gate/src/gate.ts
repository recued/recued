/** Storage-gate implementation.
 *
 *  Single-producer, single-consumer state machine. Usage is tracked as
 *  an opaque byte count — the gate never scans storage itself; callers
 *  (vault, shared_store, cache, audit, schedules) inform it via
 *  `setUsed` or incremental `addUsed` / `subUsed` each time they commit
 *  or evict a row.
 *
 *  Phase A ships the interface + wiring only. Phase B will plug in an
 *  eviction cascade (cache LRU → audit rotation → user-content block)
 *  that listens on the state-change events emitted here. */

import {
  MAX_RESERVE_FRACTION,
  MIN_RESERVE_BYTES,
  type CanWriteOptions,
  type GateConfig,
  type GateInfo,
  type StateChangeEvent,
  type StateChangeListener,
  type StorageGate,
  type StorageState,
  type WriteCheck,
} from './types.js';

export interface CreateGateOptions extends GateConfig {
  /** Time source — injectable for deterministic tests. */
  now?: () => number;
  /** ⛔ AUTHORITATIVE USAGE, PULLED INSTEAD OF PUSHED. When supplied, this is
   *  the surface's byte total and the internal `used` counter is never read.
   *
   *  WHY IT EXISTS. `used` is maintained by callers — `addUsed` on write,
   *  `setUsed` on re-anchor — and a caller that mutates the surface WITHOUT
   *  reporting it silently desynchronises the gate. That is not hypothetical:
   *  `audit-compaction` deletes audit rows through raw SQL and reports nothing,
   *  so the audit gate over-reported until the hourly retention pass
   *  re-anchored it. Once the pressure read-out surfaced `used_bytes` to the
   *  owner, that stale number became visible.
   *
   *  Threading a gate into every deleter would RELOCATE the obligation, not
   *  remove it — the next deleter forgets too. A provider removes it: the gate
   *  asks the source of truth, so no writer anywhere has to remember.
   *
   *  ⚠ MUST BE CHEAP. It is called on every read and every state recompute. The
   *  audit surface can afford it only because `readAuditUsageBytes` is an
   *  O(1) indexed row read backed by SQLite triggers; before that counter
   *  existed a provider would have meant a full table scan per call, which is
   *  far worse than the drift it fixes.
   *
   *  ⚠ A provider that throws or returns a non-finite/negative value falls back
   *  to the internal counter rather than corrupting the gate. */
  usageProvider?: () => number;
}

const DEFAULT_PRESSURE_RATIO = 0.8;

export const createStorageGate = (opts: CreateGateOptions): StorageGate => {
  let quota = assertPositive(opts.quota, 'quota');
  let reservePct = assertPct(opts.reservePct, 'reservePct');
  let pressureRatio = clampRatio(opts.pressureRatio ?? DEFAULT_PRESSURE_RATIO);
  const surface = opts.surface;
  const now = opts.now ?? (() => Date.now());

  const usageProvider = opts.usageProvider;
  let used = 0;
  let state: StorageState = 'running';
  let haltReason: string | null = null;

  const listeners = new Set<StateChangeListener>();

  /** The surface's byte total: the provider when one is wired, else the
   *  caller-maintained counter. Every read of usage goes through here. */
  const currentUsed = (): number => {
    if (!usageProvider) return used;
    try {
      const value = usageProvider();
      return Number.isFinite(value) && value >= 0 ? value : used;
    } catch {
      // A broken provider must not take the gate down, and must not invent a
      // 0 — that reads as "empty". Fall back to the pushed counter, which is
      // stale but in the right neighbourhood.
      return used;
    }
  };

  const computeThresholds = () => {
    // ⛔ The floor is CLAMPED so it can never consume the whole quota. Without
    //    this, any quota at or below MIN_RESERVE_BYTES computed
    //    `available = 0`, and the gate blocks on `used >= blockedAt` — so an
    //    empty surface rejected every write, forever. See MAX_RESERVE_FRACTION.
    const desiredReserve = Math.max(MIN_RESERVE_BYTES, Math.floor(quota * (reservePct / 100)));
    const reserve = Math.min(desiredReserve, Math.floor(quota * MAX_RESERVE_FRACTION));
    const available = Math.max(0, quota - reserve);
    const pressureAt = Math.floor(available * pressureRatio);
    const blockedAt = available;
    return { reserve, available, pressureAt, blockedAt };
  };

  const buildInfo = (): GateInfo => {
    const t = computeThresholds();
    return {
      surface,
      state,
      used: currentUsed(),
      quota,
      reserve: t.reserve,
      available: t.available,
      pressureAt: t.pressureAt,
      blockedAt: t.blockedAt,
      haltReason,
    };
  };

  const emit = (event: StateChangeEvent) => {
    for (const l of listeners) {
      try { l(event); } catch { /* listener must not crash the gate */ }
    }
  };

  const recomputeState = () => {
    if (state === 'halted') return; // halt overrides everything
    const t = computeThresholds();
    let next: StorageState;
    const u = currentUsed();
    if (u >= t.blockedAt) next = 'writes_blocked';
    else if (u >= t.pressureAt) next = 'pressure_managed';
    else next = 'running';
    if (next !== state) {
      const previous = state;
      state = next;
      emit({ previous, next, info: buildInfo(), at: now() });
    }
  };

  const setUsed = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(`gate(${surface}).setUsed: bytes must be a non-negative finite number`);
    }
    // ⚠ THE COUNTER IS MAINTAINED EVEN UNDER A PROVIDER, and that is load
    // bearing rather than tidy-mindedness. It is the FALLBACK `currentUsed`
    // returns when the provider throws or answers nonsense. The first cut
    // skipped the write under a provider, which made `used` permanently 0 — so
    // the fallback reported an EMPTY surface, the most dangerous wrong answer
    // (it clears pressure and unblocks writes on a full disk). The mutation
    // that replaced the fallback with a literal 0 passed every test, because
    // the fixture made both branches agree.
    used = bytes;
    recomputeState();
  };

  const addUsed = (delta: number) => {
    if (!Number.isFinite(delta)) {
      throw new RangeError(`gate(${surface}).addUsed: delta must be finite`);
    }
    used = Math.max(0, used + delta);
    recomputeState();
  };

  const subUsed = (delta: number) => {
    addUsed(-Math.abs(delta));
  };

  const canWrite = (bytes: number, options: CanWriteOptions = {}): WriteCheck => {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(`gate(${surface}).canWrite: bytes must be a non-negative finite number`);
    }
    const info = buildInfo();

    if (state === 'halted') {
      return { ok: false, reason: 'halted', info };
    }

    const reserveClass = !!options.reserve;
    const ceiling = reserveClass ? info.quota : info.blockedAt;
    const projected = currentUsed() + bytes;

    if (projected > ceiling) {
      return {
        ok: false,
        reason: reserveClass ? 'halted' : state === 'writes_blocked' ? 'writes_blocked' : 'storage_pressure',
        info,
      };
    }

    // Within ceiling but we are in pressure_managed — writes still accepted.
    return { ok: true, info };
  };

  const reconfigure = (patch: Partial<Pick<GateConfig, 'quota' | 'reservePct' | 'pressureRatio'>>) => {
    if (patch.quota !== undefined) quota = assertPositive(patch.quota, 'quota');
    if (patch.reservePct !== undefined) reservePct = assertPct(patch.reservePct, 'reservePct');
    if (patch.pressureRatio !== undefined) pressureRatio = clampRatio(patch.pressureRatio);
    recomputeState();
  };

  const halt = (reason: string) => {
    if (state === 'halted') {
      haltReason = reason;
      return;
    }
    const previous = state;
    state = 'halted';
    haltReason = reason;
    emit({ previous, next: 'halted', info: buildInfo(), at: now() });
  };

  const resume = () => {
    if (state !== 'halted') return;
    haltReason = null;
    state = 'running';
    recomputeState();
    if (state === 'running') {
      emit({ previous: 'halted', next: 'running', info: buildInfo(), at: now() });
    }
  };

  const onStateChange = (listener: StateChangeListener): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  return {
    // ⚠ A provider-backed surface can change with NO call into the gate (a raw
    // DELETE elsewhere), so its state is recomputed at read time — that is what
    // makes `info().state` agree with `info().used`. Surfaces without a
    // provider keep the previous behaviour exactly: no recompute on read.
    info: () => {
      if (usageProvider) recomputeState();
      return buildInfo();
    },
    setUsed,
    addUsed,
    subUsed,
    canWrite,
    reconfigure,
    halt,
    resume,
    onStateChange,
  };
};

const assertPositive = (n: number, field: string): number => {
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`${field} must be a positive finite number (got ${n})`);
  }
  return n;
};

const assertPct = (n: number, field: string): number => {
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new RangeError(`${field} must be in [0, 100] (got ${n})`);
  }
  return n;
};

const clampRatio = (n: number): number => {
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new RangeError(`pressureRatio must be in (0, 1) (got ${n})`);
  }
  return n;
};
