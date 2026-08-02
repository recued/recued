/** D-149 P1 — Reception substrate storage (placeholder schemas).
 *
 *  P1 lands the eight Reception tables as `CREATE TABLE IF NOT EXISTS`
 *  shells per the spec line "ALTER TABLE migrations land at boot for
 *  the eight new tables (most are placeholder shells until later
 *  phases populate)" + the pre-launch zero-installs rule (no migration
 *  code, no compat shim — the substrate's standard boot-time DDL
 *  pipeline owns the schema landing).
 *
 *  Per § Must Hold I-15 the eight tables are server-internal — no
 *  cross-cloud sync (D-097 / D-168 retired the legacy SYNC_OBJECTS
 *  substrate).
 *
 *  Each schema mirrors the spec's CREATE TABLE statement verbatim:
 *
 *    - `public_endpoint_registry` (§ A.3)         — endpoint state.
 *    - `public_endpoint_access_log` (§ A.3)       — per-request operational log.
 *    - `reception_form_definition` (§ A.5.3)      — D-145 form-renderer schemas.
 *    - `reception_intake_recipe_pair` (D-200)     — exact direct-checkout pair binding.
 *    - `reception_form_submission` (§ A.5.3)      — visitor submissions: intake AND booking.
 *    - `reception_drop_blob_metadata` (§ A.5.4)   — file-upload metadata.
 *    - `reception_approval_intent` (§ A.5.5)      — single-use approval intents.
 *    - `reception_status_projection` (§ A.5.6)    — read-only status link config.
 *
 *  P3 wires the registry/access-log RPC surface; P6 fills
 *  form_definition + form_submission (D-210 A.8 slice 4b-ii routed P5's
 *  bookings into that same table, and 4c dropped P5's own
 *  `reception_booking_request`); P7 fills drop_blob;
 *  P8 fills approval_intent; P9 fills status_projection. The ninth
 *  `reception_rate_limiter` table (§ Contract Tightening) lands at
 *  P3 alongside the in-memory primary path; it is intentionally
 *  excluded from the P1 placeholder set so `ensureReceptionSchema`
 *  matches the spec P1 line ("eight new tables"). D-200 later adds the
 *  eleventh Reception-owned table for exact intake recipe pairing.
 *
 *  The placeholder tables are intentionally created up-front so the
 *  per-phase fills land as ALTER-free row inserts; pre-launch zero-
 *  installs forbids migration code. Any column drift between the
 *  spec and the placeholder shape is closed at the phase that
 *  populates the table — the schema here is the contract, not a
 *  draft. */

import type Database from 'better-sqlite3';
import {
  RECEPTION_TABLES,
  type ReceptionTableName,
} from '@recued/contracts';

/** Re-exported from contracts so storage callers + tests reference a
 *  single source of truth for the Reception table inventory. */
export { RECEPTION_TABLES };
export type { ReceptionTableName };

/** Idempotent schema install — safe to call on every boot. Mirrors
 *  the per-store pattern used by `ensureContactSchema` /
 *  `ensureCorrectionEventsSchema` etc. The placeholder rows match
 *  spec § A.3 / § A.5.* verbatim so per-phase fills don't re-shape
 *  the table. */
