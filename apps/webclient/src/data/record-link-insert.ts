import { isMentionOnlyEmail, PURSUIT_CLASS_ID, type ContactRecord, type CollectionSearchGroup, type WorkEntitySearchRpcRequest, type WorkEntitySearchRpcResponse, type YoursReadRequest, type YoursSnapshot } from '@recued/contracts';
import { sourceRecordLinkDetails } from './source-record-link.js';
import { serializeSourceRecordAddress, serializeShellRoute } from '../shell/route.js';
import { recordLink } from '../shell/record-link.js';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { assetRecordIdentity, limitRecordLinkQuery, type ExactRecordLinkMatch, type ExactRecordLinkState, type RecordLinkQuery } from './exact-record-link.js';
import type { RecentWorkRecord } from './recent-work-records.js';
import type { RecordLinkShortcutGroup } from './record-link-shortcuts.js';
import type { WorkRecordLink } from './task-note-source.js';
import type { RecordLinkTarget } from './work-link-preview.js';

export type LinkKind = RecordLinkTarget['tab'];
export const LINK_KINDS = ['contact', 'task', 'note', 'commitment', 'booking', 'project', 'mail', 'calendar', 'asset'] as const;
const labels: Record<LinkKind, string> = {
  contact: 'Contacts', task: 'Tasks', note: 'Notes', commitment: 'Commitments', booking: 'Bookings',
  project: 'Projects', mail: 'Mail', calendar: 'Calendar', asset: 'Yours assets',
};
export const linkKindLabel = (kind: LinkKind): string => labels[kind];
export interface LinkOption {
  key: string; target: RecordLinkTarget; title: string; detail: string; account?: string;
  received_at?: number; expectedIdentity?: string; shortcut?: RecentWorkRecord; exact?: ExactRecordLinkMatch;
}
export interface LinkPage { options: LinkOption[]; more: boolean; warnings?: string[] }
export interface RecordLinkSearch {
  assets?: (args: YoursReadRequest) => Promise<Pick<YoursSnapshot, 'assets' | 'total_assets' | 'classes'>>;
  collections?: (args: { query: string; per_group?: number; platforms?: Array<'mail' | 'calendar'> }) => Promise<{ groups: CollectionSearchGroup[]; unavailable_sources?: Array<{ platform: string; slug: string }> }>;
  contacts?: (args: { query: string; limit: number; offset: number }) => Promise<{ contacts: ContactRecord[]; total: number }>;
  work?: (args: WorkEntitySearchRpcRequest) => Promise<WorkEntitySearchRpcResponse>;
}
const validId = (id: string) => typeof id === 'string' && !!id.trim() && id.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(id);
const option = (kind: WorkRecordLink['tab'], id: string, title: string, detail: string): LinkOption => ({ key: JSON.stringify([kind, id]),
  target: { tab: kind, id, hash: serializeShellRoute('data', kind, id) }, title, detail });

/** The same indexed services used by universal search, restricted to one kind.
 * An incomplete or failed page never becomes an empty successful search. */
