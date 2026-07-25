/** D-205 item #1 — the `contact_source_sync_state` runtime health row.
 *
 *  The contact-family counterpart of `file_source_sync_state`: ONE row per contact
 *  Source recording the last sync cycle's health and what it actually did.
 *
 *  ## Why this exists
 *
 *  `runContactSourceSync` returns a detailed outcome — how many records hydrated,
 *  how many failed their `supplies` promise, how many could not be keyed, how many
 *  could not be mirrored — and the housekeeping step **`await`ed it and threw it
 *  away**, while its own comment claimed *"a failed / degraded cycle is a RECORDED
 *  outcome."* It recorded nothing, anywhere.
 *
 *  So a leaf that quietly stopped emitting `address` would fail EVERY record, EVERY
 *  cycle, forever — and the only observable effect would be that contacts stopped
 *  gaining addresses. No error, no log, no state. That is the exact silent failure
 *  the whole `supplies`-promise mechanism was built to make loud (slices 5–7): the
 *  runner did its job, screamed into a `return`, and nobody was listening.
 *
 *  This row is who is listening. It is also what the
 *  `source_freshness_degradation` producer reads to give a contact Source a real
 *  health verdict — before this, that producer had no contact branch at all, so a
 *  totally broken contact Source reported `degraded: false` with a straight face.
 *
 *  ## Thinner than the file row, in one specific way
 *
 *  No `cursor_blob`, no `last_full_walk_at`. `ContactSourceDeclaration` declares **no
 *  cursor facet** — the runner says so out loud ("There is deliberately NO
 *  delta/cursor arm ... every cycle is a full walk, and the hash-skip keeps an
 *  unchanged re-list cheap"). Inventing a cursor column here would be a watermark
 *  with nothing behind it. A vendor that grows a real delta earns a cursor facet on
 *  the declaration first.
 *
 *  ## Fatter than the file row, in one specific way
 *
 *  It carries `last_cycle` — the counts. A contact cycle's failures are COUNTED
 *  rather than thrown (one bad vendor payload must not abort the walk), so the
 *  counts *are* the failure report; discarding them and keeping only a boolean would
 *  throw away the only diagnosis available. `last_error_message` additionally carries
 *  the runner's failure SAMPLES, which it already collects and — before this — also
 *  dropped on the floor.
 *
 *  Lifecycle mirrors the file store: seeded at task registration, `markStarted` /
 *  `markCompleted` per cycle, `deleteForSource` on unregister (runtime state, not
 *  preserved history). Spec: D-205 §9.1. */

import type Database from 'better-sqlite3';
import type { ContactSourceCycleCounts } from '@recued/contracts';

/** D-205 #2c — the counts moved to `@recued/contracts` when they started crossing
 *  the wire (`contact.source.list`): `packages/` can never import from `backend/`.
 *  Re-exported here so this module stays the family's front door and its existing
 *  importers are untouched. One definition, two doors. */
export type { ContactSourceCycleCounts } from '@recued/contracts';

export const CONTACT_SOURCE_SYNC_STATE_TABLE = 'contact_source_sync_state';

/** Staleness threshold for a contact Source. Housekeeping-cadence sync + low churn
 *  — matches the file family's 6h. A single constant; a future per-vendor knob would
 *  land on the `ContactSourceDeclaration`, not here. */
export const CONTACT_SOURCE_STALE_AFTER_MS = 21_600_000; // 6h

export interface ContactSourceSyncState {
  source_id: string;
  last_sync_started_at: number | null;
  last_sync_completed_at: number | null;
  /** The last CLEAN cycle. A degraded cycle does NOT bump it, so the freshness
   *  reader treats a broken Source as stale however recently it ran. */
  last_success_at: number | null;
  last_error_code: string | null;
  /** The failure, in words — including the runner's failure SAMPLES. "12 record(s)
   *  failed — hs_1: attributes.address promised by the declaration but absent" is a
   *  bug report; `degraded: true` is a shrug. */
  last_error_message: string | null;
  /** The last cycle failed outright, OR walked but could not do so cleanly
   *  (`failed_rows` / `unkeyable` / `mirror_failed`). Reads as stale regardless of
   *  `last_success_at`. */
  degraded: boolean;
  stale_after_ms: number;
  /** The last cycle that actually WALKED. Null when no cycle has ever got that far
   *  (a Source refused at the config gate never produces counts). */
  last_cycle: ContactSourceCycleCounts | null;
}

/** The outcome of one cycle, as the store records it.
 *
 *  ⚠ Deliberately NOT the file store's `{ ok: true } | { ok: false }` discriminant,
 *  where a DEGRADED-but-successful cycle is passed as `ok: false` and its counts are
 *  simply lost. Here `error` is the health verdict and `counts` is orthogonal to it,
 *  because a degraded contact cycle is precisely the one whose counts you most want
 *  to keep — they are the diagnosis. */
