/** Phase G (D-109) — `server.archive.*` rpc handler slice.
 *
 *  Three methods:
 *    - `server.archive.export`  → kick off an async export, return job_id
 *    - `server.archive.status`  → poll progress of an export job
 *    - `server.archive.import`  → drain + restore from a path on disk
 *
 *  Exports run asynchronously because a full warehouse dump can take
 *  tens of seconds; imports are "blocking" (the rpc resolves once the
 *  in-process restore completes + the server is back up). The
 *  paired extension polls status and shows the progress bar.
 *
 *  The handler wraps the existing `exportArchive` + `importArchive`
 *  helpers — it does NOT reimplement the crypto or the file format.
 *  That work lived on Phase F; Phase G only adds the ws-facing job
 *  lifecycle + activity log wiring. */

import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  RpcError,
  type ArchiveImportRebind,
  type ArchiveJobStatus,
  type ArchiveManifest,
  type ArchiveRealmRelation,
  type ArchiveSchemaCompat,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { isValidRecoveryKey } from '@recued/crypto';
import type { AuditLogStore } from '@recued/storage';
import { EXPORT_TTL_MS } from './export-store.js';
import { SCHEMA_VERSION } from './archive-format.js';
import { archiveSchemaTooNew } from './archive-import.js';
import type { ClientKind } from '../pairing/client-tokens.js';
import {
  resolveGatedClientInstanceId,
  resolveGatedClientOwnerId,
} from '../ws-client-identity.js';
import type { WsClient } from '../ws-server.js';

/** M5 S2 — the import-driving client's resolved identity, handed to
 *  `runImport` so it can mint that paired instance a fresh bearer INTO the
 *  restored db (the swap wipes its old one). Resolved from the authenticated
 *  `WsClient` in the handler so `runImport` carries no `WsClient` dependency. */
export interface ArchiveImportDrivingClient {
  /** Paired-instance id (`instance_id` ?? bearer-derived `token_instance_id`). */
  instance_id: string;
  /** Surface the client paired as — the new bearer + roster row inherit it. */
  client_kind: ClientKind;
  /** Optional client label, inherited onto the new bearer. */
  client_label?: string;
  /** Display name for the (re-inserted) roster row. */
  display_name: string;
  /** Owner id the roster row is scoped under (cloud `user_id` or `'self'`). */
  user_id: string;
}

/** Minimal shape the handler needs from the archive export machinery.
 *  Kept abstract so tests can inject a spy without bringing up the
 *  full server harness. */
