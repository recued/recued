import { createBackupDisclosure } from './backup-disclosure.js';
import type { ArchiveRemoteDestination, ArchiveUnattendedSettings, ArchiveUnattendedStatus } from '@recued/contracts';
import { ARCHIVE_UNATTENDED_ISSUE_TEXT } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import { createBackupFormValidation, isBackupUtcTime, isBackupWholeNumber } from './backup-form-validation.js';
import { createBackupStatusRefresh, type BackupStatusRefreshOutcome } from './backup-status-refresh.js';

export interface UnattendedBackupsPorts {
  get(): Promise<ArchiveUnattendedStatus>;
  save(input: { settings: ArchiveUnattendedSettings; recoveryKey?: string }): Promise<ArchiveUnattendedStatus>;
}
const validSettings = (value: ArchiveUnattendedSettings | undefined): value is ArchiveUnattendedSettings => {
  const schedule = value?.schedule;
  const integer = (value: number | undefined, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  return !!value && typeof value.enabled === 'boolean' && typeof value.connection_name === 'string'
    && value.connection_name.trim() !== '' && value.connection_name.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value.connection_name)
    && typeof value.destination_id === 'string' && /^[0-9a-f]{64}$/u.test(value.destination_id) && integer(value.keep_last, 1, 30)
    && !!schedule && (schedule.cadence === 'daily' || schedule.cadence === 'weekly') && integer(schedule.hour_utc, 0, 23)
    && integer(schedule.minute_utc, 0, 59) && integer(schedule.weekday_utc, 0, 6);
};
const sameSettings = (expected: ArchiveUnattendedSettings, actual: ArchiveUnattendedSettings | undefined): boolean =>
  !!actual && actual.enabled === expected.enabled && actual.connection_name === expected.connection_name
  && actual.destination_id === expected.destination_id && actual.keep_last === expected.keep_last
  && actual.schedule?.cadence === expected.schedule.cadence && actual.schedule.hour_utc === expected.schedule.hour_utc
  && actual.schedule.minute_utc === expected.schedule.minute_utc && actual.schedule.weekday_utc === expected.schedule.weekday_utc;

