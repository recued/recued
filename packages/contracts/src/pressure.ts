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

/** Human-facing byte size — `2.00 TB`, `1.4 GB`, `812 MB`, `40 KB`.
 *
 *  ⚠ Base-1024 with SI-style labels, matching how the rest of the product
 *  writes sizes (`collection-explorer`'s `formatBytes`). Consistency with the
 *  surrounding UI beats pedantic KiB/MiB here; the quota constants are declared
 *  in the same units.
 *
 *  ⚠ The top tier is TB, not GB: a disk-backed surface really can exceed 1024
 *  GB, and `3072.00 GB` is the shape this used to print there. Every tier below
 *  TB is byte-for-byte unchanged. */
export const formatPressureBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
};

/** One row of the storage read-out, ready to render.
 *
 *  ⛔ WHY THIS EXISTS AS A PURE FUNCTION. `used_bytes` / `quota_bytes` / `pct`
 *  have travelled to every client since Phase B — on `server.getStatus` AND on
 *  the heartbeat envelope — and NO client rendered them. The owner got a
 *  coloured dot saying "pressure managed on one or more surfaces" with no way
 *  to see WHICH surface, how full, or by how much. Everything needed was
 *  already on the wire; only a renderer was missing. Keeping the row model pure
 *  means the ordering + labelling can be tested without a DOM. */
export interface PressureSurfaceRow {
  surface: string;
  /** `used / quota`, e.g. `812 MB / 5.00 GB`. */
  size: string;
  /** Whole-number percentage, clamped to [0, 100] for the bar width. */
  pct: number;
  /** Raw percentage as reported, for the text — NOT clamped, because a surface
   *  over its ceiling is exactly what the owner needs to see. */
  pctLabel: string;
  state: StorageState;
  /** ⛔ HUMAN COPY, not the enum. The first cut rendered `state` straight into
   *  the table and the owner saw `pressure_managed` / `running` — machine
   *  identifiers, sitting beside a task table that correctly says "Complete".
   *  Caught by looking at the page, not by any assertion. */
  stateLabel: string;
  /** The last reclaim attempt, already formatted, or `''` when none has run in
   *  this pressure window. The server has always sent `last_reclaim`; the
   *  column that promised it was rendering nothing. */
  lastReclaim: string;
  /** True for anything the owner should act on — used to mark the row. */
  attention: boolean;
}

/** Machine state → the sentence an owner can act on. */
const STATE_LABEL: Readonly<Record<StorageState, string>> = {
  running: 'OK',
  pressure_managed: 'Under pressure',
  writes_blocked: 'Writes blocked',
  halted: 'Halted',
};

/** Coarse relative time — this column answers "recently or not", and a precise
 *  timestamp would be noise next to a percentage. */
const relativeAge = (at: number, now: number): string => {
  const ms = Math.max(0, now - at);
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

/** Project pressure details into render-ready rows, MOST CONSTRAINED FIRST.
 *
 *  ⚠ Sorted by `pct` descending, not alphabetically: the point of the read-out
 *  is to answer "what is about to stop working", and a lexicographic list buries
 *  that under whichever surface happens to start with 'a'. Ties break on name so
 *  the order is stable between heartbeats and does not flicker. */
export const pressureSurfaceRows = (
  details: PressureDetails | undefined,
  now: number = Date.now(),
): PressureSurfaceRow[] => {
  if (!details?.per_surface?.length) return [];
  return [...details.per_surface]
    .sort((a, b) => (b.pct - a.pct) || a.surface.localeCompare(b.surface))
    .map((d) => ({
      surface: d.surface,
      size: `${formatPressureBytes(d.used_bytes)} / ${formatPressureBytes(d.quota_bytes)}`,
      pct: Math.max(0, Math.min(100, Math.round(d.pct))),
      pctLabel: `${Math.round(d.pct)}%`,
      state: d.state,
      stateLabel: STATE_LABEL[d.state] ?? d.state,
      lastReclaim: d.last_reclaim
        ? `${relativeAge(d.last_reclaim.at, now)}`
          + ` · freed ${formatPressureBytes(d.last_reclaim.bytes_freed)}`
        : '',
      attention: d.state !== 'running',
    }));
};