export interface ArchiveRuntime {
  /** Synchronous pre-flight: does the server have the machinery
   *  (recovery key, db handle, blob store) to run an export right
   *  now? Returns a human reason when the answer is no; the handler
   *  rejects with `not_configured` so the ext can explain. */
  canExport(): { ok: boolean; reason?: string };
  /** Storage pre-flight. Estimates the export's peak disk footprint (temp
   *  db backup + WAL + archive + the REFERENCED blobs) and checks it against
   *  live OS free space (statfs). Resolves `ok`, or a refusal carrying the
   *  human-readable need/free so the handler rejects with
   *  `insufficient_storage` BEFORE starting a doomed job — never an ENOSPC
   *  mid-write. statfs-unsupported filesystems gate open. Async because
   *  sizing the referenced blobs reads per-hash sizes off the CAS. */
  preflightExport(opts: { includeBlobs: boolean }): Promise<
    | { ok: true }
    | { ok: false; reason: string; need_bytes: number; free_bytes: number }
  >;
  /** Delete export archives past the on-disk TTL (mtime-based). The
   *  handler piggybacks this on its job-record prune so the files never
   *  outlive their queryable job records. Returns the paths removed. */
  pruneExpiredExports(): { deleted: string[] };
  /** Actually run the export. `recoveryKey` is the user's mnemonic —
   *  the server derives the archive encryption key from it (it is never
   *  persisted). `includePassport` embeds a signed identity passport
   *  (`passport.json`) when the substrate is available. Resolves with the
   *  absolute path + byte count + the unix-ms the file becomes GC-eligible
   *  (`expires_at`). A fresh export evicts the prior one (single-latest
   *  slot). The caller populates the job map from this result. */
  runExport(opts: { includeBlobs: boolean; includePassport: boolean; recoveryKey: string }): Promise<{
    path: string;
    bytes_written: number;
    expires_at: number;
  }>;
  /** Read the manifest of an archive at `path` WITHOUT restoring.
   *  Decrypts with the recovery-key-derived key (so it also validates
   *  the key before any destructive import). */
  readManifest(path: string, recoveryKey: string): Promise<ArchiveManifest>;
  /** Q2 realm-ownership pre-check. Reports whether the archive's
   *  `recoveryKey` also owns the CURRENT server realm (`realm`), and
   *  whether the supplied keys authorize a destructive swap (`authorized`)
   *  — an enrolled-`match` realm is always authorized; `cross` realm requires
   *  a `currentRealmKey` that verifies against this realm. M5 S3 — a
   *  `not_enrolled` (fresh / pre-pair) realm reads as `same` but is authorized
   *  ONLY when the live warehouse holds no user data (`reason:
   *  'target_not_empty'` otherwise) — a backstop against a destructive restore
   *  clobbering an unenrolled-but-used server. Pure read (no archive
   *  decryption, no writes). */
  verifyRestoreRealm(opts: { recoveryKey: string; currentRealmKey?: string }): Promise<{
    realm: ArchiveRealmRelation;
    authorized: boolean;
    /** Set only when `authorized` is false, so the handler maps it to the
     *  right error: a foreign archive without current-realm proof
     *  (`realm_mismatch`) vs a fresh-but-non-empty target (`target_not_empty`). */
    reason?: 'realm_mismatch' | 'target_not_empty';
  }>;
  /** Trigger a restore. Returns the manifest + the restored_at unix-ms
   *  once the staged restore is committed; the server then restarts and
   *  the caller reconnects after respawn. `recoveryKey` is the user's
   *  mnemonic (derives the decryption key; never persisted).
   *
   *  M5 S2 — when `drivingClient` is supplied, the runtime mints that paired
   *  instance a FRESH bearer INTO the staged (restored) db and returns it as
   *  `rebind`, so the import-driving client reconnects after the restart
   *  without re-pairing (its old bearer rode in the now-discarded db). The
   *  mint is best-effort: a failure logs + drops `rebind` (the restore still
   *  commits; the client re-pairs) — it never fails the restore. */
  runImport(opts: {
    path: string;
    force: boolean;
    recoveryKey: string;
    drivingClient?: ArchiveImportDrivingClient;
  }): Promise<{
    manifest: ArchiveManifest;
    restored_at: number;
    rebind?: ArchiveImportRebind;
  }>;
}

export interface ArchiveRpcDeps {
  runtime: ArchiveRuntime;
  auditLog?: AuditLogStore;
  /** Server `data_path` — used purely for resolving relative
   *  user-supplied paths in `server.archive.import`. */
  dataPath: string;
  now?: () => number;
}

interface InternalJob {
  id: string;
  started_at: number;
  status: ArchiveJobStatus;
}

// Keep terminal job records as long as their export file lives on disk
// (the 7-day export TTL) — single-sourced from `export-store` so the
// queryable status never outlives, nor is outlived by, the file it points
// at. The prior 10-min window dropped the done-job (path + expires_at)
// while the GB file still sat on disk.
const JOB_RETENTION_MS = EXPORT_TTL_MS;

/** Validate the per-call recovery key (the user's 24-word mnemonic).
 *  Required on both export + import — the server holds only the Master DEK,
 *  never the raw recovery key, so the archive encryption key can only come
 *  from this transient arg. We validate the BIP39 shape HERE so a bad key
 *  fails the rpc synchronously with `bad_request` (400) rather than as a
 *  generic `internal` 500 from the runtime's derive — and so a doomed
 *  export job is never started. The runtime's derive stays as
 *  defense-in-depth for direct (non-rpc) callers. */
const requireRecoveryKey = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new RpcError('bad_request', 'recoveryKey is required', 400);
  }
  if (!isValidRecoveryKey(raw)) {
    throw new RpcError('bad_request', 'recoveryKey is not a valid 24-word recovery phrase', 400);
  }
  return raw;
};

export interface ArchiveHandler {
  slice: HandlerSlice<ServerRpcRegistry, ArchiveMethods, WsClient> | undefined;
  /** Snapshot of the in-memory job map — for tests + metrics. */
  getJob(id: string): ArchiveJobStatus | null;
  /** Manual GC for terminal jobs past the retention window (the
   *  handler schedules this internally; exposed for tests). */
  pruneExpired(): void;
}

