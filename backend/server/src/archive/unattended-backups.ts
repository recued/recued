/** Durable schedule and a sealed, backup-only capability. Recovery words and
 * their entropy never belong in this file's storage or notification records. */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARCHIVE_UNATTENDED_ISSUE_TEXT, RpcError, type ArchiveBackupSchedule, type ArchiveUnattendedSettings,
  type ArchiveUnattendedStatus, type ArchiveUnattendedIssue } from '@recued/contracts';
import { encrypt, decrypt, encodeCiphertext, decodeCiphertext } from '@recued/crypto';
import { writeFileAtomicSync } from '../durable-fs.js';
import type { ArchiveRuntime } from './archive-handler.js';
import type { RemoteBackups } from './remote-backups.js';

export interface ArchiveBackupCapability { key: Buffer; salt_hex: string; realm_fingerprint: string }
export class ArchiveBackupSetupError extends Error {}
export const createArchiveOperationGate = () => {
  let busy = false;
  const tryAcquire = (): (() => void) | null => {
    if (busy) return null;
    busy = true; let released = false;
    return () => { if (!released) { released = true; busy = false; } };
  };
  return { tryAcquire, acquire(): () => void {
    const release = tryAcquire();
    if (!release) throw new RpcError('archive_export_in_progress', 'A backup or restore is already running. Wait for it to finish.', 409);
    return release;
  } };
};
export type ArchiveOperationGate = ReturnType<typeof createArchiveOperationGate>;
export const unattendedBackupPath = (dbPath: string): string => `${resolve(dbPath)}.unattended-backup.json`;
const HASH = /^[0-9a-f]{64}$/u;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).every(key => names.includes(key));
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const ISSUES = new Set<ArchiveUnattendedIssue>(['interrupted', 'export_failed', 'destination_unavailable', 'transfer_unconfirmed',
  'verification_failed', 'vault_unavailable', 'insufficient_storage', 'setup_required', 'history_unavailable', 'retention_pending']);
