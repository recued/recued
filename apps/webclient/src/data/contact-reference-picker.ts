import { canonicalizeEmail, isMentionOnlyEmail, type ContactRecord } from '@recued/contracts';
import { RefPicker } from '@recued/ui-shared';
import type { DataContactGetCaller, DataContactListCaller } from './bootstrap-data-route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { contactReferenceChoice, sameReferenceChoice, type RecentReferenceChoices } from './recent-reference-choices.js';
import { mountRecentReferenceControl, recentReferencePage } from './recent-reference-picker.js';

export const contactRefOption = (contact: Pick<ContactRecord, 'email' | 'name'>): RefPicker.RefPickerOption => ({
  id: contact.email,
  label: contact.name?.trim() || (isMentionOnlyEmail(contact.email) ? 'Unnamed contact' : contact.email),
  ...(isMentionOnlyEmail(contact.email) ? {} : { sublabel: contact.email }),
});

type Lookup = { state: 'loading' | 'ready' | 'missing' | 'error'; label: string; message: string; searchQuery?: string };
const validContact = (value: ContactRecord): boolean => typeof value.email === 'string' && !!value.email.trim()
  && (value.name === undefined || typeof value.name === 'string');
const missing: Lookup = { state: 'missing', label: 'Unavailable contact',
  message: 'This contact is no longer available. Its saved reference is kept until you clear or change it.' };

/** Follow the owner's canonical contact read, including legacy merged emails.
 * This resolves display text only: the saved reference is never rewritten. */
export const readContactReference = async (get: DataContactGetCaller | undefined, reference: string, current: () => boolean = () => true): Promise<{ contact: ContactRecord | null; merged: boolean }> => {
  if (!get) throw new Error('Contact lookup is unavailable on this server.');
  let id = reference, merged = false;
  const visited = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (!current()) throw new Error('Contact lookup was retired.');
    if (visited.has(id)) throw new Error('This contact redirect could not be confirmed.');
    visited.add(id);
    const { contact } = await get({ email: id });
    if (!current()) throw new Error('Contact lookup was retired.');
    if (contact === null) return { contact: null, merged };
    if (!contact || !validContact(contact) || (id.includes('@') && canonicalizeEmail(contact.email) !== canonicalizeEmail(id) && !isMentionOnlyEmail(id))) {
      throw new Error('The saved contact could not be confirmed.');
    }
    if (contact.merged_into !== undefined) {
      if (typeof contact.merged_into !== 'string' || !contact.merged_into.trim()) throw new Error('This contact redirect could not be confirmed.');
      id = contact.merged_into; merged = true; continue;
    }
    return { contact, merged };
  }
  throw new Error('This contact redirect could not be confirmed.');
};

export const loadContactReference = async (get: DataContactGetCaller | undefined, reference: string, current: () => boolean = () => true,
  resolved?: (contact: ContactRecord) => void): Promise<Lookup> => {
  const { contact, merged } = await readContactReference(get, reference, current);
  if (!contact) return missing;
  resolved?.(contact);
  const option = contactRefOption(contact);
  return { state: 'ready', label: option.label,
    message: [option.sublabel ?? 'No email address', merged ? 'Merged contact.' : ''].filter(Boolean).join(' · '),
    searchQuery: contact.name?.trim() || (isMentionOnlyEmail(contact.email) ? undefined : contact.email) };
};

export const searchContactReferences = async (search: DataContactListCaller | undefined, query: string): Promise<RefPicker.RefPickerSearchPage> => {
  if (!search) return { options: [], retryableError: 'Contact search is unavailable on this server.' };
  if (!query.trim()) return { options: [] };
  try {
    const page = await search({ query: query.trim(), limit: 20, offset: 0 });
    if (!Array.isArray(page.contacts) || page.contacts.length > 20 || !Number.isSafeInteger(page.total) || page.total < page.contacts.length
      || page.contacts.some(contact => !validContact(contact) || contact.merged_into !== undefined)
      || new Set(page.contacts.map(contact => contact.email)).size !== page.contacts.length) throw new Error('The contact search could not be confirmed. Try again.');
    return { options: page.contacts.map(contactRefOption), truncated: page.total > page.contacts.length };
  } catch (error) { return { options: [], retryableError: `Contacts could not be searched. ${humanizeRpcError(error)}` }; }
};

