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
}

const DEFAULT_PRESSURE_RATIO = 0.8;

export const createStorageGate = (opts: CreateGateOptions): StorageGate => {
  let quota = assertPositive(opts.quota, 'quota');
  let reservePct = assertPct(opts.reservePct, 'reservePct');
  let pressureRatio = clampRatio(opts.pressureRatio ?? DEFAULT_PRESSURE_RATIO);
  const surface = opts.surface;
  const now = opts.now ?? (() => Date.now());

  let used = 0;
  let state: StorageState = 'running';
  let haltReason: string | null = null;

  const listeners = new Set<StateChangeListener>();

  const computeThresholds = () => {
    const reserve = Math.max(MIN_RESERVE_BYTES, Math.floor(quota * (reservePct / 100)));
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
      used,
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
    if (used >= t.blockedAt) next = 'writes_blocked';
    else if (used >= t.pressureAt) next = 'pressure_managed';
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
    const projected = used + bytes;

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
    info: buildInfo,
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
