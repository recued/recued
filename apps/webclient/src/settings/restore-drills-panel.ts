import { ARCHIVE_RESTORE_DRILL_ISSUE_TEXT, type ArchiveRemoteBackup, type ArchiveRestoreDrill } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export interface RestoreDrillsPorts {
  list(): Promise<{ drills: ArchiveRestoreDrill[] }>;
  start(input: { operation_id: string; backup_operation_id: string; recoveryKey: string }): Promise<ArchiveRestoreDrill>;
  cancel(input: { operation_id: string }): Promise<ArchiveRestoreDrill>;
  cleanup(input: { operation_id: string }): Promise<ArchiveRestoreDrill>;
}
const ACTIVE = new Set(['retrieving', 'restoring', 'checking', 'cleaning']);
const STATE: Record<ArchiveRestoreDrill['state'], string> = {
  retrieving: 'Reading the remote copy', restoring: 'Restoring a temporary realm', checking: 'Checking the database and blobs',
  cleaning: 'Removing the temporary realm', succeeded: 'Recovery check passed', failed: 'Recovery check failed',
};
export const mountRestoreDrills = (options: { host: HTMLElement; document: Document; ports: RestoreDrillsPorts; pollMs?: number }) => {
  const { host, document: doc, ports } = options;
  let disposed = false, starting = false, loading = false, running = false, queued = false, historyReady = false;
  let pendingControl = false, version = 0;
  let chosen: ArchiveRemoteBackup | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  host.setAttribute('data-restore-drills', '');
  host.appendChild(make('style', '[data-restore-drills] li{overflow-wrap:anywhere}'));
  host.appendChild(make('h3', 'Test recovery'));
  host.appendChild(make('p', 'Choose “Test recovery” on a verified backup below. Recued restores it in a private temporary folder, checks the database and its blob files, then removes that folder. Your server keeps running. The test saves a receipt, not your recovery words.'));
  const selected = make('p', 'No backup selected.'); selected.setAttribute('data-drill-selected', ''); host.appendChild(selected);
  const form = make('form'), label = make('label', 'Recovery words for this backup '), words = make('input');
  form.setAttribute('data-drill-form', '');
  words.type = 'password'; words.autocomplete = 'off'; words.spellcheck = false; words.setAttribute('autocapitalize', 'none');
  words.setAttribute('data-drill-words', ''); label.appendChild(words); form.appendChild(label);
  const start = make('button', 'Run recovery test'); start.type = 'submit'; start.className = 'rx-btn rx-btn-secondary';
  start.setAttribute('data-drill-start', ''); form.appendChild(start); host.appendChild(form);
  const feedback = make('p'); feedback.setAttribute('role', 'status'); feedback.setAttribute('data-drill-feedback', ''); host.appendChild(feedback);
  const refreshButton = make('button', 'Refresh recovery receipts'); refreshButton.type = 'button'; refreshButton.className = 'rx-btn rx-btn-secondary';
  refreshButton.setAttribute('data-drill-refresh', '');
  host.appendChild(refreshButton);
  const history = make('ul'); history.setAttribute('data-drill-history', ''); host.appendChild(history);
  const rows = new Map<string, { node: HTMLLIElement; summary: HTMLSpanElement; cancel: HTMLButtonElement; cleanup: HTMLButtonElement; receipt: ArchiveRestoreDrill }>();
  const buttonState = (button: HTMLButtonElement, hidden: boolean, disabled: boolean): void => {
    if ((hidden || disabled) && doc.activeElement === button) refreshButton.focus();
    button.hidden = hidden; button.disabled = disabled;
  };
  const render = (): void => {
    start.disabled = disposed || starting || pendingControl || loading || !historyReady || running || chosen === undefined;
    words.disabled = starting || chosen === undefined;
    for (const row of rows.values()) {
      const receipt = row.receipt, c = receipt.checks;
      row.summary.textContent = `${formatClientDateTime(receipt.started_at)} · Backup ${receipt.backup_operation_id} · ${receipt.issue === 'cancelled' ? 'Recovery test cancelled' : STATE[receipt.state]}`
        + (receipt.cancel_requested_at !== undefined && ACTIVE.has(receipt.state) ? ' · Cancellation requested; waiting for the test and cleanup to stop' : '')
        + (c ? ` · Database, foreign keys, and local boot key passed · ${c.referenced_blobs} referenced blobs (${c.blob_bytes} bytes) passed · Temporary realm removed` : '')
        + (receipt.issue ? ` · ${ARCHIVE_RESTORE_DRILL_ISSUE_TEXT[receipt.issue]}` : '')
        + (receipt.cleanup_pending ? ' · Temporary files remain. Retry cleanup when any old worker has stopped.' : '')
        + (receipt.cleanup_completed_at !== undefined ? ' · Temporary files removed on a later cleanup attempt. The test remains failed.' : '')
        + ` · Archive SHA-256 ${receipt.archive_sha256} `;
      const disabled = disposed || starting || pendingControl || !historyReady;
      buttonState(row.cancel, !ACTIVE.has(receipt.state), disabled || receipt.cancel_requested_at !== undefined);
      buttonState(row.cleanup, !receipt.cleanup_pending, disabled);
    }
  };
  const control = async (receipt: ArchiveRestoreDrill, action: 'cancel' | 'cleanup'): Promise<void> => {
    if (disposed || starting || pendingControl || !historyReady) return;
    if (action === 'cancel' ? !ACTIVE.has(receipt.state) || receipt.cancel_requested_at !== undefined : !receipt.cleanup_pending) return;
    pendingControl = true; historyReady = false; version++; render();
    feedback.textContent = action === 'cancel' ? 'Requesting cancellation…' : 'Retrying cleanup…';
    try {
      const result = await ports[action]({ operation_id: receipt.operation_id }); if (disposed) return;
      if (result.operation_id !== receipt.operation_id || result.backup_operation_id !== receipt.backup_operation_id
        || result.archive_sha256 !== receipt.archive_sha256 || result.archive_bytes !== receipt.archive_bytes || result.destination_id !== receipt.destination_id) throw new Error('Unexpected recovery receipt');
      const row = rows.get(receipt.operation_id); if (row) row.receipt = result;
      feedback.textContent = action === 'cancel' ? ACTIVE.has(result.state)
        ? 'Cancellation requested. Check the receipt for the final result and cleanup.'
        : 'This test has ended. Check its saved result below.'
        : result.cleanup_pending ? 'Cleanup is still pending. Wait for any old worker to stop, then retry cleanup.'
        : 'Temporary files are gone. The saved test result has not changed.';
    } catch (error) {
      if (disposed) return;
      const code = classifyRpcError(error).code;
      feedback.textContent = code === 'archive_export_in_progress' ? 'Wait for the current backup, recovery test, or restore to finish.'
        : code === 'conflict' ? 'The server refused this action. Refresh receipts and check for maintenance or a test still running.'
        : 'This action could not be confirmed. Refresh recovery receipts before trying it again.';
    } finally {
      pendingControl = false; version++;
      if (!disposed) { render(); void refresh(); }
    }
  };
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (!disposed) timer = setTimeout(() => { timer = undefined; void refresh(); }, options.pollMs ?? 5000);
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    if (pendingControl) { queued = true; return; }
    if (loading) { queued = true; return; }
    const readVersion = version; loading = true; render();
    try {
      const result = await ports.list(); if (disposed) return;
      if (readVersion !== version) { queued = true; return; }
      historyReady = true;
      running = result.drills.some(row => ACTIVE.has(row.state) || row.cleanup_pending);
      const wanted = new Set(result.drills.map(row => row.operation_id));
      for (const [id, row] of rows) if (!wanted.has(id)) {
        if (row.node.contains(doc.activeElement)) refreshButton.focus();
        history.removeChild(row.node); rows.delete(id);
      }
      for (const receipt of result.drills) {
        let row = rows.get(receipt.operation_id);
        if (!row) {
          const node = make('li'), summary = make('span'), cancel = make('button', 'Cancel test'), cleanup = make('button', 'Retry cleanup');
          node.setAttribute('data-drill-id', receipt.operation_id);
          for (const [button, action] of [[cancel, 'cancel'], [cleanup, 'cleanup']] as const) {
            button.type = 'button'; button.className = 'rx-btn rx-btn-secondary'; button.setAttribute(`data-drill-${action}`, receipt.operation_id);
            button.addEventListener('click', () => { const current = rows.get(receipt.operation_id); if (current) void control(current.receipt, action); });
          }
          node.appendChild(summary); node.appendChild(cancel); node.appendChild(cleanup);
          row = { node, summary, cancel, cleanup, receipt }; rows.set(receipt.operation_id, row); history.appendChild(node);
        } else row.receipt = receipt;
      }
      if (!result.drills.length) { feedback.textContent ||= 'No recovery receipts yet.'; }
    } catch {
      if (readVersion !== version) queued = true;
      else { historyReady = false; if (!disposed) feedback.textContent = 'Recovery receipts could not be checked. Reconnect and refresh before starting a test.'; }
    }
    finally { loading = false; if (!disposed) { render(); if (queued) { queued = false; void refresh(); } else schedule(); } }
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (disposed || starting || pendingControl || loading || !historyReady || running || !chosen) return;
    const recoveryKey = words.value.trim(); words.value = '';
    if (!recoveryKey) { feedback.textContent = 'Enter the backup’s 24 recovery words.'; return; }
    const backup = chosen, operation_id = globalThis.crypto.randomUUID();
    starting = true; render(); feedback.textContent = 'Starting the recovery test…';
    void ports.start({ operation_id, backup_operation_id: backup.operation_id, recoveryKey }).then(receipt => {
      if (disposed) return;
      if (receipt.operation_id !== operation_id || receipt.backup_operation_id !== backup.operation_id
        || receipt.archive_sha256 !== backup.sha256 || receipt.destination_id !== backup.destination.destination_id) throw new Error('Unexpected recovery receipt');
      running = ACTIVE.has(receipt.state); feedback.textContent = 'The server is running the test. Its receipt will appear below. You can leave this page.';
    }).catch(error => {
      if (disposed) return;
      const code = classifyRpcError(error).code;
      feedback.textContent = code === 'invalid_args' ? 'Use the complete 24 recovery words for this backup.'
        : code === 'archive_export_in_progress' ? 'Wait for the current backup, recovery test, or restore to finish.'
        : code === 'conflict' ? 'The server refused this request. Refresh receipts and check for pending cleanup or maintenance.'
        : code === 'not_configured' ? 'Recovery tests or their history are unavailable. Check the server before trying again.'
        : 'The test request could not be confirmed. Check recovery receipts before trying again.';
    })
      .finally(() => { starting = false; if (!disposed) { render(); void refresh(); } });
  });
  refreshButton.addEventListener('click', () => { void refresh(); });
  render(); void refresh();
  return {
    choose(backup: ArchiveRemoteBackup): boolean {
      if (disposed || starting || backup.state !== 'verified') return false;
      chosen = structuredClone(backup); words.value = '';
      selected.textContent = `${backup.destination.connection_name} · ${formatClientDateTime(backup.created_at)} · Backup ${backup.operation_id} · SHA-256 ${backup.sha256}`;
      feedback.textContent = 'Enter the recovery words for the selected backup, then run the test.'; render(); words.focus(); return true;
    },
    refresh,
    dispose(): void { disposed = true; render(); words.value = ''; words.disabled = true; if (timer !== undefined) clearTimeout(timer); },
  };
};
