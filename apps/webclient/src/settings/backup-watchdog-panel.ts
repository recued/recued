import { BACKUP_WATCHDOG_ISSUE_TEXT, type BackupWatchdogDrillStart, type BackupWatchdogDrillUpdate, type BackupWatchdogSave, type BackupWatchdogStatus } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import { mountBackupWatchdogDrill } from './backup-watchdog-drill-panel.js';

export interface BackupWatchdogPorts {
  get(): Promise<BackupWatchdogStatus>;
  save(input: BackupWatchdogSave): Promise<BackupWatchdogStatus>;
  drill?: {
    start(input: BackupWatchdogDrillStart): Promise<BackupWatchdogStatus>;
    update(input: BackupWatchdogDrillUpdate): Promise<BackupWatchdogStatus>;
  };
}
const COPY: Record<BackupWatchdogStatus['state'], string> = {
  not_configured: 'No external backup monitor is set up.', paused: 'Pings to the external monitor are off.',
  waiting: 'Waiting to send the first eligible ping. Check the monitor before relying on its alerts.',
  blocked: 'Pings are stopped because backup proof needs attention.', sending: 'Sending a ping to the external monitor…',
  acknowledged: 'The last ping was acknowledged. Check alert setup on the monitor host.',
  failed: 'The last ping could not be confirmed. Check the monitor host.',
  unavailable: 'Monitor status could not be confirmed. Refresh before changing setup.',
  drill_paused: 'Pings are temporarily paused for your monitor alert drill.',
};
/** The ping URL is a write-only draft. Polls never populate or replace it. */
export const mountBackupWatchdog = (options: { host: HTMLElement; document: Document; ports: BackupWatchdogPorts }) => {
  const { host, document: doc, ports } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  host.setAttribute('data-backup-watchdog', '');
  host.appendChild(make('h3', 'Offline backup alerts'));
  host.appendChild(make('p', 'Use a heartbeat monitor on another host. Set it to expect a ping each minute with at least five minutes of grace, and set up its alert route. It can then alert when this server is off or backup proof needs attention.'));
  const label = make('label', 'Enable monitor pings '), enabled = make('input'); enabled.type = 'checkbox';
  enabled.setAttribute('data-backup-watchdog-enabled', ''); label.appendChild(enabled); host.appendChild(label);
  const urlLabel = make('label', 'Success-ping URL '), url = make('input'); url.type = 'password'; url.autocomplete = 'off'; url.spellcheck = false;
  url.placeholder = 'HTTPS URL, entered once'; url.setAttribute('data-backup-watchdog-url', ''); urlLabel.appendChild(url); host.appendChild(urlLabel);
  host.appendChild(make('p', 'Use a Healthchecks-compatible HTTPS success URL with no query, fragment, or login. The URL is stored encrypted and is never shown again. No recovery words are needed. Pings start after a verified backup is within its age limit and no backup checks need attention. Enabled S3 checks need a complete passing scan.'));
  host.appendChild(make('p', 'Pausing this server, its backup schedule, or these pings stops the signal. Pause the external monitor too for planned downtime. A ping does not prove that an alert reached you.'));
  const save = make('button', 'Save monitor'), remove = make('button', 'Remove monitor');
  for (const [button, name] of [[save, 'save'], [remove, 'remove']] as const) {
    button.type = 'button'; button.className = 'rx-btn rx-btn-secondary'; button.disabled = true;
    button.setAttribute(`data-backup-watchdog-${name}`, ''); host.appendChild(button);
  }
  const status = make('p'), receipt = make('p'), feedback = make('p');
  for (const [node, name] of [[status, 'status'], [receipt, 'receipt'], [feedback, 'feedback']] as const) {
    node.setAttribute(`data-backup-watchdog-${name}`, ''); node.setAttribute('role', 'status'); host.appendChild(node);
  }
  let current: BackupWatchdogStatus | undefined, disposed = false, busy = false, loading = false, dirty = false;
  let generation = 0, editVersion = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const drillHost = ports.drill ? make('div') : undefined;
  if (drillHost) host.appendChild(drillHost);
  const drill = drillHost ? mountBackupWatchdogDrill({ host: drillHost, document: doc,
    start: input => drillWrite(input), update: input => drillWrite(input),
  }) : undefined;
  const buttons = () => {
    save.disabled = disposed || busy || !current || current.state === 'unavailable';
    remove.disabled = save.disabled || !current?.configured;
    drill?.render(current, busy || disposed, dirty);
  };
  const unavailable = () => { current = undefined; status.textContent = COPY.unavailable; receipt.textContent = ''; buttons(); };
  const render = (value: BackupWatchdogStatus) => {
    if (!value || !Object.hasOwn(COPY, value.state) || typeof value.enabled !== 'boolean' || typeof value.configured !== 'boolean'
      || (value.last_acknowledged_at !== undefined && (!Number.isSafeInteger(value.last_acknowledged_at) || value.last_acknowledged_at < 0))) throw new Error('Invalid monitor status');
    current = value;
    if (!dirty && value.state !== 'unavailable') enabled.checked = value.enabled;
    url.placeholder = value.configured ? 'Leave blank to keep the saved URL' : 'HTTPS URL, entered once';
    const issue = value.issue && Object.hasOwn(BACKUP_WATCHDOG_ISSUE_TEXT, value.issue) ? BACKUP_WATCHDOG_ISSUE_TEXT[value.issue] : '';
    status.textContent = COPY[value.state] + (issue ? ` ${issue}` : '');
    receipt.textContent = value.state === 'unavailable' || value.last_acknowledged_at === undefined ? ''
      : `Last ping acknowledgment: ${formatClientDateTime(value.last_acknowledged_at)}`;
    buttons();
  };
  const refresh = async (): Promise<void> => {
    if (disposed || busy || loading) return;
    loading = true; const ownGeneration = generation;
    try { const value = await ports.get(); if (!disposed && generation === ownGeneration) render(value); }
    catch { if (!disposed && generation === ownGeneration) {
      unavailable();
    } }
    finally { loading = false; if (!disposed) {
      if (timer !== undefined) clearTimeout(timer);
      if (generation !== ownGeneration && !busy) void refresh();
      else timer = setTimeout(() => { void refresh(); }, 10_000);
    } }
  };
  for (const input of [enabled, url]) for (const event of ['input', 'change']) input.addEventListener(event, () => { dirty = true; editVersion++; buttons(); });
  const drillWrite = (input: BackupWatchdogDrillStart | BackupWatchdogDrillUpdate) => {
    if (disposed || busy || !current || current.state === 'unavailable' || !ports.drill) return;
    busy = true; generation++; buttons(); feedback.textContent = 'Updating the alert drill…';
    void (async () => {
      try {
        const value = 'action' in input ? await ports.drill!.update(input) : await ports.drill!.start(input);
        if (disposed) return;
        if (value.drill?.operation_id !== input.operation_id || !value.drill.current_configuration
          || ('action' in input && (input.action === 'cancel' ? value.drill.phase !== 'cancelled' : value.drill.alert_reported_at === undefined))) throw new Error('Unconfirmed drill');
        render(value); feedback.textContent = 'Alert drill updated.';
      } catch { if (!disposed) { unavailable(); feedback.textContent = 'The alert drill update could not be confirmed. Refresh its status before another action.'; } }
      finally { busy = false; if (!disposed) { buttons(); void refresh(); } }
    })();
  };
  const submit = (forget: boolean) => {
    if (disposed || busy || !current || current.state === 'unavailable') return;
    const ping_url = url.value.trim();
    if (!forget && enabled.checked && !current.configured && !ping_url) { feedback.textContent = 'Enter the monitor success-ping URL once.'; return; }
    const input: BackupWatchdogSave = forget ? { enabled: false, forget: true }
      : { enabled: enabled.checked, ...(ping_url ? { ping_url } : {}) };
    busy = true; generation++; const submitted = editVersion; buttons(); feedback.textContent = forget ? 'Removing the monitor…' : 'Saving the monitor…';
    void (async () => {
      try {
        const value = await ports.save(input); if (disposed) return;
        if (value.enabled !== input.enabled || value.state === 'unavailable' || (forget ? value.configured : input.enabled && !value.configured)) throw new Error('Unconfirmed monitor setup');
        dirty = editVersion !== submitted;
        render(value);
        if (!dirty) url.value = '';
        feedback.textContent = dirty ? 'Monitor setup saved. Your newer edits still need saving.' : forget ? 'Monitor removed. Pause or remove its external check too.' : 'Monitor setup saved. Check its first ping and alert route on the monitor host.';
      } catch { if (!disposed) {
        unavailable(); feedback.textContent = 'Monitor setup could not be confirmed. Refresh before trying again.';
      } }
      finally { busy = false; if (!disposed) { buttons(); void refresh(); } }
    })();
  };
  save.addEventListener('click', () => submit(false)); remove.addEventListener('click', () => submit(true));
  void refresh();
  return { refresh, dispose(): void { disposed = true; generation++; url.value = ''; buttons(); if (timer !== undefined) clearTimeout(timer); } };
};
