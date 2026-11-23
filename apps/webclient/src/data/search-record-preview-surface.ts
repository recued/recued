import type { CollectionSearchGroup, ContactRecord, WorkEntitySearchGroup } from '@recued/contracts';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';
import { EXACT_LINK_OPEN_ACTION, EXACT_LINK_KEY_ATTR, verifyExactRecordLink, type ExactRecordLinkState } from './exact-record-link.js';
import { createRecordResultPreview, previewResultHtml, readRecordResultPreview } from './record-result-preview.js';
import { recordLinkShortcuts, type RecordLinkShortcutReaders } from './record-link-shortcuts.js';
import type { RecentWorkRecords } from './recent-work-records.js';
import { LINK_KINDS, type LinkOption } from './record-link-insert.js';
import { SEARCH_OPEN_CONTACT_ACTION, SEARCH_CONTACT_EMAIL_ATTR, SEARCH_OPEN_WORK_ACTION, SEARCH_WORK_KIND_ATTR, SEARCH_WORK_ID_ATTR,
  SEARCH_OPEN_RECORD_ACTION, SEARCH_GROUP_PLATFORM_ATTR, SEARCH_GROUP_SLUG_ATTR, SEARCH_RECORD_ID_ATTR } from './universal-search.js';
import { RECENT_WORK_KIND, RECENT_WORK_ID, PINNED_WORK_KIND, PINNED_WORK_ID } from './recent-work-panel.js';
import { sourceRecordLinkDetails } from './source-record-link.js';

export interface SearchRecordPreviewState {
  contacts: readonly ContactRecord[]; work?: readonly WorkEntitySearchGroup[]; sources?: readonly CollectionSearchGroup[];
  exact?: ExactRecordLinkState; empty: boolean; recent?: RecentWorkRecords; pinned?: RecentWorkRecords;
}
interface Entry { option: LinkOption; primary: HTMLElement; button?: HTMLButtonElement }
/** The visible Open control must also belong to the current registered result.
 * DOM attributes alone never grant a record read. */
export const searchRecordPreviewEntries = (root: HTMLElement, actionAttr: string, state: SearchRecordPreviewState): Entry[] => {
  const controls = [...root.querySelectorAll<HTMLElement>('[' + actionAttr + ']')];
  const entries: Entry[] = [];
  const add = (option: LinkOption, action: string, attrs: Record<string, string>) => {
    const primary = controls.find(node => node.getAttribute(actionAttr) === action && Object.entries(attrs).every(([name, value]) => node.getAttribute(name) === value));
    if (primary) entries.push({ option, primary });
  };
  if (state.exact) {
    if (state.exact.state === 'ready') {
      const match = state.exact.match;
      add({ ...match, detail: match.details.join(' · '), exact: match }, EXACT_LINK_OPEN_ACTION, { [EXACT_LINK_KEY_ATTR]: match.key });
    }
    return entries;
  }
  if (state.empty) {
    for (const [pinned, store] of [[true, state.pinned], [false, state.recent]] as const) {
      const groups = recordLinkShortcuts({ ...(pinned ? { pinned: store } : { recent: store }), kinds: LINK_KINDS, filter: 'all' });
      for (const option of groups.flatMap(group => group.options)) {
        const record = option.shortcut!;
        add(option, pinned ? 'pinned-work-open' : 'recent-work-open', { [pinned ? PINNED_WORK_KIND : RECENT_WORK_KIND]: record.kind, [pinned ? PINNED_WORK_ID : RECENT_WORK_ID]: record.id });
      }
    }
    return entries;
  }
  for (const contact of state.contacts) {
    const id = contact.contact_id || contact.email, target = { tab: 'contact' as const, id, hash: serializeShellRoute('data', 'contact', id) };
    add({ key: JSON.stringify(['preview', target.hash]), target, title: contact.name || contact.email, detail: contact.email }, SEARCH_OPEN_CONTACT_ACTION, { [SEARCH_CONTACT_EMAIL_ATTR]: contact.email });
  }
  for (const group of state.work ?? []) {
    if (group.kind !== 'task' && group.kind !== 'note' && group.kind !== 'commitment' && group.kind !== 'booking') continue;
    for (const match of group.matches) {
      const target = { tab: group.kind, id: match.id, hash: serializeShellRoute('data', group.kind, match.id) };
      add({ key: JSON.stringify(['preview', target.hash]), target, title: match.title, detail: match.source_label }, SEARCH_OPEN_WORK_ACTION, { [SEARCH_WORK_KIND_ATTR]: group.kind, [SEARCH_WORK_ID_ATTR]: match.id });
    }
  }
  for (const group of state.sources ?? []) {
    if (group.platform !== 'mail' && group.platform !== 'calendar') continue;
    for (const match of group.matches) {
      const target = { tab: group.platform, collectionSlug: group.slug, recordId: match.record_id, hash: serializeSourceRecordAddress({ tab: group.platform, collectionSlug: group.slug, recordId: match.record_id }) };
      const display = sourceRecordLinkDetails(group.platform, group.slug, match.hot_fields, match.received_at ?? 0);
      add({ key: JSON.stringify(['preview', target.hash]), target, title: display.title, detail: display.details.join(' · '), received_at: match.received_at }, SEARCH_OPEN_RECORD_ACTION,
        { [SEARCH_GROUP_PLATFORM_ATTR]: group.platform, [SEARCH_GROUP_SLUG_ATTR]: group.slug, [SEARCH_RECORD_ID_ATTR]: match.record_id });
    }
  }
  return entries;
};

