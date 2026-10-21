import type { ArchiveBackupHealthPolicy, ArchiveBackupHealthStatus } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';

export interface BackupHealthPorts {
  get(): Promise<ArchiveBackupHealthStatus>;
  save(input: { policy: ArchiveBackupHealthPolicy }): Promise<ArchiveBackupHealthStatus>;
}
/** Poll receipts without repainting the owner's unsaved age limits. */
export const mountBackupHealth = (options: { host: HTMLElement; document: Document; ports: BackupHealthPorts }) => {
  const { host, document: doc, ports } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  host.setAttribute('data-backup-health', '');
  host.appendChild(make('h3', 'Backup health'));
  host.appendChild(make('p', 'Health checks follow the enabled backup schedule and use saved receipts. They do not read S3 or run recovery tests. A recent passing test may cover an older copy.'));
  const status = make('p'), backup = make('p'), recovery = make('p'), alerts = make('p'), feedback = make('p');
  for (const [node, name] of [[status, 'status'], [backup, 'backup'], [recovery, 'recovery'], [alerts, 'alerts'], [feedback, 'feedback']] as const) {
    node.setAttribute(`data-backup-health-${name}`, ''); node.setAttribute('role', 'status');
  }
  host.appendChild(status); host.appendChild(backup); host.appendChild(recovery); host.appendChild(alerts);
  const field = (text: string, name: string, type: string) => {
    const label = make('label', text), input = make('input'); input.type = type;
    input.setAttribute(`data-backup-health-${name}`, ''); label.appendChild(input); host.appendChild(label); return input;
  };
  const enabled = field('Send health alerts ', 'enabled', 'checkbox');
  const hours = field('Latest verified backup within (hours) ', 'hours', 'number'); hours.min = '1'; hours.max = '8760'; hours.step = '1';
  const days = field('Passing recovery test within (days) ', 'days', 'number'); days.min = '1'; days.max = '365'; days.step = '1';
  host.appendChild(make('p', 'Alerts use your notification settings while this server is running. First-copy and first-test grace periods start when this destination is first monitored.'));
  const save = make('button', 'Save health limits'); save.type = 'button'; save.className = 'rx-btn rx-btn-secondary';
  save.setAttribute('data-backup-health-save', ''); host.appendChild(save); host.appendChild(feedback);
  let disposed = false, busy = false, loading = false, dirty = false, editVersion = 0, generation = 0;
  let current: ArchiveBackupHealthStatus | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const render = (value: ArchiveBackupHealthStatus): void => {
    current = value;
    if (!dirty && value.monitoring !== 'unavailable') {
      enabled.checked = value.policy.alerts_enabled; hours.value = String(value.policy.backup_max_age_hours); days.value = String(value.policy.recovery_max_age_days);
    }
    status.textContent = value.monitoring === 'unavailable' ? value.issue === 'settings_unavailable'
      ? 'Health settings could not be read or saved. Check the server, then refresh.' : 'The backup schedule could not be checked. Refresh before relying on health status.'
      : value.monitoring === 'not_configured' ? 'Set up a backup schedule to monitor its destination.'
      : value.monitoring === 'paused' ? 'Scheduled backups are paused. Health alerts are paused too.'
      : `Monitoring ${value.destination?.connection_name ?? 'scheduled backup storage'} · Checked ${formatClientDateTime(value.checked_at)}`;
    const b = value.backup, r = value.recovery;
    const unknown = (issue: 'history_unavailable' | 'clock_changed' | undefined) => issue === 'clock_changed' ? 'Check the server clock.' : 'Saved history could not be read.';
    backup.textContent = !b ? '' : b.state === 'unavailable' ? `Backup age is unknown. ${unknown(b.issue)}`
      : `${b.state === 'due' ? 'Backup overdue' : b.created_at === undefined ? 'Waiting for the first verified backup' : 'Verified backup within the age limit'}`
        + (b.created_at === undefined ? ' · No verified copy is recorded for this destination' : ` · Backup started ${formatClientDateTime(b.created_at)} · Backup ${b.operation_id}`)
        + ` · Fresh copy due ${formatClientDateTime(b.due_at!)}`;
    recovery.textContent = !r ? '' : r.state === 'unavailable' ? `Recovery test age is unknown. ${unknown(r.issue)}`
      : `${r.state === 'due' ? 'Recovery test overdue' : r.finished_at === undefined ? 'Waiting for the first passing recovery test' : 'Passing recovery test within the age limit'}`
        + (r.finished_at === undefined ? '' : ` · Passed ${formatClientDateTime(r.finished_at)} · Test ${r.operation_id}`)
        + ` · Test due ${formatClientDateTime(r.due_at!)}`;
    alerts.textContent = !value.policy.alerts_enabled ? 'Health alerts are off. Receipt checks stay available.'
      : value.alerts.some(a => a.delivery === 'pending') ? 'Health alert awaiting notification delivery.'
      : value.alerts.length ? 'Health alert delivered for the current condition.' : '';
    save.disabled = disposed || busy || value.monitoring === 'unavailable';
  };
  const refresh = async (): Promise<void> => {
    if (disposed || busy || loading) return;
    loading = true; const readGeneration = generation;
    try { const value = await ports.get(); if (!disposed && generation === readGeneration) render(value); }
    catch { if (!disposed && generation === readGeneration) {
      status.textContent = 'Backup health could not be checked. Reconnect and refresh.';
      backup.textContent = recovery.textContent = alerts.textContent = ''; current = undefined; save.disabled = true;
    } }
    finally {
      loading = false;
      if (!disposed) { if (timer !== undefined) clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 10_000); }
    }
  };
  for (const input of [enabled, hours, days]) for (const event of ['input', 'change']) input.addEventListener(event, () => { dirty = true; editVersion++; });
  save.disabled = true;
  save.addEventListener('click', () => {
    if (disposed || busy || !current || current.monitoring === 'unavailable') return;
    const policy: ArchiveBackupHealthPolicy = { alerts_enabled: enabled.checked, backup_max_age_hours: Number(hours.value), recovery_max_age_days: Number(days.value) };
    if (!Number.isInteger(policy.backup_max_age_hours) || policy.backup_max_age_hours < 1 || policy.backup_max_age_hours > 8760
      || !Number.isInteger(policy.recovery_max_age_days) || policy.recovery_max_age_days < 1 || policy.recovery_max_age_days > 365) {
      feedback.textContent = 'Choose 1 to 8760 hours for backups and 1 to 365 days for recovery tests.'; return;
    }
    busy = true; generation++; const submitted = editVersion; save.disabled = true; feedback.textContent = 'Saving health limits…';
    void (async () => {
      try {
        const result = await ports.save({ policy }); if (disposed) return;
        if (result.policy.alerts_enabled !== policy.alerts_enabled || result.policy.backup_max_age_hours !== policy.backup_max_age_hours
          || result.policy.recovery_max_age_days !== policy.recovery_max_age_days) throw new Error('Unexpected health policy');
        dirty = editVersion !== submitted; render(result);
        feedback.textContent = result.issue === 'settings_unavailable' ? 'Health limits could not be confirmed. Refresh before trying again.'
          : dirty ? 'Health limits saved. Your newer edits still need saving.' : 'Health limits saved.';
      } catch { if (!disposed) feedback.textContent = 'Health limits could not be confirmed. Refresh before trying again.'; }
      finally { busy = false; if (!disposed) { save.disabled = current === undefined || current.monitoring === 'unavailable'; void refresh(); } }
    })();
  });
  void refresh();
  return { refresh, dispose(): void { disposed = true; generation++; save.disabled = true; if (timer !== undefined) clearTimeout(timer); } };
};