export interface ContactSourceCycleOutcome {
  now: number;
  /** `null` = a clean cycle: bumps `last_success_at` and clears the flags. */
  error: { code: string; message: string } | null;
  /** Absent when the cycle was REFUSED before it walked (a config/policy failure
   *  produces no counts). A cycle that walked records them either way. */
  counts?: ContactSourceCycleCounts;
}

export interface ContactSourceSyncStateStore {
  get(source_id: string): ContactSourceSyncState | null;
  /** D-205 #2c — every row. UNCAPPED, and deliberately: the Sources strip must show
   *  EVERY Source, and a Source silently missing from a health list reads as "fine"
   *  — the exact failure this whole family exists to end. The row count is bounded
   *  by the number of enrolled connections (single digits), so there is nothing to
   *  page. */
  list(): ContactSourceSyncState[];
  /** Seed / replace a row. The wire seeds-if-absent at task registration, so health
   *  survives boot re-scans. */
  upsert(state: ContactSourceSyncState): void;
  /** Mark a cycle start. */
  markStarted(source_id: string, now: number): void;
  /** Record a cycle outcome. See {@link ContactSourceCycleOutcome}. */
  markCompleted(source_id: string, outcome: ContactSourceCycleOutcome): void;
  /** Hard-delete the row (Source unregistered — runtime state, not history). */
  deleteForSource(source_id: string): boolean;
}

/** D-205 #2c — the freshness verdict, derived from a sync-state row. The contact
 *  twin of `deriveFileSourceFreshness`, and identical by design: both families
 *  answer "how current is this mirror?" the same way.
 *
 *  `state === null` (never registered, or unregistered) → stale + never-synced. A
 *  Source we know nothing about is not a healthy one. Pure. */
export interface ContactSourceFreshness {
  /** The last clean cycle's completion time; null = never synced. */
  last_success_at: number | null;
  /** The last cycle failed / could not walk cleanly (reads stale regardless of time). */
  degraded: boolean;
  /** Degraded, never-synced, or `now - last_success_at > stale_after_ms`. */
  stale: boolean;
}

export const deriveContactSourceFreshness = (
  state: ContactSourceSyncState | null,
  now: number,
): ContactSourceFreshness => {
  if (state === null) return { last_success_at: null, degraded: false, stale: true };
  const stale =
    state.degraded
    || state.last_success_at === null
    || now - state.last_success_at > state.stale_after_ms;
  return { last_success_at: state.last_success_at, degraded: state.degraded, stale };
};

/** A fresh, never-synced state row for a newly-registered contact Source. */
export const initialContactSourceSyncState = (
  source_id: string,
): ContactSourceSyncState => ({
  source_id,
  last_sync_started_at: null,
  last_sync_completed_at: null,
  last_success_at: null,
  last_error_code: null,
  last_error_message: null,
  degraded: false,
  stale_after_ms: CONTACT_SOURCE_STALE_AFTER_MS,
  last_cycle: null,
});

export const ensureContactSourceSyncStateSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONTACT_SOURCE_SYNC_STATE_TABLE} (
      source_id              TEXT PRIMARY KEY,
      last_sync_started_at   INTEGER,
      last_sync_completed_at INTEGER,
      last_success_at        INTEGER,
      last_error_code        TEXT,
      last_error_message     TEXT,
      degraded               INTEGER NOT NULL DEFAULT 0,
      stale_after_ms         INTEGER NOT NULL,
      last_cycle             TEXT
    );
  `);
};

export const createContactSourceSyncStateStore = (
  db: Database.Database,
): ContactSourceSyncStateStore => {
  const getStmt = db.prepare(
    `SELECT * FROM ${CONTACT_SOURCE_SYNC_STATE_TABLE} WHERE source_id = ?`,
  );
  // Ordered so the strip renders deterministically. No LIMIT — see `list()`.
  const listStmt = db.prepare(
    `SELECT * FROM ${CONTACT_SOURCE_SYNC_STATE_TABLE} ORDER BY source_id ASC`,
  );
  const upsertStmt = db.prepare(`
    INSERT INTO ${CONTACT_SOURCE_SYNC_STATE_TABLE}
      (source_id, last_sync_started_at, last_sync_completed_at, last_success_at,
       last_error_code, last_error_message, degraded, stale_after_ms, last_cycle)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id) DO UPDATE SET
      last_sync_started_at   = excluded.last_sync_started_at,
      last_sync_completed_at = excluded.last_sync_completed_at,
      last_success_at        = excluded.last_success_at,
      last_error_code        = excluded.last_error_code,
      last_error_message     = excluded.last_error_message,
      degraded               = excluded.degraded,
      stale_after_ms         = excluded.stale_after_ms,
      last_cycle             = excluded.last_cycle
  `);

  // 🔑 markStarted / markCompleted are UPSERTS, not the file store's bare UPDATEs.
  //
  // The wire seeds the row at task registration, so in production the row is always
  // there — but an UPDATE against a missing row affects ZERO rows and reports
  // SUCCESS. A store whose entire purpose is to stop a failed cycle from vanishing
  // silently must not have, as its own failure mode, a cycle outcome vanishing
  // silently. So a missing row is created rather than skipped.
  const startStmt = db.prepare(`
    INSERT INTO ${CONTACT_SOURCE_SYNC_STATE_TABLE}
      (source_id, last_sync_started_at, degraded, stale_after_ms)
    VALUES (?, ?, 0, ?)
    ON CONFLICT (source_id) DO UPDATE SET last_sync_started_at = excluded.last_sync_started_at
  `);
  const okStmt = db.prepare(`
    INSERT INTO ${CONTACT_SOURCE_SYNC_STATE_TABLE}
      (source_id, last_sync_completed_at, last_success_at, degraded, stale_after_ms, last_cycle)
    VALUES (@source_id, @now, @now, 0, @stale_after_ms, @last_cycle)
    ON CONFLICT (source_id) DO UPDATE SET
      last_sync_completed_at = excluded.last_sync_completed_at,
      last_success_at        = excluded.last_success_at,
      last_error_code        = NULL,
      last_error_message     = NULL,
      degraded               = 0,
      last_cycle             = COALESCE(excluded.last_cycle, ${CONTACT_SOURCE_SYNC_STATE_TABLE}.last_cycle)
  `);
  const errStmt = db.prepare(`
    INSERT INTO ${CONTACT_SOURCE_SYNC_STATE_TABLE}
      (source_id, last_sync_completed_at, last_error_code, last_error_message,
       degraded, stale_after_ms, last_cycle)
    VALUES (@source_id, @now, @code, @message, 1, @stale_after_ms, @last_cycle)
    ON CONFLICT (source_id) DO UPDATE SET
      last_sync_completed_at = excluded.last_sync_completed_at,
      last_error_code        = excluded.last_error_code,
      last_error_message     = excluded.last_error_message,
      degraded               = 1,
      last_cycle             = COALESCE(excluded.last_cycle, ${CONTACT_SOURCE_SYNC_STATE_TABLE}.last_cycle)
  `);
  const delStmt = db.prepare(
    `DELETE FROM ${CONTACT_SOURCE_SYNC_STATE_TABLE} WHERE source_id = ?`,
  );

  /** A hand-edited / truncated blob must not poison a caller — a state row that
   *  cannot be READ is one more silent failure, and this module exists to end those. */
  const parseCycle = (raw: unknown): ContactSourceCycleCounts | null => {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      return JSON.parse(raw) as ContactSourceCycleCounts;
    } catch {
      return null;
    }
  };

  const rowToState = (row: Record<string, unknown>): ContactSourceSyncState => ({
    source_id: row.source_id as string,
    last_sync_started_at: (row.last_sync_started_at as number | null) ?? null,
    last_sync_completed_at: (row.last_sync_completed_at as number | null) ?? null,
    last_success_at: (row.last_success_at as number | null) ?? null,
    last_error_code: (row.last_error_code as string | null) ?? null,
    last_error_message: (row.last_error_message as string | null) ?? null,
    degraded: row.degraded === 1,
    stale_after_ms: row.stale_after_ms as number,
    last_cycle: parseCycle(row.last_cycle),
  });

  return {
    get(source_id) {
      if (!source_id) return null;
      const row = getStmt.get(source_id) as Record<string, unknown> | undefined;
      return row === undefined ? null : rowToState(row);
    },
    list() {
      return (listStmt.all() as Record<string, unknown>[]).map(rowToState);
    },
    upsert(s) {
      upsertStmt.run(
        s.source_id,
        s.last_sync_started_at,
        s.last_sync_completed_at,
        s.last_success_at,
        s.last_error_code,
        s.last_error_message,
        s.degraded ? 1 : 0,
        s.stale_after_ms,
        s.last_cycle === null ? null : JSON.stringify(s.last_cycle),
      );
    },
    markStarted(source_id, now) {
      if (!source_id) return;
      startStmt.run(source_id, now, CONTACT_SOURCE_STALE_AFTER_MS);
    },
    markCompleted(source_id, outcome) {
      if (!source_id) return;
      // A cycle REFUSED at the config gate never walked, so it has no counts — and
      // it must not blank the counts of the last cycle that did (COALESCE above).
      const last_cycle =
        outcome.counts === undefined ? null : JSON.stringify(outcome.counts);
      if (outcome.error === null) {
        okStmt.run({
          source_id,
          now: outcome.now,
          stale_after_ms: CONTACT_SOURCE_STALE_AFTER_MS,
          last_cycle,
        });
      } else {
        errStmt.run({
          source_id,
          now: outcome.now,
          code: outcome.error.code,
          message: outcome.error.message,
          stale_after_ms: CONTACT_SOURCE_STALE_AFTER_MS,
          last_cycle,
        });
      }
    },
    deleteForSource(source_id) {
      return source_id ? delStmt.run(source_id).changes > 0 : false;
    },
  };
};
