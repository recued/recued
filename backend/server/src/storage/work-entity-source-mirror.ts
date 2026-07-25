/** D-192 P3a — the work-entity Source mirror substrate.
 *
 *  Two pieces the read-sync runner (P3b) stands on:
 *
 *  1. **`WorkEntitySourceMirrorStore`** — the Source-identity adapter
 *     over `data_task` / `data_project` / `data_note` the spec
 *     mandates before any poller writes external rows: sync writes key
 *     by `(source_id, source_record_id)`, NEVER a raw local-id upsert
 *     with a fresh generated id (a duplicate-key conflict on the
 *     unique index is a sync bug, not a retry outcome). Mutations
 *     route through the store's `writeTask` / `writeProject` /
 *     `writeNote` / `deleteTask` / `deleteProject` / `deleteNote` so
 *     warehouse events, cascade invalidation, and audit behave exactly
 *     as any other write; only the identity RESOLUTION reads SQL
 *     directly. Implements the shared `SourceMirrorStore` contract
 *     shape (`../source-mirror/store.js`) in spirit — the row store is
 *     the canonical table itself, so `upsert` resolves the existing
 *     local row id first and `list` is deliberately absent (readers
 *     use the store's own list APIs).
 *
 *  2. **`work_entity_source_sync_state`** — one runtime cursor/health
 *     row per Source (spec § Storage model): contract hash, declared
 *     depth/mode, cursor watermark, last-cycle timestamps, error, and
 *     the degraded flag the read resolver consults for freshness
 *     honesty. Runtime state, not entity history — rows die with their
 *     Source (`deleteForSource`), while canonical work-entity rows keep
 *     their soft identity and go `orphaned`.
 *
 *  `note` joined at P6 (the spec's kind order); `commitment` never
 *  syncs through this substrate. */

import type Database from 'better-sqlite3';
import type { WorkEntitySourceDeclarableKind } from '@recued/contracts';
import type { Note, Project, Task } from '@recued/contracts';
import type {
  NoteWriteInput,
  ProjectWriteInput,
  TaskWriteInput,
  WorkEntityStore,
} from './work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Source-identity mirror adapter
// ────────────────────────────────────────────────────────────────

/** The P3a mirror surface (`note` since P6) — `task` / `project` /
 *  `note` rows keyed by `(source_id, source_record_id)`. */
export interface WorkEntitySourceMirrorStore {
  /** Resolve the local row for a remote record. Null when the record
   *  has never been mirrored. */
  getBySourceIdentity(
    kind: WorkEntitySourceDeclarableKind,
    source_id: string,
    source_record_id: string,
  ): Task | Project | Note | null;
  /** Upsert by Source identity: resolves the existing local row's `id`
   *  (or mints none, letting the store generate one) and routes the
   *  write through `writeTask` / `writeProject` / `writeNote` so
   *  events fire. The input's own `source_id`/`source_record_id` are
   *  authoritative. A note upsert onto an EXISTING row preserves what
   *  sync never populates — the canonical `body` (when the incoming
   *  write carries the projector's `''` sentinel), the `related_*`
   *  arrays, and `last_user_action_at` (a sync fold is not a user
   *  action, § A.1.2) — so no fold path can clear local-only lanes. */
  upsertBySourceIdentity(
    input:
      | { kind: 'task'; write: TaskWriteInput & { source_record_id: string } }
      | { kind: 'project'; write: ProjectWriteInput & { source_record_id: string } }
      | { kind: 'note'; write: NoteWriteInput & { source_record_id: string } },
    now?: number,
  ): Task | Project | Note;
  /** The per-Source `source_record_id → source_record_hash` map,
   *  UNCAPPED — the incremental seam (skip unchanged rows) AND the
   *  complete-walk delete diff's prior set. Live rows WITHOUT a stored
   *  hash map to `''` (deviating from the shared `SourceMirrorStore`
   *  omission rule): a row another writer created with a
   *  `source_record_id` but no hash (e.g. a vendor-write hook's
   *  create) must still be VISIBLE to the delete diff — omitting it
   *  would make a vendor-deleted record undeletable forever — while
   *  the `''` sentinel can never falsely hash-match, so it re-syncs
   *  as changed. Tombstoned rows ARE omitted — a deleted row must
   *  not re-enter the diff as a candidate for a second delete. */
  listSnapshotHashes(
    kind: WorkEntitySourceDeclarableKind,
    source_id: string,
  ): Map<string, string>;
  /** Tombstone a mirrored row by Source identity (vendor-side delete).
   *  Routes through the store's tombstoning delete so events fire.
   *  False when no live row matched. */
  tombstoneBySourceIdentity(
    kind: WorkEntitySourceDeclarableKind,
    source_id: string,
    source_record_id: string,
    now?: number,
  ): boolean;
  /** D-192 P4b — the per-Source dirty map (`source_record_id` →
   *  pending-write state) for the sync runner's dirty-row guard: a
   *  `pending` row's canonical fields are a local edit awaiting its
   *  vendor push and must not be overwritten by a sync upsert; an
   *  `awaiting_verify` row WANTS the fold (the write landed, sync
   *  completes its verification). One query per cycle — rows without a
   *  staged state are absent. */
  listPendingWriteStates(
    kind: WorkEntitySourceDeclarableKind,
    source_id: string,
  ): Map<string, 'pending' | 'awaiting_verify'>;
  /** Clear a row's pending-write state by Source identity (the sync
   *  runner completing an `awaiting_verify` fold). False when no row
   *  matched or none was staged. */
  clearPendingWriteBySourceIdentity(
    kind: WorkEntitySourceDeclarableKind,
    source_id: string,
    source_record_id: string,
  ): boolean;
}

