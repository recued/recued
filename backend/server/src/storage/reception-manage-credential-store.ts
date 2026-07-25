/** D-210 Appendix B — the `/reception/manage/<secret>` credential store.
 *
 *  A manage credential is a short-lived, single-use, per-RECORD capability the
 *  OWNER mints to reschedule / manage one reception record from a link — on
 *  their phone, off the webclient (the Appendix B promise: the edit must not
 *  require a login). It is the ONLY auth the manage page has, so it is
 *  deliberately narrow:
 *
 *    - scoped to ONE record (`kind` + `endpoint_id` + `record_id`), resolved
 *      SERVER-SIDE at use time. A holder of the link picks a new time; they
 *      cannot retarget a different booking (the target is the credential's,
 *      not the form's).
 *    - single-use on the POST (an atomic compare-and-set on `consumed_at`) —
 *      "approving a booking and MOVING it are not the same blast radius, so
 *      the edit link wants a tighter TTL / single use" (Appendix B).
 *    - short-lived (`expires_at`).
 *
 *  Only the secret's SHA-256 digest is stored (like `seller-claim-store`), so
 *  a database copy cannot reconstruct a live link. The SCOPE columns are plain
 *  text: none is a secret (the visitor PII is sealed separately in the booking
 *  row), and the enclosing per-pair SQLite database is already encrypted.
 *
 *  GET is NON-consuming (mail-link scanners must not burn the credential);
 *  POST consumes. That split is the caller's (`peek` vs `consume`), mirroring
 *  the `/reception/claim` seller-claim surface this is modelled on.
 *
 *  Spec: docs/d-210-spec.md Appendix B. */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { isReceptionRecordKind, type ReceptionRecordKind } from '@recued/contracts';

export const RECEPTION_MANAGE_CREDENTIALS_TABLE = 'reception_manage_credentials';
export const RECEPTION_MANAGE_SECRET_PREFIX = 'recued_manage_';
/** 24h default — an edit link is short-lived by ruling; the owner re-mints. */
export const RECEPTION_MANAGE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const RECEPTION_MANAGE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MANAGE_SECRET_BYTES = 32;
const MANAGE_SECRET_BASE64URL_LENGTH = 43;

/** The record a manage credential authorizes acting on. Kind-agnostic so the
 *  same surface serves a `scheduling_link` reschedule and (later) an
 *  `intake_form` edit; `record_id` is the booking_request_id / submission id. */
export interface ReceptionManageScope {
  readonly kind: ReceptionRecordKind;
  readonly endpoint_id: string;
  readonly record_id: string;
}

export interface ReceptionManageIssueInput extends ReceptionManageScope {
  readonly now: number;
  readonly ttl_ms?: number;
}

export interface ReceptionManageIssuedCredential {
  readonly credential_id: string;
  /** The full URL secret (`recued_manage_…`) — returned ONCE, never stored. */
  readonly secret: string;
  readonly expires_at: number;
}

export type ReceptionManageResolveResult =
  | { readonly status: 'ok'; readonly credential_id: string; readonly scope: ReceptionManageScope }
  | { readonly status: 'not_found' | 'expired' | 'already_consumed' };

export interface ReceptionManageCredentialStore {
  issue(input: ReceptionManageIssueInput): ReceptionManageIssuedCredential;
  /** Non-consuming lookup — for GET. Never flips `consumed_at`. */
  peek(secret: string, now: number): ReceptionManageResolveResult;
  /** Atomic single-use consume — for POST. Flips `consumed_at` iff live. */
  consume(secret: string, now: number): ReceptionManageResolveResult;
  purge(before: number): number;
}

export class ReceptionManageCredentialValidationError extends Error {
  constructor(detail: string) {
    super(`reception_manage_credential_invalid: ${detail}`);
    this.name = 'ReceptionManageCredentialValidationError';
  }
}

