import type { ArchiveRemoteDestination, ArchiveUnattendedSettings, ArchiveUnattendedStatus } from '@recued/contracts';
import { ARCHIVE_UNATTENDED_ISSUE_TEXT } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';

export interface UnattendedBackupsPorts {
  get(): Promise<ArchiveUnattendedStatus>;
  save(input: { settings: ArchiveUnattendedSettings; recoveryKey?: string }): Promise<ArchiveUnattendedStatus>;
}
export const mountUnattendedBackups = (options: { host: HTMLElement; document: Document; ports: UnattendedBackupsPorts }) => {
  const { host, document: doc, ports } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  host.setAttribute('data-unattended-backups', '');
  host.appendChild(make('h3', 'Unattended encrypted backups'));
  host.appendChild(make('p', 'Set up once with your recovery words. The server saves an encrypted backup key and runs while this browser is closed. Keep your recovery words separately: you still need them to restore.'));
  const label = <T extends HTMLElement>(text: string, control: T, attribute: string): T => {
    const node = make('label', text); control.setAttribute(attribute, ''); node.appendChild(control); host.appendChild(node); return control;
  };
  const enabled = label('Enable scheduled backups ', make('input'), 'data-unattended-enabled'); enabled.type = 'checkbox'; enabled.checked = true;
  const destination = label('Backup storage ', make('select'), 'data-unattended-destination');
  const cadence = label('Repeat ', make('select'), 'data-unattended-cadence');
  for (const value of ['daily', 'weekly']) { const node = make('option', value === 'daily' ? 'Daily' : 'Weekly'); node.value = value; cadence.appendChild(node); } cadence.value = 'daily';
  const time = label('Time (UTC) ', make('input'), 'data-unattended-time'); time.type = 'time'; time.value = '02:00';
  const day = label('Weekday (weekly backups) ', make('select'), 'data-unattended-day');
  for (const [index, value] of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].entries()) {
    const node = make('option', value); node.value = String(index); day.appendChild(node);
  } day.value = '0';
  const keep = label('Backups to keep ', make('input'), 'data-unattended-keep'); keep.type = 'number'; keep.min = '1'; keep.max = '30'; keep.step = '1'; keep.value = '5';
  const words = label('Recovery words (first setup or replace backup key) ', make('input'), 'data-unattended-words');
  words.type = 'password'; words.autocomplete = 'off'; words.spellcheck = false;
  host.appendChild(make('p', 'Failure alerts use your notification settings. Missed times become one backup when the server is available. Older remote copies are removed only after a new copy is verified.'));
  const save = make('button', 'Save backup schedule'); save.type = 'button'; save.className = 'rx-btn rx-btn-primary'; save.setAttribute('data-unattended-save', ''); host.appendChild(save);
  const status = make('p'); status.setAttribute('role', 'status'); status.setAttribute('data-unattended-status', ''); host.appendChild(status);
  const feedback = make('p'); feedback.setAttribute('role', 'status'); feedback.setAttribute('data-unattended-feedback', ''); host.appendChild(feedback);
  let choices = new Map<string, ArchiveRemoteDestination>(), current: ArchiveUnattendedStatus | undefined;
  let chosen: Pick<ArchiveRemoteDestination, 'connection_name' | 'destination_id'> | undefined, choicesSignature = '';
  const renderDestination = (): void => {
    const signature = JSON.stringify([[...choices.values()], chosen]);
    if (signature === choicesSignature) return;
    choicesSignature = signature;
    while (destination.firstChild) destination.removeChild(destination.firstChild);
    const empty = make('option', 'Choose S3 storage'); empty.value = ''; destination.appendChild(empty);
    for (const value of choices.values()) {
      const node = make('option', `${value.connection_name} — ${value.bucket}${value.prefix ? `/${value.prefix}` : ''}`);
      node.value = value.connection_name; destination.appendChild(node);
    }
    if (chosen && choices.get(chosen.connection_name)?.destination_id !== chosen.destination_id) {
      const stale = make('option', `${chosen.connection_name} — changed or unavailable; choose again`);
      stale.value = `stale:${chosen.connection_name}`; destination.appendChild(stale); destination.value = stale.value;
    } else destination.value = chosen?.connection_name ?? '';
  };
  let generation = 0, editVersion = 0;
  let disposed = false, dirty = false, busy = false, loading = false, timer: ReturnType<typeof setTimeout> | undefined;
  const render = (value: ArchiveUnattendedStatus): void => {
    current = value;
    const settings = value.settings;
    if (!dirty && settings) {
      enabled.checked = settings.enabled; chosen = { connection_name: settings.connection_name, destination_id: settings.destination_id };
      renderDestination();
      cadence.value = settings.schedule.cadence; day.value = String(settings.schedule.weekday_utc);
      time.value = `${String(settings.schedule.hour_utc).padStart(2, '0')}:${String(settings.schedule.minute_utc).padStart(2, '0')}`;
      keep.value = String(settings.keep_last);
    }
    const run = value.last_run;
    status.textContent = !value.configured ? 'No unattended backup schedule is configured.'
      : `${settings?.enabled ? 'Enabled' : 'Paused'}${value.next_run_at ? ` · Next backup: ${formatClientDateTime(value.next_run_at)}` : ''}${run ? ` · Last run: ${run.outcome === 'verified' ? 'verified in remote storage' : run.outcome === 'running' ? 'in progress' : `needs attention. ${run.issue ? ARCHIVE_UNATTENDED_ISSUE_TEXT[run.issue] : 'The backup could not be confirmed.'}`}` : ''}${value.alert_pending ? ' · Failure alert awaiting notification delivery' : ''}`;
    save.disabled = busy;
  };
  const refresh = async (): Promise<void> => {
    if (disposed || busy || loading) return;
    loading = true; const ownGeneration = generation;
    try { const value = await ports.get(); if (!disposed && generation === ownGeneration) render(value); }
    catch { if (!disposed && generation === ownGeneration) { status.textContent = 'The backup schedule could not be checked. Reconnect and refresh.'; save.disabled = current === undefined; } }
    finally {
      loading = false;
      if (!disposed) { if (timer !== undefined) clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 10_000); }
    }
  };
  for (const control of [enabled, destination, cadence, time, day, keep, words]) {
    const changed = (): void => { dirty = true; editVersion++; };
    control.addEventListener('input', changed); control.addEventListener('change', changed);
  }
  destination.addEventListener('change', () => { chosen = choices.get(destination.value); renderDestination(); });
  save.disabled = true;
  save.addEventListener('click', () => {
    if (disposed || busy || current === undefined) return;
    const live = choices.get(destination.value);
    const selected = !enabled.checked ? chosen : live?.destination_id === chosen?.destination_id ? live : undefined;
    if (!selected) { feedback.textContent = 'Refresh storage and select the backup destination again.'; return; }
    const match = /^(\d{2}):(\d{2})$/u.exec(time.value), count = Number(keep.value);
    if (!match || !Number.isInteger(count) || count < 1 || count > 30) { feedback.textContent = 'Choose a UTC time and 1 to 30 backups to keep.'; return; }
    if (!current.configured && words.value.trim() === '') { feedback.textContent = 'Enter your recovery words once to set up unattended backups.'; return; }
    const recoveryKey = words.value.trim(); words.value = '';
    const settings: ArchiveUnattendedSettings = { enabled: enabled.checked, connection_name: selected.connection_name,
      destination_id: selected.destination_id, keep_last: count, schedule: { cadence: cadence.value === 'weekly' ? 'weekly' : 'daily',
        hour_utc: Number(match[1]), minute_utc: Number(match[2]), weekday_utc: Number(day.value) } };
    const submittedVersion = editVersion;
    generation++; busy = true; save.disabled = true; feedback.textContent = 'Saving the backup schedule…';
    void ports.save({ settings, ...(recoveryKey ? { recoveryKey } : {}) }).then(result => {
      if (disposed) return;
      dirty = editVersion !== submittedVersion; render(result);
      feedback.textContent = dirty ? 'Schedule saved. Your newer edits still need saving.'
        : result.settings?.enabled ? 'Backup schedule saved. Recovery words have been cleared.' : 'Scheduled backups are paused.';
    }).catch(() => { if (!disposed) feedback.textContent = 'The schedule could not be saved. Check the recovery words, vault, and storage connection, then try again.'; })
      .finally(() => { busy = false; if (!disposed) { save.disabled = false; void refresh(); } });
  });
  void refresh();
  return {
    refresh,
    destinations(values: ArchiveRemoteDestination[]): void {
      if (disposed) return;
      choices = new Map(values.map(value => [value.connection_name, value])); renderDestination();
    },
    dispose() { disposed = true; words.value = ''; if (timer !== undefined) clearTimeout(timer); },
  };
};
