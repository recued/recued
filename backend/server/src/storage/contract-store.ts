/** D-165 §"Contract namespace" — the `contract.*` storage substrate (LOCAL-ONLY).
 *
 *  One self-describing namespace-keyed table (NOT N typed tables): sparse rows,
 *  prefix-scan reads, same pattern as `data.*`. The SCHEMA is itself stored as
 *  rows under the reserved `schema` scope (`contract.schema.composite_keys.*` /
 *  `contract.schema.value_shapes.*`), seeded from the spec-owned code seed
 *  (`@recued/contracts` `D165_CONTRACT_SCHEMA`). Data rows hang off the spec's
 *  composite_keys scopes (installed_ingredient / installed_pack / grant /
 *  policy_resolution / override); a write is gated by `validateContractWrite`
 *  against the in-memory registry the store was built with.
 *
 *  Gateway-read-only: recipes are GATED BY contract policy and never reference
 *  `{{contract.*}}` — `contract` is deliberately absent from the resolver `NS`.
 *  The gateway dispatcher (a later slice) reads schema + rows through `scan`
 *  (the `scanNamespace` primitive) and composes per role.
 *
 *  Rows are tiny (spec storage-scale: ~45–175 rows, ~15–80 KB JSON for a user
 *  with ~10 packs) so values live inline — no CAS, no FTS. Local-only by
 *  construction; never synced cloud (D-090/D-097/D-168).
 *
 *  Key encoding. A row is keyed on `(scope, segments[])`. Segment VALUES can
 *  legitimately contain dots (an operation_id is `<ingredient_id>.<op_name>`),
 *  so segments are `%`-escaped (`.`→`%2E`, `%`→`%25`) before being joined with
 *  `.` into the `seg_key` column. That keeps the dot a pure delimiter while
 *  remaining reversible, and lets prefix scans anchor on a `.` boundary (a
 *  `pack_slug` of `deal` never bleeds into `dealflow`). Scope + segments are the
 *  only public surface — callers never see seg_key.
 *
 *  Spec: D-165 §"Contract namespace"; the schema-entry types +
 *  write-validator live in `packages/contracts/src/contract-schema.ts`. */

import type Database from 'better-sqlite3';
import {
  composeRows,
  D165_CONTRACT_SCHEMA,
  projectToPolicyFields,
  validateContractSchemaRegistry,
  validateContractWrite,
  wouldLoosen,
  type CompositeKeySchema,
  type ContractMergeRow,
  type ContractSchemaRegistry,
  type ContractWriteIssue,
  type ScanFn,
} from '@recued/contracts';

const TABLE = 'contract_store';

/** The reserved scope under which the schema itself is stored. `put` rejects it
 *  (data writes can't touch schema rows — `validateContractWrite` returns
 *  `unknown_scope` for a non-composite_keys scope); `seedSchema` writes it. */
const SCHEMA_SCOPE = 'schema';

/** One decoded contract row. `segments` are the un-escaped path segment values;
 *  `value` is the parsed JSON row value. */
export interface ContractRow {
  scope: string;
  segments: string[];
  value: unknown;
  written_at: number;
}

