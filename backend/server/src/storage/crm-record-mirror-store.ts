/** D-190 — the CRM record mirror store.
 *
 *  A dedicated, NON-OPTIONAL local mirror of every CRM record (deal / contact /
 *  account), keyed `(scope, target_id)` where `scope` is the platform-reference
 *  scope `connection.api.<vendor>.<entity>`. The reconciler upserts one row per
 *  record UNCONDITIONALLY each cycle; `deal.search` / `contact.search` read it.
 *
 *  WHY a dedicated store, not an enrichment topic (the owner's call, D-190): an
 *  enrichment topic lives in the per-topic TRUST registry (D-132 — a user can set
 *  it `off`), so it is OPTIONAL by the enrichment model. A search path cannot depend
 *  on something optional. The record mirror is INFRASTRUCTURE the search reads, so it
 *  must be unconditional — its own store, written by the core reconciler task, never
 *  trust-gated, never surfaced as a toggleable "enrichment". Enrichments (AI facts
 *  ABOUT records — `deal_health_score`, …) stay in `data_enrichment`, optional and
 *  layered on top; the mirror is the records THEMSELVES.
 *
 *  The row's `meta` is the canonical projection of the record (the same
 *  `EnrichmentMeta` snapshot shape the reconciler/poll produce — name / stage /
 *  amount / close_state / key_dates.* / …), so `list`'s json_extract filters operate
 *  on canonical field names uniformly across vendors. `list` returns the SAME
 *  `{ scope, target_id, meta }` shape `EnrichmentStore.listScopeMeta` did, so the
 *  chat fan-out's `projectPlatformDeal` consumes it unchanged. */

import type Database from 'better-sqlite3';
import {
  deserializeEnrichmentMeta,
  serializeEnrichmentMeta,
  type EnrichmentMeta,
  type EnrichmentScope,
  CRM_ALIAS_VALUES,
  crmRefFields,
} from '@recued/contracts';
import type { SourceMirrorStore } from '../source-mirror/store.js';

const CRM_RECORD_MIRROR_TABLE = 'crm_record_mirror';

/** Default / max rows a single `list` returns — mirrors the enrichment
 *  `listScopeMeta` caps so the chat surface stays bounded (clamped further to the
 *  per-tool limit at the handler). */
const MIRROR_DEFAULT_LIMIT = 50;
const MIRROR_MAX_LIMIT = 200;

/** Escape SQL `LIKE` metacharacters (`\` `%` `_`) in a caller-supplied substring so
 *  the `name_contains` filter matches the query LITERALLY — `query:"a_c"` matches
 *  "a_c", not "abc". Without this the `_`/`%` in a search term act as wildcards, and
 *  the live re-filter (`matchesDeal`/`matchesContact`/`matchesAccount`, plain JS
 *  `.includes()`) would disagree with the mirror leg, making an escalated result
 *  differ from a mirror-only one. Paired with `ESCAPE '\'` on the LIKE. Single pass
 *  (each metachar prefixed with `\`); escaping `\` itself in the same pass is safe
 *  because the regex reads the ORIGINAL string, not its own output. */
const escapeLikeWildcards = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** A closed canonical-field EQUALITY filter (`json_extract(meta, path) = value`) —
 *  the `path` binds as a parameter (injection-safe), drawn from the caller's closed
 *  shared-vocab map (e.g. `$.close_state`). */
export interface MirrorMetaEquals {
  path: string;
  value: string;
}

/** A closed canonical-field numeric RANGE filter (inclusive `>= ?` / `<= ?`) over a
 *  json path (e.g. close_date ms via `$.key_dates.close_date`). */
export interface MirrorMetaRange {
  path: string;
  min?: number;
  max?: number;
}

