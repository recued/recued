/** Scope-B (D-108/D-109) — concrete `ArchiveRuntime` + rpc-deps factory.
 *
 *  This is the live implementation behind the `server.archive.*` rpc
 *  handler shell (`archive-handler.ts`). It wires the existing
 *  `exportArchive` / `importArchive` / restore helpers to the running
 *  server's handles (db, blob store, lifecycle) and maps the on-disk
 *  archive manifest onto the wire `ArchiveManifest` the ext renders.
 *
 *  Recovery key: every method takes the user's 24-word mnemonic (sent
 *  transiently over the rpc, same posture as `pair.registerRecoveryKey`).
 *  The server holds only the Master DEK after unlock — never the raw
 *  recovery key — so the archive encryption key is derived per call from
 *  the supplied mnemonic via the canonical BIP39 entropy (`@recued/crypto`
 *  `recoveryKeyToEntropy` → the 32 bytes `deriveArchiveKeys` consumes,
 *  byte-identical to the `archive` CLI's pre-derived key).
 *
 *  Online restore = stage-beside-then-atomic-swap (see `archive-restore.ts`
 *  + the module header there): stage the whole-db write to `dbPath.staging`
 *  while the server keeps serving, respond to the rpc, then fire-and-forget
 *  the restart drain (which closes the ws + db), commit the rename-swap,
 *  and hand off to the supervisor for respawn on the restored db.
 */

import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  recoveryKeyToEntropy,
  bundleToJSON,
  serverBundleFromJSON,
  serverBundleToJSON,
} from '@recued/crypto';
import {
  DRAIN_STEP_NAMES,
  type ArchiveImportRebind,
  type ArchiveManifest,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createPairedInstancesStore } from '../paired-instances-store.js';
import { openDatabase } from '../open-database.js';
import { deriveDatabaseKeyFromRecoveryEntropy } from '../database-encryption.js';
import {
  exportArchive,
  buildExportBlobSources,
  quoteSqliteIdent,
} from './archive-export.js';
import type { KeyManager } from '../key-manager.js';
import { type ImportOptions } from './archive-import.js';
import { type ArchiveManifest as OnDiskArchiveManifest } from './archive-format.js';
import { osFreeBytes } from '../storage/disk-free.js';
import {
  EXPORT_TTL_MS,
  estimateExportBytes,
  evictOtherExports,
  formatBytes,
  newExportPath,
  pruneInterruptedExportPartials,
  pruneExpiredExports,
} from './export-store.js';
import {
  stageRestore,
  commitStagedRestore,
  discardStagedRestore,
  previewToTempDb,
  type RestoreTargets,
  type StagedRestore,
} from './archive-restore.js';
import { createBundleStore } from '../bundle-store.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { verifyRecoveryKeyAgainstRealm } from '../recovery-key-processor.js';
import { exportServerPassport } from '../passport/index.js';
import type { PassportExportRpcDeps } from '../passport/export-handler.js';
import type { Lifecycle } from '../lifecycle/index.js';
import type {
  ArchiveImportDrivingClient,
  ArchiveRpcDeps,
  ArchiveRuntime,
} from './archive-handler.js';
import { assertRecordsRestoreCoherence } from '../records/store.js';
import { previewDatabaseScratchPath } from './archive-scratch.js';

/** Attribution stamped onto an archive-embedded passport's
 *  `exported_by_client_id`. The archive rpc is operator-only, so this is
 *  informational provenance, not a security boundary (mirrors the passport
 *  export-handler's webclient-bearer sentinel). */
const ARCHIVE_PASSPORT_EXPORTED_BY = 'archive-embed';

/** M5 S3 — the DENYLIST behind `isLiveWarehouseEmpty` (the not-enrolled restore
 *  guard). The guard authorizes a DESTRUCTIVE pre-enrollment restore only when
 *  the live db holds no USER data, so it must FAIL CLOSED: rather than an
 *  allowlist of user-content tables (where a missed/renamed/new table would read
 *  as "empty" and let a restore clobber real data — Codex S3.1 HIGH), it counts
 *  EVERY table EXCEPT this denylist of tables that are legitimately non-empty on
 *  a brand-new server or are written by the restore flow itself. Anything not
 *  listed here — including a future warehouse surface we forget to classify —
 *  counts as user data and BLOCKS the restore (safe direction; the user enrolls
 *  + restores through Settings instead). Three buckets:
 *    1. Boot-seeded capability/config + identity/system tables (a fresh server
 *       populates these at install; the `composeStorageContext` fresh-baseline
 *       test pins the set so a new seed table can't silently slip in).
 *    2. Operator-config-derived tables (oauth / tls / pii / tunables) — populated
 *       from TOML/env, never from user activity. These can be EMPTY in the
 *       empty-config fresh-baseline test yet non-empty in production, so they are
 *       listed explicitly (the test can't catch their omission).
 *    3. Pairing / upload-session tables — the pre-pair restore flow writes these
 *       BEFORE this check runs, so they must not count. */