const TABLE_BY_KIND: Record<WorkEntitySourceDeclarableKind, string> = {
  task: 'data_task',
  project: 'data_project',
  note: 'data_note',
};

const MIRROR_KINDS = ['task', 'project', 'note'] as const;

export const createWorkEntitySourceMirrorStore = (
  db: Database.Database,
  store: WorkEntityStore,
): WorkEntitySourceMirrorStore => {
  // Identity resolution reads SQL directly (the store has no
  // by-source-identity reader); every MUTATION routes through the
  // store. The partial unique index `(source_id, source_record_id)
  // WHERE source_record_id IS NOT NULL` guarantees ≤ 1 row.
  const idStmt = (table: string) =>
    db.prepare(
      `SELECT id, deleted_at FROM ${table} WHERE source_id = ? AND source_record_id = ?`,
    );
  const hashStmt = (table: string) =>
    db.prepare(
      `SELECT source_record_id, source_record_hash FROM ${table}
        WHERE source_id = ? AND source_record_id IS NOT NULL AND deleted_at IS NULL`,
    );
  const pendingStmt = (table: string) =>
    db.prepare(
      `SELECT source_record_id, pending_write_blob FROM ${table}
        WHERE source_id = ? AND source_record_id IS NOT NULL AND pending_write_blob IS NOT NULL`,
    );
  const stmts = Object.fromEntries(MIRROR_KINDS.map((kind) => [kind, {
    id: idStmt(TABLE_BY_KIND[kind]),
    hash: hashStmt(TABLE_BY_KIND[kind]),
    pending: pendingStmt(TABLE_BY_KIND[kind]),
  }])) as Record<
    WorkEntitySourceDeclarableKind,
    { id: Database.Statement; hash: Database.Statement; pending: Database.Statement }
  >;

  const localRowOf = (
    kind: WorkEntitySourceDeclarableKind,
    source_id: string,
    source_record_id: string,
  ): { id: string; deleted_at: number | null } | null => {
    const row = stmts[kind].id.get(source_id, source_record_id) as
      | { id: string; deleted_at: number | null }
      | undefined;
    return row ?? null;
  };

  return {
    getBySourceIdentity(kind, source_id, source_record_id) {
      const row = localRowOf(kind, source_id, source_record_id);
      if (row === null) return null;
      return kind === 'task'
        ? store.readTask(row.id)
        : kind === 'project' ? store.readProject(row.id) : store.readNote(row.id);
    },

    upsertBySourceIdentity(input, now = Date.now()) {
      const { source_id, source_record_id } = input.write;
      if (typeof source_id !== 'string' || source_id.length === 0) {
        throw new Error('upsertBySourceIdentity: write.source_id is required');
      }
      // A tombstoned row resolves too — a remote record that
      // reappears (un-archived) resurrects under its ORIGINAL local id
      // (`writeTask`/`writeProject`/`writeNote` reset `deleted_at` to
      // null).
      const existingId =
        localRowOf(input.kind, source_id, source_record_id)?.id ?? null;
      if (input.kind === 'task') {
        let write: TaskWriteInput = input.write;
        if (existingId !== null) {
          write = { ...write, id: existingId };
          const existing = store.readTask(existingId);
          if (existing !== null) {
            // Sync NEVER populates the LOCAL-ONLY lanes — the projector writes
            // only the canonical vendor fields (title / done / state / progress /
            // due_at / priority / completed_at) and leaves `body` and every
            // relationship FK unset (relationship write-back is fail-closed;
            // these are not writable lanes). So a fold onto an existing row must
            // never CLEAR them — the `composeVerifiedUpsert` invariant, enforced
            // here at the mirror seam so the awaiting_verify sync fold can't erase
            // a local body / assignment / link the direct verify path would have
            // preserved. `writeTask`'s ON CONFLICT sets every column from
            // `excluded`, binding an unsupplied field to `?? null`, so without
            // this restore a routine vendor-side edit (e.g. a title change) would
            // silently null a user's task→project link on the next cycle. An
            // explicit caller value always wins. Mirrors the note path below.
            if (write.body === undefined) write.body = existing.body;
            if (write.assigned_contact_id === undefined) {
              write.assigned_contact_id = existing.assigned_contact_id;
            }
            if (write.parent_calendar_event_id === undefined) {
              write.parent_calendar_event_id = existing.parent_calendar_event_id;
            }
            if (write.linked_mail_thread_id === undefined) {
              write.linked_mail_thread_id = existing.linked_mail_thread_id;
            }
            if (write.parent_project_id === undefined) {
              write.parent_project_id = existing.parent_project_id;
            }
            if (write.blocks_task_ids === undefined) {
              write.blocks_task_ids = existing.blocks_task_ids;
            }
          }
        }
        return store.writeTask(write, now);
      }
      if (input.kind === 'note') {
        let write: NoteWriteInput = input.write;
        if (existingId !== null) {
          write = { ...write, id: existingId };
          const existing = store.readNote(existingId);
          if (existing !== null) {
            // Sync NEVER populates the canonical long-body column, the
            // related_* arrays, or `last_user_action_at` (the projector
            // writes `body: ''` and leaves the rest unset) — so a fold
            // onto an existing row must never CLEAR them either (the
            // `composeVerifiedUpsert` invariant, enforced at the mirror
            // seam so the awaiting_verify sync fold can't erase a local
            // body the direct verify path would have preserved). An
            // explicit caller value (the verify path's preserve-compose)
            // always wins.
            if (write.body.length === 0) write.body = existing.body;
            // A note Source that maps no title (`canonical.title === ''`) leaves
            // `title` unset; without this restore the user's local title would be
            // nulled on the next fold, same class as the task/project FKs above.
            if (write.title === undefined) write.title = existing.title;
            if (write.related_contact_ids === undefined) {
              write.related_contact_ids = existing.related_contact_ids;
            }
            if (write.related_calendar_event_ids === undefined) {
              write.related_calendar_event_ids = existing.related_calendar_event_ids;
            }
            if (write.related_mail_thread_ids === undefined) {
              write.related_mail_thread_ids = existing.related_mail_thread_ids;
            }
            if (write.related_project_ids === undefined) {
              write.related_project_ids = existing.related_project_ids;
            }
            // A sync fold is not a user action (§ A.1.2).
            if (write.last_user_action_at === undefined) {
              write.last_user_action_at = existing.last_user_action_at;
            }
          }
        }
        return store.writeNote(write, now);
      }
      let write: ProjectWriteInput = input.write;
      if (existingId !== null) {
        write = { ...write, id: existingId };
        const existing = store.readProject(existingId);
        if (existing !== null) {
          // Same invariant as task/note — the projector writes only title /
          // state / target_completion_at, so `description`, `related_contact_ids`,
          // `parent_project_id`, and `last_activity_at` are local-only and must
          // survive a vendor-driven re-fold. `writeProject` binds an unsupplied
          // `last_activity_at` to `now`, so without this restore every fold would
          // silently BUMP the project's activity time to the sync clock.
          if (write.description === undefined) write.description = existing.description;
          if (write.related_contact_ids === undefined) {
            write.related_contact_ids = existing.related_contact_ids;
          }
          if (write.parent_project_id === undefined) {
            write.parent_project_id = existing.parent_project_id;
          }
          if (write.last_activity_at === undefined) {
            write.last_activity_at = existing.last_activity_at;
          }
        }
      }
      return store.writeProject(write, now);
    },

    listSnapshotHashes(kind, source_id) {
      const out = new Map<string, string>();
      for (const row of stmts[kind].hash.all(source_id) as Array<Record<string, unknown>>) {
        const rid = row.source_record_id;
        const h = row.source_record_hash;
        if (typeof rid === 'string') {
          out.set(rid, typeof h === 'string' ? h : '');
        }
      }
      return out;
    },

    tombstoneBySourceIdentity(kind, source_id, source_record_id, now = Date.now()) {
      const row = localRowOf(kind, source_id, source_record_id);
      // Already-tombstoned rows are a no-op — the documented "false
      // when no LIVE row matched" contract. Without this guard a
      // vendor list that keeps returning archived rows would re-stamp
      // `deleted_at`/`updated_at` (and inflate tombstone counts) every
      // sync cycle: the store's tombstoning UPDATE matches dead rows.
      if (row === null || row.deleted_at !== null) return false;
      return kind === 'task'
        ? store.deleteTask(row.id, { tombstone: true, now })
        : kind === 'project'
          ? store.deleteProject(row.id, { tombstone: true, now })
          : store.deleteNote(row.id, { tombstone: true, now });
    },

    listPendingWriteStates(kind, source_id) {
      const out = new Map<string, 'pending' | 'awaiting_verify'>();
      for (const row of stmts[kind].pending.all(source_id) as Array<Record<string, unknown>>) {
        const rid = row.source_record_id;
        if (typeof rid !== 'string') continue;
        try {
          const parsed: unknown = JSON.parse(row.pending_write_blob as string);
          const state = (parsed as { state?: unknown } | null)?.state;
          if (state === 'pending' || state === 'awaiting_verify') out.set(rid, state);
        } catch {
          // An unparseable blob reads as no staged state — the guard
          // fails OPEN to the normal sync overwrite (a corrupt marker
          // must not freeze a row out of sync forever).
        }
      }
      return out;
    },

    clearPendingWriteBySourceIdentity(kind, source_id, source_record_id) {
      const row = localRowOf(kind, source_id, source_record_id);
      if (row === null) return false;
      return store.clearPendingWrite(kind, row.id);
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Sync cursor / health state
// ────────────────────────────────────────────────────────────────

const SYNC_STATE_TABLE = 'work_entity_source_sync_state';

export interface WorkEntitySourceSyncState {
  source_id: string;
  /** Hash of the driving declaration — a changed declaration resets
   *  incremental trust (the runner re-walks from scratch). */
  contract_hash: string;
  sync_depth: 'meta';
  sync_mode: 'read_only' | 'read_write';
  /** Opaque cursor watermark (`updated_since` ISO/ms per declaration);
   *  null = full walk from scratch. */
  cursor_blob: string | null;
  last_sync_started_at: number | null;
  last_sync_completed_at: number | null;
  last_success_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  /** True when the last cycle failed a row on a projection cap or the
   *  fetch itself failed — the read resolver treats a degraded Source
   *  as stale regardless of `last_success_at`. */
  degraded: boolean;
  /** D-192 — lifetime per-declared-path value tally (JSON), the input to the
   *  SILENT-STALENESS signal (`work-entity-source-field-health.ts`). A declared
   *  path that never carries a value is a phantom, and if EVERY hash field is
   *  phantom the record hash is constant, every row reads "unchanged", and the
   *  mirror is frozen forever with no error and no symptom. Null until the first
   *  cycle tallies. */
  field_health_blob: string | null;
  /** D-192 CORE #8f — false when the last SUCCESSFUL cycle covered only a
   *  PARTIAL list: the gateway walk was a non-paginating single page (a
   *  Source list op with no `pagination` declared) or a paginated walk that
   *  truncated (hit the page/record ceiling or an unsafe cursor). A DISTINCT
   *  axis from `degraded` — a cycle can be `degraded: false` (nothing broke)
   *  yet `list_complete: false` (the mirror may not cover the whole list).
   *  Defaults true (a completed cycle is complete until proven partial). */
  list_complete: boolean;
  stale_after_ms: number;
}

export interface WorkEntitySourceSyncStateStore {
  get(source_id: string): WorkEntitySourceSyncState | null;
  upsert(state: WorkEntitySourceSyncState): void;
  /** Mark a cycle start (started_at now; leaves the rest intact). Row
   *  must exist (`upsert` seeds it at registration). */
  markStarted(source_id: string, now: number): void;
  markCompleted(
    source_id: string,
    outcome:
      | { ok: true; cursor_blob?: string | null; complete?: boolean; now: number }
      | { ok: false; error_code: string; error_message: string; degraded?: boolean; now: number },
  ): void;
  /** D-192 — fold a cycle's per-path value tally into the lifetime one. Separate
   *  from `markCompleted` on purpose: the tally is worth keeping even when the
   *  cycle ultimately degrades, since a partially-failed walk still proves which
   *  paths carried values on the rows it DID see. */
  mergeFieldHealth(source_id: string, blob: string): void;
  /** Hard-delete the row (Source unregistered — runtime state, not
   *  preserved history). */
  deleteForSource(source_id: string): boolean;
}

/** Idempotent (`IF NOT EXISTS`). Pre-launch: an older-shape dev DB is
 *  wiped, never migrated. Soft reference to `source_registry` — the
 *  boot reconcile calls `deleteForSource` on unregister, mirroring the
 *  spec's ON DELETE CASCADE intent without coupling table lifetimes
 *  across modules. */
export const ensureWorkEntitySourceSyncStateSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SYNC_STATE_TABLE} (
      source_id               TEXT PRIMARY KEY,
      contract_hash           TEXT NOT NULL,
      sync_depth              TEXT NOT NULL,
      sync_mode               TEXT NOT NULL,
      cursor_blob             TEXT,
      last_sync_started_at    INTEGER,
      last_sync_completed_at  INTEGER,
      last_success_at         INTEGER,
      last_error_code         TEXT,
      last_error_message      TEXT,
      degraded                INTEGER NOT NULL DEFAULT 0,
      list_complete           INTEGER NOT NULL DEFAULT 1,
      stale_after_ms          INTEGER NOT NULL,
      field_health_blob       TEXT
    );
  `);
  // Additive for a DB created before the field-health tally existed.
  const cols = db.prepare(`PRAGMA table_info(${SYNC_STATE_TABLE})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'field_health_blob')) {
    db.exec(`ALTER TABLE ${SYNC_STATE_TABLE} ADD COLUMN field_health_blob TEXT`);
  }
};

