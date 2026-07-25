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

import { existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { recoveryKeyToEntropy, bundleToJSON } from '@recued/crypto';
import type { ArchiveImportRebind, ArchiveManifest } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createPairedInstancesStore } from '../paired-instances-store.js';
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
  /** Live warehouse db handle. Export reads blob refs + the vault bundle
   *  from it; import never touches it (it stages beside + swaps at the
   *  restart boundary). */
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
  /** Late-bound accessor for the live server KeyManager (`app.keys`). Blob-
   *  encryption fix Phase 2: export needs it to open the ENCRYPTED `cache_blobs`
   *  (+ later `memory_blobs`) root and decrypt each blob to plaintext under
   *  `keyProvider('blob-store')`. A getter (not a value) because the archive
   *  runtime is composed BEFORE the app/KeyManager exists in the boot order —
   *  it is resolved at export time, mirroring `getPassportExport`. Returns
   *  undefined on a keyless server (no vault) — those roots are plaintext, so
   *  export reads them keyless; a locked vault's provider returns null and the
   *  encrypted-blob read throws (can't export encrypted blobs while sealed). */
  getKeys?: () => KeyManager | undefined;
  /** Clock — injected for deterministic tests. */
  now?: () => number;
}

/** Derive the 32-byte archive key from a 24-word mnemonic. Throws (with a
 *  `@recued/crypto` message) on an invalid mnemonic; the handler maps that
 *  to a `bad_request`. */
