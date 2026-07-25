/** D-149 P8 § A.5.5 — `reception_approval_intent` store.
 *
 *  Approval intents are one-shot scoped action records. The flow:
 *
 *    1. Mary creates an approval_link endpoint via the rpc surface;
 *       the substrate also inserts a *pre-consumption* row in
 *       `reception_approval_intent` keyed on a fresh `intent_id`
 *       (1:1 with the endpoint). The substrate is the only writer.
 *    2. Visitor accesses `/reception/approve/<endpoint_id>` → handler
 *       renders the consent form against the intent's `metadata_blob`
 *       (action_kind / target_id / etc.).
 *    3. Visitor submits → handler calls `tryConsume({ intent_id, ... })`
 *       which performs an EXCLUSIVE-transaction atomic flip of
 *       `consumed_at IS NULL → consumed_at = now`. First valid
 *       presentation wins; concurrent presentations all see
 *       `'already_consumed'`.
 *    4. Engine-side reactive trigger consumes pending consumed rows
 *       (`consumed_at IS NOT NULL AND processing_outcome = 'pending'`)
 *       async per § Must Hold I-12.
 *
 *  This store is not a user-attention surface; visitor-consumed rows are
 *  pending only for the engine-side reactive cursor.
 *
 *  Encryption discipline (per spec § N.6 + `approval-pii.ts`):
 *
 *    - `consumed_by_visitor_email_encrypted` — sealed with AAD
 *      `(endpoint_id, intent_id, 'visitor_email')`.
 *    - `consumed_outcome_encrypted` — sealed with AAD
 *      `(.., 'outcome')`. Wire shape is the canonical outcome string
 *      from `formatApprovalLinkConsumedOutcome` (closed taxonomy
 *      per spec § A.5.5 line 881).
 *    - Visitor name (when self-identified) is sealed into
 *      `metadata_blob.visitor_name_encrypted` since the schema doesn't
 *      reserve a dedicated column for it (spec § A.5.5 schema lines
 *      874-885 only has the two encrypted columns). The substrate
 *      keeps the AAD binding even though the storage layer is JSON.
 *
 *  Single-use enforcement (Must Hold I-11):
 *
 *    SQLite's `BEGIN EXCLUSIVE` transaction lock serializes the
 *    consume path; combined with the `WHERE consumed_at IS NULL`
 *    clause on the UPDATE, two concurrent processes hitting the same
 *    intent_id always see exactly one successful UPDATE. The other
 *    sees `changes === 0` and returns `'already_consumed'`. The unique
 *    index `idx_approval_intent_consumed` (created on `intent_id`
 *    WHERE consumed_at IS NOT NULL`) provides a third layer of
 *    defense — even if the EXCLUSIVE logic regresses, the index would
 *    raise a constraint violation on the second write.
 *
 *  Spec: D-149 § A.5.5 + § Must Hold I-11 + I-12. */