export const searchRecordLinks = async (kind: LinkKind, query: string, callers: RecordLinkSearch): Promise<LinkPage> => {
  const args = { query: query.trim(), offset: 0, limit: 20 };
  if (!args.query) return { options: [], more: false };
  if (kind === 'asset') {
    if (!callers.assets) throw new Error('Yours asset search is unavailable');
    const { assets, total_assets, classes } = await callers.assets({
      search: args.query, offset: args.offset, limit: args.limit, pursuits: 'exclude', mark_shown: false,
    });
    if (!Array.isArray(assets) || assets.length > args.limit || !Number.isSafeInteger(total_assets)
      || total_assets < assets.length || total_assets > 0 && !assets.length) throw new Error('Invalid asset page');
    const found = new Set<string>();
    const options: LinkOption[] = [];
    for (const asset of assets) {
      if (!asset || !validId(asset.id) || !Number.isSafeInteger(asset.created_at) || asset.created_at < 0
        || typeof asset.name !== 'string' || typeof asset.status !== 'string' || found.has(asset.id)) throw new Error('Invalid asset identity');
      found.add(asset.id);
      if (asset.deleted_at != null || asset.sync_state === 'tombstoned' || asset.class_id === PURSUIT_CLASS_ID) continue;
      options.push({
        key: JSON.stringify(['asset', asset.id]),
        target: { tab: 'asset', id: asset.id, hash: serializeShellRoute('yours', 'asset', asset.id) },
        title: asset.name.trim().slice(0, 240) || 'Asset',
        detail: [classes?.find(row => row.id === asset.class_id)?.name, asset.status.replaceAll('_', ' ')].filter(Boolean).join(' · '),
        expectedIdentity: assetRecordIdentity(asset.id, asset.created_at),
      });
    }
    return { options, more: total_assets > assets.length };
  }
  if (kind === 'contact') {
    if (!callers.contacts) throw new Error('Search unavailable');
    const result = await callers.contacts(args);
    if (!Array.isArray(result.contacts) || !Number.isSafeInteger(result.total) || result.total < result.contacts.length
      || result.contacts.length > 20 || result.total > 0 && !result.contacts.length) throw new Error('Invalid page');
    const rows = result.contacts.filter(contact => contact.merged_into === undefined);
    if (rows.some(contact => !validId(contact.contact_id || contact.email))) throw new Error('Invalid identity');
    const options = rows.map(contact => option(kind, contact.contact_id || contact.email,
      contact.name?.trim() || (isMentionOnlyEmail(contact.email) ? 'Contact' : contact.email), isMentionOnlyEmail(contact.email) ? '' : contact.email));
    if (new Set(options.map(row => row.key)).size !== options.length) throw new Error('Duplicate identity');
    return { options, more: result.total > result.contacts.length };
  }
  if (kind === 'mail' || kind === 'calendar') {
    if (!callers.collections) throw new Error('Search unavailable');
    const response = await callers.collections({ query: args.query, per_group: 20, platforms: [kind] });
    if (!Array.isArray(response.groups)) throw new Error('Invalid page');
    const options: LinkOption[] = [], groups = new Set<string>(), keys = new Set<string>();
    let more = false;
    for (const group of response.groups) {
      if (group.platform !== kind || !validId(group.slug) || groups.has(group.slug) || !Array.isArray(group.matches)
        || group.matches.length > 20 || typeof group.more !== 'boolean') throw new Error('Invalid page');
      groups.add(group.slug); more ||= group.more;
      for (const match of group.matches) {
        if (!validId(match.record_id) || !Number.isSafeInteger(match.received_at) || !match.hot_fields || typeof match.hot_fields !== 'object') throw new Error('Invalid identity');
        const key = JSON.stringify([kind, group.slug, match.record_id]); if (keys.has(key)) throw new Error('Duplicate identity'); keys.add(key);
        const target = { tab: kind, collectionSlug: group.slug, recordId: match.record_id,
          hash: serializeSourceRecordAddress({ tab: kind, collectionSlug: group.slug, recordId: match.record_id }) };
        const display = sourceRecordLinkDetails(kind, group.slug, match.hot_fields, match.received_at!);
        if (options.length < 100) options.push({ key, target, title: display.title, account: group.slug, received_at: match.received_at,
          detail: [...display.details, ...(group.source_freshness?.stale ? ['Last synced copy'] : []),
            ...(match.partial_match ? ['Some search terms matched'] : []), ...(match.thread_context ? ['Conversation context'] : [])].join(' · ') });
        else more = true;
      }
    }
    const unavailable = response.unavailable_sources ?? [];
    if (!Array.isArray(unavailable) || unavailable.some(source => source.platform !== kind || !validId(source.slug))) throw new Error('Invalid page');
    const warnings = unavailable.map(source => 'Could not search account ' + source.slug + '. Try again.');
    return { options, more, ...(warnings.length ? { warnings } : {}) };
  }
  if (!callers.work) throw new Error('Search unavailable');
  const response = await callers.work({ ...args, kind }), group = response.groups[0];
  if (response.groups.length !== 1 || group?.kind !== kind || group.offset !== 0 || typeof group.more !== 'boolean'
    || group.error || group.matches.length > 20 || group.matches.some(match => !validId(match.id))
    || new Set(group.matches.map(match => match.id)).size !== group.matches.length) throw new Error('Invalid page');
  return { more: group.more, options: group.matches.map(match => option(kind, match.id, match.title.trim() || (kind === 'task' ? 'Task' : kind === 'commitment' ? 'Commitment' : kind === 'booking' ? 'Booking' : kind === 'project' ? 'Project' : 'Note'),
    [match.source_label || 'Source unavailable', match.stale || match.source_incomplete ? 'Last synced copy' : '', match.pending_write ? 'Changes pending' : ''].filter(Boolean).join(' · '))) };
};