const deriveArchiveKeyBuffer = (mnemonic: string): Buffer =>
  Buffer.from(recoveryKeyToEntropy(mnemonic));

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
  options: { argon2_params?: { t: number; m: number; p: number } } = {},
): Promise<ArchiveImportRebind | undefined> => {
  let stagedDb: Database.Database | undefined;
  try {
    stagedDb = new Database(stagingPath);
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

export const createArchiveRuntime = (deps: ArchiveRuntimeDeps): ArchiveRuntime => {
  const now = deps.now ?? (() => Date.now());
  const { db, dbPath, dataPath, configPath, serverVersion } = deps;

  // The CURRENT realm's recovery-key check lives in `server_config` inside
  // this live db — read it to gate cross-realm restores (Q2). Reads are
  // live per call, so it always reflects the realm in force right now
  // (before any swap).
  const recoveryStore = createRecoveryKeyCheckStore(db);

  /** Open a SQLite db file read-only and count rows per table. Used to
   *  fill the wire manifest's `record_count` / `tables` (the on-disk
   *  manifest carries neither). */
  const countDbRowsAtPath = (
    path: string,
  ): { record_count: number; tables: Record<string, number> } => {
    const probe = new Database(path, { readonly: true });
    try {
      const tableRows = probe
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>;
      const tables: Record<string, number> = {};
      let total = 0;
      for (const { name } of tableRows) {
        try {
          const row = probe.prepare(`SELECT COUNT(*) AS n FROM ${quoteSqliteIdent(name)}`).get() as { n: number };
          tables[name] = row.n;
          total += row.n;
        } catch { /* unreadable table — skip */ }
      }
      return { record_count: total, tables };
    } finally {
      try { probe.close(); } catch { /* best effort */ }
    }
  };

  /** Map the on-disk manifest + counted db rows onto the wire shape.
   *  `hasPassport` comes from whether the decoded records carried a
   *  `passport.json` (the on-disk manifest doesn't track it). */
  const toWireManifest = (
    onDisk: OnDiskArchiveManifest,
    counts: { record_count: number; tables: Record<string, number> },
    hasPassport: boolean,
  ): ArchiveManifest => ({
    format_version: onDisk.archive_format_version,
    schema_version: onDisk.schema_version,
    exported_at: new Date(onDisk.created_at).toISOString(),
    record_count: counts.record_count,
    tables: counts.tables,
    includes_blobs: onDisk.blob_count > 0,
    includes_passport: hasPassport,
  });

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
      // pointed pages live in `${dbPath}-wal` and `db.backup()` copies them
      // into the temp db + the archive. Count the WAL so a large unflushed
      // write-set doesn't slip past the estimate into a mid-export ENOSPC.
      try {
        dbBytes += statSync(`${dbPath}-wal`).size;
      } catch {
        /* no WAL sidecar (checkpointed / non-WAL) — nothing to add */
      }
      // Size ONLY the blobs the export bundles (the SAME posture-split sources
      // `runExport` builds), not the whole CAS tree — orphaned objects already
      // reduce free space, so counting them too would double-charge. The
      // archive carries PLAINTEXT, so budget the plaintext size (encrypted
      // sources ≈ on-disk minus the small AEAD envelope). No decrypt here.
      let blobBytes = 0;
      // An ENCRYPTED source decrypts each blob to a transient scratch file (one
      // at a time, in the archive's dir) before streaming it in, so the peak
      // disk during export exceeds the final archive by the LARGEST single
      // encrypted blob's plaintext. Budget that too, or preflight can green-
      // light an export that then ENOSPC-fails mid-scratch (fails cleanly, but
      // pointlessly). Keyless sources stream with no scratch.
      let maxScratchBytes = 0;
      if (includeBlobs) {
        for (const source of buildExportBlobSources(dataPath, db, deps.getKeys?.()?.keyProvider('blob-store'))) {
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
      const destPath = newExportPath(dataPath, now());
      // Blob-encryption fix Phase 2 — posture-split blob sources. The live
      // KeyManager's `keyProvider('blob-store')` opens the ENCRYPTED cache_blobs
      // root so its bodies decrypt to plaintext on export; on a keyless server
      // there are no keys and the same root is plaintext + reads keyless.
      const blobSources = includeBlobs
        ? buildExportBlobSources(dataPath, db, deps.getKeys?.()?.keyProvider('blob-store'))
        : undefined;

      let vaultBundleJson: string | undefined;
      try {
        const bundle = createBundleStore(db).load();
        if (bundle) vaultBundleJson = bundleToJSON(bundle);
      } catch { /* no bundle table — pre-D-081 compositions */ }

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
    },

    async readManifest(path, recoveryKey) {
      const key = deriveArchiveKeyBuffer(recoveryKey);
      // Stream-decrypt + verify (validates the recovery key + the whole
      // archive before any preview / the destructive import) WITHOUT
      // buffering the db or overlaying blobs: the db record streams to a
      // throwaway temp file we open read-only to count rows, blobs are
      // authenticated then discarded. Memory-flat preview.
      const tmp = join(dataPath, `.archive-count-${randomBytes(8).toString('hex')}.sqlite`);
      try {
        const preview = await previewToTempDb(tmp, {
          archivePath: path,
          recoveryKey: key,
          consumerVersion: serverVersion,
          allowFutureVersion: true,
        });
        return toWireManifest(
          preview.manifest,
          countDbRowsAtPath(tmp),
          preview.passportPresent,
        );
      } finally {
        for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
          try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
        }
      }
    },

    async verifyRestoreRealm({ recoveryKey, currentRealmKey }) {
      // Does the ARCHIVE's key also own the CURRENT realm?
      const archiveKeyRealm = await verifyRecoveryKeyAgainstRealm(recoveryStore, recoveryKey);
      // `match` (your own backup over your own enrolled realm) — always
      // authorized, same-realm.
      if (archiveKeyRealm === 'match') {
        return { realm: 'same', authorized: true };
      }
      // M5 S3 — `not_enrolled` (a fresh / pre-pair server) reads as same-realm,
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
      if (archiveKeyRealm === 'not_enrolled') {
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
      // Cross-realm (foreign archive): the destructive swap additionally
      // demands proof of CURRENT-realm ownership — the `currentRealmKey` must
      // itself verify against this server's stored check.
      const authorized =
        currentRealmKey !== undefined &&
        (await verifyRecoveryKeyAgainstRealm(recoveryStore, currentRealmKey)) === 'match';
      return authorized
        ? { realm: 'cross', authorized: true }
        : { realm: 'cross', authorized: false, reason: 'realm_mismatch' };
    },

    async runImport({ path, force, recoveryKey, drivingClient }) {
      const key = deriveArchiveKeyBuffer(recoveryKey);
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
      let manifest: ArchiveManifest;
      try {
        // Count from the staged file (already on disk — no second write).
        manifest = toWireManifest(
          staged.manifest,
          countDbRowsAtPath(staged.stagingPath),
          staged.passportPresent,
        );
      } catch (err) {
        // Staging succeeded but the row-count threw — remove THIS restore's
        // staged file (by its exact path) before aborting.
        discardStagedRestore(staged.stagingPath);
        throw err;
      }
      const restored_at = now();

      // M5 S2 — mint the import-driving client a fresh bearer into the staged
      // db so it reconnects after the restart WITHOUT re-pairing (the swap
      // wipes its old bearer). Runs BEFORE the response (returned below, ahead
      // of the drain) and BEFORE the swap renames the staged db. Best-effort:
      // `mintRebindIntoStagedDb` never throws — a failure just omits `rebind`
      // and the client re-pairs.
      const rebind = drivingClient
        ? await mintRebindIntoStagedDb(staged.stagingPath, drivingClient)
        : undefined;

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
          discardStagedRestore(staged.stagingPath);
        }
      });

      return { manifest, restored_at, ...(rebind ? { rebind } : {}) };
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
          .then(async (result) => {
            // Commit the swap ONLY if the drain genuinely quiesced writers
            // (`await_inflight` didn't time out) AND closed the db
            // (`close_db` completed). Otherwise the runtime abandons the
            // staged restore and the supervisor reboots on the original db.
            const drainOk =
              result.completed.includes('close_db') &&
              !result.aborted.includes('close_db') &&
              !result.aborted.includes('await_inflight');
            await onDrained(drainOk);
            const code = lifecycle.supervisor.handoff('restart');
            exit(code);
          })
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
