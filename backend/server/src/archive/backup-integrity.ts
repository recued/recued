/** Opt-in, sequential rechecks of retained ciphertext. Durable slot claims
 * prevent restart storms; interrupted scans wait for the next scheduled slot.
 * No recovery factor, archive export, or new retention policy belongs here. */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { RpcError, type ArchiveBackupIntegrityIssue, type ArchiveBackupIntegrityPolicy,
  type ArchiveBackupIntegrityRun, type ArchiveBackupIntegrityStatus, type ArchiveUnattendedStatus } from '@recued/contracts';
import { writeFileAtomicSync } from '../durable-fs.js';
import { archiveImportOperationId } from './archive-import-receipts.js';
import { createRemoteBackupStore } from './remote-backup-store.js';
import type { RemoteBackups } from './remote-backups.js';
import { nextBackupTime, validateBackupSchedule } from './unattended-backups.js';
import { settleWithin, STOP_GRACE_MS } from '../lifecycle/settle-within.js';

const HOUR = 3_600_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).every(k => keys.includes(k));
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && archiveImportOperationId(v) === v;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const issues: ArchiveBackupIntegrityIssue[] = ['interrupted', 'export_failed', 'destination_unavailable',
  'transfer_unconfirmed', 'verification_failed', 'history_unavailable', 'stopped'];
const defaults = (): ArchiveBackupIntegrityPolicy => ({ enabled: false,
  schedule: { cadence: 'weekly', hour_utc: 3, minute_utc: 0, weekday_utc: 0 } });
