/** Owner-triggered delivery, durable evidence, and receipt-scoped retention.
 * The same archive bytes feed remote delivery and ordinary restore preview.
 * Reconnect/startup never starts a fresh export or reuses recovery words. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, unlinkSync, utimesSync } from 'node:fs';
import { chmod, copyFile, link, rename, statfs, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import type Database from 'better-sqlite3';
import { RpcError, type ArchiveJobStatus, type ArchiveRemoteBackup, type ArchiveRemoteDestination,
  type ArchiveRemoteIssue, type ArchiveRemoteTarget, type ConnectionRow } from '@recued/contracts';
import { createConnectionStore } from '../storage/connection-store.js';
import { decodeAuthFromStorage } from '../connection-auth-storage.js';
import type { KeyManager } from '../key-manager.js';
import type { S3ClientConfig } from '../collections/file/adapters/s3/client.js';
import { fsyncDir } from '../durable-fs.js';
import { archiveImportOperationId } from './archive-import-receipts.js';
import { archiveStagingName, isGeneratedExportName } from './export-store.js';
import { createRemoteBackupStore, remoteBackupObjectKey, remoteBackupScratchPath, remoteBackupView, type RemoteBackupRow } from './remote-backup-store.js';
import { createS3RemoteBackupTransport, hashRemoteBackupFile, RemoteBackupTransferError,
  type RemoteBackupTransport, type RemoteArchiveBytes } from './remote-backup-s3.js';

export interface ResolvedBackupDestination {
  destination: ArchiveRemoteDestination;
  fingerprint: string;
  transport: RemoteBackupTransport;
}
const rowBytes = (row: RemoteBackupRow): RemoteArchiveBytes => {
  if (row.bytes === undefined || row.sha256 === undefined) throw new RpcError('conflict', 'This backup has no exported bytes to check. Start a new backup.');
  return { bytes: row.bytes, sha256: row.sha256 };
};
const issueOf = (error: unknown): ArchiveRemoteIssue => error instanceof RemoteBackupTransferError ? error.kind : 'transfer_unconfirmed';
export const createRemoteBackups = (options: {
  dbPath: string;
  destinations(): ArchiveRemoteDestination[];
  describe(name: string): { destination: ArchiveRemoteDestination; fingerprint: string };
  resolve(name: string): Promise<ResolvedBackupDestination>;
  now?: () => number;
}) => {
  const dbPath = resolve(options.dbPath), dataPath = dirname(dbPath), scratch = remoteBackupScratchPath(dbPath);
  const now = options.now ?? Date.now, store = createRemoteBackupStore(dbPath, { now });
  const running = new Set<string>(), fetching = new Map<string, Promise<{ staged_name: string }>>();
  // A history I/O failure is visible to new backup/status calls, but must not
  // prevent a healthy warehouse from booting or other settings from opening.
  try { store.reconcileBoot(); } catch { /* calls fail closed when they read it */ }
  try { if (existsSync(scratch)) {
    // Only exact operation-owned archive names. No provider call or resend.
    for (const name of readdirSync(scratch)) if (/^[0-9a-f-]{36}\.recued\.archive$/u.test(name) && archiveImportOperationId(name.slice(0, 36))) {
      try { unlinkSync(join(scratch, name)); } catch { /* reclaim again at the next start */ }
    }
  } } catch { /* unreadable transfer scratch must not prevent warehouse boot */ }
  const exportsDir = join(dataPath, 'exports');
  try { if (existsSync(exportsDir)) for (const name of readdirSync(exportsDir)) {
    if (!/^\.recued-upload-[0-9a-f]{32}\.recued\.archive\.[0-9a-f-]{36}\.partial$/u.test(name)) continue;
    try { unlinkSync(join(exportsDir, name)); } catch { /* interrupted, owned ciphertext retrieval */ }
  } } catch { /* ordinary exports and restore stay available */ }
  const requireRow = (id: string): RemoteBackupRow => {
    const normalized = archiveImportOperationId(id);
    if (!normalized) throw new RpcError('invalid_args', 'operation_id must be a UUID', 400);
    const row = store.get(normalized); if (!row) throw new RpcError('not_found', 'No saved remote backup has this identifier.', 404); return row;
  };
  const resolveRow = async (row: RemoteBackupRow): Promise<ResolvedBackupDestination> => {
    let resolved: ResolvedBackupDestination;
    try { resolved = await options.resolve(row.destination.connection_name); }
    catch { throw new RemoteBackupTransferError('destination_unavailable'); }
    if (resolved.fingerprint !== row.destination_fingerprint) throw new RemoteBackupTransferError('destination_unavailable');
    return resolved;
  };
  const abortParts = async (row: RemoteBackupRow, transport: RemoteBackupTransport): Promise<void> => {
    if (!row.multipart_id) return;
    await transport.abort(row.object_key, row.multipart_id);
    store.update(row.operation_id, current => { delete current.multipart_id; });
  };
  const prune = async (verified: RemoteBackupRow, transport: RemoteBackupTransport): Promise<void> => {
    const group = store.rows().filter(row => row.destination_fingerprint === verified.destination_fingerprint);
    // Reservation order survives clock changes. A delayed check of an older
    // backup cannot reinstate its old retention setting or delete newer ones.
    const good = group.filter(row => row.state === 'verified').reverse();
    const policy = group.filter(row => row.verified_at !== undefined).at(-1);
    // Retention needs fresh evidence for its retained copy, not merely an old
    // receipt for some newer object that may no longer exist remotely.
    if (!policy || policy.state !== 'verified' || policy.operation_id !== verified.operation_id) return;
    const victims = [...good.slice(policy.keep_last), ...group.filter(row => row.state === 'pruning')];
    let pending = false;
    for (const row of victims) {
      // Verification and cleanup yield to other owner checks/exports. A newer
      // verified policy may now retain a remaining victim from this snapshot.
      const latest = store.rows().filter(current => current.destination_fingerprint === verified.destination_fingerprint && current.verified_at !== undefined).at(-1);
      if (latest?.operation_id !== verified.operation_id || latest.state !== 'verified') return;
      if (running.has(row.operation_id) || fetching.has(row.operation_id)) { pending = true; continue; }
      try {
        if (!row.etag) { pending = true; continue; }
        store.update(row.operation_id, current => { current.state = 'pruning'; });
        await transport.remove(row.object_key, row);
        store.update(row.operation_id, current => { current.state = 'pruned'; delete current.issue; });
      } catch { pending = true; }
    }
    store.update(policy.operation_id, row => { if (pending) row.retention_pending = true; else delete row.retention_pending; });
  };
  const verified = async (row: RemoteBackupRow, transport: RemoteBackupTransport): Promise<void> => {
    const identity = await transport.verify(row.object_key, rowBytes(row), row);
    const settled = store.update(row.operation_id, current => {
      current.state = 'verified'; current.verified_at = now(); delete current.issue;
      if (identity.etag !== undefined) current.etag = identity.etag;
      if (identity.version_id !== undefined) current.version_id = identity.version_id;
    });
    // Failure to remove old copies cannot turn a verified new copy into an
    // unverified one. Keep the separate cleanup result and exact victim intent.
    try { await prune(settled, transport); }
    catch { try { store.update(row.operation_id, current => { current.retention_pending = true; }); } catch { /* retain durable verdict */ } }
  };
  const service = {
    destinations: options.destinations,
    list(): ArchiveRemoteBackup[] { return store.rows().slice(-100).reverse().map(remoteBackupView); },
    reserve(target: ArchiveRemoteTarget, jobId: string): void {
      const id = archiveImportOperationId(target?.operation_id);
      if (!id || typeof target.connection_name !== 'string' || typeof target.destination_id !== 'string'
        || !/^[0-9a-f]{64}$/u.test(target.destination_id) || !Number.isInteger(target.keep_last) || target.keep_last < 1 || target.keep_last > 30) {
        throw new RpcError('invalid_args', 'Choose a storage connection, a new operation identifier, and between 1 and 30 backups to keep.', 400);
      }
      let description: ReturnType<typeof options.describe>;
      try { description = options.describe(target.connection_name); }
      catch { throw new RpcError('not_configured', 'The selected S3 backup destination is unavailable. Check its connection.', 409); }
      if (description.fingerprint !== target.destination_id) throw new RpcError('conflict', 'The selected backup destination changed. Refresh the storage choices before starting again.', 409);
      try { store.reserve({ operation_id: id, job_id: jobId, destination: description.destination,
        fingerprint: description.fingerprint, keep_last: target.keep_last }); }
      catch { throw new RpcError('conflict', 'The backup identifier is already in use, or its history cannot accept a new entry. Check saved backups before starting another.', 409); }
    },
    failed(id: string, issue: ArchiveRemoteIssue): void {
      try { store.update(id, row => {
        if (row.state === 'verified' || row.state === 'pruned' || (row.state === 'unconfirmed' && row.issue !== undefined)) return;
        row.state = 'unconfirmed'; row.issue = issue;
      }); }
      catch { /* preparing/verifying remains uncertainty if evidence cannot be written */ }
    },
    status(jobId: string): ArchiveJobStatus | null {
      const row = store.rows().find(r => r.job_id === jobId); if (!row) return null;
      const common = { remote_backup_id: row.operation_id, bytes_written: row.bytes ?? 0, progress_pct: row.state === 'verified' || row.state === 'pruned' ? 100 : 0 };
      if (row.state === 'verified' || row.state === 'pruned') {
        const path = row.export_name ? join(dataPath, 'exports', row.export_name) : undefined;
        let expires_at: number | undefined;
        // Local export GC is independent of durable remote delivery history.
        try { if (path && existsSync(path) && row.export_expires_at !== undefined && row.export_expires_at > now()) expires_at = row.export_expires_at; } catch { /* remote history still stands */ }
        return { ...common, state: 'done', ...(expires_at === undefined ? {} : { path, expires_at }) };
      }
      return row.state === 'unconfirmed' || row.state === 'pruning'
        ? { ...common, state: 'error', error: 'Remote backup delivery is not confirmed. Check the saved backup before starting another.' }
        : { ...common, state: 'running' };
    },
    async publish(id: string, artifact: { path: string; bytes_written: number; expires_at?: number }): Promise<void> {
      const row = requireRow(id); id = row.operation_id;
      if (row.state !== 'preparing' || running.has(id)) throw new RpcError('conflict', 'This backup operation has already started.');
      running.add(id); const pinned = join(scratch, `${row.operation_id}.recued.archive`);
      try {
        const context = await resolveRow(row);
        if (dirname(resolve(artifact.path)) !== join(dataPath, 'exports') || !isGeneratedExportName(basename(artifact.path))) throw new RemoteBackupTransferError('verification_failed');
        mkdirSync(scratch, { recursive: true, mode: 0o700 });
        try { await link(artifact.path, pinned); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          const free = await statfs(scratch); if (Number(free.bavail) * Number(free.bsize) < artifact.bytes_written + 1024 * 1024) throw error;
          await copyFile(artifact.path, pinned, constants.COPYFILE_EXCL);
        }
        await chmod(pinned, 0o600);
        fsyncDir(scratch);
        const bytes = await hashRemoteBackupFile(pinned);
        if (bytes.bytes !== artifact.bytes_written) throw new RemoteBackupTransferError('verification_failed');
        store.update(id, current => {
          current.state = 'uploading'; current.bytes = bytes.bytes; current.sha256 = bytes.sha256; current.export_name = basename(artifact.path);
          if (artifact.expires_at !== undefined) current.export_expires_at = artifact.expires_at;
        });
        // A lost PUT/complete reply does not prove failure. Read back the exact
        // object before deciding the result; never generate another export.
        try { await context.transport.upload(row.object_key, pinned, bytes, uploadId => {
          store.update(id, current => { if (uploadId === null) delete current.multipart_id; else current.multipart_id = uploadId; });
        }); } catch { /* the following read determines whether delivery happened */ }
        const current = store.update(id, entry => { entry.state = 'verifying'; });
        try { await abortParts(current, context.transport); } catch { /* cleanup cannot overrule a successful object read */ }
        await verified(requireRow(id), context.transport);
      } catch (error) { service.failed(id, issueOf(error)); throw new RpcError('remote_backup_unconfirmed',
        'Remote backup delivery is not confirmed. Check the saved backup before starting another.', 502); }
      finally { running.delete(id); await unlink(pinned).catch(() => { /* exact owned ciphertext can be reclaimed at boot */ }); }
    },
    check(id: string): ArchiveRemoteBackup {
      const row = requireRow(id); if (running.has(row.operation_id) || row.state === 'pruned' || row.state === 'pruning') return remoteBackupView(row);
      rowBytes(row);
      store.update(row.operation_id, current => { current.state = 'verifying'; });
      running.add(row.operation_id);
      void (async () => {
        try {
          const context = await resolveRow(row);
          try { await abortParts(row, context.transport); } catch { /* retry cleanup on a later reconciliation */ }
          await verified(row, context.transport);
        }
        catch (error) { service.failed(row.operation_id, issueOf(error)); }
        finally { running.delete(row.operation_id); }
      })();
      return remoteBackupView(requireRow(row.operation_id));
    },
    retrieve(id: string): Promise<{ staged_name: string }> {
      const row = requireRow(id), existing = fetching.get(row.operation_id); if (existing) return existing;
      if (row.state !== 'verified') throw new RpcError('conflict', 'Verify this remote backup before preparing a restore.', 409);
      const work = (async () => {
        const context = await resolveRow(row), expected = rowBytes(row);
        const staged_name = archiveStagingName(`remote-backup:${row.operation_id}`), exports = join(dataPath, 'exports');
        mkdirSync(exports, { recursive: true, mode: 0o700 }); const destination = join(exports, staged_name);
        if (existsSync(destination)) {
          const have = await hashRemoteBackupFile(destination);
          if (have.bytes === expected.bytes && have.sha256 === expected.sha256) { const at = new Date(now()); utimesSync(destination, at, at); return { staged_name }; }
          // Replace only this operation's owned cache, and only after the
          // replacement has itself been fully verified in a separate file.
        }
        const temp = join(exports, `.${staged_name}.${randomUUID()}.partial`);
        try { await context.transport.retrieve(row.object_key, temp, expected, row); await rename(temp, destination); fsyncDir(exports); return { staged_name }; }
        catch { throw new RpcError('remote_backup_unconfirmed', 'The remote backup could not be retrieved and verified. No restore was started.', 502); }
        finally { await unlink(temp).catch(() => { /* only our temporary file */ }); }
      })().catch(error => {
        if (error instanceof RpcError) throw error;
        throw new RpcError('remote_backup_unconfirmed', 'The remote backup could not be retrieved and verified. No restore was started.', 502);
      });
      fetching.set(row.operation_id, work);
      void work.finally(() => { fetching.delete(row.operation_id); }).catch(() => { /* the caller owns the error */ }); return work;
    },
  };
  return service;
};
export type RemoteBackups = ReturnType<typeof createRemoteBackups>;