/** Handles belong to a dialog, rather than a render. Label reads may change
 * display text, but cannot replace typed queries, selections or stored ids. */
export const createWorkContactPickers = (deps: {
  search?: DataContactListCaller; get?: DataContactGetCaller; known: (id: string) => ContactRecord | undefined;
  recent?: RecentReferenceChoices;
  changed: () => void; clearArrayItem: (field: string, index: number) => void;
}) => {
  type Entry = { shell: HTMLElement; handle: RefPicker.RefPickerHandle; field?: string; index?: number };
  type Snapshot = { selection: RefPicker.RefPickerSelection | null; query: string };
  const entries = new Map<string, Entry>(), names = new Map<string, Lookup>(), shifted = new Map<string, Snapshot>();
  let binding = '', generation = 0;
  let focused: { generation: number; key: string; id: string | null; query: string; start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } | undefined;
  const reset = () => { generation++; for (const entry of entries.values()) entry.handle.destroy(); entries.clear(); names.clear(); shifted.clear(); binding = ''; focused = undefined; };
  const paint = (entry: Entry) => {
    const selected = entry.handle.getValue(), value = selected ? names.get(selected.id) : undefined;
    if (selected && value) entry.handle.setValue({ id: selected.id, label: value.label });
    let notice = entry.shell.querySelector<HTMLElement>('[data-contact-picker-status]');
    if (!notice) {
      notice = entry.shell.ownerDocument.createElement('div'); notice.setAttribute('data-contact-picker-status', ''); notice.className = 'data-row-subtle work-reference-picker-status';
      const message = notice.ownerDocument.createElement('span'); message.setAttribute('role', 'status'); message.setAttribute('data-contact-picker-message', ''); notice.append(message);
      const retry = notice.ownerDocument.createElement('button'); retry.type = 'button'; retry.className = 'data-button'; retry.textContent = 'Retry contact details'; retry.setAttribute('data-contact-picker-retry', '');
      retry.addEventListener('click', () => { const id = entry.handle.getValue()?.id; if (id) loadName(id, true); }); notice.append(retry); entry.shell.append(notice);
    }
    notice.hidden = !value?.message;
    notice.querySelector<HTMLElement>('[data-contact-picker-message]')!.textContent = value?.message ?? '';
    notice.querySelector<HTMLButtonElement>('[data-contact-picker-retry]')!.hidden = value?.state !== 'error' || !deps.get;
    mountRecentReferenceControl(entry.shell, 'contact', deps.recent, entry.handle, clearRecents);
  };
  const paintAll = () => { for (const entry of entries.values()) paint(entry); };
  const clearRecents = () => {
    for (const entry of entries.values()) if (!entry.handle.getQuery().trim() || entry.handle.getQuery() === entry.handle.getValue()?.label) entry.handle.refresh();
    paintAll();
  };
  const loadName = (id: string, force = false, rememberKey?: string) => {
    if (!force && names.has(id)) return;
    const current = generation, known = deps.known(id);
    const owner = rememberKey ? entries.get(rememberKey) : undefined, epoch = deps.recent?.clearEpoch('contact');
    const prior = [...entries.values()].find(entry => entry.handle.getValue()?.id === id)?.handle.getValue()?.label ?? names.get(id)?.label
      ?? (known ? contactRefOption(known).label : undefined);
    const pending: Lookup = { state: 'loading', label: prior ?? 'Loading contact…', message: 'Loading contact details…' };
    names.set(id, pending); paintAll();
    void (async () => {
      try {
        const value = await loadContactReference(deps.get, id, () => current === generation && names.get(id) === pending, contact => {
          if (owner && entries.get(rememberKey!) === owner && owner.handle.getValue()?.id === id && epoch === deps.recent?.clearEpoch('contact'))
            deps.recent?.remember(contactReferenceChoice(contact));
        });
        if (current !== generation || names.get(id) !== pending) return;
        names.set(id, value);
      } catch (error) {
        if (current !== generation || names.get(id) !== pending) return;
        names.set(id, { state: 'error', label: prior && prior !== 'Loading contact…' ? prior : 'Contact details unavailable',
          message: `${humanizeRpcError(error)} Its saved reference is kept. Retry, or choose another contact.` });
      }
      paintAll();
    })();
  };
  return { reset, getHandle: (key: string) => entries.get(key)?.handle,
    captureBeforeRender() {
      focused = undefined;
      for (const [key, entry] of entries) {
        const active = entry.shell.ownerDocument.activeElement as HTMLInputElement | null;
        if (active?.hasAttribute('data-ref-picker-input') && entry.shell.contains(active)) {
          focused = { generation, key, id: entry.handle.getValue()?.id ?? null, query: entry.handle.getQuery(),
            start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
        }
        entry.handle.beforeRender();
      }
    },
    removeArrayItem(field: string, index: number) {
      for (const [key, entry] of entries) if (entry.field === field && entry.index !== undefined && entry.index >= index) {
        if (entry.index > index) shifted.set(`${field}\0${entry.index - 1}`, { selection: entry.handle.getValue(), query: entry.handle.getQuery() });
        entry.handle.destroy(); entries.delete(key);
      }
    },
    mount(form: HTMLElement | null, nextBinding: string) {
      if (binding !== nextBinding || !form) { reset(); binding = nextBinding; }
      if (!form) return;
      const restore = focused; focused = undefined;
      form.querySelectorAll<HTMLElement>('[data-ref-picker]').forEach(shell => {
        const mirror = shell.querySelector<HTMLInputElement>('[data-ref-picker-value][data-form-ref-target="data.contact"]');
        const key = shell.getAttribute('data-ref-picker'); if (!mirror || !key) return;
        const id = mirror.value.trim(), field = mirror.getAttribute('data-form-array-item') ?? undefined;
        const index = field ? Number(mirror.getAttribute('data-form-array-index')) : undefined;
        let entry = entries.get(key);
        if (entry && (entry.handle.getValue()?.id ?? '') !== id) { entry.handle.destroy(); entries.delete(key); entry = undefined; }
        if (entry) { entry.shell = shell; entry.handle.rewire(form); paint(entry); return; }
        const snapshotKey = `${field}\0${index}`, snapshot = shifted.get(snapshotKey); shifted.delete(snapshotKey);
        const known = deps.known(id);
        const initialValue = id ? { id, label: names.get(id)?.label ?? (known ? contactRefOption(known).label : 'Loading contact…') } : null;
        const handle = RefPicker.wireRefPicker(form, {
          minChars: deps.recent && deps.get ? 0 : 1,
          config: { pickerId: key, emptyText: 'No matching contacts.', truncatedText: 'More contacts match. Type a more specific name or email.' },
          initialValue,
          search: async query => {
            const current = generation, owner = entries.get(key);
            if (deps.recent && deps.get && !query.trim()) return recentReferencePage(deps.recent, 'contact', async (choice, owns) => {
              const { contact } = await readContactReference(deps.get, choice.id, owns);
              if (!contact || !sameReferenceChoice(choice, contactReferenceChoice(contact))) return null;
              return contactRefOption(contact);
            }, () => generation === current && entries.get(key) === owner);
            const selected = entries.get(key)?.handle.getValue();
            const actual = selected && query === selected.label ? names.get(selected.id)?.searchQuery ?? query : query;
            return searchContactReferences(deps.search, actual);
          },
          onChange: selection => {
            const current = entries.get(key); if (!current) return;
            if (!selection && current.field !== undefined && current.index !== undefined) { deps.clearArrayItem(current.field, current.index); return; }
            deps.changed(); if (selection) loadName(selection.id, true, key); else paintAll();
          },
        });
        entry = { shell, handle, field, index }; entries.set(key, entry);
        if (snapshot && (snapshot.selection?.id ?? '') === id && snapshot.query !== snapshot.selection?.label && snapshot.query !== '') handle.setQuery(snapshot.query);
        if (id) loadName(id); paint(entry);
      });
      const active = restore && restore.generation === generation ? entries.get(restore.key) : undefined;
      const input = active?.shell.querySelector<HTMLInputElement>('[data-ref-picker-input]');
      if (restore && input && input.ownerDocument.activeElement === input && (active!.handle.getValue()?.id ?? null) === restore.id
        && active!.handle.getQuery() === restore.query && restore.start !== null && restore.end !== null) {
        input.setSelectionRange(restore.start, restore.end, restore.direction ?? undefined);
      }
    },
  };
};
