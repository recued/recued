/** Production backup status panels with held replies; no server or S3 access. */
import type { ArchiveBackupHealthStatus, ArchiveBackupIntegrityStatus, ArchiveRemoteBackup, ArchiveRemoteDestination, ArchiveRemoteTarget, ArchiveRestoreDrill, ArchiveUnattendedStatus, BackupWatchdogSave, BackupWatchdogStatus } from '@recued/contracts';
import { generateRecoveryKey } from '@recued/crypto';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountRemoteBackups } from '../../src/settings/remote-backups-panel.js';
import { ARCHIVE_BACKUP_PANEL_STYLES, mountArchiveBackupPanel, type ArchiveDownloadFn } from '../../src/settings/archive-backup-panel.js';
import { createArchiveDownload } from '../../src/settings/archive-download.js';
import { connectArchiveDownloadSocket } from '../../src/settings/archive-download-connection.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'health' | 'integrity' | 'watchdog' | 'history' | 'destinations' | 'unattended' | 'save-health' | 'save-integrity' | 'save-watchdog' | 'save-unattended' | 'drills' | 'start-drill' | 'cancel-drill' | 'cleanup-drill' | 'check' | 'retrieve';
type Outcome = 'success' | 'error' | 'invalid-args' | 'unavailable' | 'mismatch' | 'unconfigured' | 'malformed' | 'applied-error';
const host = document.querySelector<HTMLElement>('#panel')!;
const style = document.createElement('style'); style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${ARCHIVE_BACKUP_PANEL_STYLES}`; document.head.appendChild(style);
let now = 1_700_000_000_000;
let destination: ArchiveRemoteDestination = { connection_name: 'Fixture backup storage', destination_id: 'a'.repeat(64), endpoint: 'https://storage.example.test', bucket: 'backups', region: 'us-east-1', prefix: '' };
let health: ArchiveBackupHealthStatus = { checked_at: now, monitoring: 'active', destination, watched_since: now,
  policy: { alerts_enabled: true, backup_max_age_hours: 36, recovery_max_age_days: 30 }, alerts: [], backup: { state: 'waiting', due_at: now + 3_600_000 }, recovery: { state: 'waiting', due_at: now + 86_400_000 } };
let integrity: ArchiveBackupIntegrityStatus = { monitoring: 'active', destination, next_run_at: now + 86_400_000,
  policy: { enabled: true, schedule: { cadence: 'weekly', hour_utc: 3, minute_utc: 0, weekday_utc: 0 } } };
let unattended: ArchiveUnattendedStatus = new URL(location.href).searchParams.get('schedule') === 'configured'
  ? { configured: true, settings: { enabled: true, connection_name: destination.connection_name, destination_id: destination.destination_id,
    keep_last: 5, schedule: { cadence: 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 } } } : { configured: false };
let holdScheduleReads = false;
const showWatchdog = new URL(location.href).searchParams.has('watchdog');
let watchdog: BackupWatchdogStatus = { configured: true, enabled: true, state: 'acknowledged',
  last_attempt_at: now - 1_000, last_acknowledged_at: now - 1_000 };
let receipt: ArchiveRemoteBackup = { operation_id: '12345678-1234-4234-8234-123456789abc', job_id: 'fixture-job', destination,
  object_key: 'recued-backups/fixture/archive', created_at: now, state: 'verified', keep_last: 5, bytes: 8000, sha256: 'b'.repeat(64), verified_at: now };
let receiptVisible = true;
type RecoveryMode = 'empty' | 'running' | 'cleanup';
const recoveryMode = new URL(location.href).searchParams.get('drills');
const recoveryRows = (mode: RecoveryMode): ArchiveRestoreDrill[] => mode === 'empty' ? [] : [{
  operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: receipt.operation_id,
  destination_id: destination.destination_id, archive_sha256: receipt.sha256!, archive_bytes: receipt.bytes!, started_at: now,
  ...(mode === 'running' ? { state: 'retrieving' as const } : { state: 'failed' as const, issue: 'cleanup_failed' as const, finished_at: now, cleanup_pending: true }),
}];
let drills = recoveryRows(recoveryMode === 'running' || recoveryMode === 'cleanup' ? recoveryMode : 'empty');
let holdRecoveryReads = false;
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
      if (outcome === 'invalid-args') { reject({ code: 'invalid_args', message: 'private provider fixture invalid arguments' }); return; }
      try { resolve(response(outcome)); } catch (error) { reject(error); }
    } });
  });
};
const panel = mountRemoteBackups({ host, document, now: () => now, onRestore: () => { expensive.push('restore'); return true; }, ports: {
  destinations: () => request('destinations', () => ({ destinations: [destination] })),
  list: () => request('history', () => ({ backups: receiptVisible ? [receipt] : [] })),
  check: ({ operation_id }) => { expensive.push('check'); return request('check', () => structuredClone(receipt), { operation_id }); },
  retrieve: ({ operation_id }) => {
    expensive.push('retrieve');
    return request('retrieve', outcome => ({ staged_name: outcome === 'malformed' ? '../invalid-archive' : `recued-upload-${'d'.repeat(32)}.recued.archive` }), { operation_id });
  },
  ...(showWatchdog ? { watchdog: {
    get: () => {
      const snapshot = structuredClone(watchdog);
      return request<BackupWatchdogStatus>('watchdog', outcome => outcome === 'unavailable'
        ? { configured: false, enabled: false, state: 'unavailable', issue: 'settings_unavailable' } : snapshot);
    },
    save: (input: BackupWatchdogSave) => request('save-watchdog', () => {
      const configured = !input.forget && (watchdog.configured || !!input.ping_url);
      watchdog = { configured, enabled: input.enabled, state: !configured ? 'not_configured' : input.enabled ? 'waiting' : 'paused' };
      return structuredClone(watchdog);
    }, { enabled: input.enabled, forget: input.forget === true }),
  } } : {}),
  ...(recoveryMode === null ? {} : { drills: {
    list: () => {
      const snapshot = structuredClone(drills);
      if (holdRecoveryReads) return request('drills', () => ({ drills: snapshot }));
      calls.push({ kind: 'drills' }); return Promise.resolve({ drills: snapshot });
    },
    start: ({ operation_id, backup_operation_id }: { operation_id: string; backup_operation_id: string }) => {
      expensive.push('start-drill');
      return request('start-drill', () => {
        const row: ArchiveRestoreDrill = { ...recoveryRows('running')[0]!, operation_id, backup_operation_id };
        drills = [row]; return structuredClone(row);
      }, { operation_id, backup_operation_id });
    },
    cancel: ({ operation_id }: { operation_id: string }) => {
      expensive.push('cancel-drill');
      return request('cancel-drill', () => {
        const row = drills.find(row => row.operation_id === operation_id)!;
        row.cancel_requested_at = now; return structuredClone(row);
      }, { operation_id });
    },
    cleanup: ({ operation_id }: { operation_id: string }) => {
      expensive.push('cleanup-drill');
      return request('cleanup-drill', () => {
        const row = drills.find(row => row.operation_id === operation_id)!;
        delete row.cleanup_pending; row.cleanup_completed_at = now; return structuredClone(row);
      }, { operation_id });
    },
  } }),
  unattended: {
    get: () => {
      const snapshot = structuredClone(unattended);
      if (holdScheduleReads) return request<ArchiveUnattendedStatus>('unattended', outcome => outcome === 'malformed' ? { configured: true } : snapshot);
      calls.push({ kind: 'unattended' }); return Promise.resolve(snapshot);
    },
    save: input => request('save-unattended', outcome => {
      if (outcome === 'mismatch') return structuredClone(unattended);
      if (outcome === 'unconfigured') return { configured: false };
      if (outcome === 'malformed') return { configured: true };
      unattended = { configured: true, settings: input.settings };
      if (outcome === 'applied-error') throw new Error('Fixture lost the schedule save reply.');
      return structuredClone(unattended);
    }, input.settings),
  },
  health: {
    get: () => {
      const snapshot = structuredClone(health);
      return request<ArchiveBackupHealthStatus>('health', outcome => outcome === 'unavailable'
        ? { ...snapshot, monitoring: 'unavailable', issue: 'settings_unavailable' }
        : outcome === 'malformed' ? { ...snapshot, policy: { ...snapshot.policy, backup_max_age_hours: 0 } } : snapshot);
    },
    save: input => request<ArchiveBackupHealthStatus>('save-health', outcome => {
      if (outcome === 'mismatch') return structuredClone(health);
      if (outcome === 'unavailable' || outcome === 'malformed') return { ...structuredClone(health), policy: input.policy,
        monitoring: outcome === 'unavailable' ? 'unavailable' : 'unknown' as ArchiveBackupHealthStatus['monitoring'],
        ...(outcome === 'unavailable' ? { issue: 'settings_unavailable' as const } : {}) };
      health = { ...health, policy: input.policy };
      if (outcome === 'applied-error') throw new Error('Fixture lost the health save reply.');
      return structuredClone(health);
    }, input.policy),
  },
  integrity: {
    get: () => {
      const snapshot = structuredClone(integrity);
      return request<ArchiveBackupIntegrityStatus>('integrity', outcome => outcome === 'unavailable'
        ? { ...snapshot, monitoring: 'unavailable', issue: 'settings_unavailable' }
        : outcome === 'malformed' ? { ...snapshot, policy: { ...snapshot.policy, schedule: { ...snapshot.policy.schedule, hour_utc: 24 } } } : snapshot);
    },
    save: input => request<ArchiveBackupIntegrityStatus>('save-integrity', outcome => {
      if (outcome === 'mismatch') return structuredClone(integrity);
      if (outcome === 'unavailable' || outcome === 'malformed') return { ...structuredClone(integrity), policy: input.policy,
        monitoring: outcome === 'unavailable' ? 'unavailable' : 'unknown' as ArchiveBackupIntegrityStatus['monitoring'],
        ...(outcome === 'unavailable' ? { issue: 'settings_unavailable' as const } : {}) };
      integrity = { ...integrity, policy: input.policy };
      if (outcome === 'applied-error') throw new Error('Fixture lost the S3 schedule save reply.');
      return structuredClone(integrity);
    }, input.policy),
  },
} });
const manualExports: Array<{ remote: ArchiveRemoteTarget | null }> = [];
let manualStatusCalls = 0, manualImportCalls = 0, manualWords = '';
const manualDownloadMode = new URL(location.href).searchParams.get('export-download');
const manualDownloadBytes = Number(new URL(location.href).searchParams.get('download-bytes') ?? '8000');
const manualSetupMode = manualDownloadMode?.startsWith('setup-') === true;
const manualStreamMode = manualDownloadMode === 'stream' || manualDownloadMode === 'stream-expiring' || manualSetupMode;
const manualExpiresAt = manualDownloadMode === null || manualDownloadMode === 'unknown' ? undefined
  : Date.now() + (manualDownloadMode === 'setup-expiring' ? 10_000 : manualStreamMode ? manualDownloadMode === 'stream-expiring' ? 30_000 : 3_600_000
    : manualDownloadMode === 'expired' || manualDownloadMode === 'remote-only' ? -1 : 60_000);
let manualDownload: Parameters<ArchiveDownloadFn>[0] | undefined, manualDownloadCalls = 0, manualDownloadCancelled = 0;
type ManualStream = { reqId: string; bytes: number; starts: number; closes: number; text(value: string): void; binary(value: ArrayBuffer): void; closed(): void; error(): void };
const manualStreams: ManualStream[] = [], manualStreamSaves: number[] = [];
const setupSignals: AbortSignal[] = [], setupReads: Array<{ release(): void; released: boolean }> = [];
class SetupSocket extends EventTarget {
  state = 0;
  constructor(readonly stream: ManualStream) { super(); }
  send(text: string): void { this.stream.reqId = (JSON.parse(text) as { req_id: string }).req_id; this.stream.starts++; }
  close(): void { this.stream.closes++; this.serverClose(); }
  serverClose(): void { this.state = 3; this.dispatchEvent(new Event('close')); }
  open(): void { if (this.state !== 3) this.state = 1; this.dispatchEvent(new Event('open')); }
}
const setupSockets: SetupSocket[] = [];
const streamDownload = createArchiveDownload({
  openSocket: async signal => {
    if (manualSetupMode) {
      setupSignals.push(signal);
      if (manualDownloadMode === 'setup-credentials') await new Promise<void>(resolve => {
        const read = { released: false, release() { read.released = true; resolve(); } }; setupReads.push(read);
      });
      signal.throwIfAborted();
    }
    const stream: ManualStream = { reqId: '', bytes: 0, starts: 0, closes: 0, text: () => {}, binary: () => {}, closed: () => {}, error: () => {} };
    manualStreams.push(stream);
    if (manualSetupMode) {
      const socket = new SetupSocket(stream); setupSockets.push(socket);
      stream.text = value => { socket.dispatchEvent(new MessageEvent('message', { data: value })); };
      stream.binary = value => { socket.dispatchEvent(new MessageEvent('message', { data: value })); };
      stream.closed = () => socket.serverClose(); stream.error = () => { socket.dispatchEvent(new Event('error')); };
      return connectArchiveDownloadSocket(socket as unknown as WebSocket, signal);
    }
    return { send: text => { stream.reqId = (JSON.parse(text) as { req_id: string }).req_id; stream.starts++; },
      close: () => { stream.closes++; stream.closed(); }, onText: callback => { stream.text = callback; }, onBinary: callback => { stream.binary = callback; },
      onClose: callback => { stream.closed = callback; }, onError: callback => { stream.error = callback; } };
  },
  saveBlob: (_name, parts) => { manualStreamSaves.push(parts.reduce((total, part) => total + part.byteLength, 0)); },
  newReqId: () => `fixture-download-${manualStreams.length}`,
});
const manualHost = new URL(location.href).searchParams.has('manual-storage') || manualDownloadMode !== null ? document.createElement('section') : undefined;
if (manualHost) host.parentElement!.appendChild(manualHost);
const manualArchive = manualHost ? mountArchiveBackupPanel({ host: manualHost, document, remoteTarget: () => panel.target(),
  ...(manualDownloadMode === null ? {} : { resumeExportStart: () => Promise.resolve({ job_id: 'fixture-existing-export' }) }),
  ...(manualDownloadMode === null || manualDownloadMode === 'server-path' ? {} : { archiveDownload: ((request) => {
    manualDownloadCalls++; expensive.push('manual-download');
    if (manualStreamMode) { const cancel = streamDownload(request); return () => { manualDownloadCancelled++; cancel(); }; }
    manualDownload = request; request.onProgress?.(0); return () => { manualDownloadCancelled++; };
  }) satisfies ArchiveDownloadFn }),
  runExport: async input => {
    // Record public delivery settings only; synthetic words stay in this browser.
    manualExports.push({ remote: input.remote ? structuredClone(input.remote) : null }); expensive.push('manual-export');
    return { job_id: 'fixture-manual-export' };
  },
  runStatus: async () => {
    manualStatusCalls++; const remote = manualExports.at(-1)?.remote;
    return { state: 'done', bytes_written: manualDownloadBytes, progress_pct: 100,
      ...(manualDownloadMode === 'remote-only' ? { remote_backup_id: receipt.operation_id }
        : remote ? { remote_backup_id: remote.operation_id } : { path: '/fixture/manual-backup.recued.archive' }),
      ...(manualExpiresAt === undefined ? {} : { expires_at: manualExpiresAt }) };
  },
  runImport: async () => { manualImportCalls++; throw new Error('No restore in this fixture.'); },
}) : undefined;
const controls = {
  calls, expensive,
  release(kind: Kind, index = 0, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture reply: ${kind} ${index}`);
    item.finish(outcome);
  },
  advance(ms: number) { now += ms; },
  holdRecoveryReads() { holdRecoveryReads = true; },
  holdScheduleReads() { holdScheduleReads = true; },
  setHealthPolicy(policy: ArchiveBackupHealthStatus['policy']) { health = { ...health, policy: structuredClone(policy) }; },
  setIntegrityPolicy(policy: ArchiveBackupIntegrityStatus['policy']) { integrity = { ...integrity, policy: structuredClone(policy) }; },
  setStorageDestinationId(id: string) { destination = { ...destination, destination_id: id }; },
  setRecoveryBackup(update: Partial<ArchiveRemoteBackup> | null) {
    receiptVisible = update !== null;
    if (update) receipt = { ...receipt, ...structuredClone(update) };
  },
  fillManualWords() {
    const input = manualHost?.querySelector<HTMLTextAreaElement>('[data-recued-archive-backup-mnemonic]');
    if (!input) throw new Error('Open the manual backup entry first.');
    manualWords = generateRecoveryKey().mnemonic; input.value = manualWords; input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  manualState() {
    return { exports: manualExports, statusCalls: manualStatusCalls, importCalls: manualImportCalls,
      downloadCalls: manualDownloadCalls, downloadCancelled: manualDownloadCancelled, expiresAt: manualExpiresAt,
      wordsPreserved: manualWords !== '' && manualHost?.querySelector<HTMLTextAreaElement>('[data-recued-archive-backup-mnemonic]')?.value === manualWords };
  },
  finishManualDownload(outcome: 'done' | 'error') {
    if (!manualDownload) throw new Error('Start a fixture download first.');
    const request = manualDownload; manualDownload = undefined;
    if (outcome === 'done') request.onDone(); else request.onError('fixture connection closed');
  },
  streamState() {
    return { sockets: manualStreams.map(({ reqId, bytes, starts, closes }) => ({ reqId, bytes, starts, closes })), savedBytes: [...manualStreamSaves] };
  },
  setupState() {
    return { aborted: setupSignals.map(signal => signal.aborted), readsReleased: setupReads.map(read => read.released), sockets: setupSockets.map(socket => ({ state: socket.state, closes: socket.stream.closes })) };
  },
  releaseSetupRead(index: number) {
    const read = setupReads[index]; if (!read || read.released) throw new Error('No held setup read.'); read.release();
  },
  openSetupSocket(index: number) {
    const socket = setupSockets[index]; if (!socket) throw new Error('No pending setup socket.'); socket.open();
  },
  streamChunk(index: number, values: number[]) {
    const stream = manualStreams[index]; if (!stream) throw new Error('Open a fixture stream first.');
    const chunk = Uint8Array.from(values); stream.bytes += chunk.byteLength; stream.binary(chunk.buffer);
  },
  streamBytes(index: number, length: number) {
    const stream = manualStreams[index]; if (!stream) throw new Error('Open a fixture stream first.');
    stream.bytes += length; stream.binary(new ArrayBuffer(length));
  },
  streamText(index: number, text: string) {
    const stream = manualStreams[index]; if (!stream) throw new Error('Open a fixture stream first.');
    stream.text(text);
  },
  streamControl(index: number, type: 'complete' | 'noise' | 'error' | 'close', sizeBytes?: number) {
    const stream = manualStreams[index]; if (!stream) throw new Error('Open a fixture stream first.');
    if (type === 'complete') stream.text(JSON.stringify({ type: 'download_complete', req_id: stream.reqId, size_bytes: sizeBytes ?? stream.bytes }));
    else if (type === 'noise') { stream.text('not-json'); stream.text('{"type":"ping"}'); }
    else if (type === 'error') stream.error(); else stream.closed();
  },
  setScheduleTime(hour: number, minute = 0) {
    if (!unattended.settings) throw new Error('Configure a fixture schedule first.');
    unattended = { ...unattended, settings: { ...unattended.settings, schedule: { ...unattended.settings.schedule, hour_utc: hour, minute_utc: minute } } };
  },
  refresh() { void panel.refresh(); },
  dispose() { manualArchive?.dispose(); manualWords = ''; panel.dispose(); },
};
declare global { interface Window { __backupStatus: typeof controls } }
window.__backupStatus = controls;
