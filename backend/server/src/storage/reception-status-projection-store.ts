/** D-149 P9 § A.5.6 — `reception_status_projection` store.
 *
 *  Status link projections are read-only views over one entity in the
 *  user's warehouse. The flow:
 *
 *    1. Mary creates a status_link endpoint via the rpc surface; the
 *       substrate also inserts a 1:1 projection row in
 *       `reception_status_projection` keyed on `projection_id` derived
 *       from the endpoint_id. The substrate is the only writer.
 *    2. Visitor accesses `/reception/status/<endpoint_id>` → handler
 *       loads the projection row + resolves `(source_entity_kind,
 *       source_entity_id)` via the injected entity reader → builds the
 *       redacted packet → renders HTML or returns JSON depending on
 *       `?format=json`.
 *    3. Handler optionally writes back `last_resolved_payload_hash` +
 *       `last_resolved_at` after rendering so auto-refresh polls can
 *       skip re-render when the projection is unchanged (HTTP ETag
 *       semantics; future P10 / P12 wiring).
 *
 *  v1 keeps the row stateless from the visitor's perspective — the
 *  read-only invariant is structural (no POST handler) + the substrate
 *  cache columns (`last_resolved_payload_hash` / `last_resolved_at`)
 *  are write-only-by-substrate, never visitor-controllable.
 *
 *  Spec: D-149 § A.5.6 + § Contract Tightening +
 *  § Must Hold I-2 + I-12. */

import type Database from 'better-sqlite3';
import type { StatusLinkProjectionKind } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Row shape (mirrors reception-store CREATE TABLE)
// ────────────────────────────────────────────────────────────────

interface StatusProjectionRow {
  projection_id: string;
  endpoint_id: string;
  projection_kind: string;
  source_entity_kind: string;
  source_entity_id: string;
  fields_visible_override: string | null;
  refresh_policy: string;
  comments_enabled: number;
  shows_update_history: number;
  last_resolved_payload_hash: string | null;
  last_resolved_at: number | null;
  metadata_blob: string | null;
}

// ────────────────────────────────────────────────────────────────
// Public projections + inputs
// ────────────────────────────────────────────────────────────────

export interface StatusProjectionRefreshPolicy {
  readonly auto_refresh_enabled: boolean;
  readonly refresh_interval_seconds?: number;
}

export interface StatusProjectionSummary {
  readonly projection_id: string;
  readonly endpoint_id: string;
  readonly projection_kind: StatusLinkProjectionKind;
  readonly source_entity_kind: string;
  readonly source_entity_id: string;
  readonly fields_visible_override: ReadonlyArray<string> | null;
  readonly refresh_policy: StatusProjectionRefreshPolicy;
  readonly comments_enabled: boolean;
  readonly shows_update_history: boolean;
  readonly last_resolved_payload_hash: string | null;
  readonly last_resolved_at: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface StatusProjectionCreateInput {
  readonly projection_id: string;
  readonly endpoint_id: string;
  readonly projection_kind: StatusLinkProjectionKind;
  readonly source_entity_kind: string;
  readonly source_entity_id: string;
  readonly fields_visible_override?: ReadonlyArray<string>;
  readonly refresh_policy: StatusProjectionRefreshPolicy;
  readonly comments_enabled: boolean;
  readonly shows_update_history: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StatusProjectionRecordResolvedInput {
  readonly endpoint_id: string;
  readonly payload_hash: string;
  readonly now: number;
}

export interface StatusProjectionStore {
  /** Insert a 1:1 projection row at endpoint create. */
  create(input: StatusProjectionCreateInput): StatusProjectionSummary;

  /** Read by projection_id. Returns `null` on miss. */
  findById(projection_id: string): StatusProjectionSummary | null;

  /** Read the (singleton) projection row for an endpoint. */
  findByEndpoint(endpoint_id: string): StatusProjectionSummary | null;

  /** Substrate-side mutator — record the most recent render's
   *  payload-hash + timestamp for HTTP-ETag-style cache validation.
   *  Visitor-side reads never trigger this; only the handler writes
   *  after a successful render. */
  recordResolved(
    input: StatusProjectionRecordResolvedInput,
  ): 'updated' | 'not_found';

  /** Substrate-side mutator — drop the cached resolved hash. Called
   *  when the source entity changes so a stale visitor poll returns
   *  the fresh projection instead of a 304-style no-op. */
  invalidateResolvedCache(endpoint_id: string): 'updated' | 'not_found';

  /** Delete the projection row (called when the endpoint is revoked
   *  via the rpc layer). */
  deleteByEndpoint(endpoint_id: string): 'deleted' | 'not_found';
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const parseMetadataBlob = (raw: string | null): Readonly<Record<string, unknown>> => {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const parseFieldsOverride = (raw: string | null): ReadonlyArray<string> | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v === 'string') out.push(v);
    }
    return out;
  } catch {
    return null;
  }
};