export type ArchiveMethods =
  | 'server.archive.export'
  | 'server.archive.status'
  | 'server.archive.import';

export const makeArchiveHandlers = (
  deps: ArchiveRpcDeps | undefined,
): ArchiveHandler => {
  if (!deps) return { slice: undefined, getJob: () => null, pruneExpired: () => { /* no deps */ } };

  const jobs = new Map<string, InternalJob>();
  /** True while an import is running OR has succeeded and is awaiting its
   *  scheduled restart. The runtime's restore flow is serialized — concurrent
   *  imports corrupt the warehouse, and a SUCCESS stays latched across the
   *  fire-and-forget drain window (the process exit()s + respawns to reset it)
   *  so a second import can't overwrite the staging mid-restart. Cleared only
   *  on a FAILED import (no restart pending). */
  let importInFlight = false;
  /** True while an export job is running. Serialized so the single-latest
   *  slot stays unambiguous: overlapping exports would race on eviction (an
   *  earlier-requested long export finishing last could delete a
   *  later-requested export's file, stranding its `done` status on a missing
   *  archive). One export at a time sidesteps that entirely. */
  let exportInFlight = false;

  const now = deps.now ?? (() => Date.now());

  const pruneExpired = (): void => {
    const at = now();
    for (const [id, job] of jobs) {
      if (job.status.state === 'running') continue;
      // Anchor a done job's record lifetime to the SAME instant the file
      // GC uses — `expires_at` (completion + TTL), not `started_at`. A long
      // export whose `started_at` is well before completion would otherwise
      // have its record pruned ahead of the file (and its advertised
      // `expires_at`), 404-ing `status` while the archive is still on disk.
      // Error jobs carry no file/expiry → fall back to start-anchored TTL.
      const expiry =
        job.status.state === 'done' && job.status.expires_at !== undefined
          ? job.status.expires_at
          : job.started_at + JOB_RETENTION_MS;
      if (expiry < at) jobs.delete(id);
    }
    // Sweep export files past the same TTL. Runs on the export-start
    // cadence (single-latest-slot eviction is the primary cleanup; this
    // backstops a last export never replaced + orphans from a prior
    // process lifetime).
    deps.runtime.pruneExpiredExports();
  };

  const startExport = async (
    includeBlobs: boolean,
    includePassport: boolean,
    recoveryKey: string,
  ): Promise<string> => {
    const preflight = deps.runtime.canExport();
    if (!preflight.ok) {
      throw new RpcError('not_configured', preflight.reason ?? 'archive export unavailable', 503);
    }
    // Reject overlapping exports up front (cheapest gate) — keeps the
    // single-latest slot race-free (see `exportInFlight`).
    if (exportInFlight) {
      throw new RpcError(
        'archive_export_in_progress',
        'an archive export is already running — wait for it to finish',
        409,
      );
    }
    // CLAIM the latch synchronously, BEFORE the first await below — the
    // storage pre-flight is async, so a second concurrent rpc would
    // otherwise slip past the in-flight check during that await and start an
    // overlapping export (defeating the single-slot guarantee). `dispatched`
    // tracks whether we handed ownership of the latch to the background
    // export's `finally`; if we bail before that (preflight refusal, etc.)
    // the outer `finally` releases it so a failure never wedges all exports.
    exportInFlight = true;
    let dispatched = false;
    try {
      // Prune FIRST: a TTL-expired export sitting on disk is exactly the kind
      // of dead weight the storage pre-flight should not count against us, so
      // free it (file sweep + in-memory job-record GC) before estimating need
      // vs free. Otherwise a stale archive could permanently wedge new exports.
      pruneExpired();
      // Storage pre-flight BEFORE the job is created — a doomed export (would
      // ENOSPC mid-write) is refused up front, never started.
      const storage = await deps.runtime.preflightExport({ includeBlobs });
      if (!storage.ok) {
        throw new RpcError(
          'insufficient_storage',
          `not enough disk space to export: ${storage.reason}`,
          507,
        );
      }
      const job_id = `arx-${randomUUID().slice(0, 12)}`;
      const job: InternalJob = {
        id: job_id,
        started_at: now(),
        status: { state: 'running', bytes_written: 0, progress_pct: 0 },
      };
      jobs.set(job_id, job);

      await deps.auditLog?.logActivity({
        activity_id: '',
        timestamp: now(),
        action: 'archive_export_start',
        target: job_id,
        detail: `include_blobs=${includeBlobs} include_passport=${includePassport}`,
      }).catch(() => { /* best-effort */ });

      // Run asynchronously — the rpc returns the job_id immediately. The
      // `exportInFlight` latch is released when the export settles (either
      // outcome) so the next export can proceed.
      void (async () => {
        try {
          const res = await deps.runtime.runExport({ includeBlobs, includePassport, recoveryKey });
          job.status = {
            state: 'done',
            bytes_written: res.bytes_written,
            progress_pct: 100,
            path: res.path,
            expires_at: res.expires_at,
          };
          await deps.auditLog?.logActivity({
            activity_id: '',
            timestamp: now(),
            action: 'archive_export_complete',
            target: job_id,
            detail: `path=${res.path} bytes=${res.bytes_written}`,
          }).catch(() => { /* best-effort */ });
        } catch (err) {
          job.status = {
            state: 'error',
            bytes_written: job.status.bytes_written,
            progress_pct: job.status.progress_pct,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          exportInFlight = false;
        }
      })();
      // The background export now owns the latch (released in its `finally`).
      dispatched = true;
      return job_id;
    } finally {
      // Released here ONLY when we bailed before handing off to the export
      // (preflight refusal / audit-or-job setup throw) — so a failed start
      // never leaves the latch stuck closed.
      if (!dispatched) exportInFlight = false;
    }
  };

  const handleExport = async (
    args: { include_blobs?: unknown; include_passport?: unknown; recoveryKey?: unknown },
  ): Promise<{ job_id: string }> => {
    const recoveryKey = requireRecoveryKey(args.recoveryKey);
    // Both toggles default ON — only an explicit `false` opts out.
    const include_blobs = args.include_blobs === false ? false : true;
    const include_passport = args.include_passport === false ? false : true;
    const job_id = await startExport(include_blobs, include_passport, recoveryKey);
    return { job_id };
  };

  const handleStatus = async (
    args: { job_id?: unknown },
  ): Promise<ArchiveJobStatus> => {
    if (typeof args.job_id !== 'string' || args.job_id.length === 0) {
      throw new RpcError('bad_request', 'job_id is required', 400);
    }
    const job = jobs.get(args.job_id);
    if (!job) {
      throw new RpcError('archive_job_unknown', `no archive job '${args.job_id}'`, 404);
    }
    // Truthful + self-enforcing status for a `done` export:
    //   (a) Past its advertised `expires_at` → it's GC-due. An idle server
    //       that never re-exports / restarts won't have run a sweep, so
    //       enforce the TTL right here: unlink the file + drop the record +
    //       404. The client never gets a path past the advertised GC time,
    //       and the file doesn't linger past expiry once status is polled.
    //   (b) Otherwise, the file must still exist — eviction (a newer
    //       export), the mtime sweep, a manual delete, or a restart can
    //       retire it out from under a lingering record. Never hand back a
    //       `path` that was unlinked: drop the record + 404.
    if (job.status.state === 'done') {
      const expired =
        job.status.expires_at !== undefined && now() >= job.status.expires_at;
      if (expired && job.status.path) {
        try { unlinkSync(job.status.path); } catch { /* already gone */ }
      }
      if (expired || (job.status.path && !existsSync(job.status.path))) {
        jobs.delete(args.job_id);
        throw new RpcError(
          'archive_job_unknown',
          `archive job '${args.job_id}' is no longer available`,
          404,
        );
      }
    }
    return job.status;
  };

  const resolveImportPath = (raw: string): string => {
    // An absolute path is the owner's explicit escape hatch — `import` is
    // owner-only (a paired-client WS rpc; it does not reach MCP / doors), so a
    // self-hosting owner naming a backup file anywhere on their own box is
    // by-design. Relative paths are the normal upload flow (archives land under
    // `{data_path}/exports/`) and MUST stay confined there.
    //
    // ⛔ `isAbsolute`, not `startsWith('/')`. D-212 ships Windows keyfile
    // support, so the server runs on Windows — where an absolute backup path is
    // `C:\…`, `C:/…` or a `\\host\share` UNC, none of which start with `/`. The
    // old prefix test read those as RELATIVE and confined/rejected the owner's
    // own absolute path. `path.isAbsolute` uses the running platform's rules
    // (which is exactly the box resolving the path), so `/…` still works on
    // POSIX and the Windows forms work on Windows.
    if (isAbsolute(raw)) return raw;
    // ⛔ CONFINE, don't just `join`. `join(dataPath,'exports','../../etc/x')`
    // normalises straight out of the exports dir — so the traversal-safety this
    // comment used to CLAIM was never enforced, turning a relative name into an
    // arbitrary-path existence probe (the pre-validation `stat` below is the
    // oracle). Resolve, then require the result to be inside the exports root;
    // `${root}${sep}` (not a bare prefix) stops the `exports-evil` sibling.
    const exportsRoot = resolve(deps.dataPath, 'exports');
    const resolved = resolve(exportsRoot, raw);
    if (resolved !== exportsRoot && !resolved.startsWith(`${exportsRoot}${sep}`)) {
      throw new RpcError(
        'bad_request',
        'relative archive path must stay within the exports directory',
        400,
      );
    }
    return resolved;
  };

  const handleImport = async (
    args: {
      path?: unknown;
      force?: unknown;
      dry_run?: unknown;
      recoveryKey?: unknown;
      currentRealmKey?: unknown;
    },
    ctx: WsClient,
  ): Promise<{
    manifest: ArchiveManifest;
    restored_at: number | null;
    realm: ArchiveRealmRelation;
    rebind?: ArchiveImportRebind;
    schema_compat?: ArchiveSchemaCompat;
  }> => {
    if (typeof args.path !== 'string' || args.path.length === 0) {
      throw new RpcError('bad_request', 'path is required', 400);
    }
    const recoveryKey = requireRecoveryKey(args.recoveryKey);
    // Validate the optional current-realm key's BIP39 shape iff supplied —
    // it only matters for the cross-realm commit branch.
    const currentRealmKey =
      args.currentRealmKey !== undefined ? requireRecoveryKey(args.currentRealmKey) : undefined;
    const force = args.force === true;
    const dry_run = args.dry_run === true;
    const resolvedPath = resolveImportPath(args.path);

    // Cheap existence check so we return a clear error before the
    // heavier import machinery spins up.
    try { await stat(resolvedPath); }
    catch { throw new RpcError('not_found', `archive at '${resolvedPath}' does not exist`, 404); }

    if (dry_run) {
      // Decrypt + read the manifest (validates the archive key), then report
      // the realm relation so the ext can branch the confirm UI (cross-realm
      // → ask for the current-realm key + the strong arm-confirm).
      const manifest = await deps.runtime.readManifest(resolvedPath, recoveryKey);
      const { realm } = await deps.runtime.verifyRestoreRealm({ recoveryKey });
      // M5 S3.0 — surface db-schema compatibility so the UI can warn + block
      // confirm BEFORE the destructive commit when the backup needs a newer
      // server (the commit independently refuses it unless `force`).
      const schema_compat: ArchiveSchemaCompat = {
        status: archiveSchemaTooNew(manifest.schema_version) ? 'archive_too_new' : 'ok',
        server_schema_version: SCHEMA_VERSION,
      };
      return { manifest, restored_at: null, realm, schema_compat };
    }

    // Q2 ownership gate — prove CURRENT-realm ownership BEFORE the
    // destructive swap, not merely that the archive decrypts. M5 S3 adds the
    // fresh-but-non-empty target gate (`target_not_empty`).
    const { realm, authorized, reason } = await deps.runtime.verifyRestoreRealm({
      recoveryKey,
      currentRealmKey,
    });
    if (!authorized) {
      if (reason === 'target_not_empty') {
        throw new RpcError(
          'archive_restore_target_not_empty',
          'this server already holds data — a destructive restore onto a ' +
            'not-yet-enrolled server is only allowed when it is empty; enroll a ' +
            'recovery key and restore through Settings instead',
          409,
        );
      }
      throw new RpcError(
        'archive_realm_mismatch',
        'this archive belongs to a different identity — restoring it over this ' +
          "server requires THIS server's recovery key to authorize the replacement",
        403,
      );
    }

    // ⛔ A CROSS-REALM restore must run OFFLINE. The online path stages while the
    // server keeps serving: it overlays the archive's blobs into the LIVE CAS,
    // re-encrypted under the RESTORED realm's key, BEFORE the drain quiesces the
    // engine. For a FOREIGN realm (a different blob key) that overwrites the
    // canonical objects the running server still references, so its live reads
    // of any overlapping hash fail (`aead: decryption failed`) for the whole
    // staging window — a mid-restore corruption of a server that is still up.
    // Same-realm restore is safe (same key ⇒ the re-encryption stays readable),
    // so only the cross-realm case is refused. The offline `archive import` runs
    // on a STOPPED server, where there are no live reads to break.
    if (realm === 'cross') {
      throw new RpcError(
        'archive_cross_realm_needs_offline',
        "restoring a DIFFERENT realm's backup over a running server would corrupt " +
          'its live blob reads mid-restore. Stop the server and run ' +
          '`recued archive import <path>` instead.',
        409,
      );
    }

    if (importInFlight) {
      throw new RpcError(
        'archive_import_in_progress',
        'a prior archive import is still running — wait for it to finish',
        409,
      );
    }
    importInFlight = true;
    await deps.auditLog?.logActivity({
      activity_id: '',
      timestamp: now(),
      action: 'archive_import_start',
      target: resolvedPath,
      detail: [force ? 'force=true' : undefined, `realm=${realm}`]
        .filter(Boolean)
        .join(' '),
    }).catch(() => { /* best-effort */ });

    // M5 S2 — resolve the import-driving client's paired identity so the
    // runtime can mint it a fresh bearer into the restored db (its old bearer
    // rode in the swapped-out db). Only when the caller is a verified paired
    // client (instance + kind + owner all present); else no handoff → the
    // client re-pairs. `import` is owner-only, so this is normally present.
    const drivingInstanceId = resolveGatedClientInstanceId(ctx);
    const drivingOwnerId = resolveGatedClientOwnerId(ctx);
    const drivingClient: ArchiveImportDrivingClient | undefined =
      drivingInstanceId && ctx.client_kind && drivingOwnerId
        ? {
            instance_id: drivingInstanceId,
            client_kind: ctx.client_kind,
            ...(ctx.client_label !== undefined ? { client_label: ctx.client_label } : {}),
            display_name: ctx.display_name,
            user_id: drivingOwnerId,
          }
        : undefined;

    try {
      const { manifest, restored_at, rebind } = await deps.runtime.runImport({
        path: resolvedPath,
        force,
        recoveryKey,
        ...(drivingClient ? { drivingClient } : {}),
      });
      await deps.auditLog?.logActivity({
        activity_id: '',
        timestamp: now(),
        action: 'archive_import_complete',
        target: resolvedPath,
        detail: `records=${manifest.record_count} realm=${realm}`,
      }).catch(() => { /* best-effort */ });
      // SUCCESS keeps `importInFlight` LATCHED — do NOT clear it. A successful
      // import has scheduled the restart drain (fire-and-forget); the staged db
      // is not committed until that drain's callback runs, and the process
      // ALWAYS exit()s at the end of it (→ the supervisor respawns a fresh
      // handler with `importInFlight=false`). Clearing the latch here would
      // re-open the window where a second import slips in and overwrites the
      // staging file before the first commits — the wrong-db-commit race.
      return { manifest, restored_at, realm, ...(rebind ? { rebind } : {}) };
    } catch (err) {
      // FAILURE releases the latch so the user can retry. `runImport` only
      // throws from the staging phase, BEFORE it schedules any restart, so no
      // drain is pending — the server stays up and the latch must reopen.
      importInFlight = false;
      // M5 S3.0 — a newer-schema archive onto this (older) binary is refused at
      // the staging stream (checkManifestCompat); map it to an actionable wire
      // error so the client can tell the user to upgrade the server first. (The
      // dry-run already surfaces this via `schema_compat`; this is the
      // server-enforced backstop if a client commits anyway.)
      if (err instanceof Error && /ARCHIVE_SCHEMA_TOO_NEW/.test(err.message)) {
        throw new RpcError('archive_schema_too_new', err.message, 409);
      }
      throw err;
    }
  };

  const slice: HandlerSlice<ServerRpcRegistry, ArchiveMethods, WsClient> = {
    methods: ['server.archive.export', 'server.archive.status', 'server.archive.import'],
    handlers: {
      'server.archive.export': async (args) =>
        handleExport(args as Parameters<typeof handleExport>[0]),
      'server.archive.status': async (args) =>
        handleStatus(args as Parameters<typeof handleStatus>[0]),
      'server.archive.import': async (args, ctx) =>
        handleImport(args as Parameters<typeof handleImport>[0], ctx),
    },
  };

  return {
    slice,
    getJob(id) {
      return jobs.get(id)?.status ?? null;
    },
    pruneExpired,
  };
};