export interface MirrorListOptions {
  /** case-insensitive substring on `json_extract(meta, '$.name')`. */
  name_contains?: string;
  /** lowercased exact match on `json_extract(meta, '$.email')`. */
  email_exact?: string;
  /** lowercased exact match on `json_extract(meta, '$.domain')` — the CRM
   *  account's strong identifier (`account.search` domain lookup, D-190). */
  domain_exact?: string;
  /** closed canonical-field equality filters (D-190 union slice). */
  meta_equals?: ReadonlyArray<MirrorMetaEquals>;
  /** closed canonical-field numeric range filters (D-190 union slice). */
  meta_ranges?: ReadonlyArray<MirrorMetaRange>;
  limit?: number;
}

export interface CrmRecordMirrorRow {
  scope: EnrichmentScope;
  target_id: string;
  meta: EnrichmentMeta;
}

/** The D-190 CRM mirror is the FIRST implementation of the shared
 *  source-mirror store contract (D-192 P1.5 — `SourceMirrorStore` in
 *  `../source-mirror/store.js`); the D-192 P3 work-entity adapter over
 *  `data_task`/`data_project`/`data_note` is the second. Type-level
 *  binding only — zero runtime change. */
export interface CrmRecordMirrorStore
  extends SourceMirrorStore<EnrichmentScope, EnrichmentMeta, CrmRecordMirrorRow, MirrorListOptions> {
  /** Upsert one record's canonical snapshot. Preserves `created_at` on conflict
   *  (only `meta` + `updated_at` change), so the row's first-seen time survives a
   *  refresh. Idempotent: re-upserting an unchanged record only bumps `updated_at`. */
  upsert(input: { scope: EnrichmentScope; target_id: string; meta: EnrichmentMeta; now: number }): void;
  /** List the mirror rows for a scope, newest-refreshed first, with the canonical
   *  filters applied IN SQL (so `limit` is post-filter — never an under-returning
   *  local trim). Returns the `{ scope, target_id, meta }` shape the chat fan-out
   *  projects from. */
  list(scope: EnrichmentScope, opts?: MirrorListOptions): CrmRecordMirrorRow[];
  /** D-167 (recall path, Tier 2) — the requested `meta` keys, PER ROW, across a scope.
   *  UNCAPPED + meta-deserialization-free (json_extract of just the requested keys),
   *  the same shape as `listSnapshotHashes`.
   *
   *  UNCAPPED IS THE WHOLE POINT — do NOT reimplement this over `list()`. `list()`
   *  clamps to `MIRROR_MAX_LIMIT` (200) because it feeds a bounded CHAT surface,
   *  where returning fewer rows is a smaller answer. Here the consumer is the PII
   *  recall aliasing index, where a value that is missing from the seed set is a
   *  value that egresses RAW to the cloud LLM. Under-returning is not a smaller
   *  answer, it is a LEAK — and a silent one, since the 201st contact would simply
   *  never be aliased and nothing would fail. The enumerate-everything shape is the
   *  same reason `listAllNamesAndCompanies` on the contact store carries no cap.
   *
   *  PER ROW, and deliberately NOT cross-key deduped, because the consumer's seed
   *  decision is ROW-CORRELATED: a CRM `name` is a real person's name only if it is
   *  not merely THIS row's own email local-part. The reconcilers SYNTHESIZE
   *  `meta.name` from the email when a contact carries no first/last name
   *  (`constructContactName`), so `sales@acme.com` yields the "name" `sales` — and
   *  seeding that as a person would alias every occurrence of the bare word "sales"
   *  in recalled prose. Deciding that needs `name` and `email` from the SAME row,
   *  which a per-key value list cannot express. The caller dedups; the A-C dedups
   *  again internally, so nothing is lost.
   *
   *  `keys` are canonical `meta` keys (`'name'`, `'company'`, `'phone'`, and dotted
   *  forms like `'mailing_address.zip'`); each lowers to `$.<key>` and binds as a
   *  PARAMETER, so a caller key can never splice into SQL. A row whose meta lacks a
   *  key json_extracts to NULL and is simply absent from that row's record, so
   *  over-listing keys (e.g. `first_name` on a vendor whose reconciler projects only
   *  the concatenated `name`) is free. Non-string values (a numeric id) are skipped —
   *  the recall index seeds strings. */
  listMetaRows(
    scope: EnrichmentScope,
    keys: readonly string[],
  ): Array<Record<string, string>>;
  /** D-190 (generic reconciler MS4) — the per-scope `target_id → snapshot_hash`
   *  map, UNCAPPED + meta-deserialization-free (json_extract of the one field).
   *  The generic full-walk reconciler reads this once per cycle to self-filter:
   *  a polled record whose canonical hash already matches its mirror row is
   *  UNCHANGED, so the reconciler skips it — turning the match-all poll into an
   *  incremental sync (only new / changed records reach the harness, so the bus /
   *  cascade / audit don't churn over the full record set every cycle). Records
   *  whose meta carries no `snapshot_hash` are omitted (they re-sync as changed). */
  listSnapshotHashes(scope: EnrichmentScope): Map<string, string>;
  /** Remove a record's mirror row (delete-cascade on a vendor record delete).
   *  Returns true when a row was removed. */
  deleteForSource(scope: EnrichmentScope, target_id: string): boolean;
  /** D-192 C-2 slice 7 — EVERY mirror row of ONE connection, UNCAPPED, with the
   *  full `meta`. The contact-import leaf's list port: it hydrates
   *  `data.contact` from the CRM records the reconcilers already mirrored, so it
   *  needs the complete per-connection set, not a page of it.
   *
   *  ⚠ **UNCAPPED IS THE WHOLE POINT — do NOT reimplement this over `list()`.**
   *  `list()` clamps to `MIRROR_MAX_LIMIT` (200) because it feeds a bounded CHAT
   *  surface, where returning fewer rows is a smaller answer. Here the consumer is
   *  a reconcile walk whose ABSENCE-BASED DELETE DIFF is gated on a completeness
   *  proof — so an under-returning read is not a smaller answer, it is a silent
   *  MASS WITHDRAWAL: every contact past the 200th would look absent from a walk
   *  claiming to be complete, and its CRM contributions would be torn out. Nothing
   *  would fail; the data would just quietly go. Same reason `listMetaRows` above
   *  carries no cap, one door over.
   *
   *  Connection-scoped, because the scope is shared across a vendor's connections
   *  (`target_id LIKE '<prefix>%'`, the same cut `deleteForConnection` makes) — a
   *  whole-scope read would hand connection A the records of connection B, and A's
   *  delete diff would then find them all "absent". */
  listForConnection(
    scope: EnrichmentScope,
    target_id_prefix: string,
  ): CrmRecordMirrorRow[];
  /** D-192 source-data-removal — bulk-remove every mirror row of ONE
   *  connection within a vendor-shared scope: `target_id LIKE
   *  '<target_id_prefix>%'` (`composeConnectionTargetIdPrefix`). The scope is
   *  shared across a vendor's connections, so the whole-scope
   *  `deleteAllForScope` would over-delete a sibling connection — this cuts to
   *  the one connection via its `target_id` prefix. Returns the rows deleted. */
  deleteForConnection(scope: EnrichmentScope, target_id_prefix: string): number;
  /** D-192 — count one connection's mirror rows within a vendor-shared scope
   *  (the "[N] records" preview). Same prefix cut as `deleteForConnection`. */
  countForConnection(scope: EnrichmentScope, target_id_prefix: string): number;
  /** **D-206 — the REVERSE lookup: "which records reference THIS one?"**
   *
   *  The other end of the relationship contract. `deal.contact_id → ref{contact}` (step 1)
   *  is read forward by the resolver (step 2); this reads it BACKWARD — *"which deals point
   *  at this contact?"* — by filtering the mirror on the declared field.
   *
   *  🔴 **It returns `{ rows, total }`, and `total` is MANDATORY — that is the whole point
   *  of this door existing.** `rows` is a bounded PAGE (correct for a chat surface: a
   *  smaller answer is a smaller answer). `total` is the **UNCAPPED, COMPLETE** count. A
   *  caller therefore CANNOT obtain a page without also being handed the true size, which is
   *  what structurally prevents *"Bob has 3 deals"* when he has 240 — a confident number
   *  over a truncated set, which a model states to the user as fact.
   *
   *  ⛔ **Do NOT reimplement this over `list()`.** `list()` hard-clamps to
   *  `MIRROR_MAX_LIMIT` (200; default 50) and reports no total, so a reverse lookup through
   *  it silently truncates and cannot even tell you that it did. That cap is CORRECT for
   *  `list()`'s bounded chat consumers and must stay — this is a different question, and it
   *  gets its own door. (`listForConnection`'s docstring makes the same argument one door
   *  over, for the same reason: *"an under-returning read is not a smaller answer."*)
   *  [[feedback_bounded_read_is_a_leak_for_security_seed_sets]]
   *
   *  🔑 `field` must be a DECLARED D-206 ref (`REF_FIELDS`) — an unknown one THROWS rather
   *  than quietly matching nothing. The closed vocabulary is what makes the json path safe
   *  to inline as a SQL literal, and inlining it is the only way the expression index is
   *  used at all (a bound path degrades to a full scan of the scope — measured). */
  listByRef(
    scope: EnrichmentScope,
    opts: { field: string; value: string; limit?: number },
  ): { rows: CrmRecordMirrorRow[]; total: number };
}

