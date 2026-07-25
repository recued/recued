/** D-145 PB14 — `CorrectionEventsStore` SQLite-backed implementation.
 *
 *  Per § B.14.2. Persists per-pair correction events as rows on the
 *  `correction_events` table. Per-pair only — no cross-cloud sync
 *  (D-097 / D-168); never returned via MCP responses (per-pair private
 *  vocabulary). The substrate enforces this by construction — no rpc
 *  in this file serializes rows through any cloud-bound surface.
 *
 *  Engine consumption hooks read through `listRecent` /
 *  `listRecentByKind` / `listByContact`; the orchestrator threads
 *  results to `packages/engine/src/correction-learning/` pure
 *  consumption helpers (Hook 1 / Hook 2 / Hook 3 per § B.14.3).
 *
 *  Compaction (§ B.14.4): `pruneOlderThan(now)` removes rows with
 *  `event_at < now - CORRECTION_EVENT_RETENTION_MS` EXCEPT kinds in
 *  `CORRECTION_EVENT_DURABLE_KINDS` (contact_merged +
 *  standing_instruction_added retain indefinitely). Housekeeping
 *  task wires this on a periodic cadence.
 *
 *  Spec: `docs/d-145-spec.md` § B.14.2 + § B.14.4. */

import type Database from 'better-sqlite3';
import {
  CORRECTION_EVENT_DURABLE_KINDS,
  CORRECTION_EVENT_KIND_SET,
  CORRECTION_EVENT_RETENTION_MS,
  CORRECTION_EVENT_SCOPE_SET,
  assertValidCorrectionEventRow,
  type CorrectionEventKind,
  type CorrectionEventRow,
  type CorrectionEventScope,
} from '@recued/contracts';

/** Server-internal table name. Per-pair only. */
export const CORRECTION_EVENTS_TABLE = 'correction_events';

/** Idempotent schema install — safe to call on every boot. The three
 *  indexes mirror § B.14.2 verbatim:
 *
 *    - `idx_correction_kind_time` powers the per-kind recency walks
 *      Hook 1 / Hook 2 / Hook 3 perform (newest-first within a kind).
 *    - `idx_correction_plan` powers the plan-correlation Settings UI
 *      surface ("what corrections did this plan trigger?").
 *    - `idx_correction_extraction` powers the extraction-event
 *      correlation Settings UI surface. */
