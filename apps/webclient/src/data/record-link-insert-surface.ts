import { createRecordResultPreview, readRecordResultPreview, previewResultHtml, RECORD_RESULT_PREVIEW_STYLES } from './record-result-preview.js';
import { parseRecordLinkQuery, readExactRecordLink, verifyExactRecordLink, RECORD_LINK_QUERY_LIMIT } from './exact-record-link.js';
import { e } from '@recued/ui-shared';
import { recordLink } from '../shell/record-link.js';
import { createRecordLinkInsert, insertRecordLinkText, insertRecordLinksText, linkInsertPreviewOptions, RECORD_LINK_SELECTION_LIMIT, LINK_KINDS, linkKindLabel, searchRecordLinks,
  type LinkInsertState, type LinkKind, type LinkOption, type PreparedRecordLink, type RecordLinkSearch } from './record-link-insert.js';
import { recordLinkShortcuts, verifyRecordLinkShortcut, type RecordLinkShortcutReaders } from './record-link-shortcuts.js';
import type { RecentWorkRecords } from './recent-work-records.js';
import { readWorkLinkPreview, type WorkLinkPreviewReaders } from './work-link-preview.js';

type Owner = { key: string; kind: 'note' | 'task' | 'chat'; id?: string };
type Snapshot = { owner: string; value: string; start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrolls: Array<{ top: number; left: number }> };
type Focus = { owner: string; control: string; start?: number | null; end?: number | null; top: number };
const TRIGGER = 'data-record-link-insert', FOCUS = 'data-link-insert-focus';

/** A modal search enhances the body textarea. It never saves a record or
 * navigates away, and search results repaint only the modal's result list. */
