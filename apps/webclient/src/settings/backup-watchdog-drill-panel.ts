import { BACKUP_WATCHDOG_DRILL_MINUTES, type BackupWatchdogDrillStart, type BackupWatchdogDrillUpdate, type BackupWatchdogStatus } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';

/** Stable controls. The parent owns writes, read generations and uncertain replies. */
export const mountBackupWatchdogDrill = (options: {
  host: HTMLElement; document: Document;
  start(input: BackupWatchdogDrillStart): void;
  update(input: BackupWatchdogDrillUpdate): void;
}) => {
  const { host, document: doc } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, name: string, text?: string) => {
    const node = doc.createElement(tag); node.setAttribute(`data-backup-watchdog-drill-${name}`, '');
    if (text !== undefined) node.textContent = text; host.appendChild(node); return node;
  };
  host.setAttribute('data-backup-watchdog-drill', '');
  make('style', 'styles', '[data-backup-watchdog-drill] [hidden] { display: none !important; }');
  make('h4', 'heading', 'Test the monitor alert route');
  make('p', 'help', 'This drill deliberately stops pings so your external monitor can alert you. Choose a pause longer than its expected period plus grace. The pause ends automatically, even if you close this page. Eligible pings then resume while the server is running; backup proof and vault checks still apply.');
  const label = make('label', 'label', 'Pause length '), duration = doc.createElement('select');
  duration.setAttribute('data-backup-watchdog-drill-duration', '');
  for (const minutes of BACKUP_WATCHDOG_DRILL_MINUTES) {
    const option = doc.createElement('option'); option.value = String(minutes); option.textContent = `${minutes} minutes`; duration.appendChild(option);
  }
  duration.value = '10'; label.appendChild(duration);
  const status = make('p', 'status'); status.setAttribute('role', 'status');
  const facts = make('p', 'facts');
  const review = make('button', 'review', 'Test monitor alerts');
  const warning = make('p', 'warning', 'This may send real alerts through the monitor’s configured routes. Leave the external monitor enabled during this drill.');
  const confirm = make('button', 'start'), back = make('button', 'back', 'Go back');
  const received = make('button', 'received'), cancel = make('button', 'cancel', 'End drill and resume eligible pings');
  for (const button of [review, confirm, back, received, cancel]) { button.type = 'button'; button.className = 'rx-btn rx-btn-secondary'; }
  let value: BackupWatchdogStatus | undefined, busy = false, edited = false, reviewing = false, revision: string | undefined;
  const open = () => !!value?.drill?.current_configuration && ['paused', 'resuming', 'awaiting_confirmation'].includes(value.drill.phase);
  const canStart = () => !busy && !edited && !!value?.configuration_revision && value.enabled && value.state === 'acknowledged' && !open();
  const paint = () => {
    const d = value?.drill, actionable = !busy && !!value && value.state !== 'unavailable';
    review.hidden = reviewing || open(); review.disabled = !canStart();
    duration.disabled = busy || open() || reviewing;
    warning.hidden = confirm.hidden = back.hidden = !reviewing;
    confirm.textContent = `Pause pings for ${duration.value} minutes`; confirm.disabled = !reviewing || !canStart(); back.disabled = busy;
    received.hidden = !open() || d?.alert_reported_at !== undefined;
    received.disabled = !actionable || !open() || d?.alert_reported_at !== undefined;
    received.textContent = d?.phase === 'paused' ? 'I received the alert — resume eligible pings' : 'I received the alert';
    cancel.hidden = !open(); cancel.disabled = !actionable || !open();
    facts.textContent = '';
    if (!value || value.state === 'unavailable') { status.textContent = 'Drill status could not be confirmed. Refresh before continuing.'; return; }
    if (d) {
      facts.textContent = `${d.alert_reported_at === undefined ? 'External alert: not confirmed by you.' : `External alert: you reported receiving it at ${formatClientDateTime(d.alert_reported_at)}.`} ${d.ping_acknowledged_at === undefined ? 'Post-drill ping: not acknowledged yet.' : `Post-drill ping: acknowledged at ${formatClientDateTime(d.ping_acknowledged_at)}.`}`;
      if (!d.current_configuration) { status.textContent = 'The earlier drill belongs to a previous monitor setup. Test this setup again.'; return; }
      if (d.phase === 'paused') { status.textContent = `Drill in progress. Pings are paused until ${formatClientDateTime(d.pause_until)}. Check your external alert route.`; return; }
      if (d.phase === 'resuming') { status.textContent = 'The pause has ended. Waiting for an eligible ping to be acknowledged. Backup proof or vault issues can delay it.'; return; }
      if (d.phase === 'awaiting_confirmation') { status.textContent = 'A fresh ping was acknowledged after the pause. Confirm whether you received the external alert.'; return; }
      if (d.phase === 'completed') { status.textContent = 'Drill complete: you reported receiving the alert and a fresh ping was acknowledged after resumption.'; return; }
      status.textContent = 'The drill ended without a completed alert test. Eligible pings can resume.'; return;
    }
    status.textContent = canStart() ? 'Ready to test. Review the pause before starting.' : 'Save any setup edits and wait for a recent ping acknowledgment with healthy backup proof before starting.';
  };
  review.addEventListener('click', () => { if (canStart()) { reviewing = true; paint(); } });
  back.addEventListener('click', () => { if (!busy) { reviewing = false; paint(); } });
  confirm.addEventListener('click', () => {
    if (!reviewing || !canStart() || !value?.configuration_revision) return;
    const minutes = BACKUP_WATCHDOG_DRILL_MINUTES.find(n => String(n) === duration.value); if (!minutes) return;
    reviewing = false;
    options.start({ operation_id: crypto.randomUUID(), configuration_revision: value.configuration_revision, pause_minutes: minutes });
  });
  received.addEventListener('click', () => { if (!received.disabled && value?.drill) options.update({ operation_id: value.drill.operation_id, action: 'confirm_alert' }); });
  cancel.addEventListener('click', () => { if (!cancel.disabled && value?.drill) options.update({ operation_id: value.drill.operation_id, action: 'cancel' }); });
  paint();
  return {
    render(next: BackupWatchdogStatus | undefined, pending: boolean, hasEdits: boolean): void {
      if (!next || next.configuration_revision !== revision || hasEdits) reviewing = false;
      revision = next?.configuration_revision; value = next; busy = pending; edited = hasEdits; paint();
    },
  };
};
