import type { ArchiveBackupHealthStatus, ArchiveBackupIntegrityStatus, ArchiveRemoteDestination, ArchiveUnattendedStatus, BackupWatchdogStatus } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import type { WebclientConnectionStatusController } from '../realtime/connection-status.js';
import type { ArchiveImportReceiptController } from './archive-import-receipt.js';

export type RestoreReadinessItem = 'schedule' | 'backup' | 'recovery' | 'integrity' | 'alerts' | 'monitor' | 'drill';
type State = 'ready' | 'attention' | 'waiting' | 'optional' | 'unavailable';
interface Row { id: RestoreReadinessItem; label: string; state: State; detail: string }
/** Read-only ports: opening this checklist cannot re-enroll keys, send a ping,
 * scan S3, start a backup, or attest to receiving an alert. */
export interface RestoreReadinessPorts {
  assertCurrentPair?: () => Promise<void>;
  destinations?: () => Promise<{ destinations: ArchiveRemoteDestination[] }>;
  unattended?: { get(): Promise<ArchiveUnattendedStatus> };
  health?: { get(): Promise<ArchiveBackupHealthStatus> };
  integrity?: { get(): Promise<ArchiveBackupIntegrityStatus> };
  watchdog?: { get(): Promise<BackupWatchdogStatus> };
}
export interface RestoreReadinessOptions {
  ports: RestoreReadinessPorts;
  connection?: Pick<WebclientConnectionStatusController, 'status' | 'onStatus'>;
  onReview?: (item: RestoreReadinessItem) => void;
}
interface Snapshot { destinations?: unknown; unattended?: unknown; health?: unknown; integrity?: unknown; watchdog?: unknown }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> | undefined => object(value) ? value : undefined;
const time = (value: unknown, now: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= now;
const LABELS: Record<RestoreReadinessItem, string> = { schedule: 'Backup schedule', backup: 'Verified backup', recovery: 'Recovery test', integrity: 'Scheduled S3 checks', alerts: 'Health alerts', monitor: 'Offline monitor', drill: 'Monitor alert drill' };
const IDS: RestoreReadinessItem[] = ['schedule', 'backup', 'recovery', 'integrity', 'alerts', 'monitor', 'drill'];

/** Current server reads only. Imported Passport claims and the completed
 * restore itself never count as backup, scan, ping, or alert-route evidence. */
export const buildRestoreReadiness = (snapshot: Snapshot, now: number): Row[] => {
  const rows = new Map<RestoreReadinessItem, Row>();
  const set = (id: RestoreReadinessItem, state: State, detail: string) => rows.set(id, { id, label: LABELS[id], state, detail });
  for (const id of IDS) set(id, 'unavailable', 'Status could not be checked. Reconnect and check again.');
  const u = record(snapshot.unattended), settings = record(u?.settings), destinations = record(snapshot.destinations)?.destinations;
  const bound = typeof settings?.connection_name === 'string' && typeof settings.destination_id === 'string'
    && Array.isArray(destinations) && destinations.some((value: unknown) => {
      const d = record(value); return d?.connection_name === settings.connection_name && d?.destination_id === settings.destination_id;
    });
  if (u?.configured === false) set('schedule', 'attention', 'Set up unattended backups on this server with your recovery words once. The words are not saved.');
  else if (u?.configured === true && settings?.enabled === false) set('schedule', 'attention', 'Scheduled backups are paused. Review the saved schedule before enabling it.');
  else if (u?.configured === true && settings?.enabled === true) {
    const run = record(u.last_run);
    if (!bound) set('schedule', 'attention', 'Refresh backup storage and choose the current destination before relying on this schedule.');
    else if (run?.issue === 'setup_required' || run?.issue === 'vault_unavailable') set('schedule', 'attention', 'The saved backup key needs attention. Check the vault and complete setup if required.');
    else if (run?.outcome === 'failed' || run?.issue === 'retention_pending' || u.alert_pending === true) set('schedule', 'attention', 'The latest backup run or its failure alert needs attention. Review its result before relying on the schedule.');
    else set('schedule', 'ready', 'The saved schedule is enabled and its storage connection is available. Check the next run in Unattended encrypted backups.');
  }
  const h = record(snapshot.health), policy = record(h?.policy);
  const matches = (value: Record<string, unknown> | undefined) => {
    const d = record(value?.destination);
    return u?.configured === true && settings?.enabled === true && bound && d?.connection_name === settings.connection_name && d?.destination_id === settings.destination_id;
  };
  if (h?.monitoring === 'paused' || h?.monitoring === 'not_configured') {
    set('backup', 'attention', 'Enable a backup schedule to check its destination and backup age.');
    set('recovery', 'attention', 'Review recovery tests after the backup schedule is enabled.');
    set('alerts', 'attention', 'Health alerts are paused until the backup schedule is enabled.');
  } else if (h?.monitoring === 'active' && matches(h) && time(h.checked_at, now) && now - h.checked_at <= 60_000) {
    for (const id of ['backup', 'recovery'] as const) {
      const age = record(h[id]), isBackup = id === 'backup';
      if (age?.state === 'current' && time(isBackup ? age.created_at : age.finished_at, now) && typeof age.due_at === 'number'
        && Number.isSafeInteger(age.due_at) && age.due_at <= 8_640_000_000_000_000 && age.due_at > now) {
        set(id, 'ready', isBackup ? 'A verified backup is within its age limit. Rechecking an old copy does not make its data fresh.' : 'A passing recovery test is within its age limit. It may cover an earlier copy; test the copy you plan to use.');
      } else if (age?.state === 'waiting') set(id, 'waiting', isBackup ? 'Waiting for a first verified backup. Review the next scheduled run or make a backup.' : 'Waiting for a first passing recovery test. Select a verified copy and choose Test recovery.');
      else if (age?.state === 'due' || (age?.state === 'current' && time(age.due_at, now))) set(id, 'attention', isBackup ? 'A verified backup is overdue. Check the last run and create a fresh copy.' : 'A passing recovery test is overdue. Select a verified copy and test recovery.');
    }
    if (policy?.alerts_enabled === false) set('alerts', 'attention', 'Health alerts are off. Review your health limits and notification settings.');
    else if (policy?.alerts_enabled === true && Array.isArray(h.alerts)) {
      const pending = h.alerts.some((value: unknown) => record(value)?.delivery === 'pending') || u?.alert_pending === true;
      set('alerts', pending ? 'attention' : 'ready', pending ? 'An alert is waiting for a notification route. Review your notification settings.' : 'Health alerts are enabled. Check your notification route; these settings do not prove a message reached you.');
    }
  }
  const scan = record(snapshot.integrity), scanPolicy = record(scan?.policy), run = record(scan?.last_run);
  if (scan && scan.monitoring !== 'unavailable' && ['active', 'paused', 'not_configured'].includes(String(scan.monitoring)) && typeof scanPolicy?.enabled === 'boolean') {
    const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const counts = run && count(run.total) && count(run.checked) && count(run.failed) && count(run.skipped)
      ? { total: run.total, checked: run.checked, failed: run.failed, skipped: run.skipped } : undefined;
    if (run?.outcome === 'failed' || (counts && counts.failed > 0)) set('integrity', 'attention', 'The last S3 scan failed. Review stored copies before relying on them.');
    else if (counts && run?.outcome === 'completed' && (counts.skipped > 0 || counts.checked < counts.total)) set('integrity', 'attention', 'The last S3 scan was partial. Skipped or unchecked copies still need review.');
    else if (scanPolicy.enabled === false) set('integrity', 'optional', 'Scheduled S3 checks are off. You can enable them to read and check retained copies.');
    else if (scan.monitoring !== 'active' || !matches(scan)) set('integrity', 'attention', 'S3 checks need an enabled backup schedule and its current storage destination.');
    else if (run?.outcome === 'running') set('integrity', 'waiting', 'An S3 scan is in progress. Wait for its result.');
    else if (counts && run?.outcome === 'completed' && run.destination_id === settings?.destination_id && counts.total > 0 && counts.checked === counts.total && counts.skipped === 0 && time(run.finished_at, now)) set('integrity', 'ready', 'The last scan checked all selected copies. It does not prove the latest copy will restore.');
    else set('integrity', 'waiting', 'No complete passing S3 scan is recorded. An empty scan does not prove that backups passed.');
  }
  const w = record(snapshot.watchdog);
  const validMonitor = w && typeof w.configured === 'boolean' && typeof w.enabled === 'boolean'
    && (w.state === 'not_configured' ? !w.configured && !w.enabled : w.state === 'paused' ? w.configured && !w.enabled : w.configured && w.enabled);
  const monitorCopy: Record<string, string> = {
    not_configured: 'Set up an external monitor on another host and save its success-ping URL here.',
    paused: 'Monitor pings are off. Review the monitor setup and its external alert route.',
    waiting: 'Waiting for the first eligible ping. Check that the monitor sees it.', sending: 'A ping is in progress. Wait for acknowledgment.',
    blocked: 'Pings are blocked by backup proof that needs attention. Review backup health and S3 checks.',
    failed: 'The last ping could not be confirmed. Check the monitor host and saved setup.',
    drill_paused: 'Pings are paused for your alert drill. Review its deadline and result.',
  };
  if (validMonitor && typeof w.state === 'string') {
    if (w.state === 'acknowledged' && time(w.last_acknowledged_at, now)) set('monitor', now - w.last_acknowledged_at <= 5 * 60_000 ? 'ready' : 'attention', now - w.last_acknowledged_at <= 5 * 60_000
      ? 'A ping was acknowledged within the last five minutes. Check its alert route on the monitor host; this does not prove alert delivery.'
      : 'The last ping acknowledgment is over five minutes old. Check the monitor host and wait for a fresh ping.');
    else if (Object.hasOwn(monitorCopy, w.state)) set('monitor', w.state === 'waiting' || w.state === 'sending' ? 'waiting' : 'attention', monitorCopy[w.state]!);
    if (w.state !== 'unavailable' && (w.state === 'acknowledged' || Object.hasOwn(monitorCopy, w.state))) {
      const d = record(w.drill);
      if (!d) set('drill', 'attention', 'Test the monitor alert route after a healthy ping. Report an alert only if it reaches you.');
      else if (d.current_configuration === false) set('drill', 'attention', 'The saved drill belongs to an earlier monitor setup. Test the current alert route.');
      else if (d.current_configuration === true && d.phase === 'completed' && time(d.started_at, now) && time(d.alert_reported_at, now) && time(d.ping_acknowledged_at, now) && time(d.resumed_at, now)
        && d.alert_reported_at >= d.started_at && d.resumed_at >= d.started_at && d.ping_acknowledged_at >= d.resumed_at && time(d.finished_at, now)
        && d.finished_at >= Math.max(d.alert_reported_at, d.ping_acknowledged_at)) set('drill', 'ready', 'For this monitor setup, you reported receiving an alert and a ping was acknowledged after resumption. Alert delivery was not independently verified.');
      else if (d.current_configuration === true && ['paused', 'resuming', 'awaiting_confirmation'].includes(String(d.phase))) set('drill', 'waiting', 'The alert drill is still open. Review its pause, your alert report, and the resumption ping separately.');
      else set('drill', 'attention', 'No completed alert drill is confirmed for this setup. Review or test the current alert route.');
    }
  }
  return IDS.map(id => rows.get(id)!);
};

export const mountPostRestoreReadiness = (options: RestoreReadinessOptions & {
  host: HTMLElement; document: Document; receipt: ArchiveImportReceiptController; timeoutMs?: number;
}): (() => void) => {
  const { host, document: doc, receipt, ports } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  host.setAttribute('data-restore-readiness', ''); host.setAttribute('hidden', '');
  host.appendChild(make('h3', 'After restore: check backups and alerts'));
  host.appendChild(make('p', 'This restore is confirmed. Review this server’s current setup and saved proof below. Backup keys and monitor setup may need attention after a move. Keep your recovery words separately.'));
  host.appendChild(make('style', '[data-restore-readiness]{min-width:0;overflow-wrap:anywhere}[data-restore-readiness] ul{padding-inline-start:1.25rem}[data-restore-readiness] li{margin-block:1rem}[data-restore-readiness] button{max-width:100%;white-space:normal}'));
  const status = make('p'); status.setAttribute('role', 'status'); status.setAttribute('data-restore-readiness-status', ''); host.appendChild(status);
  const check = make('button', 'Refresh readiness'); check.type = 'button'; check.className = 'rx-btn rx-btn-secondary'; check.setAttribute('data-restore-readiness-refresh', ''); host.appendChild(check);
  const list = make('ul'); host.appendChild(list);
  const nodes = IDS.map(id => {
    const li = make('li'); li.setAttribute('data-restore-readiness-item', id);
    const title = make('strong', LABELS[id]), detail = make('p'), review = make('button', `Review ${LABELS[id].toLowerCase()}`);
    review.type = 'button'; review.className = 'rx-btn rx-btn-secondary'; review.setAttribute('data-restore-readiness-review', id);
    review.addEventListener('click', () => { if (!disposed && receipt.read() === 'completed') options.onReview?.(id); });
    if (!options.onReview) review.setAttribute('hidden', '');
    li.appendChild(title); li.appendChild(detail); li.appendChild(review); list.appendChild(li); return { li, detail };
  });
  let disposed = false, generation = 0, active = false, busy = false;
  const pending = new Set<keyof Snapshot | 'pair'>(), cancels = new Set<() => void>();
  const connected = () => !options.connection || options.connection.status() === 'connected';
  const render = (rows: Row[]) => rows.forEach((row, index) => {
    const node = nodes[index]!; node.li.setAttribute('data-restore-readiness-state', row.state); node.detail.textContent = row.detail;
  });
  const cancelReads = () => { generation++; for (const cancel of cancels) cancel(); cancels.clear(); busy = false; check.setAttribute('aria-disabled', 'false'); };
  // A timed-out underlying RPC remains counted until it settles. Repeated
  // refreshes cannot accumulate unresolved requests for a status source.
  const read = async (key: keyof Snapshot | 'pair', get: (() => Promise<unknown>) | undefined): Promise<unknown> => {
    if (!get || pending.has(key)) return undefined;
    pending.add(key); const own = generation;
    return new Promise(resolve => {
      const finish = (value?: unknown) => { clearTimeout(timer); cancels.delete(cancel); resolve(value); };
      const cancel = () => finish();
      const timer = setTimeout(cancel, options.timeoutMs ?? 5000); cancels.add(cancel);
      void Promise.resolve().then(() => disposed || own !== generation ? undefined : get()).then(finish, () => finish()).finally(() => { pending.delete(key); });
    });
  };
  const refresh = async () => {
    if (disposed || receipt.read() !== 'completed' || busy) return;
    cancelReads(); const own = generation;
    render(buildRestoreReadiness({}, Date.now()));
    if (!connected()) { status.textContent = 'Connection lost. Reconnect and refresh readiness.'; return; }
    busy = true; check.setAttribute('aria-disabled', 'true'); status.textContent = 'Checking this server’s backup and monitor status…';
    const [destinations, unattended, health, integrity, watchdog] = await Promise.all([
      read('destinations', ports.destinations ? () => ports.destinations!() : undefined),
      read('unattended', ports.unattended ? () => ports.unattended!.get() : undefined),
      read('health', ports.health ? () => ports.health!.get() : undefined),
      read('integrity', ports.integrity ? () => ports.integrity!.get() : undefined),
      read('watchdog', ports.watchdog ? () => ports.watchdog!.get() : undefined),
    ]);
    if (disposed || own !== generation || receipt.read() !== 'completed' || !connected()) return;
    const pair = await read('pair', ports.assertCurrentPair ? async () => { await ports.assertCurrentPair!(); return true; } : async () => true);
    if (disposed || own !== generation || receipt.read() !== 'completed' || !connected()) return;
    const now = Date.now(); render(buildRestoreReadiness(pair === true ? { destinations, unattended, health, integrity, watchdog } : {}, now));
    status.textContent = `Status read ${formatClientDateTime(now)}. Refresh after changing setup. Reading this checklist starts no backups or tests.`;
    busy = false; check.setAttribute('aria-disabled', 'false');
  };
  const update = () => {
    if (disposed) return;
    if (receipt.read() !== 'completed') {
      active = false; cancelReads(); render(buildRestoreReadiness({}, Date.now())); host.setAttribute('hidden', ''); return;
    }
    host.removeAttribute('hidden'); if (!active) { active = true; void refresh(); }
  };
  check.addEventListener('click', () => { void refresh(); });
  const detachReceipt = receipt.subscribe(update);
  const detachConnection = options.connection?.onStatus(() => {
    if (!active || disposed) return;
    if (!connected()) { cancelReads(); render(buildRestoreReadiness({}, Date.now())); status.textContent = 'Connection lost. Reconnect and refresh readiness.'; }
    else void refresh();
  });
  update();
  return () => { disposed = true; cancelReads(); detachReceipt(); detachConnection?.(); };
};