export interface ContractStore {
  /** Write a DATA row. Validates `(scope, segments, value)` against the schema
   *  (structural — segments satisfy the scope's required/optional_tail, value
   *  matches the value_shape); throws `ContractWriteInvalidError` on any issue.
   *  For a `tightening_only` scope, also rejects a write that would LOOSEN the
   *  running aggregate of the existing same-scope rows it composes with (the
   *  broader rows it refines + the row it replaces), throwing
   *  `ContractWriteLoosensError`. Idempotent upsert keyed on `(scope, segments)`. */
  put(scope: string, segments: readonly string[], value: unknown): void;
  /** Read one row (DATA or schema); null when absent. */
  get(scope: string, segments: readonly string[]): ContractRow | null;
  /** Prefix-scan — every row in `scope` whose segments START WITH
   *  `prefixSegments` (omitted/empty ⇒ the whole scope), ordered by seg_key.
   *  Honors `optional_tail` naturally: a shorter prefix matches both the exact
   *  match-all row and longer rows. This is the `scanNamespace` primitive. */
  scan(scope: string, prefixSegments?: readonly string[]): ContractRow[];
  /** Delete one row; true iff a row was removed. */
  delete(scope: string, segments: readonly string[]): boolean;
  /** Delete every row in `scope` under `prefixSegments` (omitted/empty ⇒ the
   *  whole scope); returns the count removed. */
  deleteByPrefix(scope: string, prefixSegments?: readonly string[]): number;
  /** Load a spec's schema registry into `contract.schema.*` rows (idempotent
   *  upsert). Throws if the registry is malformed (`validateContractSchemaRegistry`). */
  seedSchema(registry: ContractSchemaRegistry): void;
  /** Run `fn` inside a single SQLite transaction over the store's `db` — every
   *  `put` / `delete` / `deleteByPrefix` it issues commits atomically, and a
   *  throw rolls the whole batch back. Synchronous (better-sqlite3); `fn` must
   *  not await. Lets a multi-row write (e.g. pack inventory: installed_pack +
   *  N installed_ingredient rows) be all-or-nothing rather than leaving partial
   *  state behind on a mid-batch failure. */
  transaction(fn: () => void): void;
}

/** A contract data-row write failed structural validation. Carries the issues. */
export class ContractWriteInvalidError extends Error {
  readonly scope: string;
  readonly issues: ContractWriteIssue[];
  constructor(scope: string, segments: readonly string[], issues: ContractWriteIssue[]) {
    super(
      `contract_write_invalid: ${scope} [${segments.join('/')}] — ${issues
        .map((i) => i.code)
        .join(', ')}`,
    );
    this.name = 'ContractWriteInvalidError';
    this.scope = scope;
    this.issues = issues;
  }
}

/** A schema registry that fails self-consistency was handed to `seedSchema`. */
export class ContractSchemaSeedError extends Error {
  constructor(detail: string) {
    super(`contract_schema_seed_invalid: ${detail}`);
    this.name = 'ContractSchemaSeedError';
  }
}

/** A `tightening_only` scope write would LOOSEN the running aggregate of the
 *  broader same-scope rows it refines — forbidden: an override may only restrict
 *  further, never grant more (D-166 §"Merge algebra formalization"). Carries the
 *  canonical policy-field names that loosen. */
export class ContractWriteLoosensError extends Error {
  readonly scope: string;
  readonly segments: readonly string[];
  readonly loosenedFields: string[];
  constructor(scope: string, segments: readonly string[], loosenedFields: string[]) {
    super(
      `contract_write_loosens: ${scope} [${segments.join('/')}] — loosens ${loosenedFields.join(', ')}`,
    );
    this.name = 'ContractWriteLoosensError';
    this.scope = scope;
    this.segments = segments;
    this.loosenedFields = loosenedFields;
  }
}

// ── seg_key codec ───────────────────────────────────────────────
// `.` is the delimiter; `%` is the escape introducer. Escape `%` first so the
// inverse (undo `.` then undo `%`) is unambiguous.
const escapeSegment = (s: string): string => s.replace(/%/g, '%25').replace(/\./g, '%2E');
const unescapeSegment = (s: string): string => s.replace(/%2E/g, '.').replace(/%25/g, '%');
const encodeSegKey = (segments: readonly string[]): string => segments.map(escapeSegment).join('.');
const decodeSegKey = (segKey: string): string[] => segKey.split('.').map(unescapeSegment);
// Prefix-scan bounds. The delimiter is `.` (0x2E) and `/` (0x2F) is the next
// byte, so `[prefix + '.', prefix + '/')` is exactly the half-open range of keys
// that continue past `prefix` at a segment boundary (`deal` never bleeds into
// `dealflow`). A plain range comparison — NOT SQL `LIKE`, which is ASCII-case-
// INSENSITIVE by default and would conflate `PackA.*` with `packa.*` — keeps
// prefix scans case-sensitive + index-friendly, consistent with the BINARY
// collation the `=` exact match already uses.
const prefixLowerBound = (prefix: string): string => `${prefix}.`;
const prefixUpperBound = (prefix: string): string => `${prefix}/`;