export interface RecordLinkPickerServices {
  search: RecordLinkSearch; readers: WorkLinkPreviewReaders;
  recent?: RecentWorkRecords; pinned?: RecentWorkRecords; shortcutReaders?: Pick<RecordLinkShortcutReaders, 'mail' | 'calendar'>;
}
export const createRecordLinkInsertSurface = (deps: RecordLinkPickerServices & {
  root: HTMLElement; document: Document; owner: () => Owner | null; href: () => string;
  blocked: () => boolean;
  picker?: {
    host: () => HTMLElement | null; field: () => HTMLTextAreaElement | null; triggerHost: () => HTMLElement | null;
    selected: () => readonly PreparedRecordLink[]; commit: (records: readonly PreparedRecordLink[]) => string | null;
  };
}) => {
  let host: HTMLElement | null = null, field: HTMLTextAreaElement | null = null, trigger: HTMLButtonElement | null = null;
  let dialog: HTMLDialogElement | null = null, snapshot: Snapshot | null = null, supported: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, focusedSelection: string | undefined;
  let previewReturnKey: string | undefined, previewResultsTop = 0, showingPreview = false, selectionsExpanded = false;
  const kinds = LINK_KINDS.filter(kind => kind === 'contact' ? deps.search.contacts && deps.readers.contact : kind === 'mail' || kind === 'calendar' ? deps.search.collections && deps.readers.source : deps.search.work && deps.readers.work);
  const cancelTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const removeDialog = () => {
    const old = dialog; dialog = null;
    if (old) { try { if (old.open) old.close(); } catch { /* A removed editor already closed it. */ } old.remove(); }
  };
  const scrolls = (): Snapshot['scrolls'] => {
    const values: Snapshot['scrolls'] = [];
    for (let node: HTMLElement | null = field; node && node !== deps.root; node = node.parentElement) values.push({ top: node.scrollTop, left: node.scrollLeft });
    return values;
  };
  const restoreScroll = (saved: Snapshot) => {
    let node: HTMLElement | null = field;
    for (const at of saved.scrolls) { if (!node || node === deps.root) break; node.scrollTop = at.top; node.scrollLeft = at.left; node = node.parentElement; }
  };
  const restoreEditor = (saved: Snapshot | null) => {
    if (!saved || deps.owner()?.key !== saved.owner || !field?.isConnected || field.disabled) return;
    field.focus({ preventScroll: true });
    if (field.value === saved.value) { field.setSelectionRange(saved.start, saved.end, saved.direction); restoreScroll(saved); }
  };
  const insertIntoDraft = (build: (saved: Snapshot, textarea: HTMLTextAreaElement) => ReturnType<typeof insertRecordLinkText>, limitMessage: string): string | null => {
    const saved = snapshot;
    if (!saved || deps.owner()?.key !== saved.owner || !field?.isConnected || field.value !== saved.value || field.disabled || field.readOnly || deps.blocked())
      return 'The draft changed. Close this picker and try again.';
    const value = build(saved, field);
    if (!value) return limitMessage;
    removeDialog(); cancelTimer();
    field.focus({ preventScroll: true }); field.setSelectionRange(value.start, value.end, saved.direction);
    // Native text insertion retains the textarea's Undo history. Engines
    // without that editing command still have the standard range fallback.
    try { deps.document.execCommand?.('insertText', false, value.text); } catch { /* Use the range fallback below. */ }
    if (field.value !== value.value) {
      if (field.value !== saved.value) return 'The text changed while inserting this link. Review the draft.';
      field.setRangeText(value.text, value.start, value.end, 'end');
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus({ preventScroll: true }); field.setSelectionRange(value.cursor, value.cursor);
    restoreScroll(saved); snapshot = null;
    return null;
  };
  const model = createRecordLinkInsert({ owner: () => deps.owner()?.key ?? null, kinds,
    lookup: { parse: query => parseRecordLinkQuery(query, deps.href()), read: target => readExactRecordLink(target, deps.readers, deps.href()), verify: match => verifyExactRecordLink(match, deps.readers, deps.href()) },
    search: (kind, query) => searchRecordLinks(kind, query, deps.search),
    ...(deps.recent || deps.pinned ? { shortcuts: (filter: LinkKind | 'all') => {
      const owner = deps.owner();
      return recordLinkShortcuts({ recent: deps.recent, pinned: deps.pinned, kinds, filter, current: owner && owner.kind !== 'chat' ? { kind: owner.kind, id: owner.id } : undefined });
    } } : {}),
    verifyShortcut: record => verifyRecordLinkShortcut(record, { ...deps.readers, ...deps.shortcutReaders }),
    verify: async (target, receivedAt) => (await readWorkLinkPreview(target, deps.readers, receivedAt)).state === 'ready',
    prepareSelection: async option => {
      const result = await readRecordResultPreview(option, { ...deps.readers, ...deps.shortcutReaders }, deps.href());
      return result.state === 'ready' ? { state: 'ready', match: { ...result.reference, details: result.details } } : result;
    },
    insert: target => insertIntoDraft((saved, textarea) => insertRecordLinkText(saved.value, saved.start, saved.end, deps.href(), target, textarea.maxLength), 'This link would exceed the text limit. Shorten the draft and try again.'),
    ...(deps.picker ? { initialSelections: deps.picker.selected, allowEmptyBatch: true } : {}),
    insertBatch: records => {
      if (!deps.picker) return insertIntoDraft((saved, textarea) => insertRecordLinksText(saved.value, saved.start, saved.end, deps.href(), records, textarea.maxLength), 'These links would exceed the text limit. Shorten the draft and try again.');
      const saved = snapshot;
      if (!saved || deps.owner()?.key !== saved.owner || !field?.isConnected || field.value !== saved.value || deps.blocked()) return 'The draft changed. Close this picker and try again.';
      const entries = model.state()?.selections ?? [];
      const error = deps.picker.commit(records.map(reference => ({ reference, ...(entries.find(row => row.reference === reference)?.option.shortcut ? { shortcut: entries.find(row => row.reference === reference)!.option.shortcut } : {}) })));
      if (error) return error;
      snapshot = null; removeDialog(); restoreEditor(saved); return null;
    },
    changed: () => paint(),
  });
  const preview = createRecordResultPreview({
    owner: () => { const current = model.state(); return current ? JSON.stringify([current.owner, model.revision()]) : null; },
    read: option => readRecordResultPreview(option, { ...deps.readers, ...deps.shortcutReaders }, deps.href()),
    verify: reference => verifyExactRecordLink(reference, deps.readers, deps.href()),
    activate: (key, reference) => { cancelTimer(); if (model.state()?.multiple) void model.toggleSelection(key, reference); else void model.choose(key); }, blocked: () => deps.blocked() || !!model.state()?.inserting, changed: () => paint(),
  });
  const close = (restore = true) => {
    const saved = snapshot; snapshot = null; selectionsExpanded = false; cancelTimer(); model.close(); removeDialog();
    if (restore) restoreEditor(saved);
  };
  const focus = (key: string): boolean => {
    const node = [...(dialog?.querySelectorAll<HTMLElement>('[' + FOCUS + ']') ?? [])].find(node => node.getAttribute(FOCUS) === key);
    node?.focus({ preventScroll: true }); return !!node && deps.document.activeElement === node;
  };
  const searchNow = () => { cancelTimer(); void model.search(); };
  const makeDialog = (view: LinkInsertState) => {
    if (!host?.isConnected) return null;
    const node = deps.document.createElement('dialog'); node.className = 'record-link-insert'; node.setAttribute('data-record-link-insert-dialog', '');
    node.setAttribute('aria-labelledby', 'record-link-insert-title');
    node.innerHTML = '<header><h2 id="record-link-insert-title">' + (deps.picker ? 'Add records to Chat' : 'Insert record link') + '</h2><button type="button" data-link-insert-cancel ' + FOCUS + '="cancel">Cancel</button></header>'
      + '<label>Search records<input type="search" data-link-insert-query ' + FOCUS + '="query" maxlength="' + (RECORD_LINK_QUERY_LIMIT + 1) + '" autocomplete="off" value="' + e(view.query) + '"></label>'
      + '<div class="record-link-insert-tools"><label>Record type<select data-link-insert-filter ' + FOCUS + '="filter"><option value="all">All records</option>'
      + kinds.map(kind => '<option value="' + kind + '">' + linkKindLabel(kind) + '</option>').join('') + '</select></label>'
      + '<button type="button" data-link-insert-search ' + FOCUS + '="search">Search</button></div><p role="alert" data-link-insert-error hidden></p>'
      + '<button type="button" data-link-insert-multiple ' + FOCUS + '="multiple" aria-pressed="false">Select multiple</button>'
      + '<p role="status" data-link-insert-status></p><div data-link-insert-results></div>'
      + '<footer data-link-insert-batch-footer hidden><button type="button" data-link-insert-clear ' + FOCUS + '="clear-selection" disabled>Clear selection</button><button type="button" data-link-insert-batch ' + FOCUS + '="insert-selection" disabled>Insert 0 links</button></footer>';
    node.addEventListener('click', event => {
      if (dialog !== node || !node.isConnected) return;
      event.stopPropagation();
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-link-insert-cancel]')) { close(); return; }
      if (target?.closest('[data-link-insert-search]')) { searchNow(); return; }
      if (target?.closest('[data-link-insert-multiple]')) { if (deps.picker) return; preview.close(); selectionsExpanded = false; model.setMultiple(!model.state()?.multiple); return; }
      if (target?.closest('[data-link-insert-batch]')) { cancelTimer(); void model.insertSelected(); return; }
      if (target?.closest('[data-link-insert-clear]')) { preview.close(); model.clearSelection(); return; }
      const remove = target?.closest<HTMLElement>('[data-link-insert-remove]')?.getAttribute('data-link-insert-remove');
      if (remove) { model.removeSelection(remove); return; }
      const retrySelection = target?.closest<HTMLElement>('[data-link-insert-selection-retry]')?.getAttribute('data-link-insert-selection-retry');
      if (retrySelection) { void model.retrySelection(retrySelection); return; }
      const previewAction = target?.closest<HTMLElement>('[data-link-insert-preview-action]')?.getAttribute('data-link-insert-preview-action');
      if (previewAction) {
        if (previewAction === 'close') preview.close();
        if (previewAction === 'retry') { const current = preview.state(); if (current) void preview.open(current.key); }
        if (previewAction === 'activate') {
          const current = preview.state(), view = model.state();
          const selected = view?.multiple && current?.state === 'ready' ? view.selections.find(row => row.hashes.includes(current.reference.target.hash)) : undefined;
          if (selected && !view?.inserting) { preview.close(); model.removeSelection(selected.id); } else void preview.activate();
        }
        return;
      }
      const previewKey = target?.closest<HTMLElement>('[data-link-insert-preview]')?.getAttribute('data-link-insert-preview');
      if (previewKey) { previewReturnKey = previewKey; previewResultsTop = node.querySelector<HTMLElement>('[data-link-insert-results]')!.scrollTop; cancelTimer(); void preview.open(previewKey); return; }

      const selected = target?.closest<HTMLElement>('[data-link-insert-option]')?.getAttribute('data-link-insert-option');
      if (selected) { cancelTimer(); if (model.state()?.multiple) void model.toggleSelection(selected); else void model.choose(selected); return; }
      if (target?.closest('[data-link-insert-exact-retry]')) { searchNow(); return; }
      const retry = target?.closest<HTMLElement>('[data-link-insert-retry]')?.getAttribute('data-link-insert-retry');
      if (kinds.some(kind => kind === retry)) { void model.retry(retry as LinkKind); return; }
      const at = node.getBoundingClientRect();
      if (event.target === node && (event.clientX < at.left || event.clientX > at.right || event.clientY < at.top || event.clientY > at.bottom)) close();
    });
    node.addEventListener('input', event => {
      if (dialog !== node || !node.isConnected) return;
      event.stopPropagation();
      if ((event.target as HTMLElement).hasAttribute('data-link-insert-query')) {
        model.change((event.target as HTMLInputElement).value); cancelTimer();
        if (model.state()?.query.trim()) timer = setTimeout(searchNow, 200);
      }
    });
    node.addEventListener('change', event => {
      if (dialog !== node || !node.isConnected) return;
      event.stopPropagation();
      if ((event.target as HTMLElement).hasAttribute('data-link-insert-filter')) {
        const filter = (event.target as HTMLSelectElement).value;
        if (filter === 'all' || kinds.some(kind => kind === filter)) { model.change(model.state()?.query ?? '', filter as LinkInsertState['filter']); searchNow(); }
      }
    });
    node.addEventListener('keydown', event => {
      if (dialog !== node || !node.isConnected) return;
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); if (preview.state()) preview.close(); else close(); return; }
      if (event.key === 'Enter' && (event.target as HTMLElement).hasAttribute('data-link-insert-query')) { event.preventDefault(); searchNow(); return; }
      const options = [...node.querySelectorAll<HTMLButtonElement>('[data-link-insert-option]:not(:disabled)')];
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp')
        && ((event.target as HTMLElement).hasAttribute('data-link-insert-query') || options.includes(event.target as HTMLButtonElement))) {
        event.preventDefault();
        const at = options.indexOf(event.target as HTMLButtonElement), next = at < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1
          : (at + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
        options[next]?.focus(); return;
      }
      if (event.key === 'Tab') {
        const controls = [...node.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(control => !control.closest('[hidden]') && (!control.closest('details:not([open])') || control.tagName === 'SUMMARY'));
        const at = controls.indexOf(deps.document.activeElement as HTMLElement);
        if (at < 0 || event.shiftKey && at === 0 || !event.shiftKey && at === controls.length - 1) {
          event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus({ preventScroll: true });
        }
      }
    });
    node.addEventListener('cancel', event => { event.preventDefault(); if (dialog === node) { if (preview.state()) preview.close(); else close(); } });
    node.addEventListener('close', () => { if (dialog === node && model.state()) close(); });
    host.appendChild(node); return node;
  };
  const paint = () => {
    const view = model.state();
    preview.bind(view ? linkInsertPreviewOptions(view) : []);
    const previewView = preview.state(), wasPreview = showingPreview; showingPreview = !!previewView;
    if (trigger) { trigger.setAttribute('aria-expanded', String(!!view)); trigger.setAttribute('aria-disabled', String(deps.blocked())); }
    if (!view || !snapshot) { focusedSelection = undefined; removeDialog(); return; }
    const checking = view.inserting ? 'batch' : view.selecting;
    const newlyChecking = !!checking && checking !== focusedSelection; focusedSelection = checking;
    if (!dialog?.isConnected) { removeDialog(); dialog = makeDialog(view); }
    if (!dialog) return;
    const wasOpen = dialog.open, focused = dialog.contains(deps.document.activeElement)
      ? (deps.document.activeElement as HTMLElement)?.getAttribute(FOCUS) : null;
    const results = dialog.querySelector<HTMLElement>('[data-link-insert-results]')!;
    const details = results.querySelector<HTMLDetailsElement>('[data-link-insert-selections]'); if (details) selectionsExpanded = details.open;
    const top = results.scrollTop, query = dialog.querySelector<HTMLInputElement>('[data-link-insert-query]')!;
    if (query.value !== view.query) query.value = view.query;
    const filter = dialog.querySelector<HTMLSelectElement>('[data-link-insert-filter]')!; filter.value = view.filter; filter.disabled = !!view.exact || !!view.inserting; query.disabled = !!view.inserting;
    const error = dialog.querySelector<HTMLElement>('[data-link-insert-error]')!; error.hidden = !view.error; error.textContent = (deps.picker ? view.error?.replace(' No links were inserted.', ' Your selection has not changed.') : view.error) ?? '';
    dialog.querySelector<HTMLElement>('[data-link-insert-status]')!.textContent = view.inserting ? 'Checking all selected records…' : view.multiple ? view.selections.some(entry => entry.state === 'loading') ? 'Checking selections…' : 'Select up to ' + RECORD_LINK_SELECTION_LIMIT + ' records.' : view.selecting ? 'Checking selected record…' : !view.query.trim() ? view.shortcuts?.length ? 'Choose a pinned or recently opened record, or search.' : 'Search by name or title.' : '';
    const groups = LINK_KINDS.flatMap(kind => view.groups.filter(group => group.kind === kind));
    const busy = !!view.selecting || !!view.inserting || deps.blocked();
    const optionHtml = (row: LinkOption) => '<div class="record-result-preview-row"><button type="button" class="record-link-insert-option" data-link-insert-option="' + e(row.key) + '" ' + FOCUS + '="record:' + e(row.key) + '"' + (view.multiple ? ' aria-pressed="' + view.selections.some(entry => entry.hashes.includes(row.target.hash)) + '"' : '') + ' aria-label="' + (view.multiple ? 'Select link to ' : 'Insert link to ') + e(row.title) + '"' + (busy ? ' disabled' : '') + '><strong>' + e(row.title) + '</strong>' + (row.detail ? '<span>' + e(row.detail) + '</span>' : '') + '</button><button type="button" class="record-result-preview-trigger" data-link-insert-preview="' + e(row.key) + '" ' + FOCUS + '="preview:' + e(row.key) + '" aria-label="Preview ' + e(row.title) + '" ' + (busy ? ' disabled' : '') + '>Preview</button></div>';
    const shortcuts = !view.query.trim() ? (view.shortcuts ?? []).map(group => '<section aria-label="' + group.label + '"><h3>' + group.label + '</h3>' + group.options.map(optionHtml).join('') + '</section>').join('') : '';
    const exact = view.exact;
    const exactHtml = !exact ? '' : '<section aria-label="Record link"><h3>Record link</h3>' + (exact.state === 'ready'
      ? optionHtml({ ...exact.match, detail: exact.match.details.join(' · '), exact: exact.match }) + (exact.match.warning ? '<p role="status">' + e(exact.match.warning) + '</p>' : '')
      : '<p role="status">' + e(exact.state === 'loading' ? 'Checking record link…' : exact.message) + '</p>' + (exact.state === 'error' ? '<button type="button" data-link-insert-exact-retry ' + FOCUS + '="exact-retry">Try again</button>' : '')) + '</section>';
    const listHtml = exactHtml + shortcuts + groups.map(group => { let account: string | undefined; return '<section aria-label="' + linkKindLabel(group.kind) + '"><h3>' + linkKindLabel(group.kind) + '</h3>'
      + (group.state === 'loading' ? '<p role="status">Searching…</p>' : group.state === 'error' ? '<p role="status">' + e(group.message) + '</p><button type="button" data-link-insert-retry="' + group.kind + '" ' + FOCUS + '="retry:' + group.kind + '">Try again</button>'
        : group.page.options.map(row => { const heading = row.account !== undefined && row.account !== account ? '<h4>' + e(row.account) + '</h4>' : ''; account = row.account; return heading + optionHtml(row); }).join('')
          + (!group.page.options.length && !group.page.warnings?.length ? '<p>No matching ' + linkKindLabel(group.kind).toLowerCase() + '.</p>' : '')
          + (group.page.warnings ?? []).map(warning => '<p role="status">' + e(warning) + '</p>').join('')
          + (group.page.warnings?.length ? '<button type="button" data-link-insert-retry="' + group.kind + '" ' + FOCUS + '="retry:' + group.kind + '">Try again</button>' : '')
          + (group.page.more ? '<p role="status">More matches. Refine your search.</p>' : '')) + '</section>'; }).join('');
    if (view.selections.some(entry => entry.error)) selectionsExpanded = true;
    const selectedHtml = !view.multiple || !view.selections.length ? '' : '<section aria-label="Selected records" class="record-link-insert-selected"><details data-link-insert-selections' + (selectionsExpanded ? ' open' : '') + '><summary ' + FOCUS + '="selection-summary">Selected records (' + view.selections.length + ')</summary><ul>'
      + view.selections.map(entry => '<li><strong>' + e(entry.option.title) + '</strong><p>' + e(entry.option.detail) + '</p>'
        + (entry.state === 'loading' ? '<p role="status">Checking selection…</p>' : '')
        + (entry.error ? '<p role="alert">' + e(entry.error) + '</p>' : '')
        + (entry.state === 'ready' ? '<button type="button" data-link-insert-preview="' + e(entry.option.key) + '" ' + FOCUS + '="preview:' + e(entry.option.key) + '" aria-label="Preview ' + e(entry.option.title) + '"' + (busy ? ' disabled' : '') + '>Preview</button>' : '')
        + (entry.state === 'error' ? '<button type="button" data-link-insert-selection-retry="' + e(entry.id) + '" ' + FOCUS + '="selection-retry:' + e(entry.id) + '"' + (busy ? ' disabled' : '') + '>Try again</button>' : '')
        + '<button type="button" data-link-insert-remove="' + e(entry.id) + '" ' + FOCUS + '="remove:' + e(entry.id) + '" aria-label="Remove ' + e(entry.option.title) + ' from selection"' + (busy ? ' disabled' : '') + '>Remove</button></li>').join('') + '</ul></details></section>';
    const isSelectedPreview = previewView?.state === 'ready' && view.selections.some(entry => entry.hashes.includes(previewView.reference.target.hash));
    results.innerHTML = previewView ? previewResultHtml(previewView, 'Insert', FOCUS, 'data-link-insert-preview-action', busy, view.multiple ? isSelectedPreview ? 'Remove from selection' : 'Add to selection' : undefined) : selectedHtml + listHtml;
    const multiple = dialog.querySelector<HTMLButtonElement>('[data-link-insert-multiple]')!; multiple.setAttribute('aria-pressed', String(view.multiple)); multiple.disabled = busy || !!deps.picker; multiple.hidden = !!deps.picker;
    dialog.querySelector<HTMLButtonElement>('[data-link-insert-search]')!.disabled = !!view.inserting;
    dialog.querySelector<HTMLElement>('[data-link-insert-batch-footer]')!.hidden = !view.multiple || !!previewView;
    const insert = dialog.querySelector<HTMLButtonElement>('[data-link-insert-batch]')!; insert.textContent = (deps.picker ? 'Use ' : 'Insert ') + view.selections.length + (deps.picker ? view.selections.length === 1 ? ' record' : ' records' : view.selections.length === 1 ? ' link' : ' links'); insert.disabled = busy || !view.selections.length && !deps.picker || view.selections.some(entry => entry.state !== 'ready');
    dialog.querySelector<HTMLButtonElement>('[data-link-insert-clear]')!.disabled = busy || !view.selections.length;
    try { if (!dialog.open) dialog.showModal(); } catch { close(false); return; }
    if (previewView) {
      if (!wasPreview) focus('preview-title'); else if (previewView.checking) focus('preview-close'); else if (focused && !focus(focused)) focus('preview-title');
      results.scrollTop = wasPreview ? top : 0;
    } else if (wasPreview) {
      if (focused === 'query' || focused === 'filter') focus(focused); else if (!previewReturnKey || !focus('preview:' + previewReturnKey)) focus('query');
      results.scrollTop = previewResultsTop;
    } else {
      if (newlyChecking) focus('cancel'); else if (!wasOpen) focus('query'); else if (focused && !focus(focused)) focus(view.selecting ? 'cancel' : view.multiple && view.selections.length ? 'selection-summary' : 'query');
      results.scrollTop = top;
    }
  };
  return {
    cancel() { close(false); },
    captureFocus(): Focus | null {
      const view = model.state(), active = deps.document.activeElement as HTMLInputElement | null;
      return view && dialog?.contains(active) ? { owner: view.owner, control: active?.getAttribute(FOCUS) ?? 'query',
        ...(active?.hasAttribute('data-link-insert-query') ? { start: active.selectionStart, end: active.selectionEnd } : {}), top: dialog.querySelector<HTMLElement>('[data-link-insert-results]')?.scrollTop ?? 0 } : null;
    },
    restoreFocus(saved: Focus | null) {
      if (!saved || model.state()?.owner !== saved.owner || !dialog) return;
      focus(saved.control);
      const query = dialog.querySelector<HTMLInputElement>('[data-link-insert-query]');
      if (saved.control === 'query' && saved.start != null && saved.end != null) query?.setSelectionRange(saved.start, saved.end);
      const results = dialog.querySelector<HTMLElement>('[data-link-insert-results]'); if (results) results.scrollTop = saved.top;
    },
    mount() {
      if (supported === undefined) supported = typeof deps.document.createElement?.('dialog')?.showModal === 'function';
      const owner = supported ? deps.owner() : null;
      host = owner ? deps.picker ? deps.picker.host() : deps.root.querySelector<HTMLElement>('.work-entity-dialog[data-kind="' + owner.kind + '"]') : null;
      field = owner ? deps.picker ? deps.picker.field() : host?.querySelector<HTMLTextAreaElement>('textarea[data-form-field="body"]') ?? null : null;
      if (snapshot && (snapshot.owner !== owner?.key || !field || field.value !== snapshot.value)) { snapshot = null; cancelTimer(); model.close(); }
      trigger = host?.querySelector<HTMLButtonElement>('[' + TRIGGER + ']') ?? null;
      if (!trigger && field && !field.readOnly && supported && kinds.length && recordLink(deps.href(), '#data/note/test')) {
        trigger = deps.document.createElement('button'); trigger.type = 'button'; trigger.textContent = deps.picker ? 'Add records' : 'Insert record link';
        trigger.className = 'record-link-insert-trigger'; trigger.setAttribute(TRIGGER, ''); trigger.setAttribute('aria-haspopup', 'dialog');
        if (deps.picker) deps.picker.triggerHost()?.appendChild(trigger); else field.insertAdjacentElement('beforebegin', trigger);
      }
      model.refreshShortcuts(); paint(); if (snapshot) restoreScroll(snapshot);
    },
    handleClick(event: Event): boolean {
      if (!(event.target as HTMLElement | null)?.closest?.('[' + TRIGGER + ']') || !host?.contains(event.target as Node)) return false;
      event.preventDefault();
      const owner = deps.owner();
      if (owner && field && !field.disabled && !field.readOnly && !deps.blocked()) {
        snapshot = { owner: owner.key, value: field.value, start: field.selectionStart, end: field.selectionEnd,
          direction: field.selectionDirection, scrolls: scrolls() }; selectionsExpanded = false; model.open();
      }
      return true;
    },
    dispose() { cancelTimer(); preview.dispose(); model.dispose(); snapshot = null; removeDialog(); host = field = trigger = null; },
  };
};

