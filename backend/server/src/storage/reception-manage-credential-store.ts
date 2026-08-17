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
 *  Spec: D-210 Appendix B. */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import {
  isReceptionRecordKind,
  VISITOR_LOOKUP_MAX_TTL_MS,
  type ReceptionRecordKind,
} from '@recued/contracts';

export const RECEPTION_MANAGE_CREDENTIALS_TABLE = 'reception_manage_credentials';
export const RECEPTION_MANAGE_SECRET_PREFIX = 'recued_manage_';
/** 24h default — an edit link is short-lived by ruling; the owner re-mints. */
export const RECEPTION_MANAGE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const RECEPTION_MANAGE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** D-240 — WHAT a credential authorizes, as distinct from what record it is
 *  scoped to.
 *
 *  ⛔⛔ WITHOUT THIS THE TWO CAPABILITIES ARE INTERCHANGEABLE, AND ONE OF THEM IS
 *  HANDED TO AN ANONYMOUS STRANGER. Both live in this table, share the
 *  `recued_manage_` format, and resolve through the same function. A D-240
 *  viewback secret is minted at SUBMIT and given to the visitor; a manage secret
 *  is minted by the OWNER and authorizes a reschedule. Nothing but this column
 *  stops the visitor's read-only link being POSTed to `/reception/manage` and
 *  consumed to move the booking.
 *
 *  ⇒ `peek` / `consume` take the purpose they EXPECT and refuse a mismatch, so
 *  the fence is at the store rather than in each handler's discipline.
 *
 *  - `manage` — owner-minted, single-use, WRITE (D-210 Appendix B reschedule).
 *  - `lookup` — submit-minted, repeatable, READ (D-240 submitter viewback). */
export const RECEPTION_CREDENTIAL_PURPOSES = ['manage', 'lookup'] as const;
export type ReceptionCredentialPurpose = (typeof RECEPTION_CREDENTIAL_PURPOSES)[number];

export const isReceptionCredentialPurpose = (
  value: unknown,
): value is ReceptionCredentialPurpose =>
  typeof value === 'string'
  && (RECEPTION_CREDENTIAL_PURPOSES as readonly string[]).includes(value);

/** Per-purpose TTL ceiling. A viewback legitimately outlives an edit link by an
 *  order of magnitude (a booking months out, a request open for weeks), so ONE
 *  global max would have to be the looser of the two — which would silently
 *  widen the manage link that D-210 Appendix B deliberately kept at 7 days.
 *
 *  ⛔ Keyed on the closed purpose union so a third purpose is a type error here
 *  rather than inheriting whichever bound happens to be first. */
export const RECEPTION_CREDENTIAL_MAX_TTL_MS_BY_PURPOSE: Readonly<
  Record<ReceptionCredentialPurpose, number>
> = {
  manage: RECEPTION_MANAGE_MAX_TTL_MS,
  lookup: VISITOR_LOOKUP_MAX_TTL_MS,
};

const MANAGE_SECRET_BYTES = 32;
const MANAGE_SECRET_BASE64URL_LENGTH = 43;

/** The record a manage credential authorizes acting on. Kind-agnostic so the
 *  same surface serves a `scheduling_link` reschedule and (later) an
 *  `intake_form` edit; `record_id` is the booking_request_id / submission id. */
export interface ReceptionManageScope {
  readonly kind: ReceptionRecordKind;
  readonly endpoint_id: string;
  readonly record_id: string;
  /** D-240 — what this credential authorizes DOING. See
   *  {@link RECEPTION_CREDENTIAL_PURPOSES}. */
  readonly purpose: ReceptionCredentialPurpose;
}

export interface ReceptionManageIssueInput extends ReceptionManageScope {
  readonly now: number;
  readonly ttl_ms?: number;
  /** D-240 § D10 — the absolute backstop, ALWAYS stored. Absent ⇒ the credential
   *  is collected at its own `expires_at`, which is right for every mode whose
   *  expiry is computable at mint. It exists as a separate column for the one
   *  that is not (`until_resolved`, slice 4): `purge` cannot collect a row whose
   *  only expiry column is NULL, so a request that is never resolved would leave
   *  a credential behind forever. */
  readonly ceiling_at?: number;
  /** D-240 slice 4 — `until_resolved`: how long after the record ENDS this
   *  credential should live. Present ⇒ the row is DEFERRED and
   *  `expires_at` starts at the ceiling; the stamp sweep shortens it once the
   *  record resolves. Absent ⇒ the expiry computed at mint is final. */
  readonly deferred_grace_ms?: number;
}

