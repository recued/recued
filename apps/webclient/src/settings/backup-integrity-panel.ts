import type { ArchiveBackupIntegrityPolicy, ArchiveBackupIntegrityStatus } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import { createBackupStatusRefresh, type BackupStatusRefreshOutcome } from './backup-status-refresh.js';
import { createBackupFormValidation, isBackupUtcTime, isBackupWholeNumber } from './backup-form-validation.js';

export interface BackupIntegrityPorts {
  get(): Promise<ArchiveBackupIntegrityStatus>;
  save(input: { policy: ArchiveBackupIntegrityPolicy }): Promise<ArchiveBackupIntegrityStatus>;
}
/** Stable controls preserve unsaved UTC schedules through polling/reconnect. */
export const mountBackupIntegrity = (options: {
  host: HTMLElement; document: Document; ports: BackupIntegrityPorts;
  now?: () => number;
  onRefreshPendingChange?: (pending: boolean) => void;
}) => {
  const { host, document: doc, ports } = options;
  const validation = createBackupFormValidation(doc, 'backup-integrity');
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  host.setAttribute('data-backup-integrity', '');
  host.appendChild(make('h3', 'Scheduled S3 checks'));
  host.appendChild(make('p', 'Read each retained copy at the enabled backup destination and match its full encrypted bytes to the saved checksum. Each check downloads the full copy and may incur storage fees. No recovery words are needed.'));
  const field = <T extends HTMLElement>(text: string, name: string, input: T): T => {
    const label = make('label', text); input.setAttribute(`data-backup-integrity-${name}`, ''); label.appendChild(input); host.appendChild(label); return input;
  };
  const enabled = field('Enable scheduled S3 checks ', 'enabled', make('input')); enabled.type = 'checkbox';
  const cadence = field('Repeat ', 'cadence', make('select'));
  for (const value of ['daily', 'weekly']) { const node = make('option', value === 'daily' ? 'Daily' : 'Weekly'); node.value = value; cadence.appendChild(node); }
  validation.field(cadence, host, 'cadence', () => ['daily', 'weekly'].includes(cadence.value) ? undefined : 'Choose daily or weekly S3 checks.');
  const time = field('Time (UTC) ', 'time', make('input')); time.type = 'time';
  validation.field(time, host, 'time', () => isBackupUtcTime(time.value) ? undefined : 'Enter a UTC time, such as 02:00.');
  const day = field('Weekday (weekly checks) ', 'day', make('select'));
  for (const [index, value] of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].entries()) {
    const node = make('option', value); node.value = String(index); day.appendChild(node);
  }
  validation.field(day, host, 'day', () => isBackupWholeNumber(day.value, 0, 6) ? undefined : 'Choose a weekday for S3 checks.');
  host.appendChild(make('p', 'Checks use copies that were verified before. They run one at a time while this server is on. Missed times become one scan. Existing retention rules still apply. These reads do not prove that recovery works.'));
  const status = make('p'), run = make('p'), alerts = make('p'), feedback = make('p');
  for (const [node, name] of [[status, 'status'], [run, 'run'], [alerts, 'alerts'], [feedback, 'feedback']] as const) {
    node.setAttribute(`data-backup-integrity-${name}`, ''); node.setAttribute('role', 'status');
  }
  const save = make('button', 'Save S3 check schedule'); save.type = 'button'; save.className = 'rx-btn rx-btn-secondary';
  save.setAttribute('data-backup-integrity-save', ''); host.appendChild(save);
  host.appendChild(status); host.appendChild(run); host.appendChild(alerts); host.appendChild(feedback);
  const refreshStatus = createBackupStatusRefresh({ host, document: doc, prefix: 'backup-integrity',
    ...(options.now ? { now: options.now } : {}),
    ...(options.onRefreshPendingChange ? { onPendingChange: options.onRefreshPendingChange } : {}),
  });
  let current: ArchiveBackupIntegrityStatus | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, busy = false, loading = false, dirty = false, editVersion = 0, generation = 0, refreshAfterSave = false;
  const render = (value: ArchiveBackupIntegrityStatus): void => {
    current = value;
    if (!dirty && value.monitoring !== 'unavailable') {
      enabled.checked = value.policy.enabled; cadence.value = value.policy.schedule.cadence; day.value = String(value.policy.schedule.weekday_utc);
      time.value = `${String(value.policy.schedule.hour_utc).padStart(2, '0')}:${String(value.policy.schedule.minute_utc).padStart(2, '0')}`;
    }
    status.textContent = value.monitoring === 'unavailable' ? 'The S3 check schedule could not be confirmed. Check the server clock and settings, then refresh.'
      : value.monitoring === 'not_configured' ? 'Set up an unattended backup destination before scheduled S3 checks can run.'
      : value.monitoring === 'paused' ? 'Scheduled S3 checks and their alerts are paused.'
      : `Checking retained copies at ${value.destination?.connection_name ?? 'scheduled backup storage'} · Next scan ${formatClientDateTime(value.next_run_at!)}`;
    const r = value.last_run;
    run.textContent = !r || value.monitoring === 'unavailable' ? ''
      : `${r.destination_id === value.destination?.destination_id ? 'Last scan' : 'Last scan for a prior storage destination'} ${formatClientDateTime(r.started_at)} · ${r.outcome === 'running' ? 'In progress' : r.outcome === 'failed' ? 'Needs attention' : 'Completed'}`
        + ` · ${r.checked} of ${r.total} copies checked · ${r.failed} failed · ${r.skipped} busy or removed copies skipped`
        + (r.total === 0 && r.issue !== 'history_unavailable' ? ' · No previously verified retained copies were selected' : '')
        + (r.issue === 'stopped' ? ' · Scan stopped before all copies were checked' : r.issue ? ' · Review the saved backup receipts and storage connection' : '')
        + ` · Scan ${r.operation_id}`;
    alerts.textContent = value.monitoring === 'unavailable' ? '' : value.alert_pending ? 'S3 check alert awaiting notification delivery.' : '';
    save.disabled = disposed || busy || value.monitoring === 'unavailable';
    validation.refresh();
  };
  const refresh = async (): Promise<void> => {
    if (disposed || busy || loading) return;
    loading = true; refreshAfterSave = false; const readGeneration = generation;
    let outcome: BackupStatusRefreshOutcome = 'superseded'; refreshStatus.start();
    try { const value = await ports.get(); if (!disposed && generation === readGeneration) {
      render(value); outcome = value.monitoring === 'unavailable' ? 'failure' : 'success';
    } }
    catch { if (!disposed && generation === readGeneration) {
      status.textContent = 'Scheduled S3 checks could not be confirmed. Reconnect and refresh.';
      run.textContent = alerts.textContent = ''; current = undefined; save.disabled = true;
      outcome = 'failure';
    } }
    finally {
      loading = false;
      if (!disposed) {
        if (timer !== undefined) clearTimeout(timer);
        if (refreshAfterSave) {
          refreshStatus.waitForSave();
          if (!busy) void refresh();
        } else {
          refreshStatus.finish(outcome);
          timer = setTimeout(() => { void refresh(); }, 10_000);
        }
      }
    }
  };
  for (const input of [enabled, cadence, time, day]) for (const event of ['input', 'change']) input.addEventListener(event, () => { if (disposed) return; dirty = true; editVersion++; validation.refresh(); });
  save.disabled = true;
  save.addEventListener('click', () => {
    if (disposed || busy || !current || current.monitoring === 'unavailable') return;
    if (!validation.validate()) { feedback.textContent = ''; return; }
    validation.reset();
    const [hour, minute] = time.value.split(':').map(Number);
    const policy: ArchiveBackupIntegrityPolicy = { enabled: enabled.checked, schedule: { cadence: cadence.value === 'weekly' ? 'weekly' : 'daily',
      hour_utc: hour!, minute_utc: minute!, weekday_utc: Number(day.value) } };
    busy = true; generation++; refreshAfterSave = true; refreshStatus.waitForSave();
    const submitted = editVersion; save.disabled = true; feedback.textContent = 'Saving the S3 check schedule…';
    void (async () => {
      try {
        const result = await ports.save({ policy }); if (disposed) return;
        if (JSON.stringify(result.policy) !== JSON.stringify(policy)) throw new Error('Unexpected check policy');
        dirty = editVersion !== submitted; render(result);
        feedback.textContent = result.monitoring === 'unavailable' ? 'The S3 check schedule could not be confirmed. Refresh before trying again.'
          : dirty ? 'S3 check schedule saved. Your newer edits still need saving.' : 'S3 check schedule saved.';
      } catch { if (!disposed) feedback.textContent = 'The S3 check schedule could not be confirmed. Refresh before trying again.'; }
      finally { busy = false; if (!disposed) { save.disabled = current === undefined || current.monitoring === 'unavailable'; void refresh(); } }
    })();
  });
  void refresh();
  return { refresh, dispose(): void { disposed = true; generation++; validation.dispose(); refreshStatus.dispose(); save.disabled = true; if (timer !== undefined) clearTimeout(timer); } };
};
