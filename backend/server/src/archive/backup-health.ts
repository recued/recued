/** Passive receipt health. No recovery factors, archive work, provider reads,
 * or retention authority enter this service. Only notification delivery yields. */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { RpcError, type ArchiveBackupHealthAlertKind, type ArchiveBackupHealthPolicy,
  type ArchiveBackupHealthStatus, type ArchiveUnattendedStatus } from '@recued/contracts';
import { writeFileAtomicSync } from '../durable-fs.js';
import { archiveImportOperationId } from './archive-import-receipts.js';
import { createRemoteBackupStore } from './remote-backup-store.js';
import { createRestoreDrillStore } from './restore-drill-store.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const KINDS: ArchiveBackupHealthAlertKind[] = ['backup_overdue', 'recovery_stale', 'evidence_unavailable'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).every(k => keys.includes(k));
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && archiveImportOperationId(v) === v;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);
const validPolicy = (v: unknown): v is ArchiveBackupHealthPolicy => object(v)
  && only(v, ['alerts_enabled', 'backup_max_age_hours', 'recovery_max_age_days']) && typeof v.alerts_enabled === 'boolean'
  && integer(v.backup_max_age_hours) && v.backup_max_age_hours >= 1 && v.backup_max_age_hours <= 8760
  && integer(v.recovery_max_age_days) && v.recovery_max_age_days >= 1 && v.recovery_max_age_days <= 365;