/** **D-206 — the DECLARED relationship fields, as the closed set this store indexes and
 *  filters a reverse lookup on.** Derived from `CANONICAL_CRM_FIELD_SCHEMA`'s own `ref`
 *  declarations (today: `contact_id`, `account_id`), so declaring a new relationship gives
 *  it an index and a reverse query with **no change here**.
 *
 *  🔑 **The closed-ness is load-bearing twice over.** It is what lets `listByRef` inline the
 *  json path as a SQL **LITERAL** — which is (a) safe, because the vocabulary is a built-in
 *  constant a caller cannot influence, and (b) the only way the expression index is ever
 *  USED. Measured: a **parameter-bound** path (`json_extract(meta, ?)`, which is what
 *  `list()` does) plans to `SEARCH … USING INDEX (scope=?)` — it narrows to the scope and
 *  then **scans every row of it**, because SQLite matches an expression index only against
 *  the *identical literal expression*. The literal form plans to
 *  `SEARCH … USING COVERING INDEX (scope=? AND <expr>=?)` and never touches the table. */
const REF_FIELDS: readonly string[] = [
  ...new Set(CRM_ALIAS_VALUES.flatMap((alias) => crmRefFields(alias).map((r) => r.field))),
];

/** Defence in depth on the literal inlining. The names come from a built-in constant, so
 *  this can only fire on a schema authoring error — but the day it would matter is the day
 *  someone adds a ref whose name is not an identifier, and a silent SQL splice is not a
 *  failure anyone would notice. Fail LOUD, at boot. */
