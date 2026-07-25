// D-181 Slice 2 — the LaneGovernor port.
//
// The engine depends on this *interface* (a port); the concrete two-lane
// `LaneSemaphore` lives in `backend/server/` (so `packages/` never imports
// `backend/`, preserving the public boundary). The engine acquires a slot
// before a heavy call, runs the call inline-within-run, and releases on settle.
// See `docs/d-181-spec.md` §4/§5.

import type { CallClass, ExecutionLane } from './execution-lane.js';

/** Minimal identity of the call requesting a slot. Slice 4 (the active-list)
 *  enriches the descriptor (step_id, source, kill handle, progress contract);
 *  slice 2 needs only enough to label a queue/registry entry. */
export interface SlotDescriptor {
  readonly recipe_id: string;
  readonly slug: string;
  readonly run_id?: string;
  readonly step_id?: string;
}

export interface SlotRequest {
  readonly call_class: CallClass;
  readonly descriptor: SlotDescriptor;
  /** Lanes already held by this call's *ancestors* in the dispatch tree.
   *  When the requested lane is already held, the governor returns an
   *  **inherited** lease (no new slot) — this is the non-reentrant guard that
   *  stops a same-lane nested call deadlocking at `N = 1` (D-181 §5, fold #7).
   *  Empty/omitted for a top-level call. */
  readonly held_lanes?: ReadonlySet<ExecutionLane>;
  /** Aborts the *queue wait* (a run killed while waiting for a slot). Optional
   *  in slice 2 — the kill path that drives it lands in slice 4. */
  readonly signal?: AbortSignal;
}

/** The settle outcome reported back on release. `killed` is reserved for the
 *  slice-4 kill path; slice 2 only ever reports `succeeded` / `failed`. */
export type SlotOutcome = 'succeeded' | 'failed' | 'killed';

/** D-181 §7 — the `code` carried by the error a gated `acquire` rejects with when
 *  its queued call is dropped before dispatch (an `execution.cancel`, or a
 *  `SlotRequest.signal` abort). The backend `SlotCancelledError` stamps it; the
 *  engine recognises it (the error propagates through `invokeGoverned`) to
 *  preserve a `slot_cancelled` marker into the failing step's error details, so
 *  the host can label the run `cancelled_before_dispatch` from the engine outcome
 *  alone — no run-level registry marker (D-181 §7c cancel-marker root fix). */
export const SLOT_CANCELLED_ERROR_CODE = 'slot_cancelled';

export interface SlotLease {
  /** The lane this lease occupies, or `null` when the call **bypassed** the
   *  semaphore (fast-path / ai-governor) or **inherited** an ancestor's
   *  same-lane slot. A `null` lane consumes no capacity and releases nothing. */
  readonly lane: ExecutionLane | null;
  /** A progress tick (heartbeat / file-growth / provider-event). No-op until
   *  slice 3 wires stall detection; safe to call always. */
  reportProgress(): void;
  /** Release the slot. **Must** run in a `finally` so a crashed call never
   *  leaks a slot (the slot-exhaustion correctness-must, D-181 §5). Idempotent:
   *  a second call is a no-op. */
  release(outcome: SlotOutcome): void;
}

export interface LaneGovernor {
  /** Acquire a slot for a heavy call. Resolves immediately for `fast-path` /
   *  `ai-governor` / an inherited same-lane request; otherwise resolves once a
   *  lane slot is free (queueing if the lane is full). */
  acquire(req: SlotRequest): Promise<SlotLease>;
}

/** A lease that occupies nothing — the bypass/inherited result and the value
 *  the no-op governor always returns. */
export const BYPASS_LEASE: SlotLease = {
  lane: null,
  reportProgress() {
    /* no-op */
  },
  release() {
    /* no-op */
  },
};

/** The governor the engine falls back to when none is injected (dbless tests,
 *  client-side contexts). Grants every request instantly, so behaviour is
 *  byte-identical to the pre-D-181 path until the server wires the real
 *  `LaneSemaphore`. */
export const NO_OP_LANE_GOVERNOR: LaneGovernor = {
  acquire: async () => BYPASS_LEASE,
};
