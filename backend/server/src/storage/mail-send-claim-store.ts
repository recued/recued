/** D-207 slice 3d — the outbound send claim: the general no-resend fence.
 *
 *  ## What this is, and what it is NOT
 *
 *  It is NOT the provider lookup. That was already general — `MailSentReconciliation*`
 *  is provider-neutral and Gmail, Graph and IMAP all implement it. What did not exist,
 *  and what D-200 kept privately inside its own `data.shared` workflow row (the very
 *  row this slice evicts), is the DURABLE PRE-DISPATCH CLAIM: "I am about to send
 *  message R."
 *
 *  Written BEFORE the provider call, it is the only thing that survives a crash
 *  mid-send. Without it a reconciler has nothing to reconcile AGAINST — no window, no
 *  recipient, no subject, no attachment pin — and therefore no query it could derive
 *  without asking the caller, which is precisely what it must never do.
 *
 *  ## ⛔ NOTHING HERE EVER AUTHORIZES A RESEND — INCLUDING `not_found`
 *
 *  "Absent from the Sent folder" is not "not sent". The provider may not have indexed
 *  it, the scan window can miss it, IMAP lags. A resend on `not_found` double-sends a
 *  customer their document, and no completeness proof exists at this layer that could
 *  make it safe. So a claim only ever moves FORWARD, and this store has no `delete`
 *  and no path back to an unclaimed state. Re-sending is an OWNER decision taken with
 *  the claim in front of them — which is D-200's invariant verbatim, and one of the
 *  1,990 steps that was genuinely earning its keep.
 *
 *  ## The fence is the absent field
 *
 *  `settle` takes the provider's RESULT, not a status. A caller cannot say "mark this
 *  reconciled" because there is no parameter through which to say it — exactly as
 *  `order.open` takes an `offer_id` and not a price, and `order.confirm-payment` takes
 *  evidence and not a phase. Not a validator that can be wrong; an absence that cannot.
 */

import type Database from 'better-sqlite3';
import {
  MAIL_SEND_CLAIM_STATUSES,
  isMailReconciliationId,
  isMailSendClaimSettled,
  isMailSendClaimStatus,
  type MailSendClaim,
  type MailSendClaimStatus,
  type MailSentReconciliationResult,
} from '@recued/contracts';

export const MAIL_SEND_CLAIMS_TABLE = 'mail_send_claims';

export class MailSendClaimValidationError extends Error {}
export class MailSendClaimConflictError extends Error {}

const sqlEnum = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/** The one emitter for the shape. The CREATE and the drift-convergence rebuild both
 *  go through it, so the two can never describe different tables. */
const claimsCreateDdl = (table: string): string => `
    CREATE TABLE IF NOT EXISTS ${table} (
      -- PK. The token already stamped into the message via
      -- MAIL_RECONCILIATION_ID_HEADER, so the thing we search FOR is the thing we
      -- sent, and the join needs no second identity.
      reconciliation_id     TEXT PRIMARY KEY,
      status                TEXT NOT NULL CHECK (status IN (${sqlEnum(MAIL_SEND_CLAIM_STATUSES)})),

      -- WHICH mail account it went out through, and therefore whose Sent folder is
      -- source truth for it. Recorded at CLAIM time, never passed in at reconcile
      -- time: a caller who could name the account could name one whose Sent folder
      -- happens to hold a matching message.
      sender_slug           TEXT NOT NULL,

      -- SERVER-WRITTEN at claim time. These are what the reconciliation query is
      -- DERIVED from; no recipe supplies any of them. A recipe that could author the
      -- recipient, subject or window could forge a match -- and a forged match marks
      -- a document DELIVERED that was never sent.
      recipient             TEXT NOT NULL,
      subject               TEXT NOT NULL,
      sent_after            INTEGER NOT NULL,

      proof_kind            TEXT NOT NULL CHECK (proof_kind IN ('envelope', 'attachment')),
      attachment_sha256     TEXT,
      attachment_size_bytes INTEGER,
      attachment_filename   TEXT,
      attachment_mime_type  TEXT,

      provider_message_id   TEXT,
      sent_at               INTEGER,
      ambiguity_reason      TEXT,

      revision              INTEGER NOT NULL,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,

      -- An 'attachment' proof that carries no pinned bytes is not a weaker proof, it
      -- is a BROKEN one: the reconciler would have to fall back to an envelope-only
      -- question and would silently downgrade what it claims to have proven.
      CHECK (
        (proof_kind = 'envelope'
          AND attachment_sha256 IS NULL AND attachment_size_bytes IS NULL
          AND attachment_filename IS NULL AND attachment_mime_type IS NULL)
        OR
        (proof_kind = 'attachment'
          AND attachment_sha256 IS NOT NULL AND attachment_size_bytes IS NOT NULL
          AND attachment_filename IS NOT NULL AND attachment_mime_type IS NOT NULL)
      )
    )`;

