/** Internal CLI profile. One IPC request, one disposable realm, then exit.
 * No server boot, live DB, provider credentials, or persistent recovery factor. */
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isValidReleaseVersion } from '@recued/release';
import type { ArchiveRestoreDrillChecks } from '@recued/contracts';
import { IDENTITY_PASSPHRASE_ENV_VAR } from '../identity/passphrase-env.js';
import { archiveImportOperationId } from './archive-import-receipts.js';
import { restoreDrillRealm } from './restore-drill-realm.js';

interface Request { kind: 'restore'; archivePath: string; dataPath: string; serverVersion: string; entropy: Buffer }
const request = (value: unknown): value is Request => {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'restore'
    || !('dataPath' in value) || typeof value.dataPath !== 'string' || value.dataPath.length > 4096 || !isAbsolute(value.dataPath)
    || resolve(value.dataPath) !== value.dataPath || archiveImportOperationId(basename(value.dataPath)) !== basename(value.dataPath)
    || !basename(dirname(value.dataPath)).endsWith('.restore-drills')
    || !('archivePath' in value) || value.archivePath !== join(value.dataPath, 'backup.recued.archive')
    || !('serverVersion' in value) || typeof value.serverVersion !== 'string' || !isValidReleaseVersion(value.serverVersion)
    || !('entropy' in value) || !Buffer.isBuffer(value.entropy) || value.entropy.length !== 32
    || Object.keys(value).some(k => !['kind', 'archivePath', 'dataPath', 'serverVersion', 'entropy'].includes(k))) return false;
  return true;
};

export const runRestoreDrillChild = (): void => {
  if (!process.send || !process.connected) { process.exitCode = 1; return; }
  process.on('disconnect', () => process.exit(1));
  const startupTimer = setTimeout(() => process.exit(1), 10_000);
  let started = false, continueCheck: (() => void) | undefined;
  const finish = (message: { kind: 'result'; checks: ArchiveRestoreDrillChecks } | { kind: 'failed'; issue: 'restore_failed' | 'integrity_failed' }): void => {
    if (!process.connected) process.exit(1);
    process.send!(message, error => process.exit(error || message.kind === 'failed' ? 1 : 0));
  };
  process.on('message', (message: unknown) => {
    if (started) {
      if (message && typeof message === 'object' && 'kind' in message && message.kind === 'continue'
        && Object.keys(message).length === 1 && continueCheck) { const next = continueCheck; continueCheck = undefined; next(); }
      else process.exit(1);
      return;
    }
    if (!request(message)) { if (message && typeof message === 'object' && 'entropy' in message && Buffer.isBuffer(message.entropy)) message.entropy.fill(0); process.exit(1); }
    started = true; clearTimeout(startupTimer);
    // A one-run seal for the disposable boot keyfile. Never inherit the live
    // identity passphrase or provision anything in the host's OS keychain.
    process.env[IDENTITY_PASSPHRASE_ENV_VAR] = randomBytes(32).toString('hex');
    let phase: 'restore_failed' | 'integrity_failed' = 'restore_failed';
    void restoreDrillRealm({ ...message, onChecking: async () => {
      phase = 'integrity_failed';
      await new Promise<void>((resolveCheck, rejectCheck) => {
        continueCheck = resolveCheck;
        process.send!({ kind: 'checking' }, error => { if (error) rejectCheck(error); });
      });
    } }).then(checks => {
      message.entropy.fill(0); delete process.env[IDENTITY_PASSPHRASE_ENV_VAR]; finish({ kind: 'result', checks });
    }, () => {
      message.entropy.fill(0); delete process.env[IDENTITY_PASSPHRASE_ENV_VAR]; finish({ kind: 'failed', issue: phase });
    });
  });
  process.send({ kind: 'ready' }, error => { if (error) process.exit(1); });
};
