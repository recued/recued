/** Storage selection and durable delivery history are independent of the
 * adjacent recovery-word/file form. Polling never repaints those inputs. */
import type { ArchiveRemoteBackup, ArchiveRemoteDestination, ArchiveRemoteTarget } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';

export interface RemoteBackupsPorts {
  destinations(): Promise<{ destinations: ArchiveRemoteDestination[] }>;
  list(): Promise<{ backups: ArchiveRemoteBackup[] }>;
  check(input: { operation_id: string }): Promise<ArchiveRemoteBackup>;
  retrieve(input: { operation_id: string }): Promise<{ staged_name: string }>;
  onConnected?: (listener: () => void) => () => void;
}
const ACTIVE = new Set(['preparing', 'uploading', 'verifying']);
const COPY: Record<ArchiveRemoteBackup['state'], string> = {
  preparing: 'Preparing the encrypted backup', uploading: 'Sending the encrypted backup', verifying: 'Reading back the stored copy',
  verified: 'Stored copy verified', unconfirmed: 'Delivery not confirmed — check before starting another backup',
  pruning: 'Older copy removal needs reconciliation', pruned: 'Removed by your retention setting',
};
export const mountRemoteBackups = (options: {
  host: HTMLElement; document: Document; ports: RemoteBackupsPorts;
  onRestore(stagedName: string): boolean;
  pollMs?: number;
}) => {
  const { host, document: doc, ports } = options;
  host.setAttribute('data-remote-backups', '');
  let disposed = false, generation = 0, loading = false, queuedRefresh = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destinations = new Map<string, ArchiveRemoteDestination>();
  let chosen: ArchiveRemoteDestination | undefined;
  let choicesSignature: string | undefined;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node;
  };
  const styles = make('style', '[data-remote-backups]{margin-block:1rem}[data-remote-backups] label{display:block;margin-block:.5rem}[data-remote-backups] select,[data-remote-backups] input{max-width:100%;box-sizing:border-box;font:inherit}[data-remote-backups] input[type=number]{width:6rem}[data-remote-backups] ul{padding:0;list-style:none}[data-remote-backups] li{padding-block:.75rem}[data-remote-backups] p{overflow-wrap:anywhere}[data-remote-backups] button{margin:.25rem .5rem .25rem 0}'); host.appendChild(styles);
  const heading = make('h3', 'Backup storage'); host.appendChild(heading);
  const destinationLabel = make('label', 'Send the next backup to ');
  const select = make('select'); select.setAttribute('data-remote-backup-destination', '');
  const local = make('option', 'This server — download a copy afterward'); local.value = ''; select.appendChild(local);
  destinationLabel.appendChild(select); host.appendChild(destinationLabel);
  const keepLabel = make('label', ' Backups to keep '), keep = make('input');
  keep.type = 'number'; keep.min = '1'; keep.max = '30'; keep.step = '1'; keep.value = '5';
  keep.setAttribute('data-remote-backup-keep', ''); keepLabel.appendChild(keep); host.appendChild(keepLabel);
  const note = make('p', 'Remote storage gets the encrypted archive. Your recovery words are used for this backup and are not saved. Older copies in Recued’s own folder are removed only after a new copy is verified.'); host.appendChild(note);
  const configure = make('a', 'Add an Amazon S3 backup connection'); configure.href = '#connections/others/enroll/s3'; host.appendChild(configure);
  const refreshButton = make('button', 'Refresh storage and history'); refreshButton.type = 'button'; refreshButton.className = 'rx-btn rx-btn-secondary';
  refreshButton.setAttribute('data-remote-backups-refresh', ''); host.appendChild(refreshButton);
  const status = make('p'); status.setAttribute('role', 'status'); host.appendChild(status);
  const historyHeading = make('h3', 'Remote backup history'); host.appendChild(historyHeading);
  const history = make('ul'); history.setAttribute('data-remote-backup-history', ''); host.appendChild(history);
  type Row = { node: HTMLLIElement; summary: HTMLParagraphElement; note: HTMLParagraphElement; check: HTMLButtonElement;
    prepare: HTMLButtonElement; location: HTMLParagraphElement; checksum: HTMLParagraphElement;
    receipt: ArchiveRemoteBackup; busy: boolean; prepared?: { name: string; at: number } };
  const rows = new Map<string, Row>();
  const renderRow = (row: Row): void => {
    const data = row.receipt, ready = row.prepared !== undefined && Date.now() - row.prepared.at < 5 * 60_000;
    if (!ready) delete row.prepared;
    row.node.setAttribute('data-remote-backup-state', data.state);
    row.summary.textContent = `${formatClientDateTime(data.created_at)} · ${data.destination.connection_name} · ${data.destination.bucket} · ${COPY[data.state]}${data.retention_pending ? ' · Some older copies could not be removed' : ''}`;
    row.location.textContent = data.object_key;
    row.checksum.textContent = data.sha256 ? `${data.bytes ?? 0} bytes · SHA-256 ${data.sha256}` : 'The exported bytes have not been recorded yet.';
    row.check.setAttribute('aria-disabled', String(row.busy || ACTIVE.has(data.state) || data.state === 'pruned' || data.state === 'pruning' || data.sha256 === undefined));
    row.prepare.textContent = row.prepared ? 'Open restore preview' : 'Prepare a restore';
    row.prepare.setAttribute('aria-disabled', String(row.busy || (!row.prepared && data.state !== 'verified')));
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
        const check = make('button', 'Check stored copy'), prepare = make('button', 'Prepare a restore');
        const details = make('details'), location = make('p'), checksum = make('p');
        details.appendChild(make('summary', 'Object location and checksum')); details.appendChild(location); details.appendChild(checksum);
        check.type = prepare.type = 'button'; check.className = prepare.className = 'rx-btn rx-btn-secondary';
        node.setAttribute('data-remote-backup-id', receipt.operation_id); check.setAttribute('data-remote-backup-check', ''); prepare.setAttribute('data-remote-backup-restore', '');
        node.appendChild(summary); node.appendChild(details); node.appendChild(check); node.appendChild(prepare); node.appendChild(feedback);
        row = { node, summary, note: feedback, check, prepare, location, checksum, receipt, busy: false }; rows.set(receipt.operation_id, row);
        const current = row;
        check.addEventListener('click', () => {
          if (check.getAttribute('aria-disabled') === 'true') return;
          current.busy = true; current.note.textContent = 'Checking the stored copy…'; renderRow(current);
          void ports.check({ operation_id: current.receipt.operation_id }).then(result => {
            if (disposed) return;
            if (!result || result.operation_id !== current.receipt.operation_id || !COPY[result.state]) throw new Error('Invalid backup status');
            current.receipt = result; current.note.textContent = ''; schedule(250);
          }).catch(() => { if (!disposed) current.note.textContent = 'The stored copy could not be checked. Reconnect and try again.'; })
            .finally(() => { current.busy = false; if (!disposed) renderRow(current); });
        });
        prepare.addEventListener('click', () => {
          if (prepare.getAttribute('aria-disabled') === 'true') return;
          if (current.prepared && Date.now() - current.prepared.at < 5 * 60_000) {
            current.note.textContent = options.onRestore(current.prepared.name)
              ? 'Enter the backup’s recovery words, then preview it. Nothing has been restored yet.'
              : 'Wait for the current backup or restore to finish.';
            return;
          }
          current.busy = true; current.note.textContent = 'Retrieving and verifying this backup…'; renderRow(current);
          void ports.retrieve({ operation_id: current.receipt.operation_id }).then(result => {
            if (disposed) return;
            if (!/^recued-upload-[0-9a-f]{32}\.recued\.archive$/u.test(result.staged_name)) throw new Error('Invalid staged backup name');
            current.prepared = { name: result.staged_name, at: Date.now() }; current.note.textContent = 'Ready. Open the restore preview when you are ready to enter its recovery words.';
          }).catch(() => { if (!disposed) current.note.textContent = 'This backup could not be retrieved and verified. No restore was started.'; })
            .finally(() => { current.busy = false; if (!disposed) renderRow(current); });
        });
        history.appendChild(node);
      }
      row.receipt = receipt; renderRow(row);
    }
    // Keep stable row/button nodes while placing newly discovered receipts in
    // server order. Moving a focused existing row would blur it in some engines.
    if (!history.contains(doc.activeElement)) for (const receipt of receipts) history.appendChild(rows.get(receipt.operation_id)!.node);
    status.textContent = receipts.length ? 'Showing the latest remote backup receipts.' : 'No remote backups yet.';
    // Verification can finish before asynchronous retention. Observe the
    // older copy's removal too, even after the new copy becomes verified.
    if (receipts.some(row => ACTIVE.has(row.state) || row.state === 'pruning')) schedule();
  };
  const renderDestinations = (values: ArchiveRemoteDestination[]): void => {
    const signature = JSON.stringify(values);
    if (signature === choicesSignature) return;
    choicesSignature = signature;
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
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    if (loading) { queuedRefresh = true; return; }
    loading = true; const ownGeneration = ++generation; refreshButton.setAttribute('aria-disabled', 'true');
    try {
      const [choices, receipts] = await Promise.all([ports.destinations(), ports.list()]);
      if (disposed || generation !== ownGeneration) return;
      renderDestinations(choices.destinations); renderHistory(receipts.backups);
    } catch { if (!disposed && generation === ownGeneration) status.textContent = 'Storage choices and history could not be checked. Reconnect and refresh.'; }
    finally {
      loading = false;
      if (!disposed) {
        refreshButton.setAttribute('aria-disabled', 'false');
        if (queuedRefresh) { queuedRefresh = false; schedule(250); }
      }
    }
  };
  select.addEventListener('change', () => { chosen = destinations.get(select.value); });
  refreshButton.addEventListener('click', () => { if (!loading) void refresh(); });
  const detach = ports.onConnected?.(() => { void refresh(); }); void refresh();
  return {
    target(): ArchiveRemoteTarget | undefined {
      if (disposed) throw new Error('Reload Backup & Recovery before choosing storage.');
      if (select.value === '') return undefined;
      const value = destinations.get(select.value);
      if (!value || !chosen || value.destination_id !== chosen.destination_id) throw new Error('Refresh the storage choices and select the destination again.');
      const count = Number(keep.value);
      if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error('Choose between 1 and 30 backups to keep.');
      return { operation_id: globalThis.crypto.randomUUID(), connection_name: value.connection_name, destination_id: value.destination_id, keep_last: count };
    },
    refresh,
    dispose() { disposed = true; generation++; if (timer !== undefined) clearTimeout(timer); detach?.(); },
  };
};
