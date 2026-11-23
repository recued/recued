/** D-403 (D-403) — Settings ▸ Server ▸ Storage: what takes space on the owner's
 *  server, by kind, and the purge they run: *"manual for owner to take action"*.
 *
 *  - The database file, and the space free inside it that Recued fills before the file grows.
 *  - One row per kind: items, size where the server knows it, oldest item, added in 30 days.
 *  - A kind that can be purged offers **Delete older than…**: choose 3 months, 6 months, a year or a
 *    date, by the date the kind is purged by (a row's last save, a run's start, a reading's time);
 *    preview what goes (nothing is deleted yet); export first where the kind has an export (a Records
 *    kind's export is all its rows: `records.export` takes no date); then **Delete N items**, the
 *    button naming the count. The server binds the delete to the preview and refuses it if the count
 *    moved. A kind that can't be purged says why, in a word.
 *
 *  Built with DOM calls, not markup strings: every word on it is the server's or the owner's. */
import {
  formatPressureBytes,
  parseRecordsStorageKind,
  type AuditExportPage,
  type AuditExportRequest,
  type RecordsPackRef,
  type StorageKindHold,
  type StorageKindRow,
  type StorageKindsResponse,
  type StoragePurgePreview,
  type StoragePurgePreviewRequest,
  type StoragePurgeRunRequest,
  type StoragePurgeRunResult,
} from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const STORAGE_SPACE_HOST_ATTR = 'data-recued-storage-space-host';
/** Each control's stable hook, for tests and the browser checks. */
export const STORAGE_SPACE_ACTION_ATTR = 'data-recued-storage-action';

export interface MountStorageSpacePanelOptions {
  host: HTMLElement;
  /** `storage.kinds.read`. */
  readKinds: () => Promise<StorageKindsResponse>;
  /** `storage.purge.preview`. */
  preview: (args: StoragePurgePreviewRequest) => Promise<StoragePurgePreview>;
  /** `storage.purge.run`. */
  run: (args: StoragePurgeRunRequest) => Promise<StoragePurgeRunResult>;
  /** `records.export` as CSV, for "Export all rows first" on a Records kind: it takes no date, so it
   *  saves the whole kind. Absent ⇒ no export offered. */
  exportRecords?: (args: { owner: RecordsPackRef; entity: string; format: 'csv' }) => Promise<{ csv: string }>;
  /** `audit.export.page`, for "Export them first" on run history. Absent ⇒ no export offered. */
  exportRuns?: (args: AuditExportRequest) => Promise<AuditExportPage>;
  /** Saves a file; tests pass their own. */
  download?: (filename: string, text: string, type: string) => void;
  now?: () => number;
}

export interface StorageSpacePanelMount {
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  hasInFlightWork(): boolean;
  hasUnsavedChanges(): boolean;
  dispose(): void;
}

const HOLD_WORDS: Record<StorageKindHold, string> = {
  yours: 'Yours, never deleted here',
  with_source: 'Goes when its source goes',
  resyncs: 'Would come back on the next sync',
  not_yet: 'Not yet',
};

/** The date a kind is purged by, in the form's legend and the preview. */
const BY_WORDS: Record<NonNullable<StorageKindRow['purge']>['by'], string> = { saved: 'saved', started: 'started', taken: 'taken' };

const CHOICES = [
  { id: '3', label: '3 months ago', months: 3 },
  { id: '6', label: '6 months ago', months: 6 },
  { id: '12', label: 'A year ago', months: 12 },
  { id: 'date', label: 'A date' },
] as const;
type ChoiceId = (typeof CHOICES)[number]['id'];

interface PurgeForm {
  row: StorageKindRow;
  choice: ChoiceId;
  date: string;
  busy: 'preview' | 'export' | 'run' | null;
  preview?: StoragePurgePreview;
  result?: StoragePurgeRunResult;
  error?: string;
  exported?: string;
  available: boolean;
  operation: number;
  dateError: boolean;
  unconfirmed: boolean;
  view?: PurgeView;
}

interface PurgeView {
  section: HTMLElement;
  holder: HTMLTableRowElement;
  heading: HTMLElement;
  legend: HTMLElement;
  fields: HTMLFieldSetElement;
  radios: HTMLInputElement[];
  date: HTMLInputElement;
  dateError: HTMLElement;
  error: HTMLElement;
  unavailable: HTMLElement;
  progress: HTMLElement;
  preview: HTMLElement;
  exported: HTMLElement;
  receipt: HTMLElement;
  blocked: HTMLElement;
  actions: HTMLElement;
}

