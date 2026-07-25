/** Shared pressure-details shape (Phase B).
 *
 *  One type reused by both the heartbeat envelope and the
 *  `server.getStatus` rpc response, so the extension renders from one
 *  source of truth. The renderer-on-ext side doesn't need to reconcile
 *  two shapes of the same thing.
 *
 *  Kept in contracts (not in storage-gate) because the heartbeat +
 *  rpc wire surfaces belong here — storage-gate owns the gate
 *  interface, not the wire shape.
 *
 *  `StorageState` is inlined here (not imported from storage-gate) to
 *  keep contracts dep-free. The union mirrors
 *  `packages/storage-gate/src/types.ts`; both forms must stay in
 *  lockstep — a mismatch would be a boot-time wire-shape bug. */

export type StorageState =
  | 'running'
  | 'pressure_managed'
  | 'writes_blocked'
  | 'halted';

export interface PressureSurfaceDetail {
  /** Surface identifier — matches `GateInfo.surface` and the
   *  heartbeat-envelope lookup key. */
  surface: string;
  /** Live state of this surface's gate. */
  state: StorageState;
  /** Current bytes used. */
  used_bytes: number;
  /** Byte quota configured for this surface. */
  quota_bytes: number;
  /** `used_bytes / quota_bytes × 100`, rounded to 1 decimal. Pre-
   *  computed so the renderer doesn't have to divide. `0` when
   *  `quota_bytes === 0` (defensive; never happens under normal
   *  config). */
  pct: number;
  /** Unix-ms timestamp the surface entered its current non-`running`
   *  state. Preserved across daemon restart (server_state persistence).
   *  Omitted when state === 'running'. */
  entered_at?: number;
  /** The most recent reclaim attempt on this surface, whether
   *  successful or not. Omitted when no reclaim has run yet for the
   *  current pressure window. */
  last_reclaim?: {
    /** Unix-ms timestamp of the reclaim attempt. */
    at: number;
    /** Bytes reclaimed across all pipeline steps. */
    bytes_freed: number;
    /** True when the reclaim succeeded in returning the surface to
     *  `running`. False when reclaim ran but the surface is still
     *  in pressure / blocked. */
    success: boolean;
  };
}

export interface PressureDetails {
  /** Overall worst state across the per-surface array — equal to the
   *  max of `per_surface[*].state` by severity rank. Duplicated at the
   *  heartbeat envelope level for renderers that only want a single
   *  pressure indicator. */
  worst_state: StorageState;
  /** Per-surface breakdown. Stable order — surface names are sorted
   *  lexicographically for renderer predictability. */
  per_surface: PressureSurfaceDetail[];
}

/** Rank storage states from least to most constrained; used by both
 *  the rpc layer and the heartbeat builder to compute `worst_state`. */
export const STORAGE_STATE_RANK: Readonly<Record<StorageState, number>> = {
  running: 0,
  pressure_managed: 1,
  writes_blocked: 2,
  halted: 3,
};

/** Pick the worst state across a set of surface details. Returns
 *  `'running'` for an empty input. */
export const worstStorageState = (
  states: ReadonlyArray<StorageState>,
): StorageState => {
  let worst: StorageState = 'running';
  for (const s of states) {
    if (STORAGE_STATE_RANK[s] > STORAGE_STATE_RANK[worst]) worst = s;
  }
  return worst;
};