const policyOf = (v: unknown): ArchiveBackupIntegrityPolicy => {
  if (!object(v) || !only(v, ['enabled', 'schedule']) || typeof v.enabled !== 'boolean') {
    throw new RpcError('invalid_args', 'Choose whether to recheck stored copies and a daily or weekly UTC time.', 400);
  }
  return { enabled: v.enabled, schedule: validateBackupSchedule(v.schedule) };
};
interface Saved {
  v: 1; policy: ArchiveBackupIntegrityPolicy; next_run_at: number; backup_entries?: number;
  last_run?: ArchiveBackupIntegrityRun;
  alerted_run_id?: string;
  alert?: { id: string; destination_id: string; first_detected_at: number; last_attempt_at?: number };
}
export const backupIntegrityPath = (dbPath: string): string => `${resolve(dbPath)}.backup-integrity.json`;
export const createBackupIntegrity = (options: {
  dbPath: string; schedule(): ArchiveUnattendedStatus;
  remoteBackups: Pick<RemoteBackups, 'recheck'>;
  notify(message: { title: string; text: string; link_url: string }, episodeId: string): Promise<boolean>;
  canRun?: () => boolean; now?: () => number;
}) => {
  const path = backupIntegrityPath(options.dbPath), now = options.now ?? Date.now;
  const store = createRemoteBackupStore(options.dbPath);
  let active: Promise<void> | undefined, alertActive: Promise<void> | undefined, controller: AbortController | undefined, stopped = false;
  const read = (): Saved | undefined => {
    let raw: Buffer;
    try {
      if (statSync(path).size > 16_384) throw new Error('Integrity settings exceed their limit');
      raw = readFileSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (raw.length > 16_384) throw new Error('Integrity settings exceed their limit');
    const v: unknown = JSON.parse(raw.toString('utf8'));
    if (!object(v) || v.v !== 1 || !only(v, ['v', 'policy', 'next_run_at', 'last_run', 'alert', 'alerted_run_id', 'backup_entries'])
      || !integer(v.next_run_at) || (v.backup_entries !== undefined && (!integer(v.backup_entries) || v.backup_entries > 4096))
      || (v.alerted_run_id !== undefined && !uuid(v.alerted_run_id))) throw new Error('Invalid integrity settings');
    policyOf(v.policy);
    const run = v.last_run, alert = v.alert;
    if (run !== undefined && (!object(run) || !only(run, ['operation_id', 'destination_id', 'started_at', 'finished_at', 'outcome', 'total', 'checked', 'failed', 'skipped', 'issue'])
      || !uuid(run.operation_id) || !hash(run.destination_id) || !integer(run.started_at)
      || !['running', 'completed', 'failed'].includes(String(run.outcome))
      || !integer(run.total) || run.total > 4096 || !integer(run.checked) || !integer(run.failed) || !integer(run.skipped)
      || run.failed > run.checked || run.checked + run.skipped > run.total
      || (run.finished_at !== undefined && (!integer(run.finished_at) || run.finished_at < run.started_at))
      || (run.outcome === 'running' ? run.finished_at !== undefined : run.finished_at === undefined)
      || (run.outcome === 'completed' && (run.failed !== 0 || run.checked + run.skipped !== run.total || run.issue !== undefined))
      || (run.outcome === 'failed' && run.issue === undefined)
      || (run.issue !== undefined && !issues.includes(run.issue as ArchiveBackupIntegrityIssue)))) throw new Error('Invalid integrity run');
    if (alert !== undefined && (!object(alert) || !only(alert, ['id', 'destination_id', 'first_detected_at', 'last_attempt_at'])
      || !uuid(alert.id) || !hash(alert.destination_id) || !integer(alert.first_detected_at)
      || (alert.last_attempt_at !== undefined && !integer(alert.last_attempt_at)))) throw new Error('Invalid integrity alert');
    return v as unknown as Saved;
  };
  const write = (saved: Saved): void => writeFileAtomicSync(path, `${JSON.stringify(saved)}\n`);
  const failAlert = (saved: Saved, run: ArchiveBackupIntegrityRun): void => {
    if (saved.alerted_run_id === run.operation_id) return;
    if (!saved.alert || saved.alert.destination_id !== run.destination_id) {
      saved.alert = { id: randomUUID(), destination_id: run.destination_id, first_detected_at: now() };
    }
    saved.alerted_run_id = run.operation_id;
  };
  const reconcile = (): void => {
    const saved = read(), run = saved?.last_run;
    if (!saved || !run || run.outcome !== 'running' || run.started_at > now()) return;
    run.outcome = 'failed'; run.finished_at = now(); run.issue = 'interrupted'; failAlert(saved, run); write(saved);
  };
  const context = (): { status: ArchiveBackupIntegrityStatus; saved?: Saved } => {
    let saved: Saved | undefined;
    try { saved = read(); }
    catch { return { status: { policy: defaults(), monitoring: 'unavailable', issue: 'settings_unavailable' } }; }
    const policy = saved?.policy ?? defaults();
    let source: ArchiveUnattendedStatus;
    try { source = options.schedule(); }
    catch { return { status: { policy: structuredClone(policy), monitoring: 'unavailable', issue: 'schedule_unavailable' } }; }
    const settings = source.settings;
    const status: ArchiveBackupIntegrityStatus = { policy: structuredClone(policy),
      monitoring: !source.configured || !settings ? 'not_configured' : !policy.enabled || !settings.enabled ? 'paused' : 'active',
      ...(settings ? { destination: { connection_name: settings.connection_name, destination_id: settings.destination_id } } : {}),
      ...(saved?.last_run ? { last_run: structuredClone(saved.last_run) } : {}),
      ...(saved?.alert && saved.alert.destination_id === settings?.destination_id ? { alert_pending: true } : {}) };
    if (saved?.last_run && saved.last_run.started_at > now()) {
      status.monitoring = 'unavailable'; status.issue = 'clock_changed';
    }
    if (status.monitoring === 'active' && saved) status.next_run_at = saved.next_run_at;
    return { status, saved };
  };
  const deliver = async (): Promise<void> => {
    const { status, saved } = context(), alert = saved?.alert, at = now();
    if (stopped || options.canRun?.() === false || status.monitoring !== 'active' || !saved || !alert
      || alert.destination_id !== status.destination?.destination_id
      || (alert.last_attempt_at !== undefined && at - alert.last_attempt_at < HOUR)) return;
    alert.last_attempt_at = at; write(saved); // Durable intent before the route call.
    let accepted = false;
    try { accepted = await options.notify({ title: 'Stored backup check needs attention',
      text: 'A scheduled S3 backup check did not finish successfully. A copy could not be read and matched to its saved bytes, or the check was interrupted. Open Backup & Recovery to review the check and storage receipts.',
      link_url: '#settings/backup' }, alert.id); } catch { /* Retry without saving provider text. */ }
    if (accepted) {
      const latest = read();
      if (latest?.alert?.id === alert.id) { delete latest.alert; write(latest); }
    }
  };
  const startAlerts = (): void => {
    if (stopped || alertActive || options.canRun?.() === false) return;
    alertActive = deliver().catch(() => { /* Durable intent survives route or storage failure. */ }).finally(() => { alertActive = undefined; });
  };
  const run = async (saved: Saved, destinationId: string): Promise<void> => {
    const attempt: ArchiveBackupIntegrityRun = { operation_id: randomUUID(), destination_id: destinationId, started_at: now(),
      outcome: 'running', total: 0, checked: 0, failed: 0, skipped: 0 };
    let ids: string[] = [];
    try {
      const allRows = store.rows();
      if (allRows.length < (saved.backup_entries ?? 0)) throw new Error('Backup history lost receipts');
      saved.backup_entries = allRows.length;
      const rows = allRows.filter(row => row.destination_fingerprint === destinationId
        && row.verified_at !== undefined && row.state !== 'pruned' && row.state !== 'pruning');
      if (rows.some(row => row.bytes === undefined || row.sha256 === undefined)) throw new Error('Incomplete verified receipt');
      ids = rows.map(row => row.operation_id); attempt.total = ids.length;
    } catch { attempt.outcome = 'failed'; attempt.issue = 'history_unavailable'; attempt.finished_at = now(); }
    saved.last_run = attempt; saved.next_run_at = nextBackupTime(saved.policy.schedule, now());
    if (attempt.outcome === 'failed') failAlert(saved, attempt);
    write(saved); // Consume/coalesce the slot before any provider request.
    if (attempt.outcome === 'failed') return;
    const abort = new AbortController(); controller = abort;
    try {
      for (const id of ids) {
        const before = context();
        if (stopped || options.canRun?.() === false || before.status.monitoring !== 'active'
          || before.status.destination?.destination_id !== destinationId) { attempt.issue = 'stopped'; break; }
        let failed: ArchiveBackupIntegrityIssue | undefined, skipped = false;
        try {
          const receipt = await options.remoteBackups.recheck(id, abort.signal);
          if (receipt === null) skipped = true;
          else if (receipt.state !== 'verified') failed = receipt.issue ?? 'transfer_unconfirmed';
        } catch { failed = 'history_unavailable'; }
        const latest = read();
        if (!latest || latest.last_run?.operation_id !== attempt.operation_id) return;
        // Pausing/stopping cancels this read; it is not a corruption verdict.
        if (abort.signal.aborted || stopped || options.canRun?.() === false) { attempt.issue = 'stopped'; break; }
        if (skipped) attempt.skipped++; else attempt.checked++;
        if (failed) { attempt.failed++; attempt.issue = failed; failAlert(latest, attempt); }
        latest.last_run = structuredClone(attempt); write(latest); startAlerts();
      }
      const latest = read();
      if (!latest || latest.last_run?.operation_id !== attempt.operation_id) return;
      attempt.outcome = attempt.failed > 0 || attempt.issue === 'stopped' ? 'failed' : 'completed';
      attempt.finished_at = Math.max(now(), attempt.started_at);
      latest.last_run = attempt; write(latest);
    } finally { if (controller === abort) controller = undefined; }
  };
  try { reconcile(); } catch { /* Invalid history never prevents server boot. */ }
  return {
    status(): ArchiveBackupIntegrityStatus { return context().status; },
    save(value: unknown): ArchiveBackupIntegrityStatus {
      const policy = policyOf(value);
      try {
        const previous = read(), same = previous?.policy.enabled && policy.enabled
          && JSON.stringify(previous.policy.schedule) === JSON.stringify(policy.schedule);
        const saved: Saved = { v: 1, ...previous, policy, next_run_at: same ? previous.next_run_at : nextBackupTime(policy.schedule, now()) };
        write(saved); if (!policy.enabled) controller?.abort();
      } catch { throw new RpcError('not_configured', 'Stored backup check settings could not be read or saved. Check the server before trying again.', 503); }
      return context().status;
    },
    tick(): Promise<void> {
      if (stopped || options.canRun?.() === false) return Promise.resolve();
      if (active) { startAlerts(); return active; }
      try { reconcile(); } catch { return Promise.resolve(); }
      const { status, saved } = context();
      if (status.monitoring !== 'active' || !saved || !status.destination) return Promise.resolve();
      if (saved.next_run_at <= now()) {
        active = run(saved, status.destination.destination_id).catch(() => { /* An unfinished durable claim is reconciled on the next tick. */ })
          .finally(() => { active = undefined; startAlerts(); });
      }
      startAlerts(); return active ?? Promise.resolve();
    },
    /** ⛔ BOUNDED, for a restart's 5 s drain step: what a stop cuts short is
     *  an aborted recheck, recorded as stopped, and an alert push. A pause or a maintenance window waits for all of it (`settled`). */
    async stop(): Promise<void> { stopped = true; controller?.abort(); await settleWithin(Promise.allSettled([active, alertActive]), STOP_GRACE_MS); },
    async settled(): Promise<void> { await Promise.allSettled([active, alertActive]); },
    resume(): void { stopped = false; },
  };
};
export type BackupIntegrity = ReturnType<typeof createBackupIntegrity>;