const parseRefreshPolicy = (raw: string): StatusProjectionRefreshPolicy => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const auto = parsed.auto_refresh_enabled === true;
    const intervalRaw = parsed.refresh_interval_seconds;
    const interval =
      typeof intervalRaw === 'number' && Number.isFinite(intervalRaw)
        ? intervalRaw
        : undefined;
    return interval === undefined
      ? { auto_refresh_enabled: auto }
      : { auto_refresh_enabled: auto, refresh_interval_seconds: interval };
  } catch {
    return { auto_refresh_enabled: false };
  }
};

const rowToSummary = (row: StatusProjectionRow): StatusProjectionSummary => {
  return {
    projection_id: row.projection_id,
    endpoint_id: row.endpoint_id,
    projection_kind: row.projection_kind as StatusLinkProjectionKind,
    source_entity_kind: row.source_entity_kind,
    source_entity_id: row.source_entity_id,
    fields_visible_override: parseFieldsOverride(row.fields_visible_override),
    refresh_policy: parseRefreshPolicy(row.refresh_policy),
    comments_enabled: row.comments_enabled === 1,
    shows_update_history: row.shows_update_history === 1,
    last_resolved_payload_hash: row.last_resolved_payload_hash,
    last_resolved_at: row.last_resolved_at,
    metadata: parseMetadataBlob(row.metadata_blob),
  };
};

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

export const createReceptionStatusProjectionStore = (
  db: Database.Database,
): StatusProjectionStore => {
  const insertStmt = db.prepare(`
    INSERT INTO reception_status_projection (
      projection_id, endpoint_id, projection_kind,
      source_entity_kind, source_entity_id,
      fields_visible_override, refresh_policy,
      comments_enabled, shows_update_history,
      last_resolved_payload_hash, last_resolved_at, metadata_blob
    ) VALUES (
      @projection_id, @endpoint_id, @projection_kind,
      @source_entity_kind, @source_entity_id,
      @fields_visible_override, @refresh_policy,
      @comments_enabled, @shows_update_history,
      NULL, NULL, @metadata_blob
    )
  `);

  const findByIdStmt = db.prepare(
    `SELECT * FROM reception_status_projection WHERE projection_id = @projection_id`,
  );
  const findByEndpointStmt = db.prepare(
    `SELECT * FROM reception_status_projection WHERE endpoint_id = @endpoint_id LIMIT 1`,
  );

  const recordResolvedStmt = db.prepare(`
    UPDATE reception_status_projection
       SET last_resolved_payload_hash = @payload_hash,
           last_resolved_at = @now
     WHERE endpoint_id = @endpoint_id
  `);

  const invalidateCacheStmt = db.prepare(`
    UPDATE reception_status_projection
       SET last_resolved_payload_hash = NULL,
           last_resolved_at = NULL
     WHERE endpoint_id = @endpoint_id
  `);

  const deleteByEndpointStmt = db.prepare(
    `DELETE FROM reception_status_projection WHERE endpoint_id = @endpoint_id`,
  );

  return {
    create(input) {
      insertStmt.run({
        projection_id: input.projection_id,
        endpoint_id: input.endpoint_id,
        projection_kind: input.projection_kind,
        source_entity_kind: input.source_entity_kind,
        source_entity_id: input.source_entity_id,
        fields_visible_override:
          input.fields_visible_override !== undefined
            ? JSON.stringify(input.fields_visible_override)
            : null,
        refresh_policy: JSON.stringify(input.refresh_policy),
        comments_enabled: input.comments_enabled ? 1 : 0,
        shows_update_history: input.shows_update_history ? 1 : 0,
        metadata_blob: input.metadata ? JSON.stringify(input.metadata) : null,
      });
      const row = findByIdStmt.get({ projection_id: input.projection_id }) as
        | StatusProjectionRow
        | undefined;
      if (!row) {
        throw new Error('ReceptionStatusProjectionStore.create: row missing after insert');
      }
      return rowToSummary(row);
    },

    findById(projection_id) {
      const row = findByIdStmt.get({ projection_id }) as StatusProjectionRow | undefined;
      return row ? rowToSummary(row) : null;
    },

    findByEndpoint(endpoint_id) {
      const row = findByEndpointStmt.get({ endpoint_id }) as StatusProjectionRow | undefined;
      return row ? rowToSummary(row) : null;
    },

    recordResolved(input) {
      const result = recordResolvedStmt.run({
        endpoint_id: input.endpoint_id,
        payload_hash: input.payload_hash,
        now: input.now,
      });
      return result.changes > 0 ? 'updated' : 'not_found';
    },

    invalidateResolvedCache(endpoint_id) {
      const result = invalidateCacheStmt.run({ endpoint_id });
      return result.changes > 0 ? 'updated' : 'not_found';
    },

    deleteByEndpoint(endpoint_id) {
      const result = deleteByEndpointStmt.run({ endpoint_id });
      return result.changes > 0 ? 'deleted' : 'not_found';
    },
  };
};
