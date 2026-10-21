/** Heavy recovery runs in a child process: synchronous SQLite and a native
 * driver crash must not stop the server's request loop. No recovery material
 * enters argv, the environment, stdio, or a persistent worker request. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type { ArchiveRestoreDrillChecks, ArchiveRestoreDrillIssue } from '@recued/contracts';
import { runningAsPackagedBinary } from '../packaged-binary.js';
import { writeFileAtomicSync } from '../durable-fs.js';
import { isRestoreDrillChecks } from './restore-drill-store.js';

export const RESTORE_DRILL_WORKER_TIMEOUT_MS = 30 * 60 * 1000;
const MARKER = 'worker.json';
type WorkerIssue = Extract<ArchiveRestoreDrillIssue, 'worker_failed' | 'worker_timeout' | 'stopped' | 'restore_failed' | 'integrity_failed'>;
export class RestoreDrillWorkerError extends Error {
  constructor(readonly issue: WorkerIssue) { super(issue); }
}
export interface RestoreDrillWorkerCommand { command: string; args: string[]; tsconfigPath?: string }

/** Re-execute the installed binary, or the same Node with the real CLI entry.
 * A source checkout uses its installed loader, never npx or PATH discovery.
 * ESM/npm, CJS, compiled modules, and SEA need no separate worker artifact. */
export const restoreDrillWorkerCommand = (packaged = runningAsPackagedBinary()): RestoreDrillWorkerCommand => {
  if (packaged) return { command: process.execPath, args: ['restore-drill-worker'] };
  const here = import.meta.dirname ?? __dirname;
  const ownFile = import.meta.filename ?? __filename;
  const entry = ['bin.js', 'bin.cjs'].includes(basename(ownFile)) ? ownFile
    : [join(here, 'bin.js'), join(here, '..', 'bin.js'), join(here, '..', 'bin.ts')].find(path => existsSync(path));
  if (!entry) throw new RestoreDrillWorkerError('worker_failed');
  const args = entry.endsWith('.ts') ? ['--import', createRequire(entry).resolve('tsx'), entry] : [entry];
  return { command: process.execPath, args: [...args, 'restore-drill-worker'],
    ...(entry.endsWith('.ts') ? { tsconfigPath: join(dirname(entry), '..', '..', '..', 'tsconfig.base.json') } : {}) };
};

/** Boot must not erase files a surviving worker can still write. PID reuse
 * can delay cleanup, but never authorizes killing an unrelated process.
 * The parent persists this marker BEFORE sending the worker any request. */
export const assertRestoreDrillWorkerStopped = (dataPath: string): void => {
  const path = join(dataPath, MARKER);
  let raw: string;
  try {
    if (statSync(path).size > 128) throw new Error('Invalid recovery worker marker');
    raw = readFileSync(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 1 || !('pid' in value)
    || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 0x7fffffff
    || Object.keys(value).some(k => k !== 'v' && k !== 'pid')) throw new Error('Invalid recovery worker marker');
  try { process.kill(value.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
  throw new Error('Recovery worker is still running');
};

export const runRestoreDrillWorker = (options: {
  archivePath: string; dataPath: string; entropy: Buffer; serverVersion: string;
  onChecking(): void | Promise<void>; signal: AbortSignal;
}, controls: { command?: RestoreDrillWorkerCommand; timeoutMs?: number } = {}): Promise<ArchiveRestoreDrillChecks> => {
  const timeoutMs = controls.timeoutMs ?? RESTORE_DRILL_WORKER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RESTORE_DRILL_WORKER_TIMEOUT_MS) { options.entropy.fill(0); return Promise.reject(new RestoreDrillWorkerError('worker_failed')); }
  if (options.signal.aborted) { options.entropy.fill(0); return Promise.reject(new RestoreDrillWorkerError('stopped')); }
  return new Promise<ArchiveRestoreDrillChecks>((resolve, reject) => {
    let failure: WorkerIssue | undefined, result: ArchiveRestoreDrillChecks | undefined;
    let ready = false, checking = false, acknowledged = false, admitted = false, killing = false;
    const command = controls.command ?? restoreDrillWorkerCommand();
    // This is Recued's own fixed program. It needs none of the parent's
    // credentials, NODE_OPTIONS, preload/inspector flags, or provider settings.
    const child = spawn(command.command, command.args, { env: { NODE_ENV: 'production', ...(command.tsconfigPath ? { TSX_TSCONFIG_PATH: command.tsconfigPath } : {}) },
      cwd: options.dataPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    const fail = (issue: WorkerIssue): void => {
      failure ??= issue;
      // Wait for close below: even a previously received result is not proof
      // that the native process has stopped writing or released its files.
      if (child.pid !== undefined && !killing && child.exitCode === null && child.signalCode === null) {
        killing = true; try { child.kill('SIGKILL'); } catch { /* retain ownership until close; boot checks the marker */ }
      }
    };
    const abort = (): void => { fail('stopped'); };
    const send = (message: object, sent?: () => void): void => {
      try {
        if (!child.connected) { sent?.(); fail('worker_failed'); return; }
        child.send(message, error => { sent?.(); if (error) fail('worker_failed'); });
      } catch { sent?.(); fail('worker_failed'); }
    };
    const timer = setTimeout(() => { fail('worker_timeout'); }, timeoutMs);
    options.signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => { fail('worker_failed'); });
    child.on('disconnect', () => { if (!result) fail('worker_failed'); });
    child.on('message', (message: unknown) => {
      if (failure) return;
      if (!message || typeof message !== 'object' || !('kind' in message)) { fail('worker_failed'); return; }
      const keys = Object.keys(message);
      if (message.kind === 'ready' && keys.length === 1 && !ready && admitted) {
        ready = true;
        send({ kind: 'restore', archivePath: options.archivePath, dataPath: options.dataPath,
          serverVersion: options.serverVersion, entropy: options.entropy }, () => { options.entropy.fill(0); });
      } else if (message.kind === 'checking' && keys.length === 1 && ready && !checking && !result) {
        checking = true;
        void Promise.resolve().then(() => options.onChecking()).then(() => {
          if (failure || !child.connected) return;
          acknowledged = true; send({ kind: 'continue' });
        }).catch(() => { fail('worker_failed'); });
      } else if (message.kind === 'result' && keys.length === 2 && 'checks' in message && acknowledged && !result && isRestoreDrillChecks(message.checks)
        && message.checks.server_version === options.serverVersion) {
        result = message.checks;
      } else if (message.kind === 'failed' && keys.length === 2 && 'issue' in message
        && (message.issue === 'restore_failed' || message.issue === 'integrity_failed')) {
        fail(message.issue);
      } else fail('worker_failed');
    });
    child.once('close', code => {
      clearTimeout(timer); options.signal.removeEventListener('abort', abort); options.entropy.fill(0);
      try { unlinkSync(join(options.dataPath, MARKER)); } catch { /* dead worker marker is safe for the parent's cleanup */ }
      if (failure || code !== 0 || !result) reject(new RestoreDrillWorkerError(failure ?? 'worker_failed'));
      else resolve(result);
    });
    try {
      if (child.pid === undefined) { fail('worker_failed'); return; }
      writeFileAtomicSync(join(options.dataPath, MARKER), JSON.stringify({ v: 1, pid: child.pid }));
      admitted = true;
      if (options.signal.aborted) abort();
    } catch { fail('worker_failed'); }
  }).catch(error => { throw error instanceof RestoreDrillWorkerError ? error : new RestoreDrillWorkerError('worker_failed'); })
    .finally(() => { options.entropy.fill(0); });
};