/** ⛔ A SQL CHECK generated from a TS const is real EXACTLY ONCE, at creation:
 *  `CREATE TABLE IF NOT EXISTS` skips an existing table and SQLite cannot ALTER a
 *  CHECK. So widening `MAIL_SEND_CLAIM_STATUSES` on a live server would change
 *  nothing — every new member still rejected by a CHECK compiled from the old const —
 *  while a fresh-DB suite stayed green. This is the same class that made D-207 slice
 *  1c inert in production, and the same fix `convergeSellerOffersSchema` applies.
 *
 *  ⇒ Converge the MATERIALIZED table onto the generated DDL. WIDENING-only: removing a
 *  member is a value migration and must remap rows first. */
const convergeClaimsSchema = (db: Database.Database): void => {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(MAIL_SEND_CLAIMS_TABLE) as { sql: string } | undefined;
  if (existing === undefined) return;

  const admitsEveryDeclaredMember = MAIL_SEND_CLAIM_STATUSES.every((member) =>
    existing.sql.includes(`'${member}'`),
  );
  if (admitsEveryDeclaredMember) return;

  const rebuildTable = `${MAIL_SEND_CLAIMS_TABLE}__converge`;
  const columnNames = (table: string): readonly string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    );

  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${rebuildTable}`);
    db.exec(claimsCreateDdl(rebuildTable));
    const carried = columnNames(rebuildTable).filter((column) =>
      columnNames(MAIL_SEND_CLAIMS_TABLE).includes(column),
    );
    const projection = carried.join(', ');
    db.exec(
      `INSERT INTO ${rebuildTable} (${projection}) SELECT ${projection} FROM ${MAIL_SEND_CLAIMS_TABLE}`,
    );
    db.exec(`DROP TABLE ${MAIL_SEND_CLAIMS_TABLE}`);
    db.exec(`ALTER TABLE ${rebuildTable} RENAME TO ${MAIL_SEND_CLAIMS_TABLE}`);
  })();
};

export const ensureMailSendClaimSchema = (db: Database.Database): void => {
  db.exec(claimsCreateDdl(MAIL_SEND_CLAIMS_TABLE));
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mail_send_claims_status
      ON ${MAIL_SEND_CLAIMS_TABLE} (status, updated_at DESC);
  `);
  convergeClaimsSchema(db);
};

/** What the SERVER knows before it dispatches. Note what is NOT here: a status. A
 *  claim always begins `claimed` — there is no way to mint one that already looks
 *  sent, let alone reconciled. */
export interface MailSendClaimInput {
  readonly reconciliation_id: string;
  /** The mail collection slug the send goes out through — the account whose Sent
   *  folder the reconciler will later ask. */
  readonly sender_slug: string;
  readonly recipient: string;
  readonly subject: string;
  readonly proof_kind: 'envelope' | 'attachment';
  readonly attachment_sha256?: string | null;
  readonly attachment_size_bytes?: number | null;
  readonly attachment_filename?: string | null;
  readonly attachment_mime_type?: string | null;
  readonly now: number;
}

export interface MailSendClaimSettleInput {
  readonly reconciliation_id: string;
  readonly expected_revision: number;
  /** ⛔ The provider's VERDICT, never a status. There is no parameter through which a
   *  caller could name `reconciled`. */
  readonly result: MailSentReconciliationResult;
  readonly now: number;
}

/** ⛔ `created` vs `existing` IS the fence, not a convenience.
 *
 *  A caller that cannot tell a FRESH claim from a RETRY has no choice but to dispatch
 *  in both cases — and dispatching on a retry is the double-send this whole substrate
 *  exists to prevent. The first send must proceed; a second attempt against a claim
 *  that already exists must NOT, until the earlier attempt's fate is known. */
export interface MailSendClaimResult {
  readonly result: 'created' | 'existing';
  readonly claim: MailSendClaim;
}

