import { createBackupDisclosure, revealBackupControl } from './backup-disclosure.js';
/** Storage selection and durable delivery history are independent of the
 * adjacent recovery-word/file form. Polling never repaints those inputs. */
import type { ArchiveRemoteBackup, ArchiveRemoteDestination, ArchiveRemoteTarget } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import { mountUnattendedBackups, type UnattendedBackupsPorts } from './unattended-backups-panel.js';
import { mountRestoreDrills, type RestoreDrillsPorts } from './restore-drills-panel.js';
import { mountBackupHealth, type BackupHealthPorts } from './backup-health-panel.js';
import { mountBackupIntegrity, type BackupIntegrityPorts } from './backup-integrity-panel.js';
import { mountBackupWatchdog, type BackupWatchdogPorts } from './backup-watchdog-panel.js';
import type { RestoreReadinessItem } from './post-restore-readiness.js';
import { BackupFormValidationError, createBackupFormValidation, isBackupWholeNumber } from './backup-form-validation.js';

export interface RemoteBackupsPorts {
  assertCurrentPair?: () => Promise<void>;
  destinations(): Promise<{ destinations: ArchiveRemoteDestination[] }>;
  list(): Promise<{ backups: ArchiveRemoteBackup[] }>;
  check(input: { operation_id: string }): Promise<ArchiveRemoteBackup>;
  retrieve(input: { operation_id: string }): Promise<{ staged_name: string }>;
  unattended?: UnattendedBackupsPorts;
  drills?: RestoreDrillsPorts;
  health?: BackupHealthPorts;
  integrity?: BackupIntegrityPorts;
  watchdog?: BackupWatchdogPorts;
  onConnected?: (listener: () => void) => () => void;
}
const ACTIVE = new Set(['preparing', 'uploading', 'verifying']);
const PREVIEW_LIFETIME_MS = 5 * 60_000;
const COPY: Record<ArchiveRemoteBackup['state'], string> = {
  preparing: 'Preparing the encrypted backup', uploading: 'Sending the encrypted backup', verifying: 'Reading back the stored copy',
  verified: 'Stored copy verified', unconfirmed: 'Delivery not confirmed — check before starting another backup',
  pruning: 'Older copy removal needs reconciliation', pruned: 'Removed by your retention setting',
};
export const mountRemoteBackups = (options: {
  host: HTMLElement; document: Document; ports: RemoteBackupsPorts;
  onRestore(stagedName: string): boolean;
  pollMs?: number;
  now?: () => number;
}) => {
  const { host, document: doc, ports } = options;
  const validation = createBackupFormValidation(doc, 'remote-backup');
  host.setAttribute('data-remote-backups', '');
  let disposed = false, generation = 0, loading = false, queuedRefresh = false, pendingChecks = 0;
  let healthPending = false, integrityPending = false, watchdogPending = false, unattendedPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined, previewTimer: ReturnType<typeof setTimeout> | undefined;
  let destinations = new Map<string, ArchiveRemoteDestination>();
  let chosen: ArchiveRemoteDestination | undefined;
  let choicesSignature: string | undefined;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  const styles = make('style', '[data-remote-backups]{margin-block:1rem}[data-remote-backups] label{display:block;margin-block:.5rem}[data-remote-backups] select,[data-remote-backups] input{max-width:100%;box-sizing:border-box;font:inherit}[data-remote-backups] input[type=number]{width:6rem}[data-remote-backups] ul{padding:0;list-style:none}[data-remote-backups] li{padding-block:.75rem}[data-remote-backups] p{overflow-wrap:anywhere}[data-remote-backups] button{margin:.25rem .5rem .25rem 0}@media (max-width:640px){[data-remote-backups] label:has(>input[type=checkbox]){display:flex;align-items:center;gap:.5rem;min-height:44px}}'); host.appendChild(styles);
  const storage = createBackupDisclosure(doc, 'manual-storage', 'Storage for manual backups');
  const destinationLabel = make('label', 'Send the next backup to ');
  const select = make('select'); select.setAttribute('data-remote-backup-destination', '');
  const local = make('option', 'This server — download a copy afterward'); local.value = ''; select.appendChild(local);
  destinationLabel.appendChild(select); storage.body.appendChild(destinationLabel);
  const destinationIssue = (): string | undefined => {
    const value = destinations.get(select.value);
    return select.value === '' || (value !== undefined && chosen !== undefined && value.destination_id === chosen.destination_id)
      ? undefined : 'Refresh the storage choices and select the destination again.';
  };
  validation.field(select, storage.body, 'destination', destinationIssue);
  const keepLabel = make('label', ' Backups to keep '), keep = make('input');
  keep.type = 'number'; keep.min = '1'; keep.max = '30'; keep.step = '1'; keep.value = '5';
  keep.setAttribute('data-remote-backup-keep', ''); keepLabel.appendChild(keep); storage.body.appendChild(keepLabel);
  const retentionIssue = (): string | undefined => select.value === '' || isBackupWholeNumber(keep.value, 1, 30)
    ? undefined : 'Choose a whole number between 1 and 30 backups to keep.';
  validation.field(keep, storage.body, 'keep', retentionIssue);
  const note = make('p', 'Remote storage gets the encrypted archive. Your recovery key is used for this backup and is not saved. Older copies in Recued’s own folder are removed only after a new copy is verified.'); storage.body.appendChild(note);
  const configure = make('a', 'Add an Amazon S3 backup connection'); configure.href = '#connections/others/enroll/s3';
  const refreshButton = make('button', 'Refresh backup status'); refreshButton.type = 'button'; refreshButton.className = 'rx-btn rx-btn-secondary';
  refreshButton.setAttribute('aria-label', 'Refresh backup status');
  refreshButton.setAttribute('data-remote-backups-refresh', '');
  const updateRefreshButton = (): void => {
    if (disposed) return;
    const pending = loading || pendingChecks > 0 || healthPending || integrityPending || watchdogPending || unattendedPending;
    refreshButton.setAttribute('aria-disabled', String(pending));
    refreshButton.setAttribute('aria-busy', String(pending));
    refreshButton.textContent = pendingChecks > 0 ? 'Waiting to refresh backup status…' : pending ? 'Refreshing backup status…' : 'Refresh backup status';
  };
  const status = make('p'); status.setAttribute('role', 'status'); status.setAttribute('data-remote-backups-status', '');
  const tools = createBackupDisclosure(doc, 'tools', 'More backup tools');
  const attention = make('div'); attention.setAttribute('data-backup-tools-attention', ''); attention.hidden = true;
  const attentionText = make('p', 'Backup checks need attention.'); attentionText.setAttribute('role', 'status');
  const review = make('button', 'Review backup checks'); review.type = 'button'; review.className = 'rx-btn rx-btn-secondary';
  attention.appendChild(attentionText); attention.appendChild(review);
  review.addEventListener('click', () => { tools.element.open = true; tools.summary.focus(); tools.summary.scrollIntoView?.({ block: 'start' }); });
  const warnings = new Map<string, boolean>();
  const reportAttention = (name: string, pending: boolean): void => {
    if (disposed) return;
    warnings.set(name, pending); const needsAttention = [...warnings.values()].some(Boolean);
    if (!needsAttention && doc.activeElement === review) tools.summary.focus();
    attention.hidden = !needsAttention;
    tools.summary.textContent = needsAttention ? 'More backup tools · Needs attention' : 'More backup tools';
  };
  const integrityHost = make('div'); tools.body.appendChild(integrityHost);
  const integrity = ports.integrity ? mountBackupIntegrity({ host: integrityHost, document: doc, ports: ports.integrity,
    onAttentionChange: pending => reportAttention('integrity', pending),
    ...(options.now ? { now: options.now } : {}),
    onRefreshPendingChange: pending => { integrityPending = pending; updateRefreshButton(); },
  }) : undefined;
  const healthHost = make('div'); tools.body.appendChild(healthHost);
  const health = ports.health ? mountBackupHealth({ host: healthHost, document: doc, ports: ports.health,
    onAttentionChange: pending => reportAttention('health', pending),
    ...(options.now ? { now: options.now } : {}),
    onRefreshPendingChange: pending => { healthPending = pending; updateRefreshButton(); },
  }) : undefined;
  const watchdogHost = make('div'); tools.body.appendChild(watchdogHost);
  const watchdog = ports.watchdog ? mountBackupWatchdog({ host: watchdogHost, document: doc, ports: ports.watchdog,
    onAttentionChange: pending => reportAttention('watchdog', pending),
    ...(options.now ? { now: options.now } : {}),
    onRefreshPendingChange: pending => { watchdogPending = pending; updateRefreshButton(); },
  }) : undefined;
  const unattendedHost = make('div'); host.appendChild(unattendedHost);
  const unattended = ports.unattended ? mountUnattendedBackups({ host: unattendedHost, document: doc, ports: ports.unattended,
    ...(options.now ? { now: options.now } : {}),
    onRefreshPendingChange: pending => { unattendedPending = pending; updateRefreshButton(); },
  }) : undefined;
  (unattended ? unattendedHost : host).appendChild(configure);
  const drillsHost = make('div'); tools.body.appendChild(drillsHost);
  const drills = ports.drills ? mountRestoreDrills({ host: drillsHost, document: doc, ports: ports.drills,
    onAttentionChange: pending => reportAttention('drills', pending),
    ...(options.now ? { now: options.now } : {}),
  }) : undefined;
  const historyCard = make('div'); historyCard.setAttribute('data-backup-history-card', ''); host.appendChild(historyCard);
  const historyHeading = make('h3', 'Saved copies'); historyCard.appendChild(historyHeading); historyCard.appendChild(refreshButton); historyCard.appendChild(status);
  const history = make('ul'); history.setAttribute('data-remote-backup-history', ''); historyCard.appendChild(history);
  host.appendChild(storage.element);
  if (ports.integrity || ports.health || ports.watchdog || ports.drills) { host.appendChild(attention); host.appendChild(tools.element); }
  type Row = { node: HTMLLIElement; summary: HTMLParagraphElement; cleanupNote: HTMLParagraphElement; cleanupLink: HTMLAnchorElement; note: HTMLParagraphElement; check: HTMLButtonElement;
    prepare: HTMLButtonElement; drill?: HTMLButtonElement; location: HTMLParagraphElement; checksum: HTMLParagraphElement;
    previewStatus: HTMLParagraphElement; previewExpired: boolean; details: HTMLDetailsElement; attentionShown: boolean;
    receipt: ArchiveRemoteBackup; busy: boolean; checkUnconfirmed: boolean; prepared?: { name: string; at: number } };
  const rows = new Map<string, Row>();
  const reconcileDrillBackup = (): void => { drills?.backups([...rows.values()].map(row => row.receipt)); };
  const previewMessage = (row: Row, message: string): void => {
    if (row.previewStatus.textContent !== message) row.previewStatus.textContent = message;
    row.previewStatus.hidden = message === '';
  };
  const expirePreview = (row: Row): boolean => {
    const expired = row.prepared !== undefined && Date.now() - row.prepared.at >= PREVIEW_LIFETIME_MS;
    if (expired) { delete row.prepared; row.previewExpired = true; }
    if (row.previewExpired) previewMessage(row, row.receipt.state === 'verified'
      ? 'Preview preparation expired. Prepare this backup again before opening its restore preview.'
      : 'Preview preparation expired. This copy is no longer verified, so it cannot be prepared again.');
    return expired;
  };
  const schedulePreviewExpiry = (): void => {
    if (previewTimer !== undefined) { clearTimeout(previewTimer); previewTimer = undefined; }
    if (disposed) return;
    let deadline = Infinity;
    for (const row of rows.values()) if (row.prepared) deadline = Math.min(deadline, row.prepared.at + PREVIEW_LIFETIME_MS);
    if (deadline !== Infinity) previewTimer = setTimeout(() => {
      previewTimer = undefined; if (disposed) return;
      for (const row of rows.values()) if (expirePreview(row)) renderRow(row);
      schedulePreviewExpiry();
    }, Math.max(0, deadline - Date.now()));
  };
  const renderRow = (row: Row): void => {
    const data = row.receipt; expirePreview(row);
    const cleanupPending = data.multipart_cleanup_pending === true;
    if (!row.attentionShown && (cleanupPending || data.state === 'unconfirmed' || data.state === 'pruning')) { row.details.open = true; row.attentionShown = true; }
    const cleanupDenied = cleanupPending && data.multipart_cleanup_issue === 'permission_denied';
    row.node.setAttribute('data-remote-backup-state', data.state);
    row.node.setAttribute('data-remote-backup-cleanup-pending', String(cleanupPending));
    row.summary.textContent = `${formatClientDateTime(data.created_at)} · ${data.destination.connection_name} · ${data.destination.bucket} · ${COPY[data.state]}${cleanupPending ? ' · Upload cleanup pending' : ''}${data.retention_pending ? ' · Some older copies could not be removed' : ''}`;
    const cleanupText = cleanupDenied ? 'Storage denied access to remove unfinished upload parts. Check the storage connection and its permissions, then retry upload cleanup.'
      : cleanupPending ? 'Unfinished upload cleanup is not confirmed. Retry cleanup to remove any remaining parts and check the stored copy.' : '';
    if (row.cleanupNote.textContent !== cleanupText) row.cleanupNote.textContent = cleanupText;
    row.cleanupNote.hidden = !cleanupPending;
    if (!cleanupDenied && doc.activeElement === row.cleanupLink) { revealBackupControl(row.check); row.check.focus(); }
    row.cleanupLink.hidden = !cleanupDenied;
    if (cleanupDenied) row.cleanupLink.setAttribute('href', '#connections/others/review-access/api/' + encodeURIComponent(data.destination.connection_name));
    else row.cleanupLink.removeAttribute('href');
    row.location.textContent = data.object_key;
    row.checksum.textContent = data.sha256 ? `${data.bytes ?? 0} bytes · SHA-256 ${data.sha256}` : 'The exported bytes have not been recorded yet.';
    const checkLabel = cleanupPending ? 'Retry upload cleanup' : 'Check stored copy';
    if (row.check.textContent !== checkLabel) row.check.textContent = checkLabel;
    row.check.setAttribute('aria-disabled', String(row.busy || row.checkUnconfirmed || ACTIVE.has(data.state) || data.state === 'pruned' || data.state === 'pruning' || data.sha256 === undefined));
    row.prepare.textContent = row.prepared ? 'Open restore preview' : row.previewExpired ? 'Prepare a restore again' : 'Prepare a restore';
    row.prepare.setAttribute('aria-disabled', String(row.busy || (!row.prepared && (row.checkUnconfirmed || data.state !== 'verified'))));
    row.drill?.setAttribute('aria-disabled', String(row.busy || row.checkUnconfirmed || data.state !== 'verified'));
  };
  const schedule = (delay = options.pollMs ?? 5000): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (!disposed) timer = setTimeout(() => { timer = undefined; void refresh(); }, delay);
  };
  const renderHistory = (receipts: ArchiveRemoteBackup[]): void => {
    const wanted = new Set(receipts.map(row => row.operation_id));
    for (const [id, row] of rows) if (!wanted.has(id)) {
      if (row.node.contains(doc.activeElement)) refreshButton.focus(); history.removeChild(row.node); rows.delete(id);
    }
    for (const receipt of receipts) {
      let row = rows.get(receipt.operation_id);
      if (!row) {
        const node = make('li'), summary = make('p'), feedback = make('p'); feedback.setAttribute('role', 'status');
        const cleanupNote = make('p'); cleanupNote.setAttribute('role', 'status'); cleanupNote.setAttribute('data-remote-backup-cleanup-note', ''); cleanupNote.hidden = true;
        const cleanupLink = make('a', 'Review storage connection'); cleanupLink.setAttribute('data-remote-backup-cleanup-connection', ''); cleanupLink.hidden = true;
        const previewStatus = make('p'); previewStatus.setAttribute('role', 'status'); previewStatus.hidden = true;
        previewStatus.setAttribute('data-remote-backup-preview-status', '');
        const check = make('button', 'Check stored copy'), prepare = make('button', 'Prepare a restore');
        const details = make('details'), location = make('p'), checksum = make('p');
        details.setAttribute('data-remote-backup-details', ''); details.appendChild(make('summary', 'Details and checks')); details.appendChild(location); details.appendChild(checksum);
        check.type = prepare.type = 'button'; check.className = prepare.className = 'rx-btn rx-btn-secondary';
        node.setAttribute('data-remote-backup-id', receipt.operation_id); check.setAttribute('data-remote-backup-check', ''); prepare.setAttribute('data-remote-backup-restore', '');
        node.appendChild(summary); node.appendChild(cleanupNote); node.appendChild(cleanupLink); node.appendChild(prepare); node.appendChild(feedback); node.appendChild(previewStatus); node.appendChild(details); details.appendChild(check);
        const drill = drills ? make('button', 'Test recovery') : undefined;
        if (drill) { drill.type = 'button'; drill.className = 'rx-btn rx-btn-secondary'; drill.setAttribute('data-remote-backup-drill', ''); details.appendChild(drill); }
        row = { node, summary, cleanupNote, cleanupLink, note: feedback, check, prepare, drill, location, checksum, previewStatus, previewExpired: false, details, attentionShown: false, receipt, busy: false, checkUnconfirmed: false }; rows.set(receipt.operation_id, row);
        const current = row;
        drill?.addEventListener('click', () => {
          if (drill.getAttribute('aria-disabled') === 'true') return;
          tools.element.open = true;
          current.note.textContent = drills?.choose(current.receipt) ? 'Selected for a recovery test. Enter its recovery key in Test recovery under More backup tools.' : 'Wait for the current test request to finish.';
        });
        check.addEventListener('click', () => {
          const id = current.receipt.operation_id;
          if (disposed || rows.get(id) !== current || current.busy || current.checkUnconfirmed || check.getAttribute('aria-disabled') === 'true') return;
          generation++; pendingChecks++; queuedRefresh = true;
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          current.busy = true; current.note.textContent = 'Checking the stored copy…'; renderRow(current);
          status.textContent = 'Waiting to refresh backup history after the stored copy check request.'; updateRefreshButton();
          void (async () => {
            try {
              const result = await ports.check({ operation_id: id });
              if (disposed || rows.get(id) !== current) return;
              if (!result || result.operation_id !== id || !COPY[result.state]) throw new Error('Invalid backup status');
              current.receipt = result; current.checkUnconfirmed = false; current.note.textContent = ''; reconcileDrillBackup();
            } catch {
              if (!disposed && rows.get(id) === current) {
                current.checkUnconfirmed = true;
                current.note.textContent = 'The stored copy check could not be confirmed. Refresh backup status before trying again.';
              }
            } finally {
              current.busy = false; pendingChecks--; generation++;
              if (!disposed) {
                if (rows.get(id) === current) renderRow(current);
                updateRefreshButton();
                if (pendingChecks === 0 && !loading) { queuedRefresh = false; schedule(250); }
              }
            }
          })();
        });
        prepare.addEventListener('click', () => {
          const id = current.receipt.operation_id;
          if (disposed || rows.get(id) !== current || current.busy) return;
          // A suspended tab can leave an expired Open label on screen until this action.
          if (expirePreview(current)) { renderRow(current); schedulePreviewExpiry(); return; }
          if (prepare.getAttribute('aria-disabled') === 'true') return;
          if (current.prepared) {
            previewMessage(current, options.onRestore(current.prepared.name)
              ? 'Enter the backup’s recovery key, then preview it. Nothing has been restored yet.'
              : 'Wait for the current backup or restore to finish.');
            return;
          }
          if (current.checkUnconfirmed || current.receipt.state !== 'verified') { renderRow(current); return; }
          current.busy = true; current.previewExpired = false;
          previewMessage(current, 'Retrieving and verifying this backup…'); renderRow(current);
          void (async () => {
            try {
              const result = await ports.retrieve({ operation_id: id });
              if (disposed || rows.get(id) !== current) return;
              if (!/^recued-upload-[0-9a-f]{32}\.recued\.archive$/u.test(result.staged_name)) throw new Error('Invalid staged backup name');
              current.prepared = { name: result.staged_name, at: Date.now() };
              previewMessage(current, 'Ready. Open the restore preview when you are ready to enter its recovery key.');
            } catch {
              if (!disposed && rows.get(id) === current) previewMessage(current, 'This backup could not be retrieved and verified. No restore was started.');
            } finally {
              current.busy = false;
              if (!disposed && rows.get(id) === current) { renderRow(current); schedulePreviewExpiry(); }
            }
          })();
        });
        history.appendChild(node);
      }
      row.receipt = receipt; row.checkUnconfirmed = false; renderRow(row);
    }
    // Keep stable row/button nodes while placing newly discovered receipts in
    // server order. Moving a focused existing row would blur it in some engines.
    if (!history.contains(doc.activeElement)) for (const receipt of receipts) history.appendChild(rows.get(receipt.operation_id)!.node);
    reconcileDrillBackup();
    schedulePreviewExpiry();
    status.textContent = receipts.length ? 'Showing the latest remote backup receipts.' : 'No remote backups yet.';
    // Verification can finish before asynchronous retention. Observe the
    // older copy's removal too, even after the new copy becomes verified.
    if (receipts.some(row => ACTIVE.has(row.state) || row.state === 'pruning')) schedule();
  };
  const renderDestinations = (values: ArchiveRemoteDestination[]): void => {
    const signature = JSON.stringify(values);
    if (signature === choicesSignature) return;
    choicesSignature = signature;
    unattended?.destinations(values);
    destinations = new Map(values.map(value => [value.connection_name, value]));
    while (select.firstChild) select.removeChild(select.firstChild);
    const localOption = make('option', 'This server — download a copy afterward'); localOption.value = ''; select.appendChild(localOption);
    for (const value of values) {
      const option = make('option', `${value.connection_name} — ${value.bucket}${value.prefix ? `/${value.prefix}` : ''}`);
      option.value = value.connection_name; select.appendChild(option);
    }
    if (chosen && destinations.get(chosen.connection_name)?.destination_id !== chosen.destination_id) {
      const stale = make('option', `${chosen.connection_name} — changed or unavailable; choose again`);
      stale.value = `stale:${chosen.connection_name}`; select.appendChild(stale); select.value = stale.value;
    } else select.value = chosen?.connection_name ?? '';
    validation.refresh();
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    if (pendingChecks > 0) { queuedRefresh = true; return; }
    if (loading) { queuedRefresh = true; return; }
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    loading = true; queuedRefresh = false; const ownGeneration = ++generation; updateRefreshButton();
    void health?.refresh(); void integrity?.refresh(); void watchdog?.refresh(); void unattended?.refresh();
    try {
      const [choices, receipts] = await Promise.all([ports.destinations(), ports.list()]);
      if (disposed) return;
      if (generation !== ownGeneration) { queuedRefresh = true; return; }
      renderDestinations(choices.destinations); renderHistory(receipts.backups);
      await drills?.refresh();
    } catch {
      if (!disposed) {
        if (generation !== ownGeneration) queuedRefresh = true;
        else status.textContent = 'Storage choices and history could not be checked. Reconnect and refresh.';
      }
    }
    finally {
      loading = false;
      if (!disposed) {
        updateRefreshButton();
        if (queuedRefresh && pendingChecks === 0) { queuedRefresh = false; schedule(250); }
      }
    }
  };
  for (const event of ['input', 'change']) {
    select.addEventListener(event, () => {
      if (disposed) return;
      if (select.value === '') chosen = undefined;
      else if (destinations.has(select.value)) chosen = destinations.get(select.value);
      validation.refresh();
    });
    keep.addEventListener(event, () => { if (!disposed) validation.refresh(); });
  }
  refreshButton.addEventListener('click', () => { if (!loading && !healthPending && !integrityPending && !watchdogPending && !unattendedPending) void refresh(); });
  const detach = ports.onConnected?.(() => { void refresh(); }); void refresh();
  return {
    focusReadinessItem(item: RestoreReadinessItem): void {
      if (disposed) return;
      const controls: Record<RestoreReadinessItem, string> = {
        schedule: 'data-unattended-enabled', backup: 'data-unattended-enabled', recovery: 'data-remote-backups-refresh',
        integrity: 'data-backup-integrity-enabled', alerts: 'data-backup-health-enabled',
        monitor: 'data-backup-watchdog-enabled', drill: 'data-backup-watchdog-drill-review',
      };
      const selected = host.querySelector<HTMLInputElement | HTMLButtonElement>(`[${controls[item]}]`);
      const control = selected && !selected.disabled ? selected : host.querySelector<HTMLElement>('[data-remote-backups-refresh]');
      if (control) revealBackupControl(control);
      control?.focus(); control?.scrollIntoView?.({ block: 'center' });
    },
    target(): ArchiveRemoteTarget | undefined {
      if (disposed) throw new Error('Reload Backup & Recovery before choosing storage.');
      if (destinationIssue() || retentionIssue()) storage.element.open = true;
      if (!validation.validate()) throw new BackupFormValidationError(destinationIssue() ?? retentionIssue());
      validation.reset();
      if (select.value === '') return undefined;
      const value = destinations.get(select.value)!;
      const count = Number(keep.value);
      return { operation_id: globalThis.crypto.randomUUID(), connection_name: value.connection_name, destination_id: value.destination_id, keep_last: count };
    },
    refresh,
    dispose() { disposed = true; generation++; validation.dispose(); watchdog?.dispose(); integrity?.dispose(); health?.dispose(); unattended?.dispose(); drills?.dispose(); if (timer !== undefined) clearTimeout(timer); if (previewTimer !== undefined) clearTimeout(previewTimer); detach?.(); },
  };
};