export interface ReceptionManageIssuedCredential {
  readonly credential_id: string;
  /** The full URL secret (`recued_manage_…`) — returned ONCE, never stored. */
  readonly secret: string;
  readonly expires_at: number;
  readonly ceiling_at: number;
}

export type ReceptionManageResolveResult =
  | { readonly status: 'ok'; readonly credential_id: string; readonly scope: ReceptionManageScope }
  | { readonly status: 'not_found' | 'expired' | 'already_consumed' };

export interface ReceptionManageCredentialStore {
  issue(input: ReceptionManageIssueInput): ReceptionManageIssuedCredential;
  /** Non-consuming lookup — for GET. Never flips `consumed_at`.
   *
   *  ⛔ `expect` IS REQUIRED, NOT DEFAULTED. A default would let a future caller
   *  omit it and accept either capability, which is the whole hazard
   *  {@link RECEPTION_CREDENTIAL_PURPOSES} exists to close. A mismatch reports
   *  `not_found` rather than a distinct code: a holder of a viewback secret must
   *  not learn that it is a live credential for some other door. */
  peek(
    secret: string,
    now: number,
    expect: ReceptionCredentialPurpose,
  ): ReceptionManageResolveResult;
  /** Atomic single-use consume — for POST. Flips `consumed_at` iff live. */
  consume(
    secret: string,
    now: number,
    expect: ReceptionCredentialPurpose,
  ): ReceptionManageResolveResult;
  purge(before: number): number;
  /** D-240 slice 4 — the next batch of credentials still waiting on their record.
   *
   *  ⛔ STAMPS every row it returns, so successive calls ROTATE rather than
   *  re-reading the same oldest batch forever. `now` is required for that reason
   *  — a reader that took no clock could not advance the cursor, which is the
   *  starvation this signature exists to prevent. */
  listDeferred(limit: number, now: number): ReadonlyArray<ReceptionDeferredCredential>;
  /** D-240 slice 4 — the record ended: shorten the expiry and stop deferring.
   *
   *  ⚠ CLAMPED TO THE CEILING inside the store rather than trusted from the
   *  caller. The sweep computes `completed_at + grace` from a `completed_at`
   *  the work entity supplied, and a bad value there must not be able to extend
   *  a credential past the backstop it was minted under. */
  resolveDeferred(input: {
    readonly credential_id: string;
    readonly expires_at: number;
  }): boolean;
  /** D-240 slice 6 — kill one submitter's viewback link.
   *
   *  ⛔⛔ `purpose = 'lookup'` IS PART OF THE PREDICATE, NOT AN OPTIMISATION. A
   *  record can carry BOTH capabilities at once: the visitor's viewback and an
   *  owner-minted `/reception/manage` reschedule link. Revoking "this record's
   *  credentials" without the purpose would kill the owner's own link — possibly
   *  mid-reschedule — as a side effect of cutting off a stranger. The fence that
   *  keeps the two apart at READ time has to hold at REVOKE time too.
   *
   *  ⚠ Revokes EVERY live lookup credential for the record, not one. Nothing
   *  stops a record being minted twice (a re-drive, a future re-issue affordance),
   *  and an owner who says "cut this person off" means all of them — a revoke
   *  that left a second live link would be worse than none.
   *
   *  Returns how many were revoked. 0 is a legitimate answer (already revoked,
   *  already expired, never minted) and is NOT an error: the owner's intent —
   *  this link does not work — is satisfied either way. */
  revokeLookupsForRecord(input: {
    readonly endpoint_id: string;
    readonly record_id: string;
    readonly now: number;
  }): number;
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
  purpose: string;
  created_at: number;
  expires_at: number;
  ceiling_at: number;
  deferred_grace_ms: number | null;
  consumed_at: number | null;
}

/** D-240 slice 4 — one credential whose expiry is still waiting on its record.
 *  What the stamp sweep needs and nothing else. */
export interface ReceptionDeferredCredential {
  readonly credential_id: string;
  readonly endpoint_id: string;
  readonly record_id: string;
  readonly grace_ms: number;
  readonly ceiling_at: number;
}

/** Column presence, from SQLite's own table metadata. Local rather than shared,
 *  matching `memory-schema.ts` / `housekeeping/schema.ts` — each schema module
 *  carries its own copy of this three-line helper. */