const SAFE_REF_FIELD = /^[a-z_][a-z0-9_]*$/i;
for (const field of REF_FIELDS) {
  if (!SAFE_REF_FIELD.test(field)) {
    throw new Error(`crm_record_mirror: D-206 ref field '${field}' is not a safe identifier`);
  }
}

/** D-190 — create the mirror table. Idempotent (`IF NOT EXISTS`). Pre-launch: a dev
 *  DB created against an older shape is wiped, never migrated. */
export const ensureCrmRecordMirrorSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CRM_RECORD_MIRROR_TABLE} (
      scope       TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      meta        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (scope, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_record_mirror_scope_updated
      ON ${CRM_RECORD_MIRROR_TABLE} (scope, updated_at DESC);
  `);
  // D-206 — one EXPRESSION index per declared relationship. The DECLARATION is the index
  // hint: `deal.contact_id → ref{contact}` is simultaneously what the resolver reads
  // (step 2), what a reverse lookup filters on, and what this indexes. Without these,
  // "which deals reference this contact?" is a full scan of the vendor's deal scope.
  for (const field of REF_FIELDS) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_crm_record_mirror_ref_${field}
         ON ${CRM_RECORD_MIRROR_TABLE} (scope, json_extract(meta, '$.${field}'))`,
    );
  }
};