const count = (n: number): string => n.toLocaleString('en-US');
const itemWords = (n: number, words: string): string => `${count(n)} ${n === 1 ? words.replace(/s$/u, '') : words}`;
const dateWords = (at: number): string => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const isoDay = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The cutoff a choice means: midnight, that many calendar months back, or the chosen day's midnight. */
export const storagePurgeCutoff = (choice: ChoiceId, date: string, now: number): number | undefined => {
  if (choice === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined;
    const at = new Date(`${date}T00:00:00`).getTime();
    return Number.isFinite(at) ? at : undefined;
  }
  const months = CHOICES.find((option) => option.id === choice)!;
  const at = new Date(now);
  at.setHours(0, 0, 0, 0);
  at.setMonth(at.getMonth() - ('months' in months ? months.months : 0));
  return at.getTime();
};

export const mountStorageSpacePanel = (opts: MountStorageSpacePanelOptions): StorageSpacePanelMount => {
  const doc = opts.host.ownerDocument;
  const now = opts.now ?? Date.now;
  let data: StorageKindsResponse | undefined;
  let loadError: string | undefined;
  let form: PurgeForm | undefined;
  let disposed = false;
  let generation = 0;
  let reading: { generation: number; promise: Promise<void> } | undefined;
  let pending: Promise<void> = Promise.resolve();
  opts.host.setAttribute(STORAGE_SPACE_HOST_ATTR, '');

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (name === 'class') node.className = value;
      else if (name === 'text') node.textContent = value;
      else node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
  };
  const action = (name: string, label: string, onClick: () => void, extra: Record<string, string> = {}): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: 'storage-space-btn', [STORAGE_SPACE_ACTION_ATTR]: name,
      'data-focus-key': `${name}:${extra['data-kind'] ?? ''}`, ...extra }, label);
    button.addEventListener('click', () => {
      if (!disposed && !button.disabled && opts.host.contains(button) && !button.closest('[hidden]')) onClick();
    });
    return button;
  };
  const focus = (node: HTMLElement, reveal = true): void => {
    node.focus({ preventScroll: true });
    if (reveal) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const visible = (node: HTMLElement): boolean => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < (doc.defaultView?.innerHeight ?? 0);
  };
  const findFocus = (key: string): HTMLElement | undefined =>
    [...opts.host.querySelectorAll<HTMLElement>('[data-focus-key]')].find(node => node.getAttribute('data-focus-key') === key);
  const text = (node: HTMLElement, value: string): void => { if (node.textContent !== value) node.textContent = value; };
  const download = opts.download ?? ((filename: string, body: string, type: string) => {
    const view = doc.defaultView;
    if (!view || typeof view.URL?.createObjectURL !== 'function') throw new Error('You cannot download files here.');
    const url = view.URL.createObjectURL(new view.Blob([body], { type }));
    const link = el('a', { href: url, download: filename });
    link.hidden = true;
    (doc.body ?? opts.host).append(link);
    try { link.click(); } finally { link.remove(); view.URL.revokeObjectURL(url); }
  });

  const heading = el('h2', { tabindex: '-1', 'data-focus-key': 'heading', text: 'What takes space' });
  const readStatus = el('p', { role: 'status', 'aria-atomic': 'true', tabindex: '-1', class: 'storage-space-progress', 'data-focus-key': 'loading' });
  const readError = el('p', { role: 'alert', class: 'storage-space-error' });
  const retry = action('retry', 'Try again', () => { void load(true); });
  const readFeedback = el('div', { class: 'storage-space-read-feedback' }, readStatus, readError, retry);
  const database = el('p', { class: 'storage-space-database', 'data-recued-storage-database': '' });
  const empty = el('p', { class: 'storage-space-note', text: 'No stored kinds to show.' });
  const body = el('tbody', { role: 'rowgroup' });
  const table = el('table', { class: 'storage-space-table', role: 'table', 'aria-label': 'What takes space' },
    el('thead', { role: 'rowgroup' }, el('tr', { role: 'row' },
      ...['Kind', 'Items', 'Size', 'Oldest', 'Last 30 days', 'Actions'].map((value, index) =>
        el('th', { scope: 'col', role: 'columnheader' }, el('span', { class: index === 5 ? 'storage-space-sr-only' : '', text: value }))))), body);
  const root = el('section', { class: 'storage-space', 'aria-label': 'What takes space', 'data-recued-storage-space': '' },
    heading, el('p', { class: 'storage-space-summary',
      text: "Your server's data, by kind. You can delete a kind's items older than a date. Nothing here deletes on its own." }),
    readFeedback, database, empty, table);
  opts.host.replaceChildren(root);

  interface RowView { node: HTMLTableRowElement; title: HTMLElement; values: HTMLElement[]; actions: HTMLElement; row: StorageKindRow }
  const rows = new Map<string, RowView>();
  const canExport = (row: StorageKindRow): boolean =>
    (row.purge?.export === 'records' && parseRecordsStorageKind(row.kind) !== undefined && opts.exportRecords !== undefined)
    || (row.kind === 'runs' && row.purge?.export === 'runs' && opts.exportRuns !== undefined);
  const patchRow = (row: StorageKindRow): RowView => {
    let view = rows.get(row.kind);
    if (!view) {
      const title = el('th', { scope: 'row', role: 'rowheader' });
      const values = ['Items', 'Size', 'Oldest', 'Last 30 days'].map(label => el('span', { class: 'storage-space-cell-value', 'data-label': label }));
      const actions = el('td', { class: 'storage-space-action', role: 'cell' });
      const node = el('tr', { role: 'row', 'data-recued-storage-kind': row.kind }, title,
        ...values.map(value => el('td', { role: 'cell' }, el('span', { class: 'storage-space-cell-label', 'aria-hidden': 'true', text: value.dataset.label! }), value)), actions);
      view = { node, title, values, actions, row }; rows.set(row.kind, view);
    }
    view.row = row;
    text(view.title, row.label);
    [row.items === undefined ? '—' : itemWords(row.items, row.item_words),
      row.bytes === undefined ? '—' : formatPressureBytes(row.bytes),
      row.oldest_at === undefined ? '—' : dateWords(row.oldest_at),
      row.added_30d === undefined ? '—' : `+${count(row.added_30d)}`].forEach((value, index) => text(view!.values[index]!, value));
    const existing = view.actions.querySelector<HTMLButtonElement>('button');
    if (row.purge) {
      if (!existing) view.actions.replaceChildren(action('open', 'Delete older than…', () => openForm(view!.row),
        { 'data-kind': row.kind, 'aria-label': `Delete ${row.label} older than a date` }));
      const button = view.actions.querySelector<HTMLButtonElement>('button')!;
      button.disabled = form?.busy != null;
      button.setAttribute('aria-label', `Delete ${row.label} older than a date`);
    } else text(view.actions, row.hold ? HOLD_WORDS[row.hold] : '');
    return view;
  };

  const patchInventory = (): void => {
    database.hidden = !data;
    table.hidden = !data || (data.kinds.length === 0 && !form);
    empty.hidden = !data || data.kinds.length > 0 || !!form;
    if (!data) return;
    text(database, `The database file is ${formatPressureBytes(data.database.file_bytes)}.`
      + (data.database.free_bytes > 0 ? ` ${formatPressureBytes(data.database.free_bytes)} of it is free space from deleted items, which Recued fills before the file grows.` : ''));
    const current = new Set(data.kinds.map(row => row.kind));
    for (const [kind, view] of rows) {
      if (!current.has(kind) && kind !== form?.row.kind) { view.node.remove(); rows.delete(kind); }
    }
    // Keep the active form and its native editor connected, even if a read changes row order.
    for (const row of data.kinds) {
      const view = patchRow(row);
      if (!view.node.isConnected) body.append(view.node);
      if (!form) body.append(view.node);
    }
    if (form) {
      const row = data.kinds.find(row => row.kind === form!.row.kind);
      form.available = !!row?.purge;
      if (row?.purge?.by !== form.row.purge?.by && !form.busy) form.preview = undefined;
      if (row) form.row = row;
      if (!form.available && !form.busy) form.preview = undefined;
    }
  };

  const patchForm = (open: PurgeForm): void => {
    const view = open.view!;
    const active = doc.activeElement as HTMLElement | null;
    const key = active && view.section.contains(active) ? active.getAttribute('data-focus-key') : null;
    text(view.heading, `Delete ${open.row.label} older than…`);
    const by = open.row.purge ? BY_WORDS[open.row.purge.by] : undefined;
    text(view.legend, by ? `${by[0]!.toUpperCase()}${by.slice(1)} before` : 'Older than');
    view.fields.hidden = !!open.result;
    view.fields.disabled = open.busy !== null || !open.available;
    for (const input of view.radios) if (input.checked !== (input.value === open.choice)) input.checked = input.value === open.choice;
    view.date.disabled = open.choice !== 'date';
    view.date.setAttribute('aria-invalid', String(open.dateError));
    view.dateError.hidden = !open.dateError;
    text(view.error, open.error ?? ''); view.error.hidden = !open.error;
    view.unavailable.hidden = open.available || !!open.result;
    text(view.progress, open.busy === 'preview' ? 'Counting older items…' : open.busy === 'export' ? 'Preparing your export…' : 'Deleting the previewed items…');
    view.progress.hidden = !open.busy;
    view.preview.hidden = !open.preview || !!open.result;
    if (open.preview) {
      const { items, bytes, oldest_at: oldest, newest_at: newest } = open.preview;
      const range = oldest === undefined || newest === undefined ? '' : dateWords(oldest) === dateWords(newest)
        ? ` on ${dateWords(oldest)}` : ` from ${dateWords(oldest)} to ${dateWords(newest)}`;
      text(view.preview, items === 0 ? 'Nothing is older than that.' : `${itemWords(items, open.row.item_words)}${range && by ? ` ${by}` : ''}${range}`
        + `${bytes ? `, about ${formatPressureBytes(bytes)}` : ''}. Nothing is deleted yet.`);
    }
    text(view.exported, open.exported ? `Saved ${open.exported}.` : ''); view.exported.hidden = !open.exported || !!open.result;
    view.receipt.hidden = !open.result;
    view.blocked.hidden = !open.result?.blocked;
    if (open.result) {
      const { deleted, blocked, bytes_freed: freed } = open.result;
      text(view.receipt, deleted === 0 ? 'Nothing was deleted.' : `Deleted ${itemWords(deleted, open.row.item_words)}.`
        + (freed ? ` That freed about ${formatPressureBytes(freed)} inside the database file.` : ''));
      text(view.blocked, `${itemWords(blocked, open.row.item_words)} stayed: other records point at them.`);
    }
    const buttons: HTMLButtonElement[] = [];
    if (!open.result && open.available) {
      const preview = open.preview;
      if (!preview) buttons.push(action('preview', 'Preview', () => { void doPreview(open); }));
      else if (preview.items > 0) {
        if (canExport(open.row)) buttons.push(action('export', open.row.purge?.export === 'records' ? 'Export all rows first' : 'Export them first', () => { void doExport(open, preview); }));
        const run = action('run', `Delete ${itemWords(preview.items, open.row.item_words)}`, () => { void doRun(open, preview); });
        run.classList.add('storage-space-btn--danger'); buttons.push(run);
      }
      for (const button of buttons) button.disabled = open.busy !== null;
    }
    const cancel = action(open.result ? 'close' : 'cancel', open.result ? 'Done' : 'Cancel', () => closeForm(open));
    cancel.disabled = open.busy === 'run'; buttons.push(cancel);
    view.actions.replaceChildren(...buttons);
    // Read refreshes can replace buttons, but never the date input or the focused radio.
    if (key && active && !active.isConnected) { const target = findFocus(key); if (target) focus(target, false); }
    else if (active && view.fields.contains(active) && !open.available && !open.busy) focus(view.unavailable);
  };
  const patch = (): void => {
    if (disposed) return;
    readStatus.hidden = !reading;
    text(readStatus, data ? 'Updating space measurements…' : 'Measuring…');
    readError.hidden = !loadError || !!reading; text(readError, loadError ?? '');
    retry.hidden = !loadError || !!reading;
    readFeedback.hidden = !reading && !loadError;
    patchInventory();
    if (form) patchForm(form);
  };

  const openForm = (row: StorageKindRow): void => {
    if (form?.busy || !row.purge) return;
    form?.view?.holder.remove();
    const open: PurgeForm = { row, choice: '6', date: isoDay(now() - 30 * 86_400_000), busy: null,
      available: true, operation: 0, dateError: false, unconfirmed: false };
    form = open;
    const formHeading = el('h3', { tabindex: '-1', 'data-focus-key': 'purge-heading' });
    const legend = el('legend');
    const fields = el('fieldset', { class: 'storage-space-choices' }, legend);
    const radios = CHOICES.map(option => {
      const input = el('input', { type: 'radio', name: 'storage-purge-older-than', value: option.id, 'data-focus-key': `choice:${option.id}` });
      input.addEventListener('change', () => {
        if (disposed || form !== open || open.busy || !input.checked) return;
        open.choice = option.id; open.preview = undefined; open.error = undefined; open.exported = undefined; open.dateError = false;
        patchForm(open);
      });
      return input;
    });
    const choices = el('div', { class: 'storage-space-choice-grid' }, ...radios.map((input, index) =>
      el('label', { class: 'storage-space-choice' }, input, el('span', { text: CHOICES[index]!.label }))));
    const date = el('input', { type: 'date', 'aria-label': 'The date', max: isoDay(now() - 86_400_000), value: open.date, 'data-focus-key': 'date' });
    const dateError = el('span', { id: 'storage-space-date-error', class: 'storage-space-error', text: 'Choose a date.' });
    const onDate = (): void => {
      if (disposed || form !== open || open.busy || open.choice !== 'date') return;
      open.date = date.value; open.preview = undefined; open.error = undefined; open.exported = undefined; open.dateError = false;
      patchForm(open);
    };
    date.addEventListener('input', onDate); date.addEventListener('change', onDate);
    date.setAttribute('aria-describedby', 'storage-space-date-error');
    fields.append(choices, el('label', { class: 'storage-space-date' }, el('span', { text: 'The date' }), date, dateError));
    const error = el('p', { role: 'alert', class: 'storage-space-error' });
    const unavailable = el('p', { class: 'storage-space-note', role: 'status', tabindex: '-1', 'data-focus-key': 'unavailable',
      text: 'This kind is no longer available for deletion. Your choices are kept here.' });
    const progress = el('p', { role: 'status', 'aria-atomic': 'true', tabindex: '-1', 'data-focus-key': 'progress', class: 'storage-space-progress' });
    const preview = el('p', { role: 'status', 'aria-atomic': 'true', tabindex: '-1', 'data-focus-key': 'preview', class: 'storage-space-preview' });
    const exported = el('p', { class: 'storage-space-note' });
    const receipt = el('p', { role: 'status', 'aria-atomic': 'true', tabindex: '-1', 'data-focus-key': 'receipt', class: 'storage-space-receipt' });
    const blocked = el('p', { class: 'storage-space-note' });
    const actions = el('div', { class: 'storage-space-actions' });
    const section = el('section', { class: 'storage-space-purge', 'aria-label': `Delete ${row.label} older than a date`, 'data-recued-storage-purge': row.kind },
      formHeading, fields, unavailable, error, progress, preview, exported, receipt, blocked, actions);
    const holder = el('tr', { class: 'storage-space-purge-row', role: 'row' }, el('td', { colspan: '6', role: 'cell' }, section));
    open.view = { section, holder, heading: formHeading, legend, fields, radios, date, dateError, error, unavailable, progress, preview, exported, receipt, blocked, actions };
    rows.get(row.kind)!.node.after(holder);
    patch(); focus(formHeading);
  };
  const closeForm = (open: PurgeForm): void => {
    if (disposed || form !== open || open.busy === 'run') return;
    open.operation++; open.view!.holder.remove(); form = undefined; patch();
    focus(rows.get(open.row.kind)?.actions.querySelector('button') ?? heading);
  };
  const owns = (open: PurgeForm, operation: number): boolean => !disposed && form === open && open.operation === operation;
  const begin = (open: PurgeForm, busy: NonNullable<PurgeForm['busy']>): number => {
    open.busy = busy; open.error = undefined; const operation = ++open.operation;
    patch(); focus(open.view!.progress); return operation;
  };
  const settle = (open: PurgeForm, update: () => void, target: () => HTMLElement): void => {
    const progress = open.view!.progress;
    const owner = doc.activeElement === progress;
    const reveal = visible(progress);
    update(); open.busy = null; patch();
    if (owner) {
      const next = target();
      focus(next.closest('[hidden]') ? (open.view!.unavailable.hidden ? open.view!.heading : open.view!.unavailable) : next, reveal);
    }
  };
  const doPreview = async (open: PurgeForm): Promise<void> => {
    if (disposed || form !== open || open.busy || !open.available) return;
    const before = storagePurgeCutoff(open.choice, open.date, now());
    if (before === undefined) {
      open.dateError = true; patchForm(open); focus(open.view!.date); return;
    }
    const operation = begin(open, 'preview');
    try {
      const preview = await opts.preview({ kind: open.row.kind, before });
      if (!owns(open, operation)) return;
      settle(open, () => { open.preview = preview; open.unconfirmed = false; }, () => open.view!.preview);
    } catch (error) {
      if (!owns(open, operation)) return;
      settle(open, () => { open.error = humanizeRpcError(error); }, () => open.view!.actions.querySelector('button')!);
    }
  };
  const doExport = async (open: PurgeForm, preview: StoragePurgePreview): Promise<void> => {
    if (disposed || form !== open || open.busy || open.preview !== preview || !canExport(open.row)) return;
    const operation = begin(open, 'export');
    try {
      let filename: string, content: string, type: string;
      const pack = parseRecordsStorageKind(open.row.kind);
      if (open.row.purge?.export === 'records' && pack && opts.exportRecords) {
        const exported = await opts.exportRecords({ owner: { publisher: pack.publisher, pack_slug: pack.pack_slug }, entity: pack.kind, format: 'csv' });
        if (!owns(open, operation)) return;
        filename = `${pack.pack_slug}-${pack.kind}-${isoDay(now())}.csv`; content = exported.csv; type = 'text/csv';
      } else if (open.row.kind === 'runs' && opts.exportRuns) {
        const parts: string[] = [], cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await opts.exportRuns({ until: preview.before, format: 'jsonl', ...(cursor ? { cursor } : {}) });
          if (!owns(open, operation)) return;
          parts.push(page.body); cursor = page.next_cursor;
          if (cursor) {
            if (cursors.has(cursor)) throw new Error('The export repeated a page. Try exporting again.');
            cursors.add(cursor);
          }
        } while (cursor);
        filename = `run-history-before-${isoDay(preview.before)}.jsonl`; content = parts.join(''); type = 'application/x-ndjson';
      } else throw new Error('Export is no longer available for this kind.');
      if (!owns(open, operation)) return;
      download(filename, content, type);
      settle(open, () => { open.exported = filename; }, () => findFocus('run:') ?? open.view!.preview);
    } catch (error) {
      if (!owns(open, operation)) return;
      settle(open, () => { open.error = humanizeRpcError(error); }, () => findFocus('export:') ?? open.view!.preview);
    }
  };
  const doRun = async (open: PurgeForm, preview: StoragePurgePreview): Promise<void> => {
    if (disposed || form !== open || open.busy || open.preview !== preview || !open.available) return;
    // A read started before the delete cannot overwrite its refreshed inventory.
    generation++; reading = undefined;
    const operation = begin(open, 'run');
    try {
      const result = await opts.run({ kind: open.row.kind, before: preview.before, token: preview.token });
      if (!owns(open, operation)) return;
      settle(open, () => { open.result = result; open.preview = undefined; open.unconfirmed = false; }, () => open.view!.receipt);
      void load();
    } catch (error) {
      if (!owns(open, operation)) return;
      settle(open, () => { open.preview = undefined; open.unconfirmed = true;
        open.error = `${humanizeRpcError(error)} Preview again to check what remains.`; }, () => open.view!.actions.querySelector('button')!);
    }
  };
  const load = (fromRetry = false): Promise<void> => {
    if (disposed || form?.busy === 'run') return Promise.resolve();
    if (reading) return reading.promise;
    const job = { generation: ++generation, promise: Promise.resolve() };
    reading = job; patch();
    if (fromRetry) focus(readStatus);
    job.promise = (async () => {
      try {
        const result = await opts.readKinds();
        if (disposed || job.generation !== generation) return;
        data = result; loadError = undefined;
      } catch (error) {
        if (disposed || job.generation !== generation) return;
        loadError = humanizeRpcError(error);
      } finally {
        if (!disposed && job.generation === generation) {
          const owner = doc.activeElement === readStatus, reveal = visible(readStatus);
          reading = undefined; patch();
          if (owner) focus(loadError ? retry : heading, reveal);
        }
      }
    })();
    pending = job.promise;
    return pending;
  };
  void load();
  return {
    refresh: () => load(), whenLoaded: () => pending,
    hasInFlightWork: () => !disposed && (form?.busy === 'export' || form?.busy === 'run'),
    hasUnsavedChanges: () => !disposed && !!form && !form.result && (form.unconfirmed || form.choice !== '6'),
    dispose: () => { disposed = true; generation++; if (form) form.operation++; form = undefined; opts.host.replaceChildren(); },
  };
};

export { STORAGE_SPACE_PANEL_STYLES } from './storage-space-workspace-styles.js';