export const mountUnattendedBackups = (options: {
  host: HTMLElement; document: Document; ports: UnattendedBackupsPorts;
  now?: () => number;
  onRefreshPendingChange?: (pending: boolean) => void;
}) => {
  const { host, document: doc, ports } = options;
  const validation = createBackupFormValidation(doc, 'unattended');
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  host.setAttribute('data-unattended-backups', '');
  host.appendChild(make('h3', 'Automatic backups'));
  host.appendChild(make('p', 'Save encrypted copies to S3 on a schedule, even while this browser is closed. Your recovery key is needed once for setup and again to restore. It is never saved.'));
  const status = make('p'); status.setAttribute('role', 'status'); status.setAttribute('data-unattended-status', ''); host.appendChild(status);
  const settingsDisclosure = createBackupDisclosure(doc, 'schedule', 'Schedule settings');
  host.appendChild(settingsDisclosure.element); const form = settingsDisclosure.body;
  const label = <T extends HTMLElement>(text: string, control: T, attribute: string): T => {
    const node = make('label', text); control.setAttribute(attribute, ''); node.appendChild(control); form.appendChild(node); return control;
  };
  const enabled = label('Enable scheduled backups ', make('input'), 'data-unattended-enabled'); enabled.type = 'checkbox'; enabled.checked = true;
  const destination = label('Backup storage ', make('select'), 'data-unattended-destination');
  const selectedDestination = (): Pick<ArchiveRemoteDestination, 'connection_name' | 'destination_id'> | undefined => {
    const live = choices.get(destination.value);
    return !enabled.checked ? chosen : live?.destination_id === chosen?.destination_id ? live : undefined;
  };
  validation.field(destination, form, 'destination', () => selectedDestination() ? undefined : 'Choose the backup storage again. Refresh storage if it changed or is unavailable.');
  const cadence = label('Repeat ', make('select'), 'data-unattended-cadence');
  for (const value of ['daily', 'weekly']) { const node = make('option', value === 'daily' ? 'Daily' : 'Weekly'); node.value = value; cadence.appendChild(node); } cadence.value = 'daily';
  validation.field(cadence, form, 'cadence', () => ['daily', 'weekly'].includes(cadence.value) ? undefined : 'Choose daily or weekly backups.');
  const time = label('Time (UTC) ', make('input'), 'data-unattended-time'); time.type = 'time'; time.value = '02:00';
  validation.field(time, form, 'time', () => isBackupUtcTime(time.value) ? undefined : 'Enter a UTC time, such as 02:00.');
  const day = label('Weekday (weekly backups) ', make('select'), 'data-unattended-day');
  for (const [index, value] of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].entries()) {
    const node = make('option', value); node.value = String(index); day.appendChild(node);
  } day.value = '0';
  validation.field(day, form, 'day', () => isBackupWholeNumber(day.value, 0, 6) ? undefined : 'Choose a weekday for backups.');
  const keep = label('Backups to keep ', make('input'), 'data-unattended-keep'); keep.type = 'number'; keep.min = '1'; keep.max = '30'; keep.step = '1'; keep.value = '5';
  validation.field(keep, form, 'keep', () => isBackupWholeNumber(keep.value, 1, 30) ? undefined : 'Enter a whole number from 1 to 30 backups to keep.');
  const words = label('Recovery key (first setup or replace backup key) ', make('input'), 'data-unattended-words');
  words.type = 'password'; words.autocomplete = 'off'; words.spellcheck = false;
  validation.field(words, form, 'words', () => !current?.configured && words.value.trim() === '' ? 'Enter your recovery key for the first setup.' : undefined);
  form.appendChild(make('p', 'Failure alerts use your notification settings. Missed times become one backup when the server is available. Older remote copies are removed only after a new copy is verified.'));
  const save = make('button', 'Save backup schedule'); save.type = 'button'; save.className = 'rx-btn rx-btn-primary'; save.setAttribute('data-unattended-save', ''); form.appendChild(save);
  const discard = make('button', 'Discard changes'); discard.type = 'button'; discard.className = 'rx-btn rx-btn-secondary'; discard.disabled = true;
  discard.setAttribute('data-unattended-discard', ''); form.appendChild(discard);
  const draftStatus = make('p'); draftStatus.setAttribute('role', 'status'); draftStatus.setAttribute('data-unattended-draft-status', ''); host.appendChild(draftStatus);
  const feedback = make('p'); feedback.setAttribute('role', 'status'); feedback.setAttribute('data-unattended-feedback', ''); host.appendChild(feedback);
  const refreshStatus = createBackupStatusRefresh({ host: form, document: doc, prefix: 'unattended',
    ...(options.now ? { now: options.now } : {}),
    ...(options.onRefreshPendingChange ? { onPendingChange: options.onRefreshPendingChange } : {}),
  });
  let choices = new Map<string, ArchiveRemoteDestination>(), current: ArchiveUnattendedStatus | undefined;
  let chosen: Pick<ArchiveRemoteDestination, 'connection_name' | 'destination_id'> | undefined, choicesSignature = '';
  let confirmedSettings: ArchiveUnattendedSettings | undefined;
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
  const timeValue = (settings: ArchiveUnattendedSettings | undefined) => `${String(settings?.schedule.hour_utc ?? 2).padStart(2, '0')}:${String(settings?.schedule.minute_utc ?? 0).padStart(2, '0')}`;
  const formMatches = (settings: ArchiveUnattendedSettings | undefined): boolean => {
    const destinationValue = !settings ? '' : choices.get(settings.connection_name)?.destination_id === settings.destination_id
      ? settings.connection_name : `stale:${settings.connection_name}`;
    return enabled.checked === (settings?.enabled ?? true) && destination.value === destinationValue
      && chosen?.connection_name === settings?.connection_name && chosen?.destination_id === settings?.destination_id
      && cadence.value === (settings?.schedule.cadence ?? 'daily') && time.value === timeValue(settings)
      && isBackupWholeNumber(day.value, 0, 6) && Number(day.value) === (settings?.schedule.weekday_utc ?? 0)
      && isBackupWholeNumber(keep.value, 1, 30) && Number(keep.value) === (settings?.keep_last ?? 5);
  };
  const hasDraft = () => words.value !== '' || !formMatches(confirmedSettings);
  const restoreConfirmed = (): void => {
    enabled.checked = confirmedSettings?.enabled ?? true;
    chosen = confirmedSettings ? { connection_name: confirmedSettings.connection_name, destination_id: confirmedSettings.destination_id } : undefined;
    renderDestination(); cadence.value = confirmedSettings?.schedule.cadence ?? 'daily';
    day.value = String(confirmedSettings?.schedule.weekday_utc ?? 0); time.value = timeValue(confirmedSettings); keep.value = String(confirmedSettings?.keep_last ?? 5);
  };
  let generation = 0;
  let disposed = false, busy = false, loading = false, preserveAfterSave = false, timer: ReturnType<typeof setTimeout> | undefined;
  let setupFeedback: 'saved' | 'paused' | undefined;
  const buttons = (): void => {
    const changed = hasDraft(), discardDisabled = disposed || busy || !changed;
    if (!disposed && discardDisabled && doc.activeElement === discard) enabled.focus();
    discard.disabled = discardDisabled; save.disabled = disposed || busy || current === undefined;
    draftStatus.textContent = changed ? 'Unsaved schedule changes.' : 'No unsaved schedule changes.';
    draftStatus.hidden = !changed;
    if (setupFeedback) feedback.textContent = changed ? 'Schedule saved. Your newer edits still need saving.'
      : setupFeedback === 'saved' ? 'Backup schedule saved. The recovery key has been cleared.' : 'Scheduled backups are paused.';
  };
  const clearSetupFeedback = (): void => {
    if (setupFeedback !== undefined) { setupFeedback = undefined; feedback.textContent = ''; }
  };
  const unavailable = (): void => {
    current = undefined; status.textContent = 'The backup schedule could not be checked. Reconnect and refresh.'; buttons();
  };
  const render = (value: ArchiveUnattendedStatus, keepDraft = hasDraft() || preserveAfterSave): void => {
    if (!value || typeof value.configured !== 'boolean' || (value.configured ? !validSettings(value.settings) : value.settings !== undefined)) throw new Error('Invalid backup schedule status');
    current = value;
    settingsDisclosure.summary.textContent = value.configured ? 'Change backup schedule' : 'Set up automatic backups';
    const settings = value.settings;
    confirmedSettings = settings ? structuredClone(settings) : undefined;
    if (!keepDraft) restoreConfirmed();
    preserveAfterSave = false;
    const run = value.last_run;
    status.textContent = !value.configured ? 'Automatic backups are not set up.'
      : `${settings?.enabled ? 'Enabled' : 'Paused'}${value.next_run_at ? ` · Next backup: ${formatClientDateTime(value.next_run_at)}` : ''}${run ? ` · Last run: ${run.outcome === 'verified' ? 'verified in remote storage' : run.outcome === 'running' ? 'in progress' : `needs attention. ${run.issue ? ARCHIVE_UNATTENDED_ISSUE_TEXT[run.issue] : 'The backup could not be confirmed.'}`}` : ''}${value.alert_pending ? ' · Failure alert awaiting notification delivery' : ''}`;
    buttons(); validation.refresh();
  };
  const refresh = async (): Promise<void> => {
    if (disposed || busy || loading) return;
    loading = true; const ownGeneration = generation;
    let outcome: BackupStatusRefreshOutcome = 'superseded'; refreshStatus.start();
    try { const value = await ports.get(); if (!disposed && generation === ownGeneration) {
      render(value); outcome = 'success';
    } }
    catch { if (!disposed && generation === ownGeneration) { unavailable(); outcome = 'failure'; } }
    finally {
      loading = false;
      if (!disposed) {
        if (timer !== undefined) clearTimeout(timer);
        if (generation !== ownGeneration) {
          refreshStatus.waitForSave();
          if (!busy) void refresh();
        } else {
          refreshStatus.finish(outcome);
          timer = setTimeout(() => { void refresh(); }, 10_000);
        }
      }
    }
  };
  for (const control of [enabled, destination, cadence, time, day, keep, words]) {
    const changed = (): void => { if (disposed) return; clearSetupFeedback(); buttons(); validation.refresh(); };
    control.addEventListener('input', changed); control.addEventListener('change', changed);
  }
  destination.addEventListener('change', () => { if (disposed) return; chosen = choices.get(destination.value); renderDestination(); buttons(); validation.refresh(); });
  buttons();
  save.addEventListener('click', () => {
    if (disposed || busy || current === undefined) return;
    if (!validation.validate()) { clearSetupFeedback(); return; }
    validation.reset();
    const selected = selectedDestination()!;
    const [hour, minute] = time.value.split(':').map(Number);
    const recoveryKey = words.value.trim(); words.value = '';
    const settings: ArchiveUnattendedSettings = { enabled: enabled.checked, connection_name: selected.connection_name,
      destination_id: selected.destination_id, keep_last: Number(keep.value), schedule: { cadence: cadence.value === 'weekly' ? 'weekly' : 'daily',
        hour_utc: hour!, minute_utc: minute!, weekday_utc: Number(day.value) } };
    generation++; busy = true; refreshStatus.waitForSave(); setupFeedback = undefined; buttons(); feedback.textContent = 'Saving the backup schedule…';
    void (async () => {
      try {
        const result = await ports.save({ settings, ...(recoveryKey ? { recoveryKey } : {}) });
        if (disposed) return;
        if (result?.configured !== true || !sameSettings(settings, result.settings)) throw new Error('Unconfirmed backup schedule');
        render(result, !formMatches(settings)); setupFeedback = settings.enabled ? 'saved' : 'paused'; buttons();
      } catch { if (!disposed) {
        preserveAfterSave = true; setupFeedback = undefined; unavailable();
        feedback.textContent = 'The backup schedule save could not be confirmed. Check the current schedule status before trying again.';
      } }
      finally { busy = false; if (!disposed) { buttons(); void refresh(); } }
    })();
  });
  discard.addEventListener('click', () => {
    if (disposed || busy || !hasDraft()) return;
    words.value = ''; preserveAfterSave = false; restoreConfirmed(); validation.reset(); clearSetupFeedback(); enabled.focus(); buttons();
  });
  void refresh();
  return {
    refresh,
    destinations(values: ArchiveRemoteDestination[]): void {
      if (disposed) return;
      choices = new Map(values.map(value => [value.connection_name, value])); renderDestination(); buttons(); validation.refresh();
    },
    dispose() { disposed = true; generation++; validation.dispose(); refreshStatus.dispose(); words.value = ''; buttons(); if (timer !== undefined) clearTimeout(timer); },
  };
};