export const RESTORE_GUARD_NON_USER_TABLES: ReadonlySet<string> = new Set<string>([
  // 1. BOOT-SEEDED set — the EXACT tables a freshly-composed server populates at
  //    install (verified empirically by the `composeStorageContext` fresh-baseline
  //    test, which turns red + names any new seed table that slips in). These ship
  //    non-empty, so they can't be user-data signals. NOTE: `recipes` +
  //    `recipe_insights` are MIXED (boot-seeded AND user-growable via recipe.save /
  //    runs); denylisting them wholesale is owner-ratified defense-in-depth, safe
  //    because those user-write paths are themselves gated pre-enrollment — see the
  //    reachability note on `verifyRestoreRealm`'s not_enrolled branch.
  'server_config',
  'server_state',
  'recipes',
  'contract_store',
  'local_manifest',
  'recipe_trust',
  'source_registry',
  'recipe_insights',
  // ALSO boot-seeded (the collection-registry default row, boot/setup audit
  // events, the seed recipes' reactive triggers). Surfaced 2026-06-27 by the
  // LIVE pre-pair restore wet-run: a genuinely fresh `bin.ts` server carries
  // rows here, so the guard falsely refused it as "already holds data". Safe to
  // denylist on the SAME owner-ratified reasoning as recipes/recipe_insights —
  // their user-write paths (collection enroll / recipe.save+arm) are gated
  // pre-enrollment, and this guard ONLY runs pre-enrollment; the post-USE
  // signals stay counted (`audit_entries` for runs, the per-collection content
  // tables, etc.). NOTE: the `composeStorageContext` fresh-baseline test did NOT
  // catch this — it under-seeds vs a real boot; the deferred real-boot rowcount
  // baseline (B) is the proper long-term guard against the next such table.
  'collection_instances',
  'audit_activities',
  'event_triggers',
  // Boot-seeded 2026-08-05 by the O(1) audit byte-total counter: the hourly
  // storage gate stopped summing the corpus and now reads a trigger-maintained
  // running total, which `ensureAuditUsageCounter` initialises with one row per
  // surface at first open. Pure derived bookkeeping — it holds byte counts, not
  // content — so denylisting it removes no user-data signal.
  //
  // ⛔ Its absence made `isLiveWarehouseEmpty` return false on EVERY freshly
  // composed server, which is the not-enrolled restore guard refusing a restore
  // onto a fresh install — the exact 2026-06-27 wet-run failure, reintroduced by
  // an unrelated performance change. A derived-bookkeeping table is the easiest
  // kind to add without thinking about this guard, and nothing outside these
  // tests connects the two.
  'audit_usage',
  // Boot-created 2026-08-26 by the FTS content-format marker (`@recued/fts`):
  // one row per index recording which text shape it holds, so a format change
  // rebuilds each index exactly once instead of half-matching forever. Pure
  // derived bookkeeping — a table NAME and an integer, no user content — so
  // denylisting it removes no user-data signal.
  //
  // ⛔ AND IT LANDED IN PRECISELY THE TRAP THE NOTE ABOVE DESCRIBES. "A derived-
  // bookkeeping table is the easiest kind to add without thinking about this
  // guard" — written about `audit_usage`, and the next such table walked into it
  // the same way: five reds in the fresh-baseline test, nothing else in the tree
  // connecting an FTS migration marker to a restore guard. The guard worked; the
  // habit it warns about is the durable finding.
  'fts_content_format',
  // 2. SERVER identity / config / networking / system state — populated by
  //    SETUP (identity, hostnames, TLS, exposure, operator config), never by user
  //    activity. Empty on the empty-config fresh-baseline yet non-empty on a
  //    configured box, so they're listed explicitly (the test can't catch their
  //    omission) to avoid over-refusing a configured-but-data-less server.
  'server_vault',
  'server_dek',
  'hostname_registry',
  'pro_subscription_state',
  'exposure_state',
  'cli_reachability',
  'oauth_app_config',
  'tls_domains',
  'cert_blob',
  'pii_policy',
  'enrichment_tunable_params',
  // 3. PAIRING / upload-session flow — the pre-pair restore flow itself writes
  //    these BEFORE this check runs, so they must not count as pre-existing data.
  'paired_instances',
  'client_tokens',
  'upload_session',
  // Everything else — warehouse content (mail/calendar/contacts/connections/chat/
  // files/work-entities/reception/dishes/engagements/shared), execution + memory
  // (audit_entries/audit_activities/commits/checkpoints/recued_plans/links/
  // annotation), user config + authoring (llm_config/schedules/ingredient_draft/
  // bundle/enrichment_trust/…), and caches — is COUNTED. All are empty on a fresh
  // server and gain rows only from activity, so any one row BLOCKS the restore.
]);

/** M5 S3 — the live tables that count as USER data for the restore guard: every
 *  table in `db` EXCEPT `RESTORE_GUARD_NON_USER_TABLES`, FTS5 internals, and
 *  sqlite internals, that holds ≥1 row. FAIL CLOSED by construction — an
 *  unclassified table counts. Returned as a NAMED list (not just a bool) so the
 *  fresh-baseline test pinpoints a denylist gap by table name. */