export const createCrmRecordMirrorStore = (db: Database.Database): CrmRecordMirrorStore => {
  // ON CONFLICT preserves created_at (only meta + updated_at change), so the
  // first-seen time survives refreshes.
  const upsertStmt = db.prepare(`
    INSERT INTO ${CRM_RECORD_MIRROR_TABLE} (scope, target_id, meta, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (scope, target_id) DO UPDATE SET meta = excluded.meta, updated_at = excluded.updated_at
  `);
  const deleteStmt = db.prepare(
    `DELETE FROM ${CRM_RECORD_MIRROR_TABLE} WHERE scope = ? AND target_id = ?`,
  );
  const deleteAllStmt = db.prepare(`DELETE FROM ${CRM_RECORD_MIRROR_TABLE} WHERE scope = ?`);
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${CRM_RECORD_MIRROR_TABLE} WHERE scope = ?`,
  );
  // D-192 — per-connection cut within a vendor-shared scope, `target_id LIKE
  // '<prefix>%' ESCAPE '\'` (the prefix's literal `_`/`%` are escaped so
  // `acme_` never matches `acme2_`).
  const deleteForConnStmt = db.prepare(
    `DELETE FROM ${CRM_RECORD_MIRROR_TABLE} WHERE scope = ? AND target_id LIKE ? ESCAPE '\\'`,
  );
  const countForConnStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${CRM_RECORD_MIRROR_TABLE} WHERE scope = ? AND target_id LIKE ? ESCAPE '\\'`,
  );
  // D-192 C-2 slice 7 — the contact-import leaf's UNCAPPED per-connection read.
  // No LIMIT, deliberately: see the interface note. Ordered by target_id so a walk
  // is deterministic (the delete diff and the dedupe tiebreak both benefit from a
  // stable order; SQLite guarantees none otherwise).
  const listForConnStmt = db.prepare(
    `SELECT target_id, meta FROM ${CRM_RECORD_MIRROR_TABLE}
       WHERE scope = ? AND target_id LIKE ? ESCAPE '\\'
       ORDER BY target_id ASC`,
  );

  const upsert: CrmRecordMirrorStore['upsert'] = ({ scope, target_id, meta, now }) => {
    // `serializeEnrichmentMeta` enforces the shared 8 KB snapshot cap (throws
    // MetaSnapshotTooLargeError) — the mirror honours the same bound as the
    // platform-reference meta it carries.
    upsertStmt.run(scope, target_id, serializeEnrichmentMeta(meta), now, now);
  };

  const list: CrmRecordMirrorStore['list'] = (scope, opts = {}) => {
    const limit = Math.min(Math.max(opts.limit ?? MIRROR_DEFAULT_LIMIT, 1), MIRROR_MAX_LIMIT);
    const where: string[] = ['scope = ?'];
    const args: unknown[] = [scope];
    if (opts.name_contains !== undefined && opts.name_contains.length > 0) {
      where.push("LOWER(json_extract(meta, '$.name')) LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLikeWildcards(opts.name_contains.toLowerCase())}%`);
    }
    if (opts.email_exact !== undefined && opts.email_exact.length > 0) {
      where.push("LOWER(json_extract(meta, '$.email')) = ?");
      args.push(opts.email_exact.toLowerCase());
    }
    if (opts.domain_exact !== undefined && opts.domain_exact.length > 0) {
      where.push("LOWER(json_extract(meta, '$.domain')) = ?");
      args.push(opts.domain_exact.toLowerCase());
    }
    // Closed canonical-field filters — the json path binds as a PARAMETER (an
    // unexpected caller path can never splice into SQL); a row whose meta lacks the
    // key yields json_extract → NULL and drops on the comparison.
    for (const { path, value } of opts.meta_equals ?? []) {
      where.push('json_extract(meta, ?) = ?');
      args.push(path, value);
    }
    for (const { path, min, max } of opts.meta_ranges ?? []) {
      if (typeof min === 'number' && Number.isFinite(min)) {
        where.push('json_extract(meta, ?) >= ?');
        args.push(path, min);
      }
      if (typeof max === 'number' && Number.isFinite(max)) {
        where.push('json_extract(meta, ?) <= ?');
        args.push(path, max);
      }
    }
    const sql = `SELECT target_id, meta FROM ${CRM_RECORD_MIRROR_TABLE}
                  WHERE ${where.join(' AND ')}
               ORDER BY updated_at DESC
                  LIMIT ?`;
    args.push(limit);
    const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
    const out: CrmRecordMirrorRow[] = [];
    for (const row of rows) {
      const target_id = row['target_id'];
      const rawMeta = row['meta'];
      if (typeof target_id !== 'string') continue;
      if (typeof rawMeta !== 'string') continue;
      const meta = deserializeEnrichmentMeta(rawMeta);
      if (meta === null) continue;
      out.push({ scope, target_id, meta });
    }
    return out;
  };

  const deleteForSource: CrmRecordMirrorStore['deleteForSource'] = (scope, target_id) =>
    deleteStmt.run(scope, target_id).changes > 0;

  const deleteAllForScope: CrmRecordMirrorStore['deleteAllForScope'] = (scope) =>
    deleteAllStmt.run(scope).changes;

  const countForScope: CrmRecordMirrorStore['countForScope'] = (scope) =>
    (countStmt.get(scope) as { n: number }).n;

  const listForConnection: CrmRecordMirrorStore['listForConnection'] = (
    scope,
    target_id_prefix,
  ) => {
    const rows = listForConnStmt.all(
      scope,
      `${escapeLikeWildcards(target_id_prefix)}%`,
    ) as Record<string, unknown>[];
    const out: CrmRecordMirrorRow[] = [];
    for (const row of rows) {
      const target_id = row['target_id'];
      const rawMeta = row['meta'];
      if (typeof target_id !== 'string') continue;
      if (typeof rawMeta !== 'string') continue;
      const meta = deserializeEnrichmentMeta(rawMeta);
      // ⚠ A row whose meta will not deserialize is DROPPED — and to an absence-based
      // delete diff a dropped row looks EXACTLY like a deleted one. The caller cannot
      // see the drop from here, so it must not infer completeness from this list
      // alone: compare `rows.length` against `countForConnection(scope, prefix)`,
      // which counts in SQL and drops nothing. Unequal ⇒ the walk is not complete.
      if (meta === null) continue;
      out.push({ scope, target_id, meta });
    }
    return out;
  };

  const deleteForConnection: CrmRecordMirrorStore['deleteForConnection'] = (
    scope,
    target_id_prefix,
  ) => deleteForConnStmt.run(scope, `${escapeLikeWildcards(target_id_prefix)}%`).changes;

  const countForConnection: CrmRecordMirrorStore['countForConnection'] = (
    scope,
    target_id_prefix,
  ) =>
    (countForConnStmt.get(scope, `${escapeLikeWildcards(target_id_prefix)}%`) as { n: number }).n;

  // D-167 Tier 2 — one UNCAPPED scan per scope, projecting only the requested keys
  // (no `deserializeEnrichmentMeta`, no LIMIT). The json paths bind as PARAMETERS,
  // matching the `list()` filter precedent; the SELECT list is positional (`v0`,
  // `v1`, …) so the column names never carry caller input either. Statement is
  // built per call because the column count varies with `keys.length` — the caller
  // memoises the whole seed build once per recalling turn, so this runs at most
  // once per scope per turn.
  const listMetaRows: CrmRecordMirrorStore['listMetaRows'] = (scope, keys) => {
    if (keys.length === 0) return [];

    const cols = keys.map((_, i) => `json_extract(meta, ?) AS v${i}`).join(', ');
    const rows = db
      .prepare(`SELECT ${cols} FROM ${CRM_RECORD_MIRROR_TABLE} WHERE scope = ?`)
      .all(...keys.map((k) => `$.${k}`), scope) as Record<string, unknown>[];

    const out: Array<Record<string, string>> = [];
    for (const row of rows) {
      const record: Record<string, string> = {};
      for (let i = 0; i < keys.length; i += 1) {
        const v = row[`v${i}`];
        // Only strings seed: a numeric vendor id (Pipedrive's `id`) or a nested
        // object (`mailing_address`) is not an aliasable value.
        if (typeof v !== 'string') continue;
        const trimmed = v.trim();
        if (trimmed.length === 0) continue;
        record[keys[i]!] = trimmed;
      }
      if (Object.keys(record).length > 0) out.push(record);
    }
    return out;
  };

  const hashesStmt = db.prepare(
    `SELECT target_id, json_extract(meta, '$.snapshot_hash') AS h
       FROM ${CRM_RECORD_MIRROR_TABLE} WHERE scope = ?`,
  );
  const listSnapshotHashes: CrmRecordMirrorStore['listSnapshotHashes'] = (scope) => {
    const out = new Map<string, string>();
    for (const row of hashesStmt.all(scope) as Record<string, unknown>[]) {
      const target_id = row['target_id'];
      const h = row['h'];
      // A row whose meta lacks snapshot_hash (json_extract → NULL) is omitted —
      // it re-syncs as changed, never falsely matches.
      if (typeof target_id === 'string' && typeof h === 'string' && h.length > 0) {
        out.set(target_id, h);
      }
    }
    return out;
  };

  // ── D-206 — the REVERSE lookup ─────────────────────────────────────────────────
  //
  // One prepared pair per DECLARED ref field, built at construction. The json path is
  // inlined as a LITERAL (never a bound parameter) — that is what lets SQLite use the
  // expression index, and it is safe precisely BECAUSE the vocabulary is a closed built-in
  // constant validated at module load.
  const refStmts = new Map<string, { count: Database.Statement; page: Database.Statement }>();
  for (const field of REF_FIELDS) {
    refStmts.set(field, {
      // UNCAPPED, by nature: a COUNT is the completeness claim, and it deserializes nothing.
      count: db.prepare(
        `SELECT COUNT(*) AS n FROM ${CRM_RECORD_MIRROR_TABLE}
           WHERE scope = ? AND json_extract(meta, '$.${field}') = ?`,
      ),
      page: db.prepare(
        `SELECT target_id, meta FROM ${CRM_RECORD_MIRROR_TABLE}
           WHERE scope = ? AND json_extract(meta, '$.${field}') = ?
        ORDER BY updated_at DESC
           LIMIT ?`,
      ),
    });
  }

  const listByRef: CrmRecordMirrorStore['listByRef'] = (scope, opts) => {
    const stmts = refStmts.get(opts.field);
    // ⛔ Fail LOUD. An unknown field would `json_extract` to NULL for every row and return a
    // confident, complete-looking ZERO — the exact silent-absence failure this door exists
    // to prevent, arriving through the door itself.
    if (stmts === undefined) {
      throw new Error(
        `crm_record_mirror.listByRef: '${opts.field}' is not a declared D-206 ref field ` +
          `(declared: ${REF_FIELDS.join(', ')})`,
      );
    }
    // The COMPLETE size — always, and independent of the page. This is the invariant.
    const total = (stmts.count.get(scope, opts.value) as { n: number }).n;
    const limit = Math.min(Math.max(opts.limit ?? MIRROR_DEFAULT_LIMIT, 1), MIRROR_MAX_LIMIT);
    const raw = stmts.page.all(scope, opts.value, limit) as Record<string, unknown>[];
    const rows: CrmRecordMirrorRow[] = [];
    for (const row of raw) {
      const target_id = row['target_id'];
      const rawMeta = row['meta'];
      if (typeof target_id !== 'string' || typeof rawMeta !== 'string') continue;
      const meta = deserializeEnrichmentMeta(rawMeta);
      if (meta === null) continue;
      rows.push({ scope, target_id, meta });
    }
    return { rows, total };
  };

  return {
    upsert,
    list,
    listByRef,
    listForConnection,
    listMetaRows,
    listSnapshotHashes,
    deleteForSource,
    deleteAllForScope,
    countForScope,
    deleteForConnection,
    countForConnection,
  };
};