export const ensureReceptionSchema = (db: Database.Database): void => {
  // § A.3 — endpoint registry. Server-internal, no cross-cloud sync (D-097 / D-168).
  // `enabled DEFAULT 0` enforces Must Hold I-1 default-off baseline
  // at the SQL layer; the `endpoint.enable` rpc (P3) is the only path
  // that flips to 1.
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_endpoint_registry (
      endpoint_id                          TEXT PRIMARY KEY,
      kind                                 TEXT NOT NULL,
      enabled                              INTEGER NOT NULL DEFAULT 0,
      packet_declaration                   TEXT NOT NULL,
      bearer_secret_hmac                   BLOB NOT NULL,
      single_use_secret_hmac               BLOB,
      consumed_at                          INTEGER,
      consumed_by_visitor_email_encrypted  BLOB,
      created_at                           INTEGER NOT NULL,
      created_by_client_id                 TEXT NOT NULL,
      expires_at                           INTEGER,
      long_lived_acknowledged_at           INTEGER,
      revoked_at                           INTEGER,
      revocation_reason                    TEXT,
      audit_count                          INTEGER NOT NULL DEFAULT 0,
      last_accessed_at                     INTEGER,
      metadata_blob                        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_endpoint_kind_enabled
      ON public_endpoint_registry (kind, enabled);
    CREATE INDEX IF NOT EXISTS idx_endpoint_active
      ON public_endpoint_registry (enabled, expires_at)
      WHERE revoked_at IS NULL;
  `);

  // § A.3 — operational per-request access log. Bounded retention
  // (90d default per § N.6 PII matrix); never enters D-120 audit by
  // itself — the high-assurance kinds emit the signed memory rows
  // separately via the audit emitter wired in P3.
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_endpoint_access_log (
      id                  TEXT PRIMARY KEY,
      endpoint_id         TEXT NOT NULL,
      accessed_at         INTEGER NOT NULL,
      source_ip_hash      TEXT,
      user_agent_hash     TEXT,
      action_taken        TEXT NOT NULL,
      outcome             TEXT NOT NULL,
      url_path_redacted   TEXT,
      metadata_blob       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_endpoint
      ON public_endpoint_access_log (endpoint_id, accessed_at);
    CREATE INDEX IF NOT EXISTS idx_access_outcome
      ON public_endpoint_access_log (outcome, accessed_at)
      WHERE outcome IN ('rejected', 'invalid_token', 'rate_limited');
  `);

  // D-210 A.8 slice 4c — `reception_booking_request` (D-149 § A.5.2) is DROPPED.
  // A booking is a `reception_form_submission` row whose clear slot makes it a
  // booking and whose absent form definition says it is not an intake; slice
  // 4b-ii moved every writer and every reader, leaving this table with neither.
  // The guarded `resolved_commitment_id` -> `resolved_booking_id` RENAME that
  // sat here went with it: it was dev-DB hygiene for a column ON this table, so
  // it has nothing left to rename. No DROP TABLE shim -- pre-launch, zero
  // installs; a dev DB simply carries an unread table.
  // => [[feedback_pre_launch_no_migration]]

  // § A.5.3 — reception form definitions (D-145 form-renderer schemas
  // in public mode + visibility map for user-only annotations).
  db.exec(`
    CREATE TABLE IF NOT EXISTS reception_form_definition (
      form_definition_id     TEXT PRIMARY KEY,
      template_ref           TEXT,
      schema_blob            TEXT NOT NULL,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      per_field_visibility   TEXT,
      metadata_blob          TEXT
    );
  `);

  // D-200 Slice 6g.2 — one compact, content-addressed recipe binding per
  // intake endpoint. The full form config remains in the endpoint registry and
  // the exact recipe remains in RecipeStore; every render re-derives the hash
  // from those current snapshots before treating this row as ready.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reception_intake_recipe_pair (
      endpoint_id         TEXT PRIMARY KEY,
      -- D-210 R-2 — NULLABLE, and the null is the POINT.
      --
      -- The table is keyed by endpoint and holds one pair per endpoint; the KIND of pair is
      -- the binding's own business. A scheduling pair (v3) has no form: SchedulingLinkConfig
      -- carries a closed required_visitor_fields map, never a form_definition. So this column
      -- is NULL for exactly the pairs that have no form to name, and non-null for every form
      -- pair (v1/v2), where it stays the integrity cross-check against the blob.
      --
      -- NOT a denormalized lookup key: nothing queries by it. idx_intake_recipe_pair_form
      -- below has no reader either -- kept only because the rebuild recreates what it drops.
      form_definition_id  TEXT,
      binding_blob        TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      -- D-207 slice 1b — the door contract minted for this pair.
      --
      -- It is a COLUMN, not a field on binding_blob, for one load-bearing reason: the
      -- blob is content-hashed into pair_revision, so folding the contract_id into it
      -- would change the hash the moment the door is minted -- and pair_revision is what
      -- pins an already-rendered form to the recipe that will process it. The authority
      -- link must not perturb the correctness fence.
      --
      -- NULL = unpaired, or paired before a door was minted. A dispatch that finds NULL
      -- carries no contract_id, so resolveGrantGoverningContractId floors it to
      -- PUBLIC_CONTRACT_ID (grants nothing) rather than contract-free (skips the gate).
      contract_id         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intake_recipe_pair_form
      ON reception_intake_recipe_pair (form_definition_id);
  `);

  // Guarded ALTER — `CREATE TABLE IF NOT EXISTS` skips an existing table, so a live DB
  // predating D-207 keeps its old shape unless the column is added explicitly. Mirrors
  // annotation-store's upgrade block.
  {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(reception_intake_recipe_pair)').all() as { name: string }[])
        .map((c) => c.name),
    );
    if (!cols.has('contract_id')) {
      db.exec('ALTER TABLE reception_intake_recipe_pair ADD COLUMN contract_id TEXT');
    }
  }

  // D-210 R-2 — guarded REBUILD to drop the NOT NULL on `form_definition_id`.
  //
  // `CREATE TABLE IF NOT EXISTS` skips an existing table, and SQLite cannot drop a NOT NULL
  // in place — there is no `ALTER COLUMN`. So a DB created before D-210 keeps a constraint
  // that rejects every scheduling pair, and the only fix is the standard rebuild.
  //
  // Ordering is load-bearing: this runs AFTER the `contract_id` ALTER above, so a pre-D-207
  // DB has grown that column before the copy reads it.
  //
  // Safe to do bluntly here: the reception schema declares ZERO foreign keys, so nothing
  // cascades on DROP and no other object's references need rewriting on RENAME. The whole
  // rebuild runs in ONE transaction — a crash mid-way leaves the original table untouched
  // rather than a half-copied pair registry, which would silently unpair live doors.
  {
    const formCol = (
      db.prepare('PRAGMA table_info(reception_intake_recipe_pair)').all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === 'form_definition_id');
    if (formCol !== undefined && formCol.notnull === 1) {
      db.transaction(() => {
        db.exec(`
          DROP TABLE IF EXISTS reception_intake_recipe_pair_rebuild;
          CREATE TABLE reception_intake_recipe_pair_rebuild (
            endpoint_id         TEXT PRIMARY KEY,
            form_definition_id  TEXT,
            binding_blob        TEXT NOT NULL,
            created_at          INTEGER NOT NULL,
            updated_at          INTEGER NOT NULL,
            contract_id         TEXT
          );
          INSERT INTO reception_intake_recipe_pair_rebuild
            (endpoint_id, form_definition_id, binding_blob, created_at, updated_at, contract_id)
            SELECT endpoint_id, form_definition_id, binding_blob, created_at, updated_at, contract_id
              FROM reception_intake_recipe_pair;
          DROP TABLE reception_intake_recipe_pair;
          ALTER TABLE reception_intake_recipe_pair_rebuild
            RENAME TO reception_intake_recipe_pair;
          CREATE INDEX IF NOT EXISTS idx_intake_recipe_pair_form
            ON reception_intake_recipe_pair (form_definition_id);
        `);
      })();
    }
  }

  // § A.5.3 — visitor form submissions; reactive-trigger fires on
  // row insert per Must Hold I-12. PII payload sub_dek-encrypted
  // per § N.6 retention matrix.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reception_form_submission (
      submission_id              TEXT PRIMARY KEY,
      endpoint_id                TEXT NOT NULL,
      -- D-210 A.8 slice 4a — NULLABLE. A booking has no form definition, and
      -- a sentinel ('0', '') would be a value two live equality checks can
      -- collide on: definitionSnapshotFor compares it against the frozen
      -- snapshot, and the promotion re-check compares it against the held
      -- provenance. Absent is the honest encoding of absent.
      -- ⚠ A dev DB created before this relaxation keeps its NOT NULL: SQLite
      -- cannot drop a constraint by ALTER, only by table rebuild, and a
      -- rebuild is not worth writing pre-launch with zero installs. The stale
      -- constraint is self-diagnosing — slice 4b's first booking insert fails
      -- loudly with a NOT NULL constraint failure, not silently. Recreate the
      -- dev DB if you meet it.
      form_definition_id         TEXT,
      submitted_at               INTEGER NOT NULL,
      source_ip_hash             TEXT,
      visitor_email_encrypted    BLOB,
      submission_blob_encrypted  BLOB NOT NULL,
      schema_version             INTEGER NOT NULL,
      resolved_target_kind       TEXT,
      resolved_target_id         TEXT,
      processing_outcome         TEXT NOT NULL,
      metadata_blob              TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_form_submission_endpoint
      ON reception_form_submission (endpoint_id, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_form_submission_source_window
      ON reception_form_submission (endpoint_id, source_ip_hash, submitted_at);
    CREATE INDEX IF NOT EXISTS idx_form_submission_processing
      ON reception_form_submission (processing_outcome)
      WHERE processing_outcome = 'pending';
  `);

  // ── D-210 A.8 slice 4a — the CLEAR slot, additive ────────────────────
  //
  // The merged table carries the reservation's slot as three NULLABLE, CLEAR
  // columns (null on every intake row; set on every booking row).
  //
  // 🔑 CLEAR, not folded into `submission_blob_encrypted`, and the reason is
  // NOT the one A.8/A.3 gives. That text argues `insertIfAvailable` re-checks
  // the per-day cap on the slot inside the insert transaction — it does not:
  // `countWindowStmt` filters `endpoint_id` + `received_at`, i.e. a rolling
  // 24h rate limit on SUBMISSIONS, and no SQL predicate touches a slot column
  // anywhere today.
  //
  // The real reason is the owner's capacity cap (2026-07-19, follow-on): "if a
  // cap is reached for that particular timeframe/date, block the submission
  // and tell the visitor instantly." That is a COUNT over the slot inside the
  // insert, and it is impossible if the slot is sealed in the blob. The slot
  // stays clear so that cap can exist; nothing else needs it in SQL.
  //
  // ⚠ Slot columns hold what the visitor ASKED for. The reservation is made at
  // APPROVAL, not at submit — there is no hold, and every visitor is told the
  // request will be processed shortly. So a row here is a REQUEST, and the
  // authoritative agreed slot lives on `data_booking` (D-210 A.2). Do not read
  // these as a confirmed appointment.
  //
  // ⚠ ALTER FIRST, INDEX AFTER — `CREATE TABLE IF NOT EXISTS` no-ops on an
  // existing table, so a dev DB that already has this table would never get
  // these columns and an index naming one would fail with `no such column`.
  // Slice 3a hit exactly this. Same guarded-PRAGMA shape as the rename above;
  // NOT a migration shim (pre-launch, zero installs) — dev-DB hygiene.
  {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(reception_form_submission)').all() as { name: string }[])
        .map((c) => c.name),
    );
    if (!cols.has('slot_start_at')) {
      db.exec('ALTER TABLE reception_form_submission ADD COLUMN slot_start_at INTEGER');
    }
    if (!cols.has('slot_end_at')) {
      db.exec('ALTER TABLE reception_form_submission ADD COLUMN slot_end_at INTEGER');
    }
    if (!cols.has('duration_minutes')) {
      db.exec('ALTER TABLE reception_form_submission ADD COLUMN duration_minutes INTEGER');
    }
  }

  // Created AFTER the ALTER, for the reason above. Serves the follow-on
  // capacity cap's `COUNT(*) … WHERE endpoint_id = ? AND slot_start_at
  // BETWEEN ? AND ?`; the existing `idx_form_submission_endpoint` is keyed on
  // `submitted_at` and serves the rolling rate limit, which is a different
  // question.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_form_submission_slot
      ON reception_form_submission (endpoint_id, slot_start_at)
      WHERE slot_start_at IS NOT NULL;
  `);

  // § A.5.4 — drop_link blob metadata. Blob bytes live on the server
  // filesystem under `drop_blobs/<year>/<month>/<sha256>` per
  // Must Hold I-7 (no cloud traversal); this row is the metadata
  // index. Visitor PII columns sub_dek-encrypted per § N.6.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reception_drop_blob_metadata (
      blob_id                       TEXT PRIMARY KEY,
      endpoint_id                   TEXT NOT NULL,
      uploaded_at                   INTEGER NOT NULL,
      source_ip_hash                TEXT,
      visitor_email_encrypted       BLOB,
      visitor_name_encrypted        BLOB,
      visitor_description_encrypted BLOB,
      filename_sanitized            TEXT NOT NULL,
      mime_type_reported            TEXT NOT NULL,
      mime_type_detected            TEXT NOT NULL,
      size_bytes                    INTEGER NOT NULL,
      content_hash                  TEXT NOT NULL,
      storage_path                  TEXT NOT NULL,
      data_file_entity_id           TEXT,
      scan_status                   TEXT,
      processing_outcome            TEXT NOT NULL,
      metadata_blob                 TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_drop_blob_endpoint
      ON reception_drop_blob_metadata (endpoint_id, uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_drop_blob_pending
      ON reception_drop_blob_metadata (processing_outcome)
      WHERE processing_outcome = 'pending';
  `);

  // D-172 resumable uploads — the in-flight chunked-upload session table moved
  // OUT of the Reception schema into the SHARED `upload_session` store
  // (`ensureUploadSessionSchema`), since both reception drop + webclient
  // Data→File ingest are consumers (rev-3 reframe). Keeping it here would also
  // break the RECEPTION_TABLES ratchet (it is not a Reception-substrate table).

  // § A.5.5 — single-use approval intent. `consumed_at` flips
  // atomically in EXCLUSIVE transaction on first valid presentation
  // per Must Hold I-11; second presentation 410 Gone. Consumed-by
  // PII sub_dek-encrypted per § N.6.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reception_approval_intent (
      intent_id                              TEXT PRIMARY KEY,
      endpoint_id                            TEXT NOT NULL,
      action_kind                            TEXT NOT NULL,
      target_id                              TEXT,
      consumed_at                            INTEGER,
      consumed_by_visitor_email_encrypted    BLOB,
      consumed_outcome_encrypted             BLOB,
      source_ip_hash                         TEXT,
      processing_outcome                     TEXT NOT NULL,
      metadata_blob                          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_intent_endpoint
      ON reception_approval_intent (endpoint_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_intent_consumed
      ON reception_approval_intent (intent_id)
      WHERE consumed_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_approval_intent_pending
      ON reception_approval_intent (processing_outcome)
      WHERE processing_outcome = 'pending';
  `);

  // § A.5.6 + § Contract Tightening — read-only status_link
  // projection config. 1:1 with status_link endpoints; FK to
  // public_endpoint_registry. Visitor-side reads never mutate;
  // visitor-facing field set capped by `fields_visible_override`
  // (subset of STATUS_PROJECTION_FIELDS_VISIBLE per projection_kind).
  db.exec(`
    CREATE TABLE IF NOT EXISTS reception_status_projection (
      projection_id               TEXT PRIMARY KEY,
      endpoint_id                 TEXT NOT NULL,
      projection_kind             TEXT NOT NULL,
      source_entity_kind          TEXT NOT NULL,
      source_entity_id            TEXT NOT NULL,
      fields_visible_override     TEXT,
      refresh_policy              TEXT NOT NULL,
      comments_enabled            INTEGER NOT NULL DEFAULT 0,
      shows_update_history        INTEGER NOT NULL DEFAULT 1,
      last_resolved_payload_hash  TEXT,
      last_resolved_at            INTEGER,
      metadata_blob               TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_status_projection_endpoint
      ON reception_status_projection (endpoint_id);
    CREATE INDEX IF NOT EXISTS idx_status_projection_source
      ON reception_status_projection (source_entity_kind, source_entity_id);
  `);

  // § Contract Tightening § Rate-limit substrate — hybrid in-memory
  // primary path + periodic SQLite snapshot for restart-survivability
  // of long-window limits. The in-memory token bucket is the hot path
  // (sub-millisecond check); this table is the durable shadow that
  // preserves per-day caps across process restart.
  //
  // Lands at P3 (per spec § A.3 phase line) — the ninth Reception
  // table, intentionally excluded from the P1 placeholder set because
  // § A.5.* + § A.3 enumerate eight tables. The ratchet test for the
  // eight-table inventory stays unchanged; a P3-side ratchet asserts
  // the ninth table exists with the canonical columns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reception_rate_limiter (
      bucket_key         TEXT PRIMARY KEY,
      bucket_kind        TEXT NOT NULL,
      window_start_at    INTEGER NOT NULL,
      window_end_at      INTEGER NOT NULL,
      count              INTEGER NOT NULL DEFAULT 0,
      last_request_at    INTEGER NOT NULL,
      exhausted_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limiter_window
      ON reception_rate_limiter (window_end_at)
      WHERE exhausted_at IS NOT NULL;
  `);

  // § A.20.5 — Abuse Inbox per-server IP block list (D-149 P12). The
  // tenth Reception table. `(endpoint_id, source_ip_hash)` ban tuples
  // the Abuse Inbox "Ban this IP" action appends + the path-listener
  // enforces before the per-IP rate-limit consume. `source_ip_hash` is
  // the ENDPOINT-SCOPED HKDF hash (§ Must Hold I-9 — bans are
  // per-endpoint; no server-wide raw-IP ban surface). The UNIQUE
  // constraint dedupes re-bans + doubles as the hot-path lookup index.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reception_ip_block_list (
      block_id              TEXT PRIMARY KEY,
      endpoint_id           TEXT NOT NULL,
      source_ip_hash        TEXT NOT NULL,
      blocked_at            INTEGER NOT NULL,
      blocked_by_client_id  TEXT NOT NULL,
      reason                TEXT,
      UNIQUE (endpoint_id, source_ip_hash)
    );
  `);
};