export interface MailSendClaimStore {
  /** Idempotent on `reconciliation_id`: a retry of the SAME send re-reads its claim
   *  and says so (`existing`), so the caller can refuse to dispatch twice. A reused id
   *  describing a DIFFERENT message is a loud conflict, never a silent rebind — that
   *  would let one send's proof stand in for another's. */
  claim(input: MailSendClaimInput): MailSendClaimResult;
  get(reconciliation_id: string): MailSendClaim | null;
  /** The provider acknowledged. Still not PROOF — an ack can be lost, which is why
   *  `sent` is not settled and is still reconcilable. */
  markSent(input: {
    readonly reconciliation_id: string;
    readonly expected_revision: number;
    readonly provider_message_id: string;
    readonly sent_at: number;
    readonly now: number;
  }): MailSendClaim;
  settle(input: MailSendClaimSettleInput): MailSendClaim;
  listByStatus(status: MailSendClaimStatus, limit?: number): MailSendClaim[];
}

interface ClaimRow {
  reconciliation_id: string;
  status: string;
  sender_slug: string;
  recipient: string;
  subject: string;
  sent_after: number;
  proof_kind: string;
  attachment_sha256: string | null;
  attachment_size_bytes: number | null;
  attachment_filename: string | null;
  attachment_mime_type: string | null;
  provider_message_id: string | null;
  sent_at: number | null;
  ambiguity_reason: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

const toClaim = (row: ClaimRow): MailSendClaim => {
  if (!isMailSendClaimStatus(row.status)) {
    throw new MailSendClaimValidationError(
      `mail send claim '${row.reconciliation_id}' holds unknown status '${row.status}'`,
    );
  }
  return {
    reconciliation_id: row.reconciliation_id,
    status: row.status,
    sender_slug: row.sender_slug,
    recipient: row.recipient,
    subject: row.subject,
    sent_after: row.sent_after,
    proof_kind: row.proof_kind === 'attachment' ? 'attachment' : 'envelope',
    attachment_sha256: row.attachment_sha256,
    attachment_size_bytes: row.attachment_size_bytes,
    attachment_filename: row.attachment_filename,
    attachment_mime_type: row.attachment_mime_type,
    provider_message_id: row.provider_message_id,
    sent_at: row.sent_at,
    ambiguity_reason: row.ambiguity_reason,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const requireBounded = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new MailSendClaimValidationError(
      `${field} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value;
};

export const createMailSendClaimStore = (db: Database.Database): MailSendClaimStore => {
  ensureMailSendClaimSchema(db);

  const readRow = (reconciliation_id: string): ClaimRow | undefined =>
    db
      .prepare(`SELECT * FROM ${MAIL_SEND_CLAIMS_TABLE} WHERE reconciliation_id = ?`)
      .get(reconciliation_id) as ClaimRow | undefined;

  const requireClaim = (reconciliation_id: string, expected_revision: number) => {
    const row = readRow(reconciliation_id);
    if (row === undefined) {
      throw new MailSendClaimConflictError(
        `no send claim '${reconciliation_id}' — a send is only reconcilable against the claim written before it`,
      );
    }
    const claim = toClaim(row);
    if (claim.revision !== expected_revision) {
      throw new MailSendClaimConflictError(
        `send claim '${reconciliation_id}' is at revision ${claim.revision}, not ${expected_revision}`,
      );
    }
    return claim;
  };

  return {
    claim(input) {
      if (!isMailReconciliationId(input.reconciliation_id)) {
        throw new MailSendClaimValidationError(
          'reconciliation_id must be a bounded ASCII header token',
        );
      }
      const sender_slug = requireBounded(input.sender_slug, 'sender_slug', 128);
      const recipient = requireBounded(input.recipient, 'recipient', 320);
      const subject = requireBounded(input.subject, 'subject', 998);

      const existing = readRow(input.reconciliation_id);
      if (existing !== undefined) {
        const claim = toClaim(existing);
        // ⛔ A LOUD CONFLICT, never a silent rebind. Letting a reused id describe a
        // different message would let ONE send's provider proof settle ANOTHER send's
        // claim — the same hazard F6 closed for checkout sessions.
        if (
          claim.sender_slug !== sender_slug
          || claim.recipient !== recipient
          || claim.subject !== subject
          || claim.proof_kind !== input.proof_kind
          || claim.attachment_sha256 !== (input.attachment_sha256 ?? null)
        ) {
          throw new MailSendClaimConflictError(
            `send claim '${input.reconciliation_id}' already describes a different message`,
          );
        }
        return { result: 'existing', claim };
      }

      const row: ClaimRow = {
        reconciliation_id: input.reconciliation_id,
        status: 'claimed',
        sender_slug,
        recipient,
        subject,
        // The window opens when we CLAIM — strictly before we dispatch, so the real
        // send can never fall outside it.
        sent_after: input.now,
        proof_kind: input.proof_kind,
        attachment_sha256: input.attachment_sha256 ?? null,
        attachment_size_bytes: input.attachment_size_bytes ?? null,
        attachment_filename: input.attachment_filename ?? null,
        attachment_mime_type: input.attachment_mime_type ?? null,
        provider_message_id: null,
        sent_at: null,
        ambiguity_reason: null,
        revision: 0,
        created_at: input.now,
        updated_at: input.now,
      };

      db.prepare(
        `INSERT INTO ${MAIL_SEND_CLAIMS_TABLE} (
           reconciliation_id, status, sender_slug, recipient, subject, sent_after,
           proof_kind, attachment_sha256, attachment_size_bytes, attachment_filename,
           attachment_mime_type, provider_message_id, sent_at, ambiguity_reason,
           revision, created_at, updated_at
         ) VALUES (
           @reconciliation_id, @status, @sender_slug, @recipient, @subject, @sent_after,
           @proof_kind, @attachment_sha256, @attachment_size_bytes, @attachment_filename,
           @attachment_mime_type, @provider_message_id, @sent_at, @ambiguity_reason,
           @revision, @created_at, @updated_at
         )`,
      ).run(row);

      return { result: 'created', claim: toClaim(row) };
    },

    get(reconciliation_id) {
      const row = readRow(reconciliation_id);
      return row === undefined ? null : toClaim(row);
    },

    markSent(input) {
      const claim = requireClaim(input.reconciliation_id, input.expected_revision);
      // A settled claim has provider SOURCE TRUTH behind it. A late provider ack is
      // weaker evidence than that, and must not overwrite it.
      if (isMailSendClaimSettled(claim.status)) return claim;

      const next = {
        reconciliation_id: input.reconciliation_id,
        status: 'sent' satisfies MailSendClaimStatus,
        provider_message_id: requireBounded(
          input.provider_message_id,
          'provider_message_id',
          998,
        ),
        sent_at: input.sent_at,
        revision: claim.revision + 1,
        updated_at: input.now,
        expected_revision: input.expected_revision,
      };
      db.prepare(
        `UPDATE ${MAIL_SEND_CLAIMS_TABLE}
            SET status = @status, provider_message_id = @provider_message_id,
                sent_at = @sent_at, revision = @revision, updated_at = @updated_at
          WHERE reconciliation_id = @reconciliation_id AND revision = @expected_revision`,
      ).run(next);

      return toClaim(readRow(input.reconciliation_id) as ClaimRow);
    },

    settle(input) {
      const claim = requireClaim(input.reconciliation_id, input.expected_revision);

      // ⛔ NO CHURN. A settled claim stays exactly as it is — repeated ambiguity must
      // not burn revisions, and a second `matched` must not re-stamp a delivery.
      if (isMailSendClaimSettled(claim.status)) return claim;

      const result = input.result;

      // ⛔ THE WHOLE POINT: `not_found` and `unavailable` change NOTHING. They are
      // observational. Neither is proof the message did not go out, and treating
      // either as one would double-send a customer their document.
      if (result.status === 'not_found' || result.status === 'unavailable') {
        return claim;
      }

      const settled: MailSendClaimStatus =
        result.status === 'matched' ? 'reconciled' : 'ambiguous';

      db.prepare(
        `UPDATE ${MAIL_SEND_CLAIMS_TABLE}
            SET status = @status,
                provider_message_id = COALESCE(@provider_message_id, provider_message_id),
                sent_at = COALESCE(@sent_at, sent_at),
                ambiguity_reason = @ambiguity_reason,
                revision = @revision, updated_at = @updated_at
          WHERE reconciliation_id = @reconciliation_id AND revision = @expected_revision`,
      ).run({
        reconciliation_id: input.reconciliation_id,
        status: settled,
        provider_message_id:
          result.status === 'matched' ? result.match.provider_message_id : null,
        sent_at: result.status === 'matched' ? result.match.sent_at : null,
        ambiguity_reason: result.status === 'ambiguous' ? result.reason : null,
        revision: claim.revision + 1,
        updated_at: input.now,
        expected_revision: input.expected_revision,
      });

      return toClaim(readRow(input.reconciliation_id) as ClaimRow);
    },

    listByStatus(status, limit = 100) {
      const rows = db
        .prepare(
          `SELECT * FROM ${MAIL_SEND_CLAIMS_TABLE}
            WHERE status = ? ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(status, Math.max(1, Math.min(limit, 500))) as ClaimRow[];
      return rows.map(toClaim);
    },
  };
};