/** Insert a complete URL token without changing text outside the selection. */
export const insertRecordLinkText = (body: string, start: number, end: number, href: string, target: RecordLinkTarget, max = -1) => {
  if (target.tab === 'asset') return null;
  if ('id' in target ? !validId(target.id) || target.hash !== serializeShellRoute('data', target.tab, target.id)
    : !validId(target.collectionSlug) || !validId(target.recordId) || target.hash !== serializeSourceRecordAddress(target)) return null;
  const url = recordLink(href, target.hash);
  if (!url || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > body.length) return null;
  const left = body.slice(0, start), right = body.slice(end);
  const text = (left && !/\s$/u.test(left) ? ' ' : '') + url + (right && !/^\s/u.test(right) ? ' ' : '');
  const value = left + text + right;
  return max >= 0 && value.length > max ? null : { value, start, end, text, cursor: start + text.length };
};

export const RECORD_LINK_SELECTION_LIMIT = 20;
/** One block is inserted with one native edit, preserving text outside the selection. */
export const insertRecordLinksText = (body: string, start: number, end: number, href: string, records: readonly Pick<ExactRecordLinkMatch, 'target' | 'title'>[], max = -1) => {
  if (!records.length || records.length > RECORD_LINK_SELECTION_LIMIT || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > body.length) return null;
  const lines: string[] = [];
  for (const record of records) {
    const link = insertRecordLinkText('', 0, 0, href, record.target); if (!link) return null;
    const title = record.title.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 200) || linkKindLabel(record.target.tab);
    lines.push('- ' + title + ': ' + link.text);
  }
  const left = body.slice(0, start), right = body.slice(end);
  const text = (left && !left.endsWith('\n') ? '\n' : '') + lines.join('\n') + (right && !right.startsWith('\n') ? '\n' : '');
  const value = left + text + right;
  return max >= 0 && value.length > max ? null : { value, start, end, text, cursor: start + text.length };
};

export type LinkGroup = { kind: LinkKind } & ({ state: 'loading' } | { state: 'ready'; page: LinkPage } | { state: 'error'; message: string });
export interface LinkSelection { id: string; hashes: string[]; option: LinkOption; state: 'loading' | 'ready' | 'error'; reference?: ExactRecordLinkMatch; error?: string }
export interface PreparedRecordLink { reference: ExactRecordLinkMatch; shortcut?: RecentWorkRecord }
export interface LinkInsertState { owner: string; query: string; filter: LinkKind | 'all'; groups: LinkGroup[]; shortcuts?: RecordLinkShortcutGroup[]; exact?: ExactRecordLinkState; selecting?: string; error?: string; multiple: boolean; selections: LinkSelection[]; inserting?: boolean }
export const linkInsertOptions = (view: LinkInsertState): LinkOption[] => view.exact?.state === 'ready' ? [{ ...view.exact.match, detail: view.exact.match.details.join(' · '), exact: view.exact.match }]
  : view.query.trim() ? view.groups.flatMap(group => group.state === 'ready' ? group.page.options : []) : view.shortcuts?.flatMap(group => group.options) ?? [];