interface ManageRow {
  credential_id: string;
  secret_hash: string;
  kind: string;
  endpoint_id: string;
  record_id: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export const ensureReceptionManageCredentialSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RECEPTION_MANAGE_CREDENTIALS_TABLE} (
      credential_id TEXT PRIMARY KEY,
      secret_hash   TEXT NOT NULL UNIQUE,
      kind          TEXT NOT NULL,
      endpoint_id   TEXT NOT NULL,
      record_id     TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL CHECK (expires_at > created_at),
      consumed_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reception_manage_credentials_expiry
      ON ${RECEPTION_MANAGE_CREDENTIALS_TABLE} (expires_at);
    CREATE INDEX IF NOT EXISTS idx_reception_manage_credentials_record
      ON ${RECEPTION_MANAGE_CREDENTIALS_TABLE} (endpoint_id, record_id);
  `);
};

const cleanId = (value: string, field: string): string => {
  if (typeof value !== 'string') {
    throw new ReceptionManageCredentialValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ReceptionManageCredentialValidationError(`${field} must be non-empty`);
  }
  if (trimmed.length > 256) {
    throw new ReceptionManageCredentialValidationError(`${field} is too long`);
  }
  return trimmed;
};

export const isReceptionManageSecret = (value: unknown): value is string =>
  typeof value === 'string'
  && new RegExp(
    `^${RECEPTION_MANAGE_SECRET_PREFIX}[A-Za-z0-9_-]{${MANAGE_SECRET_BASE64URL_LENGTH}}$`,
  ).test(value);

export const generateReceptionManageSecret = (): string =>
  `${RECEPTION_MANAGE_SECRET_PREFIX}${randomBytes(MANAGE_SECRET_BYTES).toString('base64url')}`;

const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

const rowToResolve = (row: ManageRow | undefined, now: number): ReceptionManageResolveResult => {
  if (row === undefined) return { status: 'not_found' };
  if (row.consumed_at !== null) return { status: 'already_consumed' };
  if (row.expires_at <= now) return { status: 'expired' };
  return {
    status: 'ok',
    credential_id: row.credential_id,
    scope: { kind: row.kind as ReceptionRecordKind, endpoint_id: row.endpoint_id, record_id: row.record_id },
  };
};

export const createReceptionManageCredentialStore = (
  db: Database.Database,
): ReceptionManageCredentialStore => {
  ensureReceptionManageCredentialSchema(db);

  const insertStmt = db.prepare(`
    INSERT INTO ${RECEPTION_MANAGE_CREDENTIALS_TABLE}
      (credential_id, secret_hash, kind, endpoint_id, record_id, created_at, expires_at, consumed_at)
    VALUES (@credential_id, @secret_hash, @kind, @endpoint_id, @record_id, @created_at, @expires_at, NULL)
  `);
  const selectStmt = db.prepare(`
    SELECT credential_id, secret_hash, kind, endpoint_id, record_id, created_at, expires_at, consumed_at
    FROM ${RECEPTION_MANAGE_CREDENTIALS_TABLE} WHERE secret_hash = ?
  `);
  // Single-use CAS: only flips when unconsumed AND unexpired, so a replay or a
  // late click after expiry never marks (and never returns) a usable scope.
  const consumeStmt = db.prepare(`
    UPDATE ${RECEPTION_MANAGE_CREDENTIALS_TABLE}
    SET consumed_at = @now
    WHERE secret_hash = @secret_hash AND consumed_at IS NULL AND expires_at > @now
  `);
  const purgeStmt = db.prepare(
    `DELETE FROM ${RECEPTION_MANAGE_CREDENTIALS_TABLE} WHERE expires_at <= ?`,
  );

  return {
    issue(input) {
      if (!isReceptionRecordKind(input.kind)) {
        throw new ReceptionManageCredentialValidationError(`kind '${String(input.kind)}' is not a manageable reception record kind`);
      }
      const endpoint_id = cleanId(input.endpoint_id, 'endpoint_id');
      const record_id = cleanId(input.record_id, 'record_id');
      if (!Number.isFinite(input.now)) {
        throw new ReceptionManageCredentialValidationError('now must be a finite number');
      }
      const ttl = input.ttl_ms ?? RECEPTION_MANAGE_DEFAULT_TTL_MS;
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > RECEPTION_MANAGE_MAX_TTL_MS) {
        throw new ReceptionManageCredentialValidationError('ttl_ms out of range');
      }
      const credential_id = randomUUID();
      const secret = generateReceptionManageSecret();
      const expires_at = input.now + ttl;
      insertStmt.run({
        credential_id,
        secret_hash: hashSecret(secret),
        kind: input.kind,
        endpoint_id,
        record_id,
        created_at: input.now,
        expires_at,
      });
      return { credential_id, secret, expires_at };
    },

    peek(secret, now) {
      if (!isReceptionManageSecret(secret)) return { status: 'not_found' };
      const row = selectStmt.get(hashSecret(secret)) as ManageRow | undefined;
      return rowToResolve(row, now);
    },

    consume(secret, now) {
      if (!isReceptionManageSecret(secret)) return { status: 'not_found' };
      const secret_hash = hashSecret(secret);
      const changed = consumeStmt.run({ secret_hash, now }).changes;
      const row = selectStmt.get(secret_hash) as ManageRow | undefined;
      if (changed === 1) {
        // We just consumed it: report the scope as of the pre-consume state.
        if (row === undefined) return { status: 'not_found' };
        return {
          status: 'ok',
          credential_id: row.credential_id,
          scope: { kind: row.kind as ReceptionRecordKind, endpoint_id: row.endpoint_id, record_id: row.record_id },
        };
      }
      // The CAS did nothing — report WHY (already consumed / expired / gone).
      return rowToResolve(row, now);
    },

    purge(before) {
      return purgeStmt.run(before).changes;
    },
  };
};
