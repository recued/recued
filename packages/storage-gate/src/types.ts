/** Public types for the Phase A storage gate.
 *
 *  The gate is a narrow contract: given a running byte count and a
 *  quota, tell callers whether a write should proceed and emit events
 *  when the state changes. Phase A provides this scaffolding only —
 *  Phase B will layer eviction (cache LRU → audit rotation → user
 *  content blocking) on top. */

/** Four lifecycle states per the Phase A spec.
 *   - running:            used < pressureAt                — writes fine.
 *   - pressure_managed:   pressureAt ≤ used < blockedAt    — writes fine, evict.
 *   - writes_blocked:     used ≥ blockedAt                  — user content rejected.
 *   - halted:             explicit halt (kill switch)      — all writes rejected. */
export type StorageState =
  | 'running'
  | 'pressure_managed'
  | 'writes_blocked'
  | 'halted';

/** Absolute minimum reserve carveout, in bytes. Keeps small-quota
 *  surfaces from computing a trivial reserve when `reservePct` alone
 *  rounds to a handful of kilobytes.
 *
 *  ⚠ A FLOOR, AND A FLOOR CAN EXCEED WHAT IT IS FLOORING — see
 *  {@link MAX_RESERVE_FRACTION}. */
export const MIN_RESERVE_BYTES = 10 * 1024 * 1024;

/** The most of a surface's quota the reserve may ever take.
 *
 *  ⛔⛔ WITHOUT THIS, A SMALL-QUOTA SURFACE IS DEAD FROM BOOT. The reserve is
 *  `max(MIN_RESERVE_BYTES, quota × pct)` and `blockedAt = quota − reserve`, so
 *  any quota at or below the 10 MB floor computed `blockedAt = 0` — and the
 *  gate blocks on `used >= blockedAt`, which at zero is every write, forever,
 *  on a completely empty surface.
 *
 *  ⚠ IT WAS NOT HYPOTHETICAL. `schedules` shipped at a 5 MB quota and
 *  `account_store` at exactly 10 MB, so BOTH were permanently `writes_blocked`
 *  on every server: `schedules.create` could not succeed anywhere. Found by
 *  seeding a demo, because nothing else had called it in a long time and no
 *  test asserted a configured surface is writable at boot.
 *
 *  🔑 Clamping rather than raising the quotas is what stops it recurring: the
 *  next surface added under the floor is capped here instead of arriving
 *  silently dead. Healthy surfaces are unaffected — at any quota above
 *  2 × MIN_RESERVE the floor is already the smaller number. */
export const MAX_RESERVE_FRACTION = 0.5;

export interface GateConfig {
  /** Total quota for this gated surface, in bytes. */
  quota: number;
  /** Reserve percentage (0–100). Effective reserve is the max of this
   *  and `MIN_RESERVE_BYTES`. */
  reservePct: number;
  /** Fraction (0–1) of the user-available region above which we enter
   *  `pressure_managed`. Defaults to 0.8. */
  pressureRatio?: number;
  /** Surface name for events + logging. */
  surface: string;
}

/** Effective thresholds derived from a `GateConfig` + live usage. */
export interface GateInfo {
  surface: string;
  state: StorageState;
  used: number;
  quota: number;
  reserve: number;
  /** `quota - reserve` — bytes available for user content. */
  available: number;
  /** Absolute byte threshold above which we enter pressure_managed. */
  pressureAt: number;
  /** Absolute byte threshold above which user content is rejected. */
  blockedAt: number;
  /** Present when `state === 'halted'`. */
  haltReason: string | null;
}

export interface WriteCheck {
  ok: boolean;
  /** Omitted when `ok === true`. */
  reason?: 'storage_pressure' | 'writes_blocked' | 'halted';
  info: GateInfo;
}

export interface CanWriteOptions {
  /** When true, the write is classified as a reserve-class write
   *  (audit entries, pressure-transition records) and is admitted up to
   *  the full quota even when user writes are blocked. Per spec: "the
   *  reserve allows audit + pressure-transition audit entries to land
   *  even at writes_blocked." */
  reserve?: boolean;
}

export interface StateChangeEvent {
  previous: StorageState;
  next: StorageState;
  info: GateInfo;
  /** Epoch millisecond time of the transition. */
  at: number;
}

export type StateChangeListener = (event: StateChangeEvent) => void;

export interface StorageGate {
  /** Snapshot the current gate state. */
  info(): GateInfo;

  /** Set the absolute usage count and re-evaluate state. */
  setUsed(bytes: number): void;

  /** Incremental helpers. `delta` may be negative. */
  addUsed(delta: number): void;
  subUsed(delta: number): void;

  /** Decide whether a write of `bytes` would be admitted. */
  canWrite(bytes: number, opts?: CanWriteOptions): WriteCheck;

  /** Live-edit the gate's quota / reserve. Emits a state-change event
   *  if the recalculated state differs from the previous one. */
  reconfigure(patch: Partial<Pick<GateConfig, 'quota' | 'reservePct' | 'pressureRatio'>>): void;

  /** Force-halt the surface (kill switch). Reason is surfaced via
   *  `GateInfo.haltReason`. */
  halt(reason: string): void;

  /** Clear an explicit halt. Does nothing when not halted. */
  resume(): void;

  /** Subscribe to state transitions. Returns an unsubscribe handle. */
  onStateChange(listener: StateChangeListener): () => void;
}
