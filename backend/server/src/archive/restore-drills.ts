import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidRecoveryKey, recoveryKeyToEntropy } from '@recued/crypto';
import { RpcError, type ArchiveRestoreDrill, type ArchiveRestoreDrillIssue } from '@recued/contracts';
import { fsyncDir } from '../durable-fs.js';
import { archiveImportOperationId } from './archive-import-receipts.js';
import { createRestoreDrillStore, restoreDrillActive, restoreDrillScratchPath } from './restore-drill-store.js';
import { assertRestoreDrillWorkerStopped, RestoreDrillWorkerError, runRestoreDrillWorker } from './restore-drill-worker.js';
import type { RemoteBackups } from './remote-backups.js';
import type { ArchiveOperationGate } from './unattended-backups.js';

export const createRestoreDrills = (options: {
  dbPath: string; remoteBackups: RemoteBackups; gate: ArchiveOperationGate; serverVersion: string;
  now?: () => number; canRun?: () => boolean;
}) => {
  const store = createRestoreDrillStore(options.dbPath), root = restoreDrillScratchPath(options.dbPath), now = options.now ?? Date.now;
  let active: Promise<void> | undefined, stopped = false;
  let controller: AbortController | undefined, activeId: string | undefined;
  let cleanupActive: { id: string; promise: Promise<ArchiveRestoreDrill> } | undefined;
  const privateRoot = (): void => {
    try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Drill scratch is not a private directory');
    chmodSync(root, 0o700);
  };
  // Never replay recovery factors. Reclaim only directories belonging to valid
  // durable receipts, even when a crash happened before the first file write.
  try {
    for (const row of store.rows()) {
      if (!restoreDrillActive(row) && !row.cleanup_pending) continue;
      let pending = false;
      try { privateRoot(); const dir = join(root, row.operation_id); assertRestoreDrillWorkerStopped(dir); rmSync(dir, { recursive: true, force: true }); fsyncDir(root); }
      catch { pending = true; }
      store.update(row.operation_id, current => {
        if (restoreDrillActive(current)) {
          current.state = 'failed'; current.finished_at = now();
          current.issue = pending ? 'cleanup_failed' : current.cancel_requested_at === undefined ? 'interrupted' : 'cancelled';
        } else if (!pending) current.cleanup_completed_at = now();
        if (pending) current.cleanup_pending = true; else delete current.cleanup_pending;
        delete current.checks;
      });
    }
  } catch { /* a broken ledger blocks drill calls, never warehouse boot */ }
  const history = (): ArchiveRestoreDrill[] => {
    try { return store.rows(); }
    catch { throw new RpcError('not_configured', 'Recovery drill history could not be read. Repair it before starting another drill.', 503); }
  };
  const requireRow = (operationId: unknown): ArchiveRestoreDrill => {
    const id = archiveImportOperationId(operationId);
    if (!id) throw new RpcError('invalid_args', 'Choose a recovery test by its operation identifier.', 400);
    const row = history().find(current => current.operation_id === id);
    if (!row) throw new RpcError('not_found', 'This recovery test is not in the saved history.', 404);
    return row;
  };
  return {
    list(): ArchiveRestoreDrill[] { return history().slice(-100).reverse(); },
    cancel(input: { operation_id: string }): ArchiveRestoreDrill {
      const row = requireRow(input?.operation_id);
      // Repeating an exact request after a lost reply cannot stop a newer test.
      if (!restoreDrillActive(row)) return row;
      if (activeId !== row.operation_id || !controller) throw new RpcError('conflict', 'This test needs reconciliation. Restart the server before retrying cleanup.', 409);
      // Persist intent before signalling the worker or its remote download.
      const requested = row.cancel_requested_at === undefined
        ? store.update(row.operation_id, current => { current.cancel_requested_at = now(); }) : row;
      controller.abort();
      return requested;
    },
    retryCleanup(input: { operation_id: string }): Promise<ArchiveRestoreDrill> {
      const row = requireRow(input?.operation_id);
      if (cleanupActive?.id === row.operation_id) return cleanupActive.promise;
      if (restoreDrillActive(row)) throw new RpcError('conflict', 'Wait for this recovery test to finish before retrying cleanup.', 409);
      if (!row.cleanup_pending) return Promise.resolve(row);
      if (stopped || options.canRun?.() === false) throw new RpcError('conflict', 'Wait for server maintenance to finish before retrying cleanup.', 409);
      const release = options.gate.acquire();
      const run = async (): Promise<ArchiveRestoreDrill> => {
        // The saved cleanup_pending bit is durable intent. Never retrieve,
        // restore, or kill a process identified only by a persisted PID.
        try {
          privateRoot(); const dir = join(root, row.operation_id);
          assertRestoreDrillWorkerStopped(dir);
          await rm(dir, { recursive: true, force: true }); fsyncDir(root);
        } catch { return requireRow(row.operation_id); }
        return store.update(row.operation_id, current => {
          delete current.cleanup_pending; current.cleanup_completed_at = now();
        });
      };
      const promise = run().finally(() => { cleanupActive = undefined; release(); });
      cleanupActive = { id: row.operation_id, promise }; return promise;
    },
    start(input: { operation_id: string; backup_operation_id: string; recoveryKey: string }): ArchiveRestoreDrill {
      const id = archiveImportOperationId(input?.operation_id), backupId = archiveImportOperationId(input?.backup_operation_id);
      if (!id || !backupId || typeof input.recoveryKey !== 'string' || !isValidRecoveryKey(input.recoveryKey)) throw new RpcError('invalid_args', 'Choose a backup, a new drill identifier, and its 24-word recovery key.', 400);
      if (stopped || options.canRun?.() === false) throw new RpcError('conflict', 'Wait for the server to finish maintenance before starting a drill.', 409);
      const prior = history().find(row => row.operation_id === id);
      if (prior) throw new RpcError('conflict', 'This drill identifier was already used. Check recovery drill history.', 409);
      const backup = options.remoteBackups.receipt(backupId);
      if (backup.state !== 'verified' || backup.sha256 === undefined || backup.bytes === undefined) throw new RpcError('conflict', 'Verify the remote backup before testing recovery.', 409);
      // A lost ledger must not turn an unrelated pre-existing directory into
      // ours merely because a caller supplied its UUID.
      try { privateRoot(); lstatSync(join(root, id)); throw new RpcError('conflict', 'This temporary directory already exists. Choose a new drill identifier.', 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const release = options.gate.acquire();
      let entropy: Buffer;
      try {
        const raw = recoveryKeyToEntropy(input.recoveryKey);
        try { entropy = Buffer.from(raw); } finally { raw.fill(0); }
      } catch (error) { release(); throw error; }
      const row: ArchiveRestoreDrill = { operation_id: id, backup_operation_id: backupId, destination_id: backup.destination.destination_id,
        archive_sha256: backup.sha256, archive_bytes: backup.bytes, started_at: now(), state: 'retrieving' };
      try { store.reserve(row); }
      catch { entropy.fill(0); release(); throw new RpcError('conflict', 'Drill history cannot accept this request. Check history and retry any pending cleanup.', 409); }
      const dir = join(root, id);
      const ownController = new AbortController(); controller = ownController; activeId = id;
      const run = async (): Promise<void> => {
        let issue: ArchiveRestoreDrillIssue | undefined, checks: ArchiveRestoreDrill['checks'];
        try {
          privateRoot(); await mkdir(dir, { mode: 0o700 }); fsyncDir(root);
          const free = await statfs(dir);
          // The encrypted archive, restored DB/CAS, migration working space,
          // and one largest plaintext blob scratch all share this volume.
          if (Number(free.bavail) * Number(free.bsize) < row.archive_bytes * 4 + 64 * 1024 * 1024) { issue = 'insufficient_storage'; throw new Error('Insufficient drill space'); }
          issue = 'retrieval_failed';
          const archivePath = join(dir, 'backup.recued.archive');
          if (ownController.signal.aborted) throw new RestoreDrillWorkerError('stopped');
          await options.remoteBackups.retrieveForDrill(backupId, archivePath, ownController.signal);
          if (ownController.signal.aborted) throw new RestoreDrillWorkerError('stopped');
          store.update(id, current => { current.state = 'restoring'; }); issue = 'restore_failed';
          checks = await runRestoreDrillWorker({ archivePath, dataPath: dir, entropy, serverVersion: options.serverVersion, signal: ownController.signal,
            onChecking() { issue = 'integrity_failed'; store.update(id, current => { current.state = 'checking'; }); } });
          issue = undefined;
        } catch (error) {
          if (ownController.signal.aborted) issue = 'stopped';
          else if (error instanceof RestoreDrillWorkerError) issue = error.issue;
          else issue ??= 'restore_failed';
        }
        finally { entropy.fill(0); }
        // Cleanup precedes the success verdict. A restart during this phase
        // records interruption, since there is no durable proof of completion.
        try { store.update(id, current => { current.state = 'cleaning'; }); } catch { /* cleanup must still run */ }
        let cleanupPending = false;
        try { privateRoot(); assertRestoreDrillWorkerStopped(dir); await rm(dir, { recursive: true, force: true }); fsyncDir(root); }
        catch { issue = 'cleanup_failed'; cleanupPending = true; }
        store.update(id, current => {
          if (!cleanupPending && current.cancel_requested_at !== undefined) issue = 'cancelled';
          current.state = issue === undefined && checks !== undefined ? 'succeeded' : 'failed'; current.finished_at = now();
          if (current.state === 'succeeded') current.checks = checks;
          else current.issue = issue ?? 'restore_failed';
          if (cleanupPending) current.cleanup_pending = true;
        });
      };
      active = run().catch(() => { /* leave durable uncertainty when settlement I/O fails */ }).finally(() => { active = undefined; controller = undefined; activeId = undefined; release(); });
      return structuredClone(row);
    },
    async stop(): Promise<void> { stopped = true; controller?.abort(); await Promise.allSettled([active, cleanupActive?.promise]); },
    resume(): void { stopped = false; },
  };
};
export type RestoreDrills = ReturnType<typeof createRestoreDrills>;
