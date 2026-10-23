/** Production backup status panels with held replies; no server or S3 access. */
import type { ArchiveBackupHealthStatus, ArchiveBackupIntegrityStatus, ArchiveRemoteBackup, ArchiveRemoteDestination, ArchiveUnattendedStatus } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountRemoteBackups } from '../../src/settings/remote-backups-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'health' | 'integrity' | 'history' | 'destinations' | 'unattended' | 'save-health' | 'save-integrity' | 'save-unattended';
type Outcome = 'success' | 'error' | 'unavailable';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style'); style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}`; document.head.appendChild(style);
let now = 1_700_000_000_000;
const destination: ArchiveRemoteDestination = { connection_name: 'Fixture backup storage', destination_id: 'a'.repeat(64), endpoint: 'https://storage.example.test', bucket: 'backups', region: 'us-east-1', prefix: '' };
let health: ArchiveBackupHealthStatus = { checked_at: now, monitoring: 'active', destination, watched_since: now,
  policy: { alerts_enabled: true, backup_max_age_hours: 36, recovery_max_age_days: 30 }, alerts: [], backup: { state: 'waiting', due_at: now + 3_600_000 }, recovery: { state: 'waiting', due_at: now + 86_400_000 } };
let integrity: ArchiveBackupIntegrityStatus = { monitoring: 'active', destination, next_run_at: now + 86_400_000,
  policy: { enabled: true, schedule: { cadence: 'weekly', hour_utc: 3, minute_utc: 0, weekday_utc: 0 } } };
let unattended: ArchiveUnattendedStatus = { configured: false };
const receipt: ArchiveRemoteBackup = { operation_id: '12345678-1234-4234-8234-123456789abc', job_id: 'fixture-job', destination,
  object_key: 'recued-backups/fixture/archive', created_at: now, state: 'verified', keep_last: 5, bytes: 8000, sha256: 'b'.repeat(64), verified_at: now };
const calls: Array<{ kind: Kind; policy?: unknown }> = [];
const expensive: string[] = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = <T>(kind: Kind, response: (outcome: Outcome) => T, policy?: unknown): Promise<T> => {
  calls.push({ kind, ...(policy === undefined ? {} : { policy }) });
  return new Promise((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture reply was already released.'); released = true;
      if (outcome === 'error') { reject(new Error('private provider fixture failure')); return; }
      resolve(response(outcome));
    } });
  });
};
const panel = mountRemoteBackups({ host, document, now: () => now, onRestore: () => { expensive.push('restore'); return true; }, ports: {
  destinations: () => request('destinations', () => ({ destinations: [destination] })),
  list: () => request('history', () => ({ backups: [receipt] })),
  check: async () => { expensive.push('check'); throw new Error('No S3 reads in this fixture.'); },
  retrieve: async () => { expensive.push('retrieve'); throw new Error('No retrievals in this fixture.'); },
  unattended: {
    get: async () => { calls.push({ kind: 'unattended' }); return structuredClone(unattended); },
    save: input => request('save-unattended', () => {
      unattended = { configured: true, settings: input.settings }; return structuredClone(unattended);
    }, input.settings),
  },
  health: {
    get: () => {
      const snapshot = structuredClone(health);
      return request<ArchiveBackupHealthStatus>('health', outcome => outcome === 'unavailable'
        ? { ...snapshot, monitoring: 'unavailable', issue: 'settings_unavailable' } : snapshot);
    },
    save: input => request('save-health', () => { health = { ...health, policy: input.policy }; return structuredClone(health); }, input.policy),
  },
  integrity: {
    get: () => {
      const snapshot = structuredClone(integrity);
      return request<ArchiveBackupIntegrityStatus>('integrity', outcome => outcome === 'unavailable'
        ? { ...snapshot, monitoring: 'unavailable', issue: 'settings_unavailable' } : snapshot);
    },
    save: input => request('save-integrity', () => { integrity = { ...integrity, policy: input.policy }; return structuredClone(integrity); }, input.policy),
  },
} });
const controls = {
  calls, expensive,
  release(kind: Kind, index = 0, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture reply: ${kind} ${index}`);
    item.finish(outcome);
  },
  advance(ms: number) { now += ms; },
  refresh() { void panel.refresh(); },
  dispose() { panel.dispose(); },
};
declare global { interface Window { __backupStatus: typeof controls } }
window.__backupStatus = controls;