export const RECORD_LINK_INSERT_STYLES = [
  RECORD_RESULT_PREVIEW_STYLES,
  '.record-link-insert-trigger { display:block; margin:0 0 .5rem; padding:.4rem .65rem; border:1px solid var(--border,#d1d5db); border-radius:6px; background:var(--rx-input-bg,var(--surface,#fff)); color:var(--fg,#111); font:inherit; cursor:pointer; }',
  'dialog.record-link-insert { box-sizing:border-box; position:fixed; inset:0; margin:auto; width:min(32rem,calc(100vw - 2rem)); max-height:80dvh; overflow:hidden; padding:1rem; background:var(--rx-input-bg,var(--surface,#fff)); color:var(--fg,#111); border:1px solid var(--border,#d1d5db); border-radius:12px; box-shadow:0 12px 40px #0004; overflow-wrap:anywhere; }',
  '.record-link-insert[open] { display:flex; flex-direction:column; }',
  '.record-link-insert [data-link-insert-results] { min-height:0; overflow:auto; }',
  '.record-link-insert > :not([data-link-insert-results]) { flex-shrink:0; }',
  '.record-link-insert [data-link-insert-status]:empty { display:none; }',
  '.record-link-insert::backdrop { background:#0003; }',
  '.record-link-insert header,.record-link-insert-tools { display:flex; align-items:center; justify-content:space-between; gap:.75rem; margin-bottom:.75rem; }',
  '.record-link-insert h4 { margin:.75rem 0 .35rem; overflow-wrap:anywhere; }',
  '.record-link-insert h2 { margin:0; font-size:1.2rem; }',
  '.record-link-insert label { display:flex; flex-direction:column; gap:.3rem; min-width:0; margin-bottom:.75rem; }',
  '.record-link-insert-tools label { flex:1; margin:0; }',
  '.record-link-insert input,.record-link-insert select { box-sizing:border-box; width:100%; padding:.55rem; min-width:0; background:var(--rx-input-bg,var(--surface,#fff)); color:var(--fg,#111); border:1px solid var(--border,#d1d5db); border-radius:6px; font:inherit; }',
  '.record-link-insert button { padding:.5rem .65rem; border:1px solid var(--border,#d1d5db); border-radius:6px; background:var(--rx-input-bg,var(--surface,#fff)); color:var(--fg,#111); font:inherit; cursor:pointer; }',
  '.record-link-insert h3 { margin:.75rem 0 .4rem; font-size:1rem; }',
  '.record-link-insert-option { display:flex; flex-direction:column; align-items:start; gap:.3rem; text-align:left; width:100%; margin:.3rem 0; overflow-wrap:anywhere; }',
  '.record-link-insert-selected { margin:.5rem 0; padding:.5rem; border:1px solid var(--border); border-radius:6px; }',
  '.record-link-insert-selected summary { cursor:pointer; min-height:32px; }',
  '.record-link-insert-selected ul { padding-left:1.25rem; }',
  '.record-link-insert-selected li { margin:.5rem 0; overflow-wrap:anywhere; }',
  '.record-link-insert-selected p { margin:.25rem 0; }',
  '.record-link-insert [data-link-insert-batch-footer] { display:flex; flex-wrap:wrap; justify-content:space-between; gap:.5rem; padding-top:.75rem; }',
  '.record-link-insert [data-link-insert-batch-footer][hidden] { display:none; }',
  '.record-link-insert-option[aria-pressed=true] { outline:2px solid var(--accent,#2563eb); outline-offset:-2px; }',
  '.record-link-insert [data-link-insert-multiple][aria-pressed=true] { border-color:var(--accent,#2563eb); font-weight:600; }',
  '.record-link-insert-option span { font-size:.85em; opacity:.8; }',
].join('\n');