export const linkInsertPreviewOptions = (view: LinkInsertState): LinkOption[] => [...linkInsertOptions(view), ...view.selections.filter(entry => entry.state === 'ready').map(entry => entry.option)];
export const createRecordLinkInsert = (deps: {
  owner: () => string | null; kinds: readonly LinkKind[];
  search: (kind: LinkKind, query: string) => Promise<LinkPage>;
  lookup?: { parse: (query: string) => RecordLinkQuery; read: (target: RecordLinkTarget) => Promise<ExactRecordLinkState>; verify: (match: ExactRecordLinkMatch) => Promise<boolean> };
  shortcuts?: (filter: LinkKind | 'all') => RecordLinkShortcutGroup[];
  verifyShortcut?: (record: RecentWorkRecord) => Promise<boolean>;
  verify: (target: RecordLinkTarget, receivedAt?: number) => Promise<boolean>;
  insert: (target: RecordLinkTarget) => string | null;
  prepareSelection?: (option: LinkOption) => Promise<ExactRecordLinkState>;
  insertBatch?: (references: readonly ExactRecordLinkMatch[]) => string | null;
  initialSelections?: () => readonly PreparedRecordLink[];
  allowEmptyBatch?: boolean;
  changed: () => void;
}) => {
  let view: LinkInsertState | null = null, generation = 0, batchSequence = 0, disposed = false;
  const state = () => { if (disposed || view?.owner !== deps.owner()) { view = null; generation++; } return view; };
  const close = () => { view = null; generation++; deps.changed(); };
  const stopBatch = (current: LinkInsertState) => { if (current.inserting) { batchSequence++; current.inserting = false; } };
  const prepare = async (current: LinkInsertState, entry: LinkSelection, expected = entry.option.exact) => {
    const pending: LinkSelection = { ...entry, state: 'loading', error: undefined };
    current.selections = current.selections.map(row => row === entry ? pending : row); deps.changed();
    try {
      const result = await deps.prepareSelection!(pending.option);
      if (state() !== current || !current.multiple || !current.selections.includes(pending)) return;
      if (result.state !== 'ready' || expected && (result.match.identity !== expected.identity || result.match.target.hash !== expected.target.hash)) {
        pending.state = 'error';
        pending.error = result.state === 'missing' ? result.message : 'This record could not be confirmed. Try again or remove it.';
      } else {
        const duplicate = current.selections.find(row => row !== pending && row.reference?.target.hash === result.match.target.hash);
        if (duplicate && current.selections.indexOf(duplicate) < current.selections.indexOf(pending)) {
          duplicate.hashes = [...new Set([...duplicate.hashes, ...pending.hashes, result.match.target.hash])];
          current.selections = current.selections.filter(row => row !== pending);
        } else {
          const ready: LinkSelection = { ...pending, state: 'ready', reference: result.match,
            hashes: [...new Set([...pending.hashes, ...(duplicate?.hashes ?? []), result.match.target.hash])],
            option: { ...pending.option, target: result.match.target, title: result.match.title, detail: result.match.details.join(' · '), exact: result.match } };
          current.selections = current.selections.filter(row => row !== duplicate).map(row => row === pending ? ready : row);
        }
      }
    } catch {
      if (state() !== current || !current.multiple || !current.selections.includes(pending)) return;
      pending.state = 'error'; pending.error = 'This record could not be checked. Try again.';
    }
    deps.changed();
  };
  const load = async (kind: LinkKind) => {
    const current = state(); if (!current || !current.query.trim() || !deps.kinds.includes(kind)) return;
    const query = current.query, token: LinkGroup = { kind, state: 'loading' }, visit = generation;
    current.groups = current.groups.filter(group => group.kind !== kind).concat(token); deps.changed();
    try {
      const page = await deps.search(kind, query);
      if (state() !== current || visit !== generation || !current.groups.includes(token)) return;
      current.groups = current.groups.map(group => group === token ? { kind, state: 'ready', page } : group);
    } catch (error) {
      if (state() !== current || visit !== generation || !current.groups.includes(token)) return;
      current.groups = current.groups.map(group => group === token ? { kind, state: 'error', message: classifyRpcError(error).code === 'unknown_method'
        ? 'Update your Recued server to search these records.' : linkKindLabel(kind) + ' could not be searched. Try again.' } : group);
    }
    deps.changed();
  };
  const refreshShortcuts = () => {
    const current = state(); if (!current || current.query.trim() || !deps.shortcuts) return;
    const next = deps.shortcuts(current.filter); if (JSON.stringify(next) === JSON.stringify(current.shortcuts)) return;
    generation++; stopBatch(current); current.shortcuts = next; current.selecting = undefined; current.error = undefined; deps.changed();
  };
  return { state, close, revision: () => generation,
    open() {
      const owner = deps.owner(); if (disposed || !owner) return; generation++;
      const selections: LinkSelection[] = (deps.initialSelections?.() ?? []).slice(0, RECORD_LINK_SELECTION_LIMIT).map(({ reference, shortcut }) => {
        const id = JSON.stringify(['selected', reference.target.hash]);
        return { id, hashes: [reference.target.hash], state: 'ready', reference,
          option: { key: id, target: reference.target, title: reference.title, detail: reference.details.join(' · '), exact: reference, ...(shortcut ? { shortcut } : {}) } };
      });
      view = { owner, query: '', filter: 'all', groups: [], multiple: deps.initialSelections !== undefined, selections, ...(deps.shortcuts ? { shortcuts: deps.shortcuts('all') } : {}) }; deps.changed();
    },
    change(query: string, filter: LinkInsertState['filter'] = state()?.filter ?? 'all') {
      const current = state(); if (!current || filter !== 'all' && !deps.kinds.includes(filter)) return;
      generation++; stopBatch(current); current.query = deps.lookup ? limitRecordLinkQuery(query) : query.slice(0, 200); current.filter = filter; current.groups = []; current.exact = undefined; current.selecting = undefined; current.error = undefined;
      if (deps.shortcuts) current.shortcuts = current.query.trim() ? [] : deps.shortcuts(filter);
      deps.changed();
    },
    refreshShortcuts,
    search: async () => {
      const current = state(); if (!current) return;
      generation++; stopBatch(current); current.groups = []; current.selecting = undefined; current.error = undefined;
      if (!current.query.trim()) { if (deps.shortcuts) current.shortcuts = deps.shortcuts(current.filter); deps.changed(); return; }
      const parsed = deps.lookup?.parse(current.query);
      if (parsed && parsed.kind !== 'text') {
        const visit = generation;
        if (parsed.kind === 'invalid') { current.exact = { state: 'invalid', message: parsed.message }; deps.changed(); return; }
        current.filter = parsed.target.tab; current.exact = { state: 'loading' }; deps.changed();
        try {
          const exact = await deps.lookup!.read(parsed.target);
          if (state() !== current || visit !== generation) return;
          current.exact = exact;
        } catch {
          if (state() !== current || visit !== generation) return;
          current.exact = { state: 'error', message: 'This record could not be checked. Try again.' };
        }
        deps.changed(); return;
      }
      current.exact = undefined;
      await Promise.all((current.filter === 'all' ? deps.kinds : [current.filter]).map(load));
    },
    retry: load,
    setMultiple(enabled: boolean) {
      const current = state(); if (!current || current.selecting || current.inserting || !deps.prepareSelection || !deps.insertBatch || !deps.lookup) return;
      current.multiple = enabled; current.selections = []; current.error = undefined; deps.changed();
    },
    async toggleSelection(key: string, expected?: ExactRecordLinkMatch) {
      refreshShortcuts();
      const current = state(); if (!current?.multiple || current.inserting || !deps.prepareSelection) return;
      const option = linkInsertPreviewOptions(current).find(row => row.key === key); if (!option) return;
      const selected = current.selections.find(row => row.hashes.includes(option.target.hash));
      if (selected) { current.selections = current.selections.filter(row => row !== selected); current.error = undefined; deps.changed(); return; }
      if (current.selections.length >= RECORD_LINK_SELECTION_LIMIT) { current.error = 'Select up to ' + RECORD_LINK_SELECTION_LIMIT + ' records. Remove a selection to add another.'; deps.changed(); return; }
      const id = JSON.stringify(['selected', option.target.hash]);
      const entry: LinkSelection = { id, hashes: [option.target.hash], option: { ...option, key: id, ...(expected ? { exact: expected } : {}) }, state: 'loading' };
      current.selections.push(entry); current.error = undefined; await prepare(current, entry, expected);
    },
    removeSelection(id: string) {
      const current = state(); if (!current || current.inserting) return;
      current.selections = current.selections.filter(row => row.id !== id); current.error = undefined; deps.changed();
    },
    clearSelection() { const current = state(); if (!current || current.inserting) return; current.selections = []; current.error = undefined; deps.changed(); },
    async retrySelection(id: string) {
      const current = state(), entry = current?.selections.find(row => row.id === id);
      if (current?.multiple && !current.inserting && entry?.state === 'error') await prepare(current, entry);
    },
    async insertSelected() {
      const current = state(); if (!current?.multiple || current.inserting || !deps.insertBatch || !current.selections.length && !deps.allowEmptyBatch || current.selections.some(row => row.state !== 'ready' || !row.reference)) return;
      const entries = current.selections.slice(), visit = ++batchSequence;
      const active = () => state() === current && current.inserting && visit === batchSequence;
      current.inserting = true; current.error = undefined; for (const entry of entries) entry.error = undefined; deps.changed();
      for (const entry of entries) {
        if (!active()) return;
        try {
          const shortcutExists = !entry.option.shortcut || await (deps.verifyShortcut?.(entry.option.shortcut) ?? false);
          if (!active()) return;
          const exists = shortcutExists && await (deps.lookup?.verify(entry.reference!) ?? false);
          if (!active()) return;
          if (!exists) entry.error = 'This record was removed or replaced. Remove it and search again.';
        } catch { if (!active()) return; entry.error = 'This record could not be checked. Try inserting again.'; }
      }
      if (!active()) return;
      if (entries.some(row => row.error)) current.error = 'Some selected records could not be checked. No links were inserted.';
      else {
        try {
          const error = deps.insertBatch(entries.map(row => row.reference!));
          if (!active()) return;
          if (!error) { close(); return; }
          current.error = error;
        } catch { if (!active()) return; current.error = 'Links could not be inserted. Review the draft and try again.'; }
      }
      current.inserting = false; deps.changed();
    },
    async choose(key: string) {
      refreshShortcuts();
      const current = state(); if (!current || current.selecting || current.multiple) return;
      const options = linkInsertOptions(current);
      const selected = options.find(row => row.key === key);
      if (!selected) return;
      const visit = generation; current.selecting = key; current.error = undefined; deps.changed();
      try {
        const exists = await (selected.exact ? deps.lookup?.verify(selected.exact) ?? false : selected.shortcut ? deps.verifyShortcut?.(selected.shortcut) ?? false
          : selected.received_at === undefined ? deps.verify(selected.target) : deps.verify(selected.target, selected.received_at));
        if (selected.shortcut) refreshShortcuts();
        if (state() !== current || generation !== visit || current.selecting !== key) return;
        if (!exists) current.error = 'This record is no longer available. Search again.';
        else {
          const error = deps.insert(selected.target);
          if (!error) { close(); return; }
          current.error = error;
        }
      } catch {
        if (state() !== current || generation !== visit || current.selecting !== key) return;
        current.error = 'The selected record could not be checked. Try selecting it again.';
      }
      current.selecting = undefined; deps.changed();
    },
    dispose() { disposed = true; view = null; generation++; },
  };
};