interface Episode {
  id: string; kind: ArchiveBackupHealthAlertKind; first_detected_at: number;
  last_attempt_at?: number; delivered_at?: number;
}
interface Saved {
  v: 1; policy?: ArchiveBackupHealthPolicy;
  watch?: { id: string; destination_id: string; started_at: number; backup_entries?: number; recovery_entries?: number };
  alerts: Episode[];
}
export const backupHealthPath = (dbPath: string): string => `${resolve(dbPath)}.backup-health.json`;
export const createBackupHealth = (options: {
  dbPath: string; schedule(): ArchiveUnattendedStatus;
  notify(message: { title: string; text: string; link_url: string }, episodeId: string): Promise<boolean>;
  canRun?: () => boolean; now?: () => number;
}) => {
  const path = backupHealthPath(options.dbPath), now = options.now ?? Date.now;
  const backups = createRemoteBackupStore(options.dbPath), drills = createRestoreDrillStore(options.dbPath);
  let stopped = false, active: Promise<void> | undefined;
  const read = (): Saved => {
    let raw: Buffer;
    try {
      if (statSync(path).size > 16_384) throw new Error('Health settings exceed their limit');
      raw = readFileSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, alerts: [] }; throw error; }
    if (raw.length > 16_384) throw new Error('Health settings exceed their limit');
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!object(value) || value.v !== 1 || !only(value, ['v', 'policy', 'watch', 'alerts'])
      || (value.policy !== undefined && !validPolicy(value.policy)) || !Array.isArray(value.alerts) || value.alerts.length > KINDS.length) throw new Error('Invalid health settings');
    const watch = value.watch;
    if (watch !== undefined && (!object(watch) || !only(watch, ['id', 'destination_id', 'started_at', 'backup_entries', 'recovery_entries'])
      || !uuid(watch.id) || !hash(watch.destination_id) || !integer(watch.started_at)
      || ['backup_entries', 'recovery_entries'].some(k => { const count = watch[k]; return count !== undefined && (!integer(count) || count > 4096); }))) throw new Error('Invalid health watch');
    const kinds = new Set<string>(), ids = new Set<string>();
    for (const alert of value.alerts) {
      if (!object(alert) || !only(alert, ['id', 'kind', 'first_detected_at', 'last_attempt_at', 'delivered_at'])
        || !uuid(alert.id) || typeof alert.kind !== 'string' || !KINDS.includes(alert.kind as ArchiveBackupHealthAlertKind)
        || !integer(alert.first_detected_at) || (alert.last_attempt_at !== undefined && !integer(alert.last_attempt_at))
        || (alert.delivered_at !== undefined && (!integer(alert.delivered_at) || alert.last_attempt_at === undefined))
        || watch === undefined || kinds.has(alert.kind) || ids.has(alert.id)) throw new Error('Invalid health alert');
      kinds.add(alert.kind); ids.add(alert.id);
    }
    return value as unknown as Saved;
  };
  const write = (saved: Saved): void => { writeFileAtomicSync(path, `${JSON.stringify(saved)}\n`); };
  const defaults = (weekly = false): ArchiveBackupHealthPolicy => ({ alerts_enabled: true, backup_max_age_hours: weekly ? 192 : 36, recovery_max_age_days: 30 });
  const observe = (): { status: ArchiveBackupHealthStatus; saved?: Saved } => {
    const at = now();
    let saved: Saved;
    try { saved = read(); }
    catch { return { status: { checked_at: at, policy: defaults(), monitoring: 'unavailable', issue: 'settings_unavailable', alerts: [] } }; }
    const before = JSON.stringify(saved);
    let schedule: ArchiveUnattendedStatus;
    try { schedule = options.schedule(); }
    catch { return { status: { checked_at: at, policy: saved.policy ?? defaults(), monitoring: 'unavailable', issue: 'schedule_unavailable', alerts: [] } }; }
    const settings = schedule.settings, policy = saved.policy ?? defaults(settings?.schedule.cadence === 'weekly');
    const status: ArchiveBackupHealthStatus = { checked_at: at, policy: structuredClone(policy),
      monitoring: !schedule.configured || !settings ? 'not_configured' : !settings.enabled ? 'paused' : 'active', alerts: [] };
    if (settings) status.destination = { connection_name: settings.connection_name, destination_id: settings.destination_id };
    const desired = new Set<ArchiveBackupHealthAlertKind>();
    if (status.monitoring === 'active' && settings) {
      if (saved.watch?.destination_id !== settings.destination_id) {
        saved.watch = { id: randomUUID(), destination_id: settings.destination_id, started_at: at }; saved.alerts = [];
      }
      const watch = saved.watch!; status.watched_since = watch.started_at;
      const checkState = (last: number | undefined, age: number) => {
        const due_at = (last ?? watch.started_at) + age;
        return { state: at >= due_at ? 'due' as const : last === undefined ? 'waiting' as const : 'current' as const, due_at };
      };
      try {
        const allRows = backups.rows();
        if (allRows.length < (watch.backup_entries ?? 0)) throw new Error('Backup history lost receipts');
        watch.backup_entries = allRows.length;
        const rows = allRows.filter(row => row.destination_fingerprint === settings.destination_id);
        const copies = rows.filter(row => row.state === 'verified' || (row.state === 'verifying'
          && row.verified_at !== undefined && row.sha256 !== undefined && row.bytes !== undefined && row.issue === undefined));
        if (watch.started_at > at || copies.some(row => row.created_at > at || row.verified_at! > at)) {
          status.backup = { state: 'unavailable', issue: 'clock_changed' };
        } else {
          const copy = copies.reduce<(typeof copies)[number] | undefined>((best, row) => !best || row.created_at > best.created_at ? row : best, undefined);
          const age = !copy && rows.some(row => row.verified_at !== undefined)
            ? { state: 'due' as const, due_at: at }
            : checkState(copy?.created_at, policy.backup_max_age_hours * HOUR);
          status.backup = { ...age,
            ...(copy ? { operation_id: copy.operation_id, created_at: copy.created_at, verified_at: copy.verified_at } : {}) };
        }
        try {
          const byId = new Map(rows.map(row => [row.operation_id, row]));
          const allDrills = drills.rows();
          if (allDrills.length < (watch.recovery_entries ?? 0)) throw new Error('Recovery history lost receipts');
          watch.recovery_entries = allDrills.length;
          const passes = allDrills.filter(row => {
            const copy = byId.get(row.backup_operation_id);
            return row.destination_id === settings.destination_id && row.state === 'succeeded' && row.checks !== undefined && row.finished_at !== undefined
              && copy?.verified_at !== undefined && row.archive_sha256 === copy.sha256 && row.archive_bytes === copy.bytes;
          });
          if (watch.started_at > at || passes.some(row => row.started_at > at || row.finished_at! > at)) status.recovery = { state: 'unavailable', issue: 'clock_changed' };
          else {
            const pass = passes.reduce<(typeof passes)[number] | undefined>((best, row) => !best || row.finished_at! > best.finished_at! ? row : best, undefined);
            status.recovery = { ...checkState(pass?.finished_at, policy.recovery_max_age_days * DAY),
              ...(pass ? { operation_id: pass.operation_id, backup_operation_id: pass.backup_operation_id, finished_at: pass.finished_at } : {}) };
          }
        } catch { status.recovery = { state: 'unavailable', issue: 'history_unavailable' }; }
      } catch {
        status.backup = status.recovery = { state: 'unavailable', issue: 'history_unavailable' };
      }
      if (status.backup?.state === 'due') desired.add('backup_overdue');
      if (status.recovery?.state === 'due') desired.add('recovery_stale');
      if (status.backup?.state === 'unavailable' || status.recovery?.state === 'unavailable') desired.add('evidence_unavailable');
    }
    const episodes: Episode[] = [];
    if (policy.alerts_enabled) for (const kind of KINDS) {
      const prior = saved.alerts.find(a => a.kind === kind);
      if (desired.has(kind)) episodes.push(prior ?? { id: randomUUID(), kind, first_detected_at: at });
      // Unreadable evidence cannot prove that an overdue condition recovered.
      // Keep its identity/acknowledgment, but send only currently provable alerts.
      else if (prior && ((kind === 'backup_overdue' && status.backup?.state === 'unavailable')
        || (kind === 'recovery_stale' && status.recovery?.state === 'unavailable'))) episodes.push(prior);
    }
    saved.alerts = episodes;
    try { if (JSON.stringify(saved) !== before) write(saved); }
    catch { return { status: { checked_at: at, policy: structuredClone(policy), monitoring: 'unavailable', issue: 'settings_unavailable', alerts: [] } }; }
    status.alerts = saved.alerts.filter(a => desired.has(a.kind)).map(a => ({ kind: a.kind, first_detected_at: a.first_detected_at, delivery: a.delivered_at === undefined ? 'pending' : 'delivered' }));
    return { status, saved };
  };
  const deliver = async (): Promise<void> => {
    for (const kind of KINDS) {
      if (stopped || options.canRun?.() === false) return;
      const { status, saved } = observe();
      if (status.monitoring !== 'active' || !saved) return;
      if (!status.alerts.some(a => a.kind === kind)) continue;
      const alert = saved.alerts.find(a => a.kind === kind), at = now();
      if (!alert || alert.delivered_at !== undefined || (alert.last_attempt_at !== undefined && at - alert.last_attempt_at < HOUR)) continue;
      alert.last_attempt_at = at; write(saved); // Durable intent/throttle before any route call.
      const text = kind === 'backup_overdue'
        ? 'No verified backup is recent enough for your saved age limit. Open Backup & Recovery to check the schedule and storage receipts.'
        : kind === 'recovery_stale'
        ? 'No passing recovery test is recent enough for your saved age limit. Open Backup & Recovery and test a verified copy with its recovery words.'
        : 'Backup health could not be checked from saved receipts. Open Backup & Recovery to check the history and server clock.';
      let accepted = false;
      try { accepted = await options.notify({ title: 'Backup health needs attention', text, link_url: '#settings/backup' }, alert.id); }
      catch { /* Route errors stay out of storage and UI; retry the pending episode. */ }
      if (accepted) {
        // Re-evaluate evidence and re-read after the await. A late acknowledgment
        // cannot clear another episode or overwrite a policy/destination edit.
        const latest = observe().saved, current = latest?.alerts.find(a => a.id === alert.id);
        if (current && latest && latest.watch?.id === saved.watch?.id) { current.delivered_at = now(); write(latest); }
      }
    }
  };
  // Establish a first-evidence grace period even when no browser is open.
  observe();
  return {
    status(): ArchiveBackupHealthStatus { return observe().status; },
    save(policy: unknown): ArchiveBackupHealthStatus {
      if (!validPolicy(policy)) throw new RpcError('invalid_args', 'Choose alerts, 1 to 8760 hours for backups, and 1 to 365 days for recovery tests.', 400);
      let saved: Saved;
      try { saved = read(); saved.policy = structuredClone(policy); write(saved); }
      catch { throw new RpcError('not_configured', 'Backup health settings could not be read or saved. Check the server before trying again.', 503); }
      return observe().status;
    },
    tick(): Promise<void> {
      if (stopped || options.canRun?.() === false) return Promise.resolve();
      observe();
      if (!active) active = deliver().catch(() => { /* Keep durable pending intent; the next tick retries. */ }).finally(() => { active = undefined; });
      return active;
    },
    async stop(): Promise<void> { stopped = true; await Promise.allSettled([active]); },
    resume(): void { stopped = false; },
  };
};
export type BackupHealth = ReturnType<typeof createBackupHealth>;