export const ensureCorrectionEventsSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CORRECTION_EVENTS_TABLE} (
      id                          TEXT PRIMARY KEY,
      ts                          INTEGER NOT NULL,
      event_at                    INTEGER NOT NULL,
      kind                        TEXT NOT NULL,
      payload_blob                TEXT NOT NULL,
      source_plan_id              TEXT,
      source_extraction_event_id  TEXT,
      scope                       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_correction_kind_time
      ON ${CORRECTION_EVENTS_TABLE} (kind, event_at DESC);
    CREATE INDEX IF NOT EXISTS idx_correction_plan
      ON ${CORRECTION_EVENTS_TABLE} (source_plan_id)
      WHERE source_plan_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_correction_extraction
      ON ${CORRECTION_EVENTS_TABLE} (source_extraction_event_id)
      WHERE source_extraction_event_id IS NOT NULL;
  `);
};

interface RawRow {
  id: string;
  ts: number;
  event_at: number;
  kind: string;
  payload_blob: string;
  source_plan_id: string | null;
  source_extraction_event_id: string | null;
  scope: string;
}

const rowFromRaw = (raw: RawRow): CorrectionEventRow => {
  if (!CORRECTION_EVENT_KIND_SET.has(raw.kind as CorrectionEventKind)) {
    throw new Error(
      `${CORRECTION_EVENTS_TABLE}: persisted kind '${raw.kind}' is not in CORRECTION_EVENT_KINDS (id=${raw.id})`,
    );
  }
  if (!CORRECTION_EVENT_SCOPE_SET.has(raw.scope as CorrectionEventScope)) {
    throw new Error(
      `${CORRECTION_EVENTS_TABLE}: persisted scope '${raw.scope}' is not in CORRECTION_EVENT_SCOPES (id=${raw.id})`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.payload_blob);
  } catch (e) {
    throw new Error(
      `${CORRECTION_EVENTS_TABLE}: failed to parse payload_blob for id ${raw.id}: ${(e as Error).message}`,
    );
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `${CORRECTION_EVENTS_TABLE}: payload_blob for id ${raw.id} is not a JSON object`,
    );
  }
  return {
    id: raw.id,
    ts: raw.ts,
    event_at: raw.event_at,
    kind: raw.kind as CorrectionEventKind,
    payload_blob: payload as Record<string, unknown>,
    ...(raw.source_plan_id !== null ? { source_plan_id: raw.source_plan_id } : {}),
    ...(raw.source_extraction_event_id !== null
      ? { source_extraction_event_id: raw.source_extraction_event_id }
      : {}),
    scope: raw.scope as CorrectionEventScope,
  };
};

export interface ListRecentOptions {
  /** Cap the result set. Defaults to 200 (Settings UI page size +
   *  engine-consumption recency window). */
  readonly limit?: number;
  /** Filter to a single kind. Used by Hook 2 (extraction confidence
   *  re-calibration walks the `extraction_undone` + `rejected_extraction`
   *  rows) and Hook 1 (`context_marked_omit` walk). */
  readonly kind?: CorrectionEventKind;
  /** Filter to a single scope. Used by Hook 1 to skip
   *  `this_request` / `this_session` rows that are inert across
   *  requests. */
  readonly scope?: CorrectionEventScope;
}

export interface CorrectionEventsStore {
  /** Insert a row. Validates the envelope + per-kind payload via the
   *  contracts-side `assertValidCorrectionEventRow` before the SQLite
   *  write. Throws `CorrectionEventValidationError` on bad input.
   *  Throws on duplicate `id` — callers should generate fresh UUIDs. */
  record(row: CorrectionEventRow): void;
  /** List rows newest-first (`event_at DESC`), optionally filtered. */
  listRecent(options?: ListRecentOptions): CorrectionEventRow[];
  /** List rows linked to a specific RecuedPlan. Used by the Settings
   *  UI "see corrections for this plan" surface. */
  listByPlan(plan_id: string): CorrectionEventRow[];
  /** List rows linked to a specific extraction event id. Used by the
   *  Settings UI + replay path. */
  listByExtractionEvent(extraction_event_id: string): CorrectionEventRow[];
  /** Clear every row. Settings UI "Clear my correction history"
   *  affordance routes through this; engine reverts to default
   *  thresholds + omission defaults on the next request. */
  clearAll(): number;
  /** Prune rows with `event_at < now - CORRECTION_EVENT_RETENTION_MS`
   *  except kinds in `CORRECTION_EVENT_DURABLE_KINDS`. Returns the
   *  number of rows removed. Housekeeping wires this. */
  pruneOlderThan(now: number): number;
  /** Total row count (test + diagnostics). */
  count(): number;
}

/** Distinguishable error raised on duplicate-id insert. The substrate
 *  uses crypto-random UUIDs; this surfaces the (~impossible)
 *  collision so the caller can regenerate. */
export class CorrectionEventIdCollisionError extends Error {
  readonly code = 'CORRECTION_EVENT_ID_COLLISION' as const;
  constructor(public readonly id: string) {
    super(
      `${CORRECTION_EVENTS_TABLE}: id '${id}' already in use; caller must generate a fresh id`,
    );
    this.name = 'CorrectionEventIdCollisionError';
  }
}

export const createCorrectionEventsStore = (
  db: Database.Database,
): CorrectionEventsStore => {
  ensureCorrectionEventsSchema(db);

  const insertStmt = db.prepare(
    `INSERT INTO ${CORRECTION_EVENTS_TABLE}
       (id, ts, event_at, kind, payload_blob, source_plan_id,
        source_extraction_event_id, scope)
     VALUES
       (@id, @ts, @event_at, @kind, @payload_blob, @source_plan_id,
        @source_extraction_event_id, @scope)`,
  );

  const listAllStmt = db.prepare(
    `SELECT id, ts, event_at, kind, payload_blob, source_plan_id,
            source_extraction_event_id, scope
       FROM ${CORRECTION_EVENTS_TABLE}
      ORDER BY event_at DESC
      LIMIT @limit`,
  );

  const listByKindStmt = db.prepare(
    `SELECT id, ts, event_at, kind, payload_blob, source_plan_id,
            source_extraction_event_id, scope
       FROM ${CORRECTION_EVENTS_TABLE}
      WHERE kind = @kind
      ORDER BY event_at DESC
      LIMIT @limit`,
  );

  const listByScopeStmt = db.prepare(
    `SELECT id, ts, event_at, kind, payload_blob, source_plan_id,
            source_extraction_event_id, scope
       FROM ${CORRECTION_EVENTS_TABLE}
      WHERE scope = @scope
      ORDER BY event_at DESC
      LIMIT @limit`,
  );

  const listByKindAndScopeStmt = db.prepare(
    `SELECT id, ts, event_at, kind, payload_blob, source_plan_id,
            source_extraction_event_id, scope
       FROM ${CORRECTION_EVENTS_TABLE}
      WHERE kind = @kind AND scope = @scope
      ORDER BY event_at DESC
      LIMIT @limit`,
  );

  const listByPlanStmt = db.prepare(
    `SELECT id, ts, event_at, kind, payload_blob, source_plan_id,
            source_extraction_event_id, scope
       FROM ${CORRECTION_EVENTS_TABLE}
      WHERE source_plan_id = @plan_id
      ORDER BY event_at DESC`,
  );

  const listByExtractionStmt = db.prepare(
    `SELECT id, ts, event_at, kind, payload_blob, source_plan_id,
            source_extraction_event_id, scope
       FROM ${CORRECTION_EVENTS_TABLE}
      WHERE source_extraction_event_id = @extraction_event_id
      ORDER BY event_at DESC`,
  );

  const clearStmt = db.prepare(`DELETE FROM ${CORRECTION_EVENTS_TABLE}`);

  // Prune excludes durable kinds via a NOT IN clause. Bind the list
  // verbatim — better-sqlite3 binds arrays via a placeholder
  // expansion; we build the placeholder string from the closed list
  // length so the prepared statement stays stable.
  const durablePlaceholders = CORRECTION_EVENT_DURABLE_KINDS.map(() => '?').join(', ');
  const pruneStmt = db.prepare(
    `DELETE FROM ${CORRECTION_EVENTS_TABLE}
      WHERE event_at < ?
        AND kind NOT IN (${durablePlaceholders})`,
  );

  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM ${CORRECTION_EVENTS_TABLE}`);

  return {
    record(row) {
      // Substrate-boundary validation — parsed-JSON inputs (rpc body
      // payloads) go through this gate before reaching SQLite.
      assertValidCorrectionEventRow(row);
      // Codex P2 fold (2026-05-10) — derive correlation columns from
      // payload IDs when callers omit them. Without this, valid
      // corrections accepted by the contract (e.g. `plan_outcome_corrected`
      // carrying `payload.plan_id` but no `source_plan_id`) persist with
      // NULL correlation columns and disappear from listByPlan() /
      // listByExtractionEvent() correlation surfaces unless every
      // producer manually duplicates the link. The substrate now lifts
      // the canonical payload field onto the column at insert time so
      // queryability is structural, not per-caller-discipline.
      const payload = row.payload_blob as Record<string, unknown>;
      const payloadPlanId =
        row.kind === 'plan_outcome_corrected' && typeof payload.plan_id === 'string'
          ? payload.plan_id
          : null;
      const payloadExtractionEventId =
        (row.kind === 'extraction_undone' ||
          row.kind === 'extraction_edited' ||
          row.kind === 'rejected_extraction') &&
        typeof payload.extraction_event_id === 'string'
          ? payload.extraction_event_id
          : null;
      try {
        insertStmt.run({
          id: row.id,
          ts: row.ts,
          event_at: row.event_at,
          kind: row.kind,
          payload_blob: JSON.stringify(row.payload_blob),
          source_plan_id: row.source_plan_id ?? payloadPlanId,
          source_extraction_event_id:
            row.source_extraction_event_id ?? payloadExtractionEventId,
          scope: row.scope,
        });
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) {
          throw new CorrectionEventIdCollisionError(row.id);
        }
        throw e;
      }
    },
    listRecent(options) {
      const limit = options?.limit ?? 200;
      let rows: RawRow[];
      if (options?.kind && options?.scope) {
        rows = listByKindAndScopeStmt.all({
          kind: options.kind,
          scope: options.scope,
          limit,
        }) as RawRow[];
      } else if (options?.kind) {
        rows = listByKindStmt.all({ kind: options.kind, limit }) as RawRow[];
      } else if (options?.scope) {
        rows = listByScopeStmt.all({ scope: options.scope, limit }) as RawRow[];
      } else {
        rows = listAllStmt.all({ limit }) as RawRow[];
      }
      return rows.map(rowFromRaw);
    },
    listByPlan(plan_id) {
      const rows = listByPlanStmt.all({ plan_id }) as RawRow[];
      return rows.map(rowFromRaw);
    },
    listByExtractionEvent(extraction_event_id) {
      const rows = listByExtractionStmt.all({ extraction_event_id }) as RawRow[];
      return rows.map(rowFromRaw);
    },
    clearAll() {
      const res = clearStmt.run();
      return res.changes;
    },
    pruneOlderThan(now) {
      const cutoff = now - CORRECTION_EVENT_RETENTION_MS;
      const res = pruneStmt.run(cutoff, ...CORRECTION_EVENT_DURABLE_KINDS);
      return res.changes;
    },
    count() {
      const row = countStmt.get() as { n: number };
      return row.n;
    },
  };
};