const issue = (value: unknown): value is ArchiveUnattendedIssue => ISSUES.has(value as ArchiveUnattendedIssue);
export const validateBackupSchedule = (value: unknown): ArchiveBackupSchedule => {
  if (!object(value) || !only(value, ['cadence', 'hour_utc', 'minute_utc', 'weekday_utc'])
    || (value.cadence !== 'daily' && value.cadence !== 'weekly') || !integer(value.hour_utc, 0, 23)
    || !integer(value.minute_utc, 0, 59) || !integer(value.weekday_utc, 0, 6)) {
    throw new RpcError('invalid_args', 'Choose a daily or weekly UTC time.', 400);
  }
  return { cadence: value.cadence, hour_utc: value.hour_utc, minute_utc: value.minute_utc, weekday_utc: value.weekday_utc };
};
export const validateUnattendedSettings = (value: unknown): ArchiveUnattendedSettings => {
  if (!object(value) || !only(value, ['enabled', 'connection_name', 'destination_id', 'keep_last', 'schedule'])
    || typeof value.enabled !== 'boolean' || typeof value.connection_name !== 'string' || !value.connection_name.trim()
    || value.connection_name.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.connection_name)
    || typeof value.destination_id !== 'string' || !HASH.test(value.destination_id) || !integer(value.keep_last, 1, 30)) {
    throw new RpcError('invalid_args', 'Choose daily or weekly UTC time, an S3 destination, and 1 to 30 copies to keep.', 400);
  }
  validateBackupSchedule(value.schedule);
  return structuredClone(value) as unknown as ArchiveUnattendedSettings;
};
export const nextBackupTime = (schedule: ArchiveBackupSchedule, after: number): number => {
  const next = new Date(after);
  next.setUTCHours(schedule.hour_utc, schedule.minute_utc, 0, 0);
  if (schedule.cadence === 'weekly') next.setUTCDate(next.getUTCDate() + (schedule.weekday_utc - next.getUTCDay() + 7) % 7);
  if (next.getTime() <= after) next.setUTCDate(next.getUTCDate() + (schedule.cadence === 'weekly' ? 7 : 1));
  return next.getTime();
};
interface Saved {
  v: 1;
  settings: ArchiveUnattendedSettings;
  capability: { ciphertext: string; salt_hex: string; realm_fingerprint: string };
  next_run_at: number;
  last_run?: NonNullable<ArchiveUnattendedStatus['last_run']>;
  alert?: { operation_id: string; issue: ArchiveUnattendedIssue; attempted_at?: number };
}
const aad = (capability: Saved['capability']): Uint8Array => new TextEncoder().encode(
  `recued/archive-backup/v1/${capability.salt_hex}/${capability.realm_fingerprint}`,
);
const readSaved = (path: string): Saved | null => {
  let raw: string;
  try {
    if (statSync(path).size > 16_384) throw new Error('oversized');
    raw = readFileSync(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Unattended backup settings cannot be read.'); }
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.v !== 1 || !only(value, ['v', 'settings', 'capability', 'next_run_at', 'last_run', 'alert'])
      || !integer(value.next_run_at, 0) || !object(value.capability)
      || !only(value.capability, ['ciphertext', 'salt_hex', 'realm_fingerprint'])
      || typeof value.capability.ciphertext !== 'string' || value.capability.ciphertext.length > 2048
      || typeof value.capability.salt_hex !== 'string' || !HASH.test(value.capability.salt_hex)
      || typeof value.capability.realm_fingerprint !== 'string' || !HASH.test(value.capability.realm_fingerprint)) throw new Error('shape');
    validateUnattendedSettings(value.settings);
    const run = value.last_run, alert = value.alert;
    if (run !== undefined && (!object(run) || !only(run, ['operation_id', 'started_at', 'finished_at', 'outcome', 'issue'])
      || typeof run.operation_id !== 'string' || !/^[0-9a-f-]{36}$/u.test(run.operation_id) || !integer(run.started_at, 0)
      || (run.finished_at !== undefined && !integer(run.finished_at, 0)) || !['running', 'verified', 'failed'].includes(run.outcome as string)
      || (run.issue !== undefined && !issue(run.issue)))) throw new Error('run');
    if (alert !== undefined && (!object(alert) || !only(alert, ['operation_id', 'issue', 'attempted_at'])
      || typeof alert.operation_id !== 'string' || !/^[0-9a-f-]{36}$/u.test(alert.operation_id) || !issue(alert.issue)
      || (alert.attempted_at !== undefined && !integer(alert.attempted_at, 0)))) throw new Error('alert');
    return value as unknown as Saved;
  } catch { throw new Error('Unattended backup settings are invalid.'); }
};
const view = (saved: Saved | null): ArchiveUnattendedStatus => saved === null ? { configured: false } : {
  configured: true, settings: structuredClone(saved.settings),
  ...(saved.settings.enabled ? { next_run_at: saved.next_run_at } : {}),
  ...(saved.last_run ? { last_run: structuredClone(saved.last_run) } : {}),
  ...(saved.alert ? { alert_pending: true } : {}),
};
export const createUnattendedBackups = (options: {
  dbPath: string; runtime: ArchiveRuntime; remoteBackups: RemoteBackups; gate: ArchiveOperationGate;
  getEncryptionKey(): Uint8Array | null;
  /** Returns false when the owner's notification route is unavailable. */
  notify(message: { title: string; text: string; link_url: string }, operationId?: string): Promise<boolean>;
  canRun?: () => boolean; now?: () => number;
}) => {
  const path = unattendedBackupPath(options.dbPath), now = options.now ?? Date.now;
  const write = (saved: Saved): void => writeFileAtomicSync(path, `${JSON.stringify(saved)}\n`);
  let active: Promise<void> | undefined, saving: Promise<ArchiveUnattendedStatus> | undefined;
  let alertActive: Promise<void> | undefined, stopped = false;
  let storageAlertAt = -Infinity;
  const markVerified = (saved: Saved, operationId: string): void => {
    if (!saved.last_run || saved.last_run.operation_id !== operationId) throw new Error('Backup checkpoint changed.');
    saved.last_run.outcome = 'verified'; saved.last_run.finished_at = now(); delete saved.last_run.issue;
    if (saved.alert?.operation_id === operationId) delete saved.alert;
    try {
      if (options.remoteBackups.list().find(row => row.operation_id === operationId)?.retention_pending) {
        saved.alert = { operation_id: operationId, issue: 'retention_pending' };
      }
    } catch { saved.alert = { operation_id: operationId, issue: 'history_unavailable' }; }
  };
  const reconcile = (saved: Saved | null): void => {
    const run = saved?.last_run;
    if (!saved || !run || run.outcome === 'verified') return;
    // An owner check or a committed delivery can settle an unfinished or
    // previously unconfirmed run. Never create or resend any archive here.
    let delivered = false, failure: ArchiveUnattendedIssue = 'interrupted';
    try { delivered = options.remoteBackups.status(`arx-${run.operation_id}`)?.state === 'done'; }
    catch { failure = 'history_unavailable'; }
    if (delivered) markVerified(saved, run.operation_id);
    else if (run.outcome === 'running') {
      run.outcome = 'failed'; run.finished_at = now(); run.issue = failure;
      saved.alert = { operation_id: run.operation_id, issue: failure };
    } else return;
    write(saved);
  };
  try { reconcile(readSaved(path)); } catch { /* Keep warehouse boot available; ticks retry the checkpoint. */ }
  const notifyPending = async (): Promise<void> => {
    let saved: Saved | null;
    try { saved = readSaved(path); }
    catch {
      if (now() - storageAlertAt < 3_600_000) return;
      storageAlertAt = now();
      await options.notify({ title: 'Scheduled backups are unavailable',
        text: 'Backup settings could not be read or saved. Open Backup & Recovery on this server to investigate.', link_url: '#settings/backup' });
      return;
    }
    const alert = saved?.alert;
    if (!saved || !alert || (alert.attempted_at !== undefined && now() - alert.attempted_at < 3_600_000)) return;
    alert.attempted_at = now(); write(saved);
    const confirmed = saved.last_run?.operation_id === alert.operation_id && saved.last_run.outcome === 'verified';
    const text = alert.issue === 'retention_pending'
      ? 'The latest scheduled encrypted backup is verified, but some older copies could not be removed. Open Backup & Recovery to check retention.'
      : `${ARCHIVE_UNATTENDED_ISSUE_TEXT[alert.issue]} ${confirmed ? 'The scheduled encrypted backup is verified.' : 'A scheduled encrypted backup could not be confirmed.'} Open Backup & Recovery to check its receipt and storage connection.`;
    const accepted = await options.notify({ title: 'Scheduled backup needs attention', text, link_url: '#settings/backup' }, alert.operation_id);
    if (accepted) {
      // Delivery yields to exports and settings changes. Clear only this alert
      // from the latest checkpoint; a stale snapshot would overwrite new work.
      const latest = readSaved(path);
      if (latest?.alert?.operation_id === alert.operation_id && latest.alert.issue === alert.issue) {
        delete latest.alert; write(latest);
      }
    }
  };
  const startAlerts = (): void => {
    if (stopped || alertActive) return;
    alertActive = notifyPending().catch(() => { /* Durable alert remains pending; never record provider errors. */ })
      .finally(() => { alertActive = undefined; });
  };
  const currentRun = (operationId: string): Saved => {
    const latest = readSaved(path);
    if (!latest || latest.last_run?.operation_id !== operationId) throw new Error('Backup checkpoint changed.');
    return latest;
  };
  const service = {
    status(): ArchiveUnattendedStatus { return view(readSaved(path)); },
    save(settings: unknown, recoveryKey?: string): Promise<ArchiveUnattendedStatus> {
      if (stopped || active || saving) return Promise.reject(new RpcError('conflict', 'Wait for the current backup operation to finish.', 409));
      const work = async (): Promise<ArchiveUnattendedStatus> => {
        const config = validateUnattendedSettings(settings), release = options.gate.acquire();
        let capability: ArchiveBackupCapability | undefined, key: Uint8Array | null = null;
        try {
          const previous = readSaved(path);
          if (config.enabled && !options.remoteBackups.destinations().some(row => row.connection_name === config.connection_name && row.destination_id === config.destination_id)) {
            throw new RpcError('not_configured', 'Refresh and choose an available S3 destination.', 409);
          }
          let sealed = previous?.capability;
          if (recoveryKey !== undefined || !sealed) {
            key = options.getEncryptionKey();
            if (!key) throw new RpcError('locked', 'Unlock the server vault before configuring unattended backups.', 409);
            if (!options.runtime.prepareUnattendedExport || typeof recoveryKey !== 'string') throw new RpcError('invalid_args', 'Enter your recovery key once to enable unattended backups.', 400);
            capability = await options.runtime.prepareUnattendedExport(recoveryKey);
            sealed = { ciphertext: '', salt_hex: capability.salt_hex, realm_fingerprint: capability.realm_fingerprint };
            sealed.ciphertext = encodeCiphertext(await encrypt(key, capability.key, aad(sealed)));
          }
          const latest = readSaved(path);
          const prior = latest?.settings.schedule, next = config.schedule;
          const sameSchedule = latest?.settings.enabled && config.enabled
            && prior?.cadence === next.cadence && prior.hour_utc === next.hour_utc && prior.minute_utc === next.minute_utc
            && (next.cadence === 'daily' || prior.weekday_utc === next.weekday_utc);
          const saved: Saved = { v: 1, settings: config, capability: sealed,
            next_run_at: sameSchedule ? latest.next_run_at : nextBackupTime(config.schedule, now()),
            ...(latest?.last_run ? { last_run: latest.last_run } : {}), ...(latest?.alert ? { alert: latest.alert } : {}) };
          write(saved); return view(saved);
        } finally { capability?.key.fill(0); key?.fill(0); release(); }
      };
      saving = work().finally(() => { saving = undefined; }); return saving;
    },
    tick(): Promise<void> {
      if (stopped || saving || options.canRun?.() === false) return Promise.resolve();
      if (active) { startAlerts(); return active; }
      const work = async (): Promise<void> => {
        let saved: Saved | null;
        try { saved = readSaved(path); reconcile(saved); }
        catch { startAlerts(); return; }
        if (!saved) return;
        if (!saved.settings.enabled || saved.next_run_at > now() || stopped || options.canRun?.() === false) return;
        const release = options.gate.tryAcquire(); if (!release) return;
        const operation_id = randomUUID(), job_id = `arx-${operation_id}`;
        let key: Uint8Array | null = null, root: Uint8Array | undefined, reserved = false;
        let failure: ArchiveUnattendedIssue = 'export_failed';
        try {
          saved.last_run = { operation_id, started_at: now(), outcome: 'running' };
          saved.next_run_at = nextBackupTime(saved.settings.schedule, now());
          write(saved); // Durable claim BEFORE any export or provider call.
          key = options.getEncryptionKey(); failure = 'vault_unavailable';
          if (!key) throw new Error('locked');
          failure = 'setup_required';
          root = await decrypt(key, decodeCiphertext(saved.capability.ciphertext), aad(saved.capability));
          if (root.length !== 32 || !options.runtime.runUnattendedExport) throw new Error('invalid capability');
          const readiness = options.runtime.canExport(); if (!readiness.ok) throw new Error('unavailable');
          options.runtime.pruneExpiredExports();
          failure = 'insufficient_storage';
          const space = await options.runtime.preflightExport({ includeBlobs: true }); if (!space.ok) throw new Error('storage');
          failure = 'destination_unavailable';
          if (!options.remoteBackups.destinations().some(row => row.connection_name === saved.settings.connection_name && row.destination_id === saved.settings.destination_id)) throw new Error('changed destination');
          failure = 'history_unavailable';
          options.remoteBackups.reserve({ ...saved.settings, operation_id }, job_id); reserved = true;
          failure = 'export_failed';
          const capability: ArchiveBackupCapability = { key: Buffer.from(root), salt_hex: saved.capability.salt_hex, realm_fingerprint: saved.capability.realm_fingerprint };
          let artifact: Awaited<ReturnType<ArchiveRuntime['runExport']>>;
          try { artifact = await options.runtime.runUnattendedExport(capability); }
          finally { capability.key.fill(0); }
          failure = 'transfer_unconfirmed';
          await options.remoteBackups.publish(operation_id, artifact);
          failure = 'history_unavailable';
          const receipt = options.remoteBackups.status(job_id);
          if (receipt?.state !== 'done') throw new Error('unconfirmed');
          const latest = currentRun(operation_id); markVerified(latest, operation_id); write(latest);
        } catch (error) {
          if (error instanceof ArchiveBackupSetupError) failure = 'setup_required';
          if (failure === 'transfer_unconfirmed') {
            try { failure = options.remoteBackups.list().find(row => row.operation_id === operation_id)?.issue ?? failure; } catch { /* preserve the last known failure */ }
          }
          if (reserved) options.remoteBackups.failed(operation_id, failure === 'export_failed' ? 'export_failed' : 'transfer_unconfirmed');
          const latest = currentRun(operation_id);
          let confirmed = false;
          if (reserved) { try { confirmed = options.remoteBackups.status(job_id)?.state === 'done'; } catch { /* retain uncertainty */ } }
          if (confirmed) markVerified(latest, operation_id);
          else {
            latest.last_run = { operation_id, started_at: latest.last_run!.started_at, finished_at: now(), outcome: 'failed', issue: failure };
            latest.alert = { operation_id, issue: failure };
          }
          write(latest);
        } finally { key?.fill(0); root?.fill(0); release(); }
      };
      active = work().finally(() => { active = undefined; startAlerts(); }); return active;
    },
    async stop(): Promise<void> { stopped = true; await Promise.allSettled([active, saving, alertActive]); },
    resume(): void { stopped = false; },
  };
  return service;
};
export type UnattendedBackups = ReturnType<typeof createUnattendedBackups>;