const FOCUS = 'data-record-result-preview-focus', ACTION = 'data-record-result-preview-action';
export const createSearchRecordPreviewSurface = (deps: {
  root: HTMLElement; document: Document; actionAttr: string; owner: () => string | null; href: () => string;
  openContact: (email: string, canonicalId: string) => void;
  readers: RecordLinkShortcutReaders; state: () => SearchRecordPreviewState; blocked: () => boolean; scrollHost: () => Element | null;
}) => {
  let container: HTMLElement | null = null, dialog: HTMLDialogElement | null = null, supported: boolean | undefined;
  let entries = new Map<string, Entry>(), returnTop = 0, returnLeft = 0, lastFocus = 'preview-title', dialogTop = 0;
  const listening = new WeakSet<HTMLElement>();
  const model = createRecordResultPreview({ owner: deps.owner, blocked: deps.blocked,
    read: option => readRecordResultPreview(option, deps.readers, deps.href()),
    verify: reference => verifyExactRecordLink(reference, deps.readers, deps.href()),
    activate: (key, reference) => {
      const entry = entries.get(key); if (!entry?.primary.isConnected) return;
      if (entry.option.target.tab === 'contact' && reference.target.tab === 'contact' && !entry.option.exact && !entry.option.shortcut)
        deps.openContact(entry.primary.getAttribute(SEARCH_CONTACT_EMAIL_ATTR) ?? entry.option.target.id, reference.target.id);
      else entry.primary.click();
    }, changed: () => paint(),
  });
  const removeDialog = () => { const old = dialog; dialog = null; if (old) { try { if (old.open) old.close(); } catch {} old.remove(); } };
  const focus = (control: string) => { const node = [...(dialog?.querySelectorAll<HTMLElement>('[' + FOCUS + ']') ?? [])].find(node => node.getAttribute(FOCUS) === control); node?.focus({ preventScroll: true }); };
  const close = (restore = true) => {
    const view = model.state(), owner = deps.owner(); model.close(); removeDialog();
    if (restore && view && owner === view.owner) {
      (entries.get(view.key)?.button ?? container?.querySelector<HTMLElement>('input[type="search"]'))?.focus({ preventScroll: true });
      const host = deps.scrollHost(); if (host) { host.scrollTop = returnTop; host.scrollLeft = returnLeft; }
    }
  };
  const makeDialog = () => {
    const node = deps.document.createElement('dialog'); node.className = 'work-link-preview'; node.setAttribute('aria-label', 'Record preview'); node.setAttribute('data-record-result-preview-dialog', '');
    node.addEventListener('cancel', event => { event.preventDefault(); if (dialog === node) close(); });
    node.addEventListener('close', () => { if (dialog === node && !node.open) close(); });
    node.addEventListener('focusin', event => { const key = (event.target as HTMLElement)?.getAttribute(FOCUS); if (key) lastFocus = key; });
    node.addEventListener('scroll', () => { dialogTop = node.scrollTop; });
    node.addEventListener('click', event => {
      event.stopPropagation(); const action = (event.target as HTMLElement)?.closest<HTMLElement>('[' + ACTION + ']')?.getAttribute(ACTION);
      if (action === 'close') close();
      if (action === 'activate') void model.activate();
      if (action === 'retry') { const current = model.state(); if (current) void model.open(current.key); }
    });
    node.addEventListener('keydown', event => {
      event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = [...node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], at = controls.indexOf(deps.document.activeElement as HTMLButtonElement);
        event.preventDefault(); controls[at < 0 ? event.shiftKey ? controls.length - 1 : 0 : (at + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
      }
    });
    deps.root.appendChild(node); return node;
  };
  const paint = () => {
    const view = model.state(); for (const [key, entry] of entries) entry.button?.setAttribute('aria-expanded', String(view?.key === key));
    if (!view) { removeDialog(); return; }
    if (!dialog?.isConnected) { removeDialog(); dialog = makeDialog(); }
    const oldFocus = dialog.contains(deps.document.activeElement) ? (deps.document.activeElement as HTMLElement)?.getAttribute(FOCUS) : null, top = dialog.open ? dialog.scrollTop : dialogTop;
    dialog.innerHTML = previewResultHtml(view, 'Open', FOCUS, ACTION, deps.blocked()); dialog.setAttribute('aria-busy', String(view.state === 'loading' || !!view.checking));
    try { if (!dialog.open) dialog.showModal(); } catch { close(false); return; }
    focus(view.checking ? 'preview-close' : oldFocus ?? lastFocus); dialog.scrollTop = top;
  };
  return {
    mount() {
      container = deps.owner() ? deps.root.querySelector<HTMLElement>('.rq-search') : null;
      if (supported === undefined) supported = typeof deps.document.createElement?.('dialog')?.showModal === 'function';
      entries = new Map((supported && container ? searchRecordPreviewEntries(container, deps.actionAttr, deps.state()) : [])
        .filter(entry => entry.option.target.tab === 'contact' ? !!deps.readers.contact : 'id' in entry.option.target ? !!deps.readers.work : !!deps.readers.source)
        .map(entry => [entry.option.key, entry]));
      for (const [key, entry] of entries) {
        let wrapper = entry.primary.parentElement;
        if (!wrapper?.classList.contains('record-result-preview-row')) {
          wrapper = deps.document.createElement('div'); wrapper.className = 'record-result-preview-row'; entry.primary.replaceWith(wrapper); wrapper.appendChild(entry.primary);
        }
        let button = wrapper.querySelector<HTMLButtonElement>('[data-record-result-preview]');
        if (!button) { button = deps.document.createElement('button'); button.type = 'button'; button.className = 'record-result-preview-trigger'; wrapper.appendChild(button); }
        button.setAttribute('data-record-result-preview', key); button.setAttribute('aria-label', 'Preview ' + entry.option.title); button.setAttribute('aria-haspopup', 'dialog'); button.textContent = 'Preview'; button.setAttribute('aria-disabled', String(deps.blocked())); entry.button = button;
        if (!listening.has(button)) { listening.add(button); button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation(); const selected = button!.getAttribute('data-record-result-preview'); if (!selected || !entries.has(selected)) return;
          const host = deps.scrollHost(); returnTop = host?.scrollTop ?? 0; returnLeft = host?.scrollLeft ?? 0; lastFocus = 'preview-title'; dialogTop = 0; void model.open(selected);
        }); }
      }
      const old = model.state(); model.bind([...entries.values()].map(entry => entry.option));
      if (old && !model.state()) { removeDialog(); if (old.owner === deps.owner()) container?.querySelector<HTMLElement>('input[type="search"]')?.focus({ preventScroll: true }); }
      paint();
    },
    reset: (restore = false) => close(restore),
    dispose() { model.dispose(); removeDialog(); entries.clear(); container = null; },
  };
};