export const restoreGuardUserDataTables = (
  database: Database.Database,
): string[] => {
  // FTS5 virtual tables carry internal shadow tables (`<name>_data` / `_idx` /
  // `_docsize` / `_config` / `_content`) that hold segment + config rows even
  // when the indexed PARENT is empty — counting them would falsely read as data.
  // The real content lives in the parent (regular) table, which IS counted.
  // Derive the exclusion from the schema (the fts5 vtables + their shadows)
  // rather than a `_fts` naming assumption.
  const ftsExcluded = new Set<string>();
  const ftsVtables = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%'`)
    .all() as Array<{ name: string }>;
  for (const { name } of ftsVtables) {
    ftsExcluded.add(name);
    for (const suffix of ['data', 'idx', 'docsize', 'config', 'content']) {
      ftsExcluded.add(`${name}_${suffix}`);
    }
  }

  const tables = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>;
  const hits: string[] = [];
  for (const { name } of tables) {
    if (RESTORE_GUARD_NON_USER_TABLES.has(name) || ftsExcluded.has(name)) continue;
    const row = database
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteSqliteIdent(name)}`)
      .get() as { n: number };
    if (row.n > 0) hits.push(name);
  }
  return hits;
};

/** M5 S3 — does the LIVE warehouse hold any USER data? `false` ⇒ a destructive
 *  pre-enrollment restore is refused. Throws only on a broken db handle; the
 *  caller treats a throw as not-empty (never authorize a swap on an unreadable
 *  warehouse). */
export const isLiveWarehouseEmpty = (database: Database.Database): boolean =>
  restoreGuardUserDataTables(database).length === 0;

export interface ArchiveRuntimeDeps {
  /** Live warehouse db handle. Export reads blob refs + the legacy vault
   *  bundle from it; the D-212 server bundle comes from the db sidecar. Import
   *  never mutates this handle (it stages beside + swaps at restart). */
  db: Database.Database;
  /** Absolute db file path — the restore target + staging anchor. */
  dbPath: string;
  /** `dirname(dbPath)` — blobs/ + exports/ live here. */
  dataPath: string;
  /** Live config.toml path, or null when config came from env/defaults. */
  configPath: string | null;
  /** Server version — `producer_version` on export, `consumer_version`
   *  for the import compatibility check. */
  serverVersion: string;
  /** Trigger the restart: drain (closes ws + db), then run `onDrained`
   *  with whether the drain fully quiesced writers + closed the db
   *  (`drainOk` — the runtime commits the swap iff true, else abandons it),
   *  then hand off to the supervisor + exit. Fire-and-forget AND deferred —
   *  `runImport` responds to the rpc BEFORE the drain begins; the client
   *  reconnects after the supervisor respawns. */
  requestRestart: (onDrained: (drainOk: boolean) => Promise<void>) => void;
  /** Late-bound accessor for the passport-export substrate (providers +
   *  live `serverIdentity` getter + audit). Composed a layer deeper than
   *  this runtime (it needs the cert stack), so it's a getter resolved at
   *  export time — `undefined` on a db-less / no-audit boot ⇒ exports just
   *  skip the embedded passport. */
  getPassportExport?: () => PassportExportRpcDeps | undefined;
  /** Late-bound accessor for the live server KeyManager (`app.keys`). Export
   *  needs it to open every production CAS root and decrypt each blob to
   *  plaintext under `keyProvider('blob-store')`. A getter (not a value)
   *  because the archive
   *  runtime is composed BEFORE the app/KeyManager exists in the boot order —
   *  it is resolved at export time, mirroring `getPassportExport`. A missing or
   *  locked vault produces a null-returning provider and encrypted-blob reads
   *  fail closed (blobs cannot export while the realm is sealed). */
  getKeys?: () => KeyManager | undefined;
  /** Clock — injected for deterministic tests. */
  now?: () => number;
}

/** Derive the 32-byte archive key from a 24-word mnemonic. Throws (with a
 *  `@recued/crypto` message) on an invalid mnemonic; the handler maps that
 *  to a `bad_request`. */
const deriveArchiveKeyBuffer = (mnemonic: string): Buffer =>
  Buffer.from(recoveryKeyToEntropy(mnemonic));

/** SQLite stamps these 16 bytes at offset 0 of every plaintext database. The
 *  D-212 cipher covers page 1 along with the rest of the file, so the magic's
 *  absence is what separates an encrypted realm from a plain one. */
const SQLITE_PLAINTEXT_HEADER = 'SQLite format 3\u0000';

/** Is the realm database at `path` encrypted? Answered from the FILE, because
 *  the file is what the export actually copies — `VACUUM INTO` inherits the
 *  cipher of the connection reading it. The KeyManager cannot answer this: its
 *  state reads `locked` whenever EITHER the legacy D-081 password bundle (a row
 *  inside SQLite) or the D-212 sidecar is present, so a password-bundle realm
 *  with a plain database looks encrypted to it — the offline CLI backs such a
 *  realm up without complaint, and the two export doors must agree about it.
 *  Anything that does not read back as the plaintext magic counts as encrypted:
 *  an unrestorable backup only announces itself at disaster-recovery time. */
const isDatabaseFileEncrypted = (path: string): boolean => {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(SQLITE_PLAINTEXT_HEADER.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return read !== head.length || head.toString('utf8') !== SQLITE_PLAINTEXT_HEADER;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
};

/** M5 S2 — mint the import-driving client a fresh bearer + roster row INTO the
 *  STAGED restore db, so it reconnects after the restart without re-pairing
 *  (the swap wiped its old bearer — that row lived in the now-discarded db).
 *  The staged db BECOMES the live db at the swap, so the write lands in the
 *  restored realm. The new token carries `metadata.instance_id` so the client's
 *  next WS upgrade re-derives the SAME paired identity (`deriveBearerInstanceId`).
 *
 *  CRITICAL: fold the WAL into the main staging file before returning — the
 *  swap renames ONLY the main file (`stagingPath` → `dbPath`), so an
 *  un-checkpointed bearer left in a `-wal` sidecar would be silently lost. A
 *  `wal_checkpoint(TRUNCATE)` that reports `busy != 0` did NOT fully fold the
 *  WAL, so the handoff FAILS CLOSED (resolves `undefined`) rather than return a
 *  PHANTOM bearer the client would stash over its working one and then be
 *  unable to reconnect with. Best-effort: ANY failure (incl. the busy check)
 *  resolves `undefined` (the restore still commits; the client just re-pairs) —
 *  it NEVER throws, so a handoff problem can't abort a migration. Exported for
 *  direct test coverage. */
export const mintRebindIntoStagedDb = async (
  stagingPath: string,
  drivingClient: ArchiveImportDrivingClient,
  options: {
    argon2_params?: { t: number; m: number; p: number };
    databaseKey?: Uint8Array | null;
  } = {},
): Promise<ArchiveImportRebind | undefined> => {
  let stagedDb: Database.Database | undefined;
  try {
    stagedDb = await openDatabase(stagingPath, {
      ...(Object.prototype.hasOwnProperty.call(options, 'databaseKey')
        ? { databaseKey: options.databaseKey ?? null }
        : {}),
    });
    // Fail FAST on any lock contention instead of blocking on the default 5s
    // busy_timeout: in production this connection is the sole writer (the row
    // counter already closed its read handle), so there is nothing to wait for;
    // and a restore must never HANG on the handoff — if a checkpoint somehow
    // can't complete, surface busy immediately so we degrade to no-rebind.
    stagedDb.pragma('busy_timeout = 0');
    // Re-insert the roster row (the swap wiped this instance's `paired_instances`
    // row) — the stores' `CREATE TABLE IF NOT EXISTS` ctors make this safe on
    // any archive's schema.
    createPairedInstancesStore(stagedDb).addOrRefresh({
      instance_id: drivingClient.instance_id,
      user_id: drivingClient.user_id,
      display_name: drivingClient.display_name,
      kind: drivingClient.client_kind,
    });
    const issued = await createClientTokenStore(
      stagedDb,
      options.argon2_params ? { argon2_params: options.argon2_params } : {},
    ).issue({
      client_kind: drivingClient.client_kind,
      ...(drivingClient.client_label !== undefined
        ? { client_label: drivingClient.client_label }
        : {}),
      metadata: { instance_id: drivingClient.instance_id },
    });
    // Fold the WAL into the MAIN staging file BEFORE the swap renames it (the
    // swap moves ONLY the main file). A TRUNCATE checkpoint reports `busy != 0`
    // when it could not fully fold + truncate the WAL — then the bearer may
    // live only in a `-wal` the swap discards, so FAIL the handoff rather than
    // hand back a phantom bearer. (`busy === 0` also covers a non-WAL staged db,
    // whose writes already went straight to the main file.)
    const ckpt = stagedDb.pragma('wal_checkpoint(TRUNCATE)') as
      | Array<{ busy?: number }>
      | { busy?: number };
    const busy = Array.isArray(ckpt) ? ckpt[0]?.busy : ckpt?.busy;
    if (busy !== 0) {
      throw new Error(
        `staged-db WAL checkpoint did not complete (busy=${String(busy)}) — bearer not durable in the main file`,
      );
    }
    return {
      token_id: issued.token_id,
      bearer: issued.bearer,
      instance_id: drivingClient.instance_id,
    };
  } catch (err) {
    console.error(
      '[archive] driving-client re-pair mint failed — restore proceeds, client will re-pair',
      err,
    );
    return undefined;
  } finally {
    try {
      stagedDb?.close();
    } catch {
      /* best effort */
    }
  }
};

/** The minimum of a SQLite handle the row-count walk needs. Declared so the
 *  walk can be driven with a probe that fails on one table — the real path
 *  cannot synthesize that, because export runs `VACUUM INTO` and a database
 *  corrupt enough to have an uncountable table never survives the rebuild. */
export interface RowCountProbe {
  prepare(sql: string): { all(): unknown; get(): unknown };
}

/** Count rows per table, reporting the tables that could NOT be counted.
 *
 *  ⛔ Skipping an unreadable table is right — one bad table must not fail a
 *  dry run — but skipping it SILENTLY is not: `tables` would simply lack the
 *  key, which is indistinguishable from a table the archive never had, and
 *  the sum is then presented to an operator as "records in this archive"
 *  while short by an unknown amount, on the screen where they decide to
 *  restore. The caller needs to know the total is a floor. */
export const countTablesFromProbe = (
  probe: RowCountProbe,
): { record_count: number; tables: Record<string, number>; uncounted: string[] } => {
  const tableRows = probe
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  const tables: Record<string, number> = {};
  const uncounted: string[] = [];
  let total = 0;
  for (const { name } of tableRows) {
    try {
      const row = probe.prepare(`SELECT COUNT(*) AS n FROM ${quoteSqliteIdent(name)}`).get() as { n: number };
      tables[name] = row.n;
      total += row.n;
    } catch {
      uncounted.push(name);
    }
  }
  return { record_count: total, tables, uncounted };
};

export const createArchiveRuntime = (deps: ArchiveRuntimeDeps): ArchiveRuntime => {
  const now = deps.now ?? (() => Date.now());
  const { db, dbPath, dataPath, configPath, serverVersion } = deps;
  const serverBundleStore = createServerBundleStore(dbPath);

  // The CURRENT realm's recovery-key check lives in `server_config` inside
  // this live db — read it to gate cross-realm restores (Q2). Reads are
  // live per call, so it always reflects the realm in force right now
  // (before any swap).
  const recoveryStore = createRecoveryKeyCheckStore(db);

  /** Open a SQLite db file read-only and count rows per table. Used to
   *  fill the wire manifest's `record_count` / `tables` (the on-disk
   *  manifest carries neither).
   *
   *  ⚠ Returns the tables it could NOT count alongside the total. A row
   *  count that silently drops a table is a number presented as "records
   *  in this archive" while being short by an unknown amount — and it is
   *  read on the restore preview, which is where an operator decides to
   *  commit. Skipping is still the right behaviour (one unreadable table
   *  must not fail a dry run); reporting nothing about it is not. */
  const countDbRowsAtPath = async (
    path: string,
    databaseKey?: Uint8Array | null,
  ): Promise<{
    record_count: number;
    tables: Record<string, number>;
    uncounted: string[];
  }> => {
    const probe = await openDatabase(path, {
      readonly: true,
      ...(databaseKey !== undefined ? { databaseKey } : {}),
    });
    try {
      // D-221 — a whole-db archive naturally carries Records tables, but the
      // runnable unit also includes their namespace snapshots, catalog,
      // inventory, migration receipts, accounting, and exact event generation.
      // Validate that unit on the staged, still-discardable file before either
      // preview or swap can accept it. Pre-Records archives contain no Records
      // table and pass unchanged.
      assertRecordsRestoreCoherence(probe);
      return countTablesFromProbe(probe as unknown as RowCountProbe);
    } finally {
      try { probe.close(); } catch { /* best effort */ }
    }
  };

  /** Map the on-disk manifest + counted db rows onto the wire shape.
   *  `hasPassport` comes from whether the decoded records carried a
   *  `passport.json` (the on-disk manifest doesn't track it). */
  const toWireManifest = (
    onDisk: OnDiskArchiveManifest,
    counts: { record_count: number; tables: Record<string, number>; uncounted?: string[] },
    hasPassport: boolean,
  ): ArchiveManifest => ({
    format_version: onDisk.archive_format_version,
    schema_version: onDisk.schema_version,
    exported_at: new Date(onDisk.created_at).toISOString(),
    record_count: counts.record_count,
    tables: counts.tables,
    // Emitted ONLY when something was actually skipped: an always-present
    // empty array would make "this server does not report it" and "nothing
    // was skipped" the same wire value, which is the distinction the field
    // exists to carry.
    ...(counts.uncounted && counts.uncounted.length > 0
      ? { uncounted_tables: counts.uncounted }
      : {}),
    includes_blobs: onDisk.blob_count > 0,
    includes_passport: hasPassport,
  });

  /** Does `key` own the CURRENT realm — asked of BOTH anchors, bundle first.
   *
   *  ⛔ A realm has two anchors and either alone is insufficient — the exact
   *  rule `enrollRealmRecoveryKey` enforces at every enrollment door. The
   *  BUNDLE (an encrypted realm's recovery wrap) is authoritative; the SENTINEL
   *  (the cheap `recovery_key_check` row) can be ABSENT while the bundle exists,
   *  because the enroll step-2→step-3 window is not transactional and a crash
   *  there leaves a realm bundle-owned with no sentinel, permanently. A
   *  sentinel-ONLY check reads that state as `not_enrolled` and hands the realm
   *  to whoever asks — which the enrollment door's own comment names as landing
   *  "here AND at the archive realm gate". This IS that gate; it was checking
   *  only the sentinel.
   *
   *    `owns`    — at least one anchor exists and EVERY existing anchor accepts
   *                the key.
   *    `foreign` — an anchor exists and rejects the key (INCLUDING a present
   *                bundle we cannot check for lack of a KeyManager: fail closed,
   *                never downgrade an owned realm to unowned).
   *    `unowned` — neither anchor exists (a genuinely fresh / pre-pair server).
   *
   *  Degrades to the prior sentinel-only behaviour exactly when no bundle
   *  exists (`bundlePresent` false ⇒ the answer is the sentinel's). */
  const classifyRealmOwnership = async (
    key: string,
  ): Promise<'owns' | 'foreign' | 'unowned'> => {
    const keys = deps.getKeys?.();
    const bundlePresent = keys?.hasServerBundle() ?? serverBundleStore.load() !== null;
    const sentinel = await verifyRecoveryKeyAgainstRealm(recoveryStore, key);
    const sentinelPresent = sentinel !== 'not_enrolled';

    if (!bundlePresent && !sentinelPresent) return 'unowned';

    // `verifyRecoveryKey` opens the bundle's recovery wrap directly from the
    // key, so it answers even on a LOCKED manager. A present bundle with no
    // manager to check it is unproven → foreign (fail closed).
    const bundleAccepts =
      !bundlePresent || (keys ? await keys.verifyRecoveryKey(key) : false);
    const sentinelAccepts = !sentinelPresent || sentinel === 'match';
    return bundleAccepts && sentinelAccepts ? 'owns' : 'foreign';
  };

  return {
    canExport() {
      // The runtime is only constructed when the warehouse db exists
      // (gated at the wiring site). The recovery key arrives per call, so
      // there's nothing else to pre-flight here.
      return { ok: true };
    },

    async preflightExport({ includeBlobs }) {
      // Live OS free space — the truth the kernel knows. statfs unsupported
      // on this filesystem ⇒ gate-open (mirror the service quota tracker:
      // let the export run and surface a natural ENOSPC rather than wedge
      // the surface because statfs isn't implemented here).
      let freeBytes: number;
      try {
        freeBytes = osFreeBytes(dataPath);
      } catch {
        return { ok: true };
      }
      let dbBytes = 0;
      try {
        dbBytes = statSync(dbPath).size;
      } catch {
        /* db file unstattable — estimate from 0, headroom still applies */
      }
      // The warehouse runs in WAL mode (compose-storage-context): uncheck-
      // pointed pages live in `${dbPath}-wal` and the logical snapshot includes them
      // into the temp db + the archive. Count the WAL so a large unflushed
      // write-set doesn't slip past the estimate into a mid-export ENOSPC.
      try {
        dbBytes += statSync(`${dbPath}-wal`).size;
      } catch {
        /* no WAL sidecar (checkpointed / non-WAL) — nothing to add */
      }
      // Size ONLY the blobs the export bundles (the SAME root-split sources
      // `runExport` builds), not the whole CAS tree — orphaned objects already
      // reduce free space, so counting them too would double-charge. The
      // archive carries PLAINTEXT, so budget the plaintext size (encrypted
      // sources ≈ on-disk minus the small AEAD envelope). No decrypt here.
      let blobBytes = 0;
      // An ENCRYPTED source decrypts each blob to a transient scratch file (one
      // at a time, in the data dir) before streaming it in, so the peak
      // disk during export exceeds the final archive by the LARGEST single
      // encrypted blob's plaintext. Budget that too, or preflight can green-
      // light an export that then ENOSPC-fails mid-scratch (fails cleanly, but
      // pointlessly). Explicit keyless format-test fixtures stream without
      // scratch, but the production builder creates encrypted sources only.
      let maxScratchBytes = 0;
      if (includeBlobs) {
        const getBlobKey = deps.getKeys?.()?.keyProvider('blob-store') ?? (() => null);
        for (const source of buildExportBlobSources(dataPath, db, getBlobKey)) {
          for (const hash of source.hashes) {
            const s = source.store.plaintextSizeOf
              ? await source.store.plaintextSizeOf(hash)
              : await source.store.sizeOf(hash);
            if (s) {
              blobBytes += s;
              if (source.store.encrypted && s > maxScratchBytes) maxScratchBytes = s;
            }
          }
        }
      }
      const needBytes = estimateExportBytes(dbBytes, blobBytes) + maxScratchBytes;
      if (freeBytes < needBytes) {
        return {
          ok: false,
          reason: `need ~${formatBytes(needBytes)} free, ${formatBytes(freeBytes)} available`,
          need_bytes: needBytes,
          free_bytes: freeBytes,
        };
      }
      return { ok: true };
    },

    pruneExpiredExports() {
      return { deleted: pruneExpiredExports(dataPath, EXPORT_TTL_MS, now()) };
    },

    async runExport({ includeBlobs, includePassport, recoveryKey }) {
      const key = deriveArchiveKeyBuffer(recoveryKey);
      try {
      // Prove this phrase actually opens THIS realm before writing a backup
      // with it. The rpc layer validates BIP39 well-formedness only, and this
      // path — unlike the CLI, which must derive the key to open the db at all
      // — reuses the already-open boot handle, so a different-but-valid
      // mnemonic would seal the outer archive under key B while the embedded
      // database and bundle still need key A. Restore accepts one key, so the
      // archive is unrestorable; without this check the only signal arrives at
      // disaster-recovery time, which is the one moment it is worthless.
      const exportBundle = serverBundleStore.load();
      if (exportBundle) {
        let probe: Uint8Array | undefined;
        try {
          probe = await deriveDatabaseKeyFromRecoveryEntropy(exportBundle, key);
        } catch (err) {
          throw new Error(
            'archive export: that recovery key does not open this server\'s vault — ' +
              'the backup would not be restorable. ' +
              `Cause: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // ⛔ …and prove that key opens the LIVE DATABASE, not just the sidecar.
        // The check above only proves the mnemonic unwraps the sidecar CURRENTLY
        // on disk. But the server snapshots the already-open boot handle (keyed
        // under the Master DEK it booted with, A) while embedding the on-disk
        // sidecar — and if that sidecar has DRIFTED to a different valid bundle
        // (Master DEK B) since boot, the mnemonic still unwraps it, yet the key
        // it yields cannot open the archived database bytes. Restore derives
        // from the embedded sidecar, so the backup is silently unrestorable —
        // the one signal arriving at disaster-recovery time. The offline CLI is
        // immune because it OPENS the db with the sidecar-derived key to export
        // at all; the online path reuses the boot handle, so it must verify
        // explicitly. A read-only second handle coexists with the live one under
        // WAL; a mismatched key fails `assertReadable` inside `openDatabase`.
        let verify: Database.Database | undefined;
        try {
          verify = await openDatabase(dbPath, { databaseKey: probe, readonly: true });
        } catch (err) {
          throw new Error(
            'archive export: this server\'s vault bundle sidecar no longer opens the ' +
              'running database — it has drifted since boot, so the backup would embed a ' +
              'bundle that cannot decrypt its own database bytes and would not be restorable. ' +
              `Cause: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          try { verify?.close(); } catch { /* best effort */ }
          probe.fill(0);
        }
      } else if (isDatabaseFileEncrypted(dbPath)) {
        // Encrypted realm whose sidecar has gone missing since boot: the keys
        // are still in RAM so the server runs, but the archive would carry an
        // encrypted database and nothing able to open it.
        throw new Error(
          'archive export: this realm is encrypted but its vault bundle sidecar is ' +
            'missing — the backup would not be restorable.',
        );
      }
      const destPath = newExportPath(dataPath, now());
      // D-212 slice 4 — every production blob root is keyed, including the
      // historical shared `blobs/` root. A missing/locked KeyManager supplies a
      // null-returning provider so export fails closed at decrypt rather than
      // interpreting ciphertext as plaintext.
      const blobSources = includeBlobs
        ? buildExportBlobSources(
            dataPath,
            db,
            deps.getKeys?.()?.keyProvider('blob-store') ?? (() => null),
          )
        : undefined;

      let vaultBundleJson: string | undefined;
      try {
        const bundle = createBundleStore(db).load();
        if (bundle) vaultBundleJson = bundleToJSON(bundle);
      } catch { /* no bundle table — pre-D-081 compositions */ }
      const serverBundle = serverBundleStore.load();
      const serverVaultBundleJson = serverBundle
        ? serverBundleToJSON(serverBundle)
        : undefined;

      // Mint + embed a signed `migration_full` identity passport (the
      // default-on "include identity passport" toggle). Best-effort: the
      // passport is an attestation rider, so ANY failure resolving the
      // substrate or minting (an unavailable substrate on a db-less /
      // no-audit boot, a throwing getter, a sign error) downgrades to an
      // archive WITHOUT the passport rather than failing the whole backup.
      let passportJson: string | undefined;
      if (includePassport) {
        try {
          const px = deps.getPassportExport?.();
          if (px) {
            const signed = await exportServerPassport({
              providers: px.providers,
              serverIdentity: px.serverIdentity(),
              audit: px.audit,
              exported_by_client_id: ARCHIVE_PASSPORT_EXPORTED_BY,
              options: { profile: 'migration_full', reason: 'embedded in data archive export' },
            });
            passportJson = JSON.stringify(signed);
          }
        } catch (err) {
          console.error('[archive] passport mint failed — exporting without it', err);
        }
      }

      const res = await exportArchive({
        destPath,
        recoveryKey: key,
        db,
        configPath: configPath ?? undefined,
        vaultBundleJson,
        serverVaultBundleJson,
        ...(passportJson !== undefined ? { passportJson } : {}),
        ...(blobSources ? { blobSources } : {}),
        // The export rpc always writes a fresh, uniquely-stamped file, so
        // there is never a pre-existing target to guard against.
        force: true,
        producerVersion: serverVersion,
      });
      // Single-latest slot: the fresh archive evicts any prior export so the
      // GB-sized files never accumulate (the leak the in-memory-only prune
      // left behind). Eviction is age-bounded — it never deletes a file
      // newer than the one just written.
      evictOtherExports(dataPath, res.path);
      return {
        path: res.path,
        bytes_written: res.bytes_written,
        // The file is GC-eligible at write-time + TTL; the mtime-based
        // sweep uses the same window, so the reported expiry matches.
        expires_at: now() + EXPORT_TTL_MS,
      };
      } finally {
        // The recovery-key entropy copied into `key` opens every archive of
        // this realm; wipe our copy whether we returned or threw.
        key.fill(0);
      }
    },

    async readManifest(path, recoveryKey) {
      const key = deriveArchiveKeyBuffer(recoveryKey);
      // Stream-decrypt + verify (validates the recovery key + the whole
      // archive before any preview / the destructive import) WITHOUT
      // buffering the db or overlaying blobs: the db record streams to a
      // throwaway temp file we open read-only to count rows, blobs are
      // authenticated then discarded. Memory-flat preview.
      const tmp = previewDatabaseScratchPath(dataPath);
      try {
        const preview = await previewToTempDb(tmp, {
          archivePath: path,
          recoveryKey: key,
          consumerVersion: serverVersion,
          allowFutureVersion: true,
        });
        const previewDatabaseKey = preview.serverVaultBundle
          ? await deriveDatabaseKeyFromRecoveryEntropy(
              serverBundleFromJSON(preview.serverVaultBundle.toString('utf8')),
              key,
            )
          : null;
        try {
          return toWireManifest(
            preview.manifest,
            await countDbRowsAtPath(tmp, previewDatabaseKey),
            preview.passportPresent,
          );
        } finally {
          previewDatabaseKey?.fill(0);
        }
      } finally {
        for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
          try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
        }
        // Wipe the recovery-key entropy: it is the caller's, but this method
        // copied it into `key`, and leaving that copy in the heap is residual
        // exposure of the material that opens every archive of this realm.
        key.fill(0);
      }
    },

    async verifyRestoreRealm({ recoveryKey, currentRealmKey }) {
      // Does the ARCHIVE's key own the CURRENT realm? Asked of BOTH anchors —
      // see `classifyRealmOwnership`. Checking only the sentinel misread a
      // bundle-owned-but-sentinel-missing realm as `not_enrolled`, which both
      // BYPASSED current-realm proof for empty warehouses and BLOCKED the
      // owner's own valid key for non-empty ones.
      const ownership = await classifyRealmOwnership(recoveryKey);
      // `owns` (your own backup over your own enrolled realm) — always
      // authorized, same-realm.
      if (ownership === 'owns') {
        return { realm: 'same', authorized: true };
      }
      // M5 S3 — `unowned` (a fresh / pre-pair server) reads as same-realm,
      // but authorize the DESTRUCTIVE swap only when the warehouse is empty.
      //
      // This is DEFENSE-IN-DEPTH, not the primary protection. The footgun the
      // owner cared about — a wrong key sealing a bogus realm — is already
      // closed by validate-before-seal: the dry-run decrypts + validates the key
      // BEFORE any commit, and the realm seals only via the archive's own
      // sentinel at a successful commit. And the state this guard defends
      // against ("unenrolled server that already holds user data") is itself
      // ARCHITECTURALLY PREVENTED: every user-data write path — recipe.save,
      // recipe runs, collection enrollment, webhooks, warehouse sync — goes
      // through the SAME `server_not_enrolled` rpc gate (only the S3 restore
      // allowlist + `registerRecoveryKey` are exempt), so an unenrolled server
      // can only ever hold the deterministic boot seed. The `isLiveWarehouseEmpty`
      // denylist counts everything but that seed (+ config/identity + the restore
      // flow's own rows); it is a fail-closed backstop to the enrollment gate.
      // The known residual — `recipes`/`recipe_insights` are mixed boot+user
      // tables denylisted wholesale — is unreachable here precisely because their
      // user-write paths (recipe.save / runs) are themselves gated pre-enrollment
      // (owner-ratified: not worth seed-aware row counting for a prevented state).
      // A throw in the count fails closed.
      if (ownership === 'unowned') {
        let empty: boolean;
        try {
          empty = isLiveWarehouseEmpty(db);
        } catch {
          empty = false;
        }
        return empty
          ? { realm: 'same', authorized: true }
          : { realm: 'same', authorized: false, reason: 'target_not_empty' };
      }
      // `foreign` (a cross-realm archive): the destructive swap additionally
      // demands proof of CURRENT-realm ownership — the `currentRealmKey` must
      // itself own this realm, by the SAME two-anchor rule (not the sentinel
      // alone, which had the identical bundle-owned-but-sentinel-missing hole).
      const authorized =
        currentRealmKey !== undefined &&
        (await classifyRealmOwnership(currentRealmKey)) === 'owns';
      return authorized
        ? { realm: 'cross', authorized: true }
        : { realm: 'cross', authorized: false, reason: 'realm_mismatch' };
    },

    async runImport({ path, force, recoveryKey, drivingClient }) {
      const key = deriveArchiveKeyBuffer(recoveryKey);
      try {
      const targets: RestoreTargets = { dbPath, dataPath, configPath };
      const importOpts: ImportOptions = {
        archivePath: path,
        recoveryKey: key,
        consumerVersion: serverVersion,
        // The rpc's `force` maps to the schema/version compatibility
        // override (the live-server guard is N/A online — the drain owns
        // quiescing the engine before the swap).
        allowFutureVersion: force,
      };

      // ── Stage live (old db untouched): stream the archive's db to a UNIQUE
      // staging side file + overlay blobs, decrypting + verifying as we go. A
      // wrong key / tampered archive throws HERE (during the stream);
      // `stageRestore`/`streamRestoreInto` self-reclaims its partial staging
      // file on that failure, so the server just stays up (no restart, no
      // debris). Only the SMALL `staged` descriptor (config + counts, no db
      // bytes) is held across the drain.
      const staged: StagedRestore = await stageRestore(targets, importOpts);
      // From here on a staged db sits on disk and live CAS objects are parked
      // behind the overlay, so everything up to the response shares one unwind.
      // Opening the archive's own sidecar belongs inside it: a malformed bundle
      // or a key that does not open it throws exactly like an unreadable staged
      // db, and leaving either failure to escape strands the parked objects
      // under hashes the still-serving original db references.
      let stagedDatabaseKey: Uint8Array | null = null;
      let manifest: ArchiveManifest;
      try {
        stagedDatabaseKey = staged.serverVaultBundle
          ? await deriveDatabaseKeyFromRecoveryEntropy(
              serverBundleFromJSON(staged.serverVaultBundle.toString('utf8')),
              key,
            )
          : null;
        // Count from the staged file (already on disk — no second write).
        manifest = toWireManifest(
          staged.manifest,
          await countDbRowsAtPath(staged.stagingPath, stagedDatabaseKey),
          staged.passportPresent,
        );
      } catch (err) {
        // Remove THIS restore's staged file (by its exact path) and put the
        // displaced CAS objects back before aborting.
        stagedDatabaseKey?.fill(0);
        discardStagedRestore(staged.stagingPath, staged.displacedBlobs);
        throw err;
      }
      const restored_at = now();

      // M5 S2 — mint the import-driving client a fresh bearer into the staged
      // db so it reconnects after the restart WITHOUT re-pairing (the swap
      // wipes its old bearer). Runs BEFORE the response (returned below, ahead
      // of the drain) and BEFORE the swap renames the staged db. Best-effort:
      // `mintRebindIntoStagedDb` never throws — a failure just omits `rebind`
      // and the client re-pairs.
      let rebind: ArchiveImportRebind | undefined;
      try {
        rebind = drivingClient
          ? await mintRebindIntoStagedDb(staged.stagingPath, drivingClient, {
              databaseKey: stagedDatabaseKey,
            })
          : undefined;
      } finally {
        stagedDatabaseKey?.fill(0);
      }

      // ── Respond first (return below), THEN drain → swap → restart. The
      // drain closes the ws + db; the swap renames the staged db onto
      // dbPath; the supervisor respawns on the restored db. The swap runs
      // ONLY when the drain fully quiesced writers + closed the db
      // (`drainOk`) — committing over an un-quiesced / still-open db would
      // corrupt it, so on a timed-out/aborted drain we abandon the staged
      // restore and let the supervisor reboot on the ORIGINAL db.
      deps.requestRestart(async (drainOk) => {
        if (drainOk) {
          await commitStagedRestore(targets, staged, { now });
        } else {
          // Also puts back any live CAS object the staging overlay wrote over:
          // the ORIGINAL db keeps serving and still references those hashes, so
          // leaving the archive realm's ciphertext there would strand them.
          discardStagedRestore(staged.stagingPath, staged.displacedBlobs);
        }
      });

      return { manifest, restored_at, ...(rebind ? { rebind } : {}) };
      } finally {
        // Wipe our copy of the recovery-key entropy. The restart callback
        // registered above captures only `targets`/`staged`/`now` — never
        // `key` — so wiping it here (as we return, before that callback fires)
        // is safe, and `stageRestore` already consumed it during the stream.
        key.fill(0);
      }
    },
  };
};

export interface ComposeArchiveRpcDepsOptions {
  db: Database.Database | undefined;
  dbPath: string;
  configPath: string | null;
  serverVersion: string;
  auditLog?: AuditLogStore;
  lifecycle: Lifecycle | undefined;
  exit?: (code: number) => void;
  /** Late-bound passport-export substrate accessor — see
   *  `ArchiveRuntimeDeps.getPassportExport`. */
  getPassportExport?: () => PassportExportRpcDeps | undefined;
  /** Late-bound KeyManager accessor — see `ArchiveRuntimeDeps.getKeys`. */
  getKeys?: () => KeyManager | undefined;
  now?: () => number;
}

/** Assemble the `ArchiveRpcDeps` consumed by `makeArchiveHandlers`.
 *  Returns `undefined` (leaving the `server.archive.*` rpc absent) when
 *  the warehouse db or the lifecycle aren't available — e.g. a db-less
 *  harness or a server that never composed lifecycle. */
export const composeArchiveRpcDeps = (
  opts: ComposeArchiveRpcDepsOptions,
): ArchiveRpcDeps | undefined => {
  const { db, lifecycle } = opts;
  if (!db || !lifecycle) return undefined;

  const exit = opts.exit ?? ((code: number): never => process.exit(code));
  const dataPath = dirname(opts.dbPath);

  const runtime = createArchiveRuntime({
    db,
    dbPath: opts.dbPath,
    dataPath,
    configPath: opts.configPath,
    serverVersion: opts.serverVersion,
    now: opts.now,
    ...(opts.getKeys ? { getKeys: opts.getKeys } : {}),
    ...(opts.getPassportExport ? { getPassportExport: opts.getPassportExport } : {}),
    requestRestart: (onDrained) => {
      // Defer to the next tick so the rpc response frame + the handler's
      // completion audit flush BEFORE the drain starts tearing down the ws
      // + db. Mirrors the bootstrap `onRestartRequested` restart shape,
      // with the staged-restore commit/abandon inserted between the drain
      // and the supervisor handoff.
      setImmediate(() => {
        void lifecycle
          .requestDrain({ intent: 'restart', reason: 'archive_import' })
          .then(
            async (result) => {
              // Commit the swap ONLY after the complete production drain. A
              // timeout, thrown step, or missing/unwired step means some source
              // may still own the live DB, so fail closed and abandon staging.
              const drainOk =
                result.aborted.length === 0 &&
                DRAIN_STEP_NAMES.every((step) => result.completed.includes(step));
              await onDrained(drainOk);
              const code = lifecycle.supervisor.handoff('restart');
              exit(code);
            },
            // A drain that REJECTS is a drain that did not complete, so it takes
            // the same abandon path as `drainOk === false`. `onDrained` is the
            // only thing that puts back the CAS objects the staging overlay
            // displaced, and the supervisor is about to reboot on the ORIGINAL
            // db, which still references them — skipping it leaves that db
            // pointing at the archive realm's ciphertext. `requestDrain` has
            // rejected in practice: it writes the clean-shutdown marker around
            // the drain, and doing that after `close_db` threw on the closed
            // connection. This is `then`'s rejection handler rather than a
            // trailing `catch` so it sees only the drain's own failure, never
            // the commit's — `commitStagedRestore` unwinds itself and
            // deliberately preserves a staged db that boot still needs.
            async (err) => {
              console.error('[archive] restart drain failed — abandoning the staged restore', err);
              try {
                await onDrained(false);
              } catch (abandonErr) {
                console.error('[archive] staged-restore abandon failed', abandonErr);
              }
              exit(1);
            },
          )
          .catch((err) => {
            console.error('[archive] restart drain / commit failed', err);
            exit(1);
          });
      });
    },
  });

  // Boot-time TTL sweep — the file GC must not depend on a *future* export
  // (single-latest-slot eviction only fires when the next export lands). A
  // server that takes one backup then sits idle past `expires_at` would
  // otherwise keep that archive forever; this also reaps orphans from a
  // prior process lifetime (the in-memory job map is gone after a restart,
  // but the file persists). Self-hosted servers restart often enough
  // (updates, reboots) that boot + export-start sweeps honor the 7-day TTL
  // in practice. Best-effort — never block boot on it.
  try {
    pruneInterruptedExportPartials(dataPath);
    runtime.pruneExpiredExports();
  } catch (err) {
    console.error('[archive] boot-time export prune failed', err);
  }

  return {
    runtime,
    dataPath,
    now: opts.now,
    ...(opts.auditLog ? { auditLog: opts.auditLog } : {}),
  };
};