export const createWorkEntitySourceSyncStateStore = (
  db: Database.Database,
): WorkEntitySourceSyncStateStore => {
  const getStmt = db.prepare(`SELECT * FROM ${SYNC_STATE_TABLE} WHERE source_id = ?`);
  const upsertStmt = db.prepare(`
    INSERT INTO ${SYNC_STATE_TABLE}
      (source_id, contract_hash, sync_depth, sync_mode, cursor_blob,
       last_sync_started_at, last_sync_completed_at, last_success_at,
       last_error_code, last_error_message, degraded, list_complete, stale_after_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id) DO UPDATE SET
      contract_hash = excluded.contract_hash,
      sync_depth = excluded.sync_depth,
      sync_mode = excluded.sync_mode,
      cursor_blob = excluded.cursor_blob,
      last_sync_started_at = excluded.last_sync_started_at,
      last_sync_completed_at = excluded.last_sync_completed_at,
      last_success_at = excluded.last_success_at,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message,
      degraded = excluded.degraded,
      list_complete = excluded.list_complete,
      stale_after_ms = excluded.stale_after_ms
  `);
  const startStmt = db.prepare(
    `UPDATE ${SYNC_STATE_TABLE} SET last_sync_started_at = ? WHERE source_id = ?`,
  );
  const okStmt = db.prepare(`
    UPDATE ${SYNC_STATE_TABLE} SET
      last_sync_completed_at = ?, last_success_at = ?, cursor_blob = ?,
      last_error_code = NULL, last_error_message = NULL, degraded = 0, list_complete = ?
    WHERE source_id = ?
  `);
  const errStmt = db.prepare(`
    UPDATE ${SYNC_STATE_TABLE} SET
      last_sync_completed_at = ?, last_error_code = ?, last_error_message = ?, degraded = ?
    WHERE source_id = ?
  `);
  // The blob is owned solely by `mergeFieldHealth`. `upsert` deliberately does
  // NOT write it: a Source re-registering (or a boot re-seed) must not wipe the
  // lifetime tally that the phantom-path signal is built on.
  const healthStmt = db.prepare(
    `UPDATE ${SYNC_STATE_TABLE} SET field_health_blob = ? WHERE source_id = ?`,
  );
  const delStmt = db.prepare(`DELETE FROM ${SYNC_STATE_TABLE} WHERE source_id = ?`);

  const rowToState = (row: Record<string, unknown>): WorkEntitySourceSyncState => ({
    source_id: row.source_id as string,
    contract_hash: row.contract_hash as string,
    sync_depth: row.sync_depth as 'meta',
    sync_mode: row.sync_mode as 'read_only' | 'read_write',
    cursor_blob: (row.cursor_blob as string | null) ?? null,
    last_sync_started_at: (row.last_sync_started_at as number | null) ?? null,
    last_sync_completed_at: (row.last_sync_completed_at as number | null) ?? null,
    last_success_at: (row.last_success_at as number | null) ?? null,
    last_error_code: (row.last_error_code as string | null) ?? null,
    last_error_message: (row.last_error_message as string | null) ?? null,
    degraded: row.degraded === 1,
    // Complete unless explicitly recorded 0 (a fresh/unwritten column defaults
    // to 1 in-schema; the `!== 0` read is the safe-honest fallback).
    list_complete: row.list_complete !== 0,
    stale_after_ms: row.stale_after_ms as number,
    field_health_blob: (row.field_health_blob as string | null) ?? null,
  });

  return {
    get(source_id) {
      const row = getStmt.get(source_id) as Record<string, unknown> | undefined;
      return row === undefined ? null : rowToState(row);
    },
    upsert(s) {
      upsertStmt.run(
        s.source_id, s.contract_hash, s.sync_depth, s.sync_mode, s.cursor_blob,
        s.last_sync_started_at, s.last_sync_completed_at, s.last_success_at,
        s.last_error_code, s.last_error_message, s.degraded ? 1 : 0,
        s.list_complete ? 1 : 0, s.stale_after_ms,
      );
    },
    markStarted(source_id, now) {
      startStmt.run(now, source_id);
    },
    markCompleted(source_id, outcome) {
      if (outcome.ok) {
        // list_complete: only an explicit false marks the mirror partial; an
        // omitted flag (a caller predating #8f) keeps the completed cycle
        // complete. The runner passes the real fetch-cycle value.
        okStmt.run(
          outcome.now, outcome.now, outcome.cursor_blob ?? null,
          outcome.complete === false ? 0 : 1, source_id,
        );
      } else {
        errStmt.run(
          outcome.now, outcome.error_code, outcome.error_message,
          outcome.degraded === false ? 0 : 1, source_id,
        );
      }
    },
    mergeFieldHealth(source_id, blob) {
      healthStmt.run(blob, source_id);
    },
    deleteForSource(source_id) {
      return delStmt.run(source_id).changes > 0;
    },
  };
};