const hasColumn = (db: Database.Database, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((r) => r.name === column);

export const ensureReceptionManageCredentialSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RECEPTION_MANAGE_CREDENTIALS_TABLE} (
      credential_id TEXT PRIMARY KEY,
      secret_hash   TEXT NOT NULL UNIQUE,
      kind          TEXT NOT NULL,
      endpoint_id   TEXT NOT NULL,
      record_id     TEXT NOT NULL,
      purpose       TEXT NOT NULL DEFAULT 'manage',
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL CHECK (expires_at > created_at),
      ceiling_at    INTEGER NOT NULL DEFAULT 0,
      deferred_grace_ms INTEGER,
      last_swept_at INTEGER,
      consumed_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reception_manage_credentials_expiry
      ON ${RECEPTION_MANAGE_CREDENTIALS_TABLE} (expires_at);
    CREATE INDEX IF NOT EXISTS idx_reception_manage_credentials_record
      ON ${RECEPTION_MANAGE_CREDENTIALS_TABLE} (endpoint_id, record_id);
  `);
  // D-240 — the two added columns, for a database created before this slice.
  // ⚠ `DEFAULT 'manage'` is the SAFE direction and is the reason the default is
  // not `'lookup'`: every row that predates this column was minted by
  // `reception.manage.mint`, which is admin-only, so classifying them as the
  // OWNER capability describes what they are. A row defaulted the other way
  // would be a write credential the lookup door would accept.
  if (!hasColumn(db, RECEPTION_MANAGE_CREDENTIALS_TABLE, 'purpose')) {
    db.exec(
      `ALTER TABLE ${RECEPTION_MANAGE_CREDENTIALS_TABLE} `
      + `ADD COLUMN purpose TEXT NOT NULL DEFAULT 'manage'`,
    );
  }
  // ⛔⛔ THE BACKFILL IS NOT OPTIONAL, AND MY FIRST VERSION OF THIS COMMENT TALKED
  // ITSELF INTO SKIPPING IT. It said `DEFAULT 0` was fine because "any that still
  // mattered has an `expires_at` the purge honours anyway" — FALSE. The purge
  // predicate is an OR (`expires_at <= @before` OR `ceiling_at <= @before`), so a
  // row left at `ceiling_at = 0` is collected on the FIRST pass regardless of how
  // live its `expires_at` is. With `fireImmediate: true` on the retention
  // registration, upgrading would have deleted every outstanding owner reschedule
  // link at boot.
  //
  // ⇒ ADD the column, then BACKFILL it to each row's own `expires_at`, which is
  // exactly the ceiling a credential minted before deferral existed should have:
  // nothing about it is deferred, so its expiry IS its backstop.
  //
  // ⚠ `WHERE ceiling_at = 0` is safe as the backfill predicate because a live
  // insert can never produce it — `issue` writes `max(ceiling_at ?? expires_at,
  // expires_at)` and `expires_at > created_at > 0`. Zero means "this row predates
  // the column" and nothing else.
  if (!hasColumn(db, RECEPTION_MANAGE_CREDENTIALS_TABLE, 'ceiling_at')) {
    db.exec(
      `ALTER TABLE ${RECEPTION_MANAGE_CREDENTIALS_TABLE} `
      + `ADD COLUMN ceiling_at INTEGER NOT NULL DEFAULT 0`,
    );
  }
  db.exec(
    `UPDATE ${RECEPTION_MANAGE_CREDENTIALS_TABLE} `
    + `SET ceiling_at = expires_at WHERE ceiling_at = 0`,
  );
  // D-240 slice 4 — `until_resolved`.
  //
  // ⛔⛔ A NULLABLE COMPANION COLUMN, NOT A NULLABLE `expires_at`, and the spec
  // said the latter. Relaxing `NOT NULL` on a shipped column is a SQLite table
  // rebuild (copy, drop, rename) — real risk for a behaviour that is reachable
  // another way. A deferred credential DOES have an expiry the whole time: the
  // §D10 ceiling. What is deferred is the SHORTENING. So `expires_at` starts at
  // the ceiling and the sweep moves it in, `expires_at` is never a lie, `peek`
  // and `purge` are untouched, and the migration is a plain ADD COLUMN.
  if (!hasColumn(db, RECEPTION_MANAGE_CREDENTIALS_TABLE, 'deferred_grace_ms')) {
    db.exec(
      `ALTER TABLE ${RECEPTION_MANAGE_CREDENTIALS_TABLE} ADD COLUMN deferred_grace_ms INTEGER`,
    );
  }
  // D-240 — the sweep's round-robin cursor. See `listDeferred`.
  if (!hasColumn(db, RECEPTION_MANAGE_CREDENTIALS_TABLE, 'last_swept_at')) {
    db.exec(
      `ALTER TABLE ${RECEPTION_MANAGE_CREDENTIALS_TABLE} ADD COLUMN last_swept_at INTEGER`,
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reception_manage_credentials_ceiling
      ON ${RECEPTION_MANAGE_CREDENTIALS_TABLE} (ceiling_at);
    CREATE INDEX IF NOT EXISTS idx_reception_manage_credentials_deferred
      ON ${RECEPTION_MANAGE_CREDENTIALS_TABLE} (deferred_grace_ms)
      WHERE deferred_grace_ms IS NOT NULL;
  `);
};

/** The id length cap, EXPORTED so the rpc validator and this store enforce one
 *  number. Two copies is how a shape one layer calls valid becomes an exception
 *  in the next. */
export const RECEPTION_CREDENTIAL_ID_MAX = 256;

const cleanId = (value: string, field: string): string => {
  if (typeof value !== 'string') {
    throw new ReceptionManageCredentialValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ReceptionManageCredentialValidationError(`${field} must be non-empty`);
  }
  if (trimmed.length > RECEPTION_CREDENTIAL_ID_MAX) {
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

const scopeOf = (row: ManageRow): ReceptionManageScope => ({
  kind: row.kind as ReceptionRecordKind,
  endpoint_id: row.endpoint_id,
  record_id: row.record_id,
  purpose: row.purpose as ReceptionCredentialPurpose,
});

const rowToResolve = (
  row: ManageRow | undefined,
  now: number,
  expect: ReceptionCredentialPurpose,
): ReceptionManageResolveResult => {
  if (row === undefined) return { status: 'not_found' };
  // ⛔ THE PURPOSE FENCE, AND IT IS FIRST. Before any liveness question: a
  // credential for a different door is not this door's business, and reporting
  // `expired` / `already_consumed` for one would confirm it exists. `not_found`
  // is what a wrong secret gets, and that is what a right-secret-wrong-door is.
  if (row.purpose !== expect) return { status: 'not_found' };
  if (row.consumed_at !== null) return { status: 'already_consumed' };
  if (row.expires_at <= now) return { status: 'expired' };
  return { status: 'ok', credential_id: row.credential_id, scope: scopeOf(row) };
};

export const createReceptionManageCredentialStore = (
  db: Database.Database,
): ReceptionManageCredentialStore => {
  ensureReceptionManageCredentialSchema(db);

  const insertStmt = db.prepare(`
    INSERT INTO ${RECEPTION_MANAGE_CREDENTIALS_TABLE}
      (credential_id, secret_hash, kind, endpoint_id, record_id, purpose,
       created_at, expires_at, ceiling_at, deferred_grace_ms, consumed_at)
    VALUES (@credential_id, @secret_hash, @kind, @endpoint_id, @record_id, @purpose,
            @created_at, @expires_at, @ceiling_at, @deferred_grace_ms, NULL)
  `);
  const selectStmt = db.prepare(`
    SELECT credential_id, secret_hash, kind, endpoint_id, record_id, purpose,
           created_at, expires_at, ceiling_at, deferred_grace_ms, consumed_at
    FROM ${RECEPTION_MANAGE_CREDENTIALS_TABLE} WHERE secret_hash = ?
  `);
  // Single-use CAS: only flips when unconsumed AND unexpired, so a replay or a
  // late click after expiry never marks (and never returns) a usable scope.
  const consumeStmt = db.prepare(`
    UPDATE ${RECEPTION_MANAGE_CREDENTIALS_TABLE}
    SET consumed_at = @now
    WHERE secret_hash = @secret_hash AND consumed_at IS NULL AND expires_at > @now
  `);
  // D-240 § D10 — TWO predicates, and the second is the backstop.
  //
  // ⛔⛔ `expires_at <= @before` ALONE CANNOT COLLECT A DEFERRED CREDENTIAL. Slice
  // 4's `until_resolved` has no `expires_at` until its record flips `done`, and
  // a NULL matches no comparison — so a request that is abandoned would leave its
  // credential in this table forever. `ceiling_at` is written on EVERY row, so
  // the second clause always eventually fires.
  //
  // ⚠ Written in the NULL-tolerant form now, while `expires_at` is still NOT
  // NULL, so slice 4 relaxes the column without also having to remember this.
  // ⚠ Only LIVE rows. A consumed (revoked) or already-expired credential has
  // nothing left to shorten, and sweeping them would re-touch rows every pass
  // for no effect.
  //
  // ⛔⛔ ORDERED BY `last_swept_at`, NOT `created_at`, AND THAT IS A STARVATION
  // FIX RATHER THAN A PREFERENCE. Oldest-first was a permanent block: an
  // unresolved row never changes state, so 200 long-running requests sat at the
  // front of every hourly pass forever and nothing behind them was ever
  // examined. Their credentials would have lived to the 180-day ceiling instead
  // of their configured grace — silently, because the sweep reported `scanned:
  // 200` each time and looked busy.
  //
  // ⇒ Every scanned row is STAMPED (below), so the next pass takes the ones it
  // has not seen. `NULLS FIRST` via COALESCE(…, 0) puts never-swept rows ahead
  // of everything, so a new credential is examined on the very next pass.
  const listDeferredStmt = db.prepare(
    `SELECT credential_id, endpoint_id, record_id, deferred_grace_ms, ceiling_at
     FROM ${RECEPTION_MANAGE_CREDENTIALS_TABLE}
     WHERE deferred_grace_ms IS NOT NULL AND consumed_at IS NULL
     ORDER BY COALESCE(last_swept_at, 0) ASC, created_at ASC LIMIT ?`,
  );
  const markSweptStmt = db.prepare(
    `UPDATE ${RECEPTION_MANAGE_CREDENTIALS_TABLE}
     SET last_swept_at = @now WHERE credential_id = @credential_id`,
  );
  // ⛔ `deferred_grace_ms = NULL` in the SAME statement that moves the expiry.
  // Two statements would leave a window where the row is stamped and still
  // listed as deferred, so the next sweep pass would stamp it again — harmless
  // today because the computation is idempotent, and exactly the kind of
  // "harmless today" that stops being true when someone adds a side effect.
  const resolveDeferredStmt = db.prepare(
    `UPDATE ${RECEPTION_MANAGE_CREDENTIALS_TABLE}
     SET expires_at = @expires_at, deferred_grace_ms = NULL
     WHERE credential_id = @credential_id AND deferred_grace_ms IS NOT NULL`,
  );
  // ⛔ `consumed_at IS NULL` keeps this idempotent: a second revoke of the same
  // record changes nothing and reports 0, rather than re-stamping a later time
  // over the moment access actually ended.
  // ⛔ `expires_at > @now` IS PART OF LIVENESS, and leaving it out made the rpc
  // contradict its own contract: `ReceptionLookupRevokeResult` says an expired
  // link yields `revoked: 0`, but without this an already-dead credential was
  // counted as newly revoked. The owner would be told they had just cut off
  // access that ended weeks ago.
  const revokeLookupsStmt = db.prepare(
    `UPDATE ${RECEPTION_MANAGE_CREDENTIALS_TABLE}
     SET consumed_at = @now
     WHERE endpoint_id = @endpoint_id AND record_id = @record_id
       AND purpose = 'lookup' AND consumed_at IS NULL AND expires_at > @now`,
  );
  const purgeStmt = db.prepare(
    `DELETE FROM ${RECEPTION_MANAGE_CREDENTIALS_TABLE} `
    + `WHERE (expires_at IS NOT NULL AND expires_at <= @before) OR ceiling_at <= @before`,
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
      if (!isReceptionCredentialPurpose(input.purpose)) {
        throw new ReceptionManageCredentialValidationError(
          `purpose '${String(input.purpose)}' is not a reception credential purpose`,
        );
      }
      const ttl = input.ttl_ms ?? RECEPTION_MANAGE_DEFAULT_TTL_MS;
      // Per-PURPOSE, not global: a viewback legitimately outlives an edit link.
      const maxTtl = RECEPTION_CREDENTIAL_MAX_TTL_MS_BY_PURPOSE[input.purpose];
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > maxTtl) {
        throw new ReceptionManageCredentialValidationError(
          `ttl_ms out of range for purpose '${input.purpose}' (max ${maxTtl})`,
        );
      }
      const credential_id = randomUUID();
      const secret = generateReceptionManageSecret();
      const expires_at = input.now + ttl;
      // ⚠ NEVER BELOW `expires_at`. The ceiling is a backstop for a credential
      // whose expiry is deferred, not a second, tighter deadline — a ceiling
      // inside the expiry would collect a live credential early, and the caller
      // would have no way to see why the link died before its stated date.
      const ceiling_at = Math.max(input.ceiling_at ?? expires_at, expires_at);
      // D-240 slice 4 — a DEFERRED credential lives until the ceiling until its
      // record resolves. ⚠ `expires_at` is overwritten to the ceiling rather
      // than left at the caller's ttl: for `until_resolved` the ttl the caller
      // computed is meaningless (there is no anchor yet), and leaving it would
      // expire the link before the request it reports on had finished.
      const deferred = input.deferred_grace_ms;
      const isDeferred = typeof deferred === 'number' && Number.isFinite(deferred) && deferred > 0;
      const stored_expires_at = isDeferred ? ceiling_at : expires_at;
      insertStmt.run({
        credential_id,
        secret_hash: hashSecret(secret),
        kind: input.kind,
        endpoint_id,
        record_id,
        purpose: input.purpose,
        created_at: input.now,
        expires_at: stored_expires_at,
        ceiling_at,
        deferred_grace_ms: isDeferred ? deferred : null,
      });
      return { credential_id, secret, expires_at: stored_expires_at, ceiling_at };
    },

    peek(secret, now, expect) {
      if (!isReceptionManageSecret(secret)) return { status: 'not_found' };
      const row = selectStmt.get(hashSecret(secret)) as ManageRow | undefined;
      return rowToResolve(row, now, expect);
    },

    consume(secret, now, expect) {
      if (!isReceptionManageSecret(secret)) return { status: 'not_found' };
      const secret_hash = hashSecret(secret);
      // ⛔ THE PURPOSE IS CHECKED BEFORE THE CAS, NOT AFTER. Consuming first and
      // rejecting after would BURN a credential belonging to another door — a
      // viewback link POSTed here (by a scanner, or deliberately) would be
      // refused and also destroyed, which is a denial of service on the
      // submitter's read access dressed up as a security check.
      const existing = selectStmt.get(secret_hash) as ManageRow | undefined;
      if (existing === undefined || existing.purpose !== expect) return { status: 'not_found' };
      const changed = consumeStmt.run({ secret_hash, now }).changes;
      const row = selectStmt.get(secret_hash) as ManageRow | undefined;
      if (changed === 1) {
        // We just consumed it: report the scope as of the pre-consume state.
        if (row === undefined) return { status: 'not_found' };
        return { status: 'ok', credential_id: row.credential_id, scope: scopeOf(row) };
      }
      // The CAS did nothing — report WHY (already consumed / expired / gone).
      return rowToResolve(row, now, expect);
    },

    purge(before) {
      return purgeStmt.run({ before }).changes;
    },

    listDeferred(limit, now) {
      const rows = listDeferredStmt.all(Math.max(1, Math.floor(limit))) as Array<{
        credential_id: string;
        endpoint_id: string;
        record_id: string;
        deferred_grace_ms: number;
        ceiling_at: number;
      }>;
      // ⚠ Stamped BEFORE the caller acts on them, and deliberately: a row whose
      // completion read throws must still advance, or one permanently unreadable
      // record would re-block the head of the queue exactly as oldest-first did.
      const mark = db.transaction((ids: ReadonlyArray<string>) => {
        for (const credential_id of ids) markSweptStmt.run({ credential_id, now });
      });
      mark(rows.map((r) => r.credential_id));
      return rows.map((r) => ({
        credential_id: r.credential_id,
        endpoint_id: r.endpoint_id,
        record_id: r.record_id,
        grace_ms: r.deferred_grace_ms,
        ceiling_at: r.ceiling_at,
      }));
    },

    revokeLookupsForRecord(input) {
      const endpoint_id = cleanId(input.endpoint_id, 'endpoint_id');
      const record_id = cleanId(input.record_id, 'record_id');
      if (!Number.isFinite(input.now)) {
        throw new ReceptionManageCredentialValidationError('now must be a finite number');
      }
      return revokeLookupsStmt.run({ endpoint_id, record_id, now: input.now }).changes;
    },

    resolveDeferred(input) {
      const row = db
        .prepare(
          `SELECT ceiling_at FROM ${RECEPTION_MANAGE_CREDENTIALS_TABLE} WHERE credential_id = ?`,
        )
        .get(input.credential_id) as { ceiling_at: number } | undefined;
      if (row === undefined) return false;
      // The clamp the interface promises: a `completed_at` from a work entity is
      // not this store's data, and it must not be able to push a credential past
      // the backstop it was minted under.
      const expires_at = Math.min(input.expires_at, row.ceiling_at);
      return resolveDeferredStmt.run({ credential_id: input.credential_id, expires_at })
        .changes > 0;
    },
  };
};