export const describeS3BackupConnection = (row: ConnectionRow) => {
  const config: unknown = JSON.parse(row.config_json);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid S3 configuration');
  const value = config as Record<string, unknown>;
  if (row.kind !== 'api' || value.vendor !== 's3' || typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value.bucket)
    || typeof value.region !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/u.test(value.region)) throw new Error('Invalid S3 destination');
  const endpoint = typeof value.endpoint === 'string' && value.endpoint !== '' ? new URL(value.endpoint) : new URL(`https://${value.bucket}.s3.${value.region}.amazonaws.com`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('S3 backups require a credential-free HTTPS endpoint');
  const root = row.subresource_path ?? '/';
  // Every repeated segment has a mandatory slash. An optional slash inside
  // the repeated group caused exponential backtracking on an invalid suffix.
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/u.test(root) || root.split('/').some(p => p === '.' || p === '..')) throw new Error('Unsupported S3 resource scope');
  const prefix = root.replace(/^\/+|\/+$/gu, '') + (root.replace(/\//gu, '') ? '/' : '');
  const exampleId = '00000000-0000-4000-8000-000000000000';
  if (Buffer.byteLength(remoteBackupObjectKey(exampleId, exampleId, prefix), 'utf8') > 1024) throw new Error('S3 backup object key is too long');
  const endpointText = endpoint.toString().replace(/\/+$/u, '');
  const usePathStyle = typeof value.endpoint === 'string' && value.endpoint !== '' && value.use_path_style !== false;
  const fingerprint = createHash('sha256').update(JSON.stringify([endpointText, value.bucket, value.region, usePathStyle, prefix])).digest('hex');
  const destination: ArchiveRemoteDestination = { connection_name: row.name, destination_id: fingerprint, bucket: value.bucket,
    region: value.region, endpoint: endpointText, prefix };
  return { destination, fingerprint, config: { bucket: value.bucket, region: value.region,
    ...(typeof value.endpoint === 'string' && value.endpoint !== '' ? { endpoint: destination.endpoint, use_path_style: usePathStyle } : {}) } };
};

export const createSqliteRemoteBackups = (options: { db: Database.Database; dbPath: string; getKeys?: () => Pick<KeyManager, 'keyProvider'> | undefined; now?: () => number }) => {
  let connectionStore: ReturnType<typeof createConnectionStore> | undefined;
  const connections = () => connectionStore ??= createConnectionStore(options.db);
  const describe = (name: string) => { const row = connections().get('api', name); if (!row) throw new Error('Missing S3 connection'); return describeS3BackupConnection(row); };
  return createRemoteBackups({ dbPath: options.dbPath, now: options.now, describe,
    destinations: () => connections().list({ kind: 'api' }).flatMap(row => { try { return [describeS3BackupConnection(row).destination]; } catch { return []; } }),
    resolve: async name => {
      const row = connections().get('api', name); if (!row) throw new RemoteBackupTransferError('destination_unavailable');
      const description = describeS3BackupConnection(row), keyProvider = options.getKeys?.()?.keyProvider('connection');
      if (!keyProvider?.()) throw new RemoteBackupTransferError('destination_unavailable');
      const auth = await decodeAuthFromStorage(row.auth_ciphertext, row, keyProvider);
      if (auth.type !== 'basic' || !auth.username || !auth.password) throw new RemoteBackupTransferError('destination_unavailable');
      const config: S3ClientConfig = { ...description.config, access_key: auth.username, secret_key: auth.password };
      const assertCurrent = (): void => {
        const live = connections().get('api', name);
        if (!keyProvider() || !live || live.auth_ciphertext !== row.auth_ciphertext || live.config_json !== row.config_json
          || live.subresource_path !== row.subresource_path) throw new RemoteBackupTransferError('destination_unavailable');
      };
      assertCurrent(); return { destination: description.destination, fingerprint: description.fingerprint,
        transport: createS3RemoteBackupTransport({ config, assertCurrent }) };
    },
  });
};