import type Database from 'better-sqlite3';
import {
  APPROVAL_LINK_PROCESSING_OUTCOME_SET,
  type ApprovalLinkActionKind,
  type ApprovalLinkProcessingOutcome,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Row shape (mirrors reception-store CREATE TABLE)
// ────────────────────────────────────────────────────────────────

interface ApprovalIntentRow {
  intent_id: string;
  endpoint_id: string;
  action_kind: string;
  target_id: string | null;
  consumed_at: number | null;
  consumed_by_visitor_email_encrypted: Buffer | null;
  consumed_outcome_encrypted: Buffer | null;
  source_ip_hash: string | null;
  processing_outcome: string;
  metadata_blob: string | null;
}

// ────────────────────────────────────────────────────────────────
// Public projections
// ────────────────────────────────────────────────────────────────

/** Public summary projection — read-side. Encrypted columns surface as
 *  base64 strings so callers (e.g., the engine reactive handler) can
 *  decrypt via `openApprovalIntentPiiField`. */
export interface ApprovalIntentSummary {
  readonly intent_id: string;
  readonly endpoint_id: string;
  readonly action_kind: ApprovalLinkActionKind;
  readonly target_id: string | null;
  readonly consumed_at: number | null;
  readonly consumed_by_visitor_email_encrypted: string | null;
  readonly consumed_outcome_encrypted: string | null;
  readonly source_ip_hash: string | null;
  readonly processing_outcome: ApprovalLinkProcessingOutcome;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ApprovalIntentCreateInput {
  readonly intent_id: string;
  readonly endpoint_id: string;
  readonly action_kind: ApprovalLinkActionKind;
  readonly target_id: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ApprovalIntentConsumeInput {
  readonly intent_id: string;
  readonly endpoint_id: string;
  readonly now: number;
  readonly source_ip_hash: string | null;
  /** Pre-encrypted ciphertext (base64 of `iv || ct`). Caller builds
   *  via `sealApprovalIntentPiiField`. */
  readonly visitor_email_encrypted: string | null;
  readonly visitor_name_encrypted: string | null;
  readonly outcome_encrypted: string;
  /** Free-form metadata merge; substrate persists the union of the
   *  existing row's metadata + this delta. */
  readonly metadata_patch?: Readonly<Record<string, unknown>>;
}

export type ApprovalIntentConsumeResult =
  | { readonly ok: true; readonly row: ApprovalIntentSummary }
  | { readonly ok: false; readonly reason: 'already_consumed' | 'not_found' };

export interface ApprovalIntentStore {
  /** Insert a pre-consumption row. Substrate calls this at endpoint
   *  create time so the visitor render path can read the row + the
   *  consume path has a target to flip. */
  create(input: ApprovalIntentCreateInput): ApprovalIntentSummary;

  /** Read a single row by id. Returns `null` on miss. */
  findById(intent_id: string): ApprovalIntentSummary | null;

  /** Find the (presumed singleton) intent row for an endpoint_id. The
   *  substrate creates exactly one intent per endpoint at create time;
   *  this lookup feeds the visitor handler's "load the intent that
   *  this endpoint id represents" pattern. */
  findByEndpoint(endpoint_id: string): ApprovalIntentSummary | null;

  /** Atomic single-use flip per Must Hold I-11. Wraps the read+update
   *  in `BEGIN EXCLUSIVE` so concurrent presentations race-resolve. */
  tryConsume(input: ApprovalIntentConsumeInput): ApprovalIntentConsumeResult;

  /** Engine-side mutator — flip terminal `processing_outcome`. */
  markProcessed(input: {
    intent_id: string;
    outcome: Exclude<ApprovalLinkProcessingOutcome, 'pending'>;
  }): 'updated' | 'not_found';

  /** List pending consumed rows for an endpoint, ordered by
   *  `consumed_at` ASC. Used by the engine-side reactive cursor + the
   *  tests. */
  listPendingForEndpoint(endpoint_id: string, limit?: number): ReadonlyArray<ApprovalIntentSummary>;
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

const blobToBase64 = (raw: Buffer | null): string | null => {
  if (raw === null) return null;
  return raw.toString('base64');
};

const base64ToBlob = (raw: string | null): Buffer | null => {
  if (raw === null) return null;
  return Buffer.from(raw, 'base64');
};

const rowToSummary = (row: ApprovalIntentRow): ApprovalIntentSummary => {
  const outcomeRaw = row.processing_outcome;
  const outcome: ApprovalLinkProcessingOutcome =
    APPROVAL_LINK_PROCESSING_OUTCOME_SET.has(outcomeRaw as ApprovalLinkProcessingOutcome)
      ? (outcomeRaw as ApprovalLinkProcessingOutcome)
      : 'pending';
  return {
    intent_id: row.intent_id,
    endpoint_id: row.endpoint_id,
    action_kind: row.action_kind as ApprovalLinkActionKind,
    target_id: row.target_id,
    consumed_at: row.consumed_at,
    consumed_by_visitor_email_encrypted: blobToBase64(row.consumed_by_visitor_email_encrypted),
    consumed_outcome_encrypted: blobToBase64(row.consumed_outcome_encrypted),
    source_ip_hash: row.source_ip_hash,
    processing_outcome: outcome,
    metadata: parseMetadataBlob(row.metadata_blob),
  };
};

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

export const createReceptionApprovalIntentStore = (
  db: Database.Database,
): ApprovalIntentStore => {
  const insertStmt = db.prepare(`
    INSERT INTO reception_approval_intent (
      intent_id, endpoint_id, action_kind, target_id,
      consumed_at, consumed_by_visitor_email_encrypted, consumed_outcome_encrypted,
      source_ip_hash, processing_outcome, metadata_blob
    ) VALUES (
      @intent_id, @endpoint_id, @action_kind, @target_id,
      NULL, NULL, NULL,
      NULL, 'pending', @metadata_blob
    )
  `);

  const findByIdStmt = db.prepare(
    `SELECT * FROM reception_approval_intent WHERE intent_id = @intent_id`,
  );
  const findByEndpointStmt = db.prepare(
    `SELECT * FROM reception_approval_intent WHERE endpoint_id = @endpoint_id LIMIT 1`,
  );
  const listPendingStmt = db.prepare(`
    SELECT * FROM reception_approval_intent
     WHERE endpoint_id = @endpoint_id
       AND consumed_at IS NOT NULL
       AND processing_outcome = 'pending'
     ORDER BY consumed_at ASC
     LIMIT @limit
  `);

  // EXCLUSIVE-transaction flip. Read inside the transaction; UPDATE
  // gated on `consumed_at IS NULL` so even if the EXCLUSIVE lock has
  // a subtle implementation bug the WHERE clause prevents a double-
  // consume.
  const selectInsideTxStmt = db.prepare(
    `SELECT * FROM reception_approval_intent WHERE intent_id = @intent_id`,
  );
  const updateConsumeStmt = db.prepare(`
    UPDATE reception_approval_intent
       SET consumed_at = @consumed_at,
           consumed_by_visitor_email_encrypted = @visitor_email_encrypted,
           consumed_outcome_encrypted = @outcome_encrypted,
           source_ip_hash = @source_ip_hash,
           metadata_blob = @metadata_blob
     WHERE intent_id = @intent_id
       AND consumed_at IS NULL
  `);

  const markProcessedStmt = db.prepare(`
    UPDATE reception_approval_intent
       SET processing_outcome = @outcome
     WHERE intent_id = @intent_id
  `);

  return {
    create(input) {
      insertStmt.run({
        intent_id: input.intent_id,
        endpoint_id: input.endpoint_id,
        action_kind: input.action_kind,
        target_id: input.target_id,
        metadata_blob: input.metadata ? JSON.stringify(input.metadata) : null,
      });
      const row = findByIdStmt.get({ intent_id: input.intent_id }) as
        | ApprovalIntentRow
        | undefined;
      if (!row) {
        throw new Error('ReceptionApprovalIntentStore.create: row missing after insert');
      }
      return rowToSummary(row);
    },

    findById(intent_id) {
      const row = findByIdStmt.get({ intent_id }) as ApprovalIntentRow | undefined;
      return row ? rowToSummary(row) : null;
    },

    findByEndpoint(endpoint_id) {
      const row = findByEndpointStmt.get({ endpoint_id }) as ApprovalIntentRow | undefined;
      return row ? rowToSummary(row) : null;
    },

    tryConsume(input) {
      // EXCLUSIVE transaction — serializes concurrent consume attempts
      // at the SQLite layer. Better-sqlite3's `transaction` wrapper
      // uses `BEGIN EXCLUSIVE` when called with `.exclusive(...)`. The
      // call returns the wrapped function's return value.
      const run = db.transaction((): ApprovalIntentConsumeResult => {
        const existing = selectInsideTxStmt.get({ intent_id: input.intent_id }) as
          | ApprovalIntentRow
          | undefined;
        if (!existing) {
          return { ok: false, reason: 'not_found' };
        }
        if (existing.consumed_at !== null) {
          return { ok: false, reason: 'already_consumed' };
        }
        // Merge metadata patch onto the row's existing metadata so the
        // engine reactive path sees the union (existing row carries
        // action-config refs; consume-time delta carries the outcome
        // shape's `kind` discriminator). Substrate-side never trusts
        // the visitor with merging — every key in `metadata_patch`
        // belongs to the substrate's own consume helper.
        const existingMeta = parseMetadataBlob(existing.metadata_blob);
        const mergedMeta = input.metadata_patch
          ? { ...existingMeta, ...input.metadata_patch }
          : existingMeta;
        const result = updateConsumeStmt.run({
          intent_id: input.intent_id,
          consumed_at: input.now,
          visitor_email_encrypted: base64ToBlob(input.visitor_email_encrypted),
          outcome_encrypted: base64ToBlob(input.outcome_encrypted),
          source_ip_hash: input.source_ip_hash,
          metadata_blob:
            input.metadata_patch || Object.keys(existingMeta).length > 0
              ? JSON.stringify({
                  ...mergedMeta,
                  ...(input.visitor_name_encrypted !== null
                    ? { visitor_name_encrypted: input.visitor_name_encrypted }
                    : {}),
                })
              : input.visitor_name_encrypted !== null
                ? JSON.stringify({ visitor_name_encrypted: input.visitor_name_encrypted })
                : null,
        });
        if (result.changes === 0) {
          // The EXCLUSIVE lock should make this unreachable; defense
          // in depth surfaces it as a clean "already consumed" decision
          // rather than a thrown exception.
          return { ok: false, reason: 'already_consumed' };
        }
        const updated = findByIdStmt.get({ intent_id: input.intent_id }) as
          | ApprovalIntentRow
          | undefined;
        if (!updated) {
          throw new Error('ReceptionApprovalIntentStore.tryConsume: row missing after update');
        }
        return { ok: true, row: rowToSummary(updated) };
      });
      // `.exclusive` is the public hook for `BEGIN EXCLUSIVE`. Without
      // it, the default mode is `BEGIN DEFERRED` which doesn't take
      // the writer lock until first write — leaving a window during
      // the select where a concurrent process could squeeze in.
      const exclusive = (run as unknown as { exclusive: () => ApprovalIntentConsumeResult }).exclusive;
      if (typeof exclusive === 'function') {
        return exclusive();
      }
      return run();
    },

    markProcessed(input) {
      const result = markProcessedStmt.run({
        intent_id: input.intent_id,
        outcome: input.outcome,
      });
      return result.changes > 0 ? 'updated' : 'not_found';
    },

    listPendingForEndpoint(endpoint_id, limit = 100) {
      const rows = listPendingStmt.all({ endpoint_id, limit }) as ApprovalIntentRow[];
      return rows.map(rowToSummary);
    },
  };
};