/** Install the contract_store table. Idempotent (`IF NOT EXISTS`); safe on every
 *  boot and from the store factory. */
export const ensureContractStoreSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      scope        TEXT NOT NULL,
      seg_key      TEXT NOT NULL,
      value_inline TEXT NOT NULL,
      written_at   INTEGER NOT NULL,
      PRIMARY KEY (scope, seg_key)
    );
    CREATE INDEX IF NOT EXISTS contract_store_scope_idx ON ${TABLE} (scope);
  `);
};

export interface CreateContractStoreOptions {
  /** Schema the store validates writes against + the seed `seedSchema()` loads
   *  when called with no override. Defaults to D-165's spec-owned seed. */
  registry?: ContractSchemaRegistry;
  /** Time source for `written_at`. */
  now?: () => number;
}

export const createContractStore = (
  db: Database.Database,
  opts?: CreateContractStoreOptions,
): ContractStore => {
  ensureContractStoreSchema(db);
  const registry = opts?.registry ?? D165_CONTRACT_SCHEMA;
  const now = opts?.now ?? (() => Date.now());

  const putStmt = db.prepare(
    `INSERT INTO ${TABLE} (scope, seg_key, value_inline, written_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, seg_key) DO UPDATE SET
         value_inline = excluded.value_inline,
         written_at   = excluded.written_at`,
  );
  const getStmt = db.prepare(
    `SELECT seg_key, value_inline, written_at FROM ${TABLE} WHERE scope = ? AND seg_key = ?`,
  );
  const scanScopeStmt = db.prepare(
    `SELECT seg_key, value_inline, written_at FROM ${TABLE} WHERE scope = ? ORDER BY seg_key`,
  );
  const scanPrefixStmt = db.prepare(
    `SELECT seg_key, value_inline, written_at FROM ${TABLE}
       WHERE scope = ? AND (seg_key = ? OR (seg_key >= ? AND seg_key < ?))
       ORDER BY seg_key`,
  );
  const deleteStmt = db.prepare(`DELETE FROM ${TABLE} WHERE scope = ? AND seg_key = ?`);
  const deleteScopeStmt = db.prepare(`DELETE FROM ${TABLE} WHERE scope = ?`);
  const deletePrefixStmt = db.prepare(
    `DELETE FROM ${TABLE} WHERE scope = ? AND (seg_key = ? OR (seg_key >= ? AND seg_key < ?))`,
  );

  interface DbRow {
    seg_key: string;
    value_inline: string;
    written_at: number;
  }
  const decode = (scope: string, row: DbRow): ContractRow => ({
    scope,
    segments: decodeSegKey(row.seg_key),
    value: JSON.parse(row.value_inline) as unknown,
    written_at: row.written_at,
  });

  const rawPut = (scope: string, segments: readonly string[], value: unknown): void => {
    putStmt.run(scope, encodeSegKey(segments), JSON.stringify(value ?? null), now());
  };

  const scanRows = (scope: string, prefixSegments?: readonly string[]): ContractRow[] => {
    const prefix = encodeSegKey(prefixSegments ?? []);
    const rows =
      prefix === ''
        ? (scanScopeStmt.all(scope) as DbRow[])
        : (scanPrefixStmt.all(
            scope,
            prefix,
            prefixLowerBound(prefix),
            prefixUpperBound(prefix),
          ) as DbRow[]);
    return rows.map((r) => decode(scope, r));
  };

  /** Enforce the `tightening_only` write rule for a row in `scope`: the incoming
   *  value (projected onto canonical policy fields) may not LOOSEN the running
   *  aggregate of the EXISTING rows that compose with it — every row whose
   *  segments are a (non-strict) prefix of this path: the strictly-broader rows it
   *  refines (an operation-specific override is checked against the actor+ingredient
   *  match-all) PLUS the existing row at this exact path that this upsert replaces,
   *  so a restrictive override can't be loosened to a weaker explicit value by
   *  overwriting it (spec: "running aggregate of EXISTING rows in the relevant
   *  role"). Sibling specifics (equal length, differing tail) are not prefixes, so
   *  they're excluded — they never co-apply at dispatch (D-166 4b). A match-all has
   *  no broader same-scope baseline; its grant floor is composed cross-scope at
   *  dispatch (D-166 4d). NB a deny-flag CLEAR (`denied:false` projects to `{}`)
   *  carries no value, so it is not "looser" than anything and is admitted —
   *  clearing an override is delete-like, falling back to the grant floor (4d). */
  const enforceTightening = (
    scope: string,
    ck: CompositeKeySchema,
    segments: readonly string[],
    value: Record<string, unknown>,
  ): void => {
    const projectedIncoming = projectToPolicyFields(ck.value_shape, value);
    const requiredPrefix = segments.slice(0, ck.required.length);
    const priorRows: ContractMergeRow[] = scanRows(scope, requiredPrefix)
      .filter(
        (r) =>
          r.segments.length <= segments.length &&
          r.segments.every((seg, i) => seg === segments[i]),
      )
      .map((r) => ({
        value: projectToPolicyFields(ck.value_shape, r.value as Record<string, unknown>),
        merge_precedence: ck.merge_precedence,
        merge_rule: ck.merge_rule,
      }));
    const loosened = wouldLoosen(composeRows(priorRows).policy, projectedIncoming);
    if (loosened.length > 0) {
      throw new ContractWriteLoosensError(scope, segments, loosened);
    }
  };

  return {
    put(scope, segments, value) {
      const issues = validateContractWrite(registry, scope, segments, value);
      if (issues.length > 0) throw new ContractWriteInvalidError(scope, segments, issues);
      const ck = registry.composite_keys[scope];
      if (ck.merge_rule === 'tightening_only') {
        enforceTightening(scope, ck, segments, value as Record<string, unknown>);
      }
      rawPut(scope, segments, value);
    },

    get(scope, segments) {
      const row = getStmt.get(scope, encodeSegKey(segments)) as DbRow | undefined;
      return row ? decode(scope, row) : null;
    },

    scan(scope, prefixSegments) {
      return scanRows(scope, prefixSegments);
    },

    delete(scope, segments) {
      return deleteStmt.run(scope, encodeSegKey(segments)).changes > 0;
    },

    deleteByPrefix(scope, prefixSegments) {
      const prefix = encodeSegKey(prefixSegments ?? []);
      const res =
        prefix === ''
          ? deleteScopeStmt.run(scope)
          : deletePrefixStmt.run(scope, prefix, prefixLowerBound(prefix), prefixUpperBound(prefix));
      return res.changes;
    },

    seedSchema(toSeed) {
      const problems = validateContractSchemaRegistry(toSeed);
      if (problems.length > 0) {
        throw new ContractSchemaSeedError(
          problems.map((p) => `${p.code}@${p.entry}`).join('; '),
        );
      }
      const seed = db.transaction(() => {
        for (const [name, ck] of Object.entries(toSeed.composite_keys)) {
          rawPut(SCHEMA_SCOPE, ['composite_keys', name], ck);
        }
        for (const [name, vs] of Object.entries(toSeed.value_shapes)) {
          rawPut(SCHEMA_SCOPE, ['value_shapes', name], vs);
        }
      });
      seed();
    },

    transaction(fn) {
      db.transaction(fn)();
    },
  };
};

/** Adapt a {@link ContractStore} to the pure `@recued/contracts` `ScanFn` the
 *  dispatcher (`composeForRole`) consumes. `ContractRow.value` is typed `unknown`
 *  (rows hold arbitrary JSON) whereas the dispatcher's `ContractRowLike` wants
 *  `Record<string, unknown>`; every contract DATA row is a JSON object (a
 *  value-shape record), so the narrowing is sound. Pure forwarding — one shared
 *  store handle backs every call. The D-166 Slice 4d.4 catalog-gate resolver
 *  builds one of these over `app.contractStoreRef` (serve path) / the MCP boot
 *  handle and chains the per-role compositions. */
export const createContractScanFn = (store: ContractStore): ScanFn => {
  return (scope, prefixSegments) =>
    store.scan(scope, prefixSegments).map((row) => ({
      segments: row.segments,
      value: row.value as Record<string, unknown>,
    }));
};

