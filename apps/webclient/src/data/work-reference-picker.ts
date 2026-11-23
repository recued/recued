import type { SourceRegistration, WorkEntityGetRpcResponse, WorkEntitySearchRpcRequest, WorkEntitySearchRpcResponse } from '@recued/contracts';
import { RefPicker } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { sameReferenceChoice, workReferenceChoice, type RecentReferenceChoices } from './recent-reference-choices.js';
import { mountRecentReferenceControl, recentReferencePage } from './recent-reference-picker.js';

type Search = (args: WorkEntitySearchRpcRequest) => Promise<WorkEntitySearchRpcResponse>;
type Kind = 'project' | 'task';
type Get<K extends Kind> = (args: { kind: K; id: string }) => Promise<WorkEntityGetRpcResponse>;
const label = (kind: Kind, title: string, source: string) => `${title.trim() || `Untitled ${kind}`} · ${source.trim() || 'Source unavailable'}`;
const capital = (kind: Kind) => kind === 'project' ? 'Project' : 'Task';

/** Accept only the requested inventory. Incomplete searches say so, and a
 * failed read never turns into an apparently empty list. */
const searchReferences = async (kind: Kind, search: Search | undefined, query: string): Promise<RefPicker.RefPickerSearchPage> => {
  if (!search) return { options: [], retryableError: `${capital(kind)} search is unavailable on this server.` };
  if (!query.trim()) return { options: [] };
  try {
    const result = await search({ kind, query: query.trim(), limit: 20, offset: 0 });
    const group = result.groups[0];
    if (result.groups.length !== 1 || group?.kind !== kind || group.offset !== 0 || typeof group.more !== 'boolean' || group.matches.length > 20
      || group.matches.some(match => !match.id) || new Set(group.matches.map(match => match.id)).size !== group.matches.length) {
      throw new Error(`The ${kind} search could not be confirmed. Try again.`);
    }
    if (group.error) throw new Error(group.error);
    return { options: group.matches.map(match => ({ id: match.id, label: label(kind, match.title, match.source_label),
      ...((match.stale || match.source_incomplete || match.pending_write) ? { sublabel: [match.stale || match.source_incomplete ? 'Last synced copy' : '', match.pending_write ? 'Changes pending' : ''].filter(Boolean).join(' · ') } : {}) })),
      truncated: group.more };
  } catch (error) {
    return { options: [], retryableError: classifyRpcError(error).code === 'unknown_method'
      ? `Update your Recued server to search ${kind}s.` : `${capital(kind)}s could not be searched. ${humanizeRpcError(error)}` };
  }
};

type Lookup = { state: 'loading' | 'ready' | 'missing' | 'error'; label: string; message: string; searchQuery?: string };
const referenceLabel = (kind: Kind, id: string, response: WorkEntityGetRpcResponse, sources: readonly SourceRegistration[]): Lookup => {
  const entity = response.entity;
  if (entity && (entity._kind !== kind || entity.id !== id)) throw new Error(`The linked ${kind} could not be confirmed.`);
  if (!entity || entity.deleted_at != null || entity.sync_state === 'orphaned' || entity.sync_state === 'tombstoned') {
    return { state: 'missing', label: `Unavailable ${kind}`, message: `This ${kind} is no longer available. Its link is kept until you clear or change it.` };
  }
  if (entity._kind !== 'project' && entity._kind !== 'task') throw new Error('The linked entity could not be confirmed.');
  if (entity._kind === 'task' && typeof entity.done !== 'boolean') throw new Error('The task status could not be confirmed.');
  return { state: 'ready', label: label(kind, entity.title, sources.find(source => source.id === entity.source_id)?.source_label ?? ''),
    searchQuery: entity.title,
    message: [entity._kind === 'task' ? (entity.done ? 'Completed task.' : 'Open task.') : '',
      entity.sync_state !== 'live' ? `Showing the last synced ${kind} ${kind === 'task' ? 'name and status' : 'name'}.` : '',
      entity.pending_write ? `This ${kind} has changes waiting for its source.` : ''].filter(Boolean).join(' ') };
};

export const searchProjectReferences = (search: Search | undefined, query: string) => searchReferences('project', search, query);
export const searchTaskReferences = (search: Search | undefined, query: string) => searchReferences('task', search, query);
export const projectReferenceLabel = (id: string, response: WorkEntityGetRpcResponse, sources: readonly SourceRegistration[]) => referenceLabel('project', id, response, sources);
export const taskReferenceLabel = (id: string, response: WorkEntityGetRpcResponse, sources: readonly SourceRegistration[]) => referenceLabel('task', id, response, sources);

type Dependencies<K extends Kind> = { search?: Search; get?: Get<K>; recent?: RecentReferenceChoices; sources: () => readonly SourceRegistration[]; changed: () => void;
  clearArrayItem: (field: string, index: number) => void };

/** A dialog owns its pickers and label reads. Repaints reattach the same
 * handles, preserving a typed query; array removals migrate remaining slots. */
const createWorkReferencePickers = <K extends Kind>(kind: K, deps: Dependencies<K> & { currentTaskId?: () => string | undefined }) => {
  type Entry = { shell: HTMLElement; handle: RefPicker.RefPickerHandle; selection: RefPicker.RefPickerSelection | null; rejection?: string; field?: string; index?: number };
  type Snapshot = { selection: RefPicker.RefPickerSelection | null; query: string; rejection?: string };
  const entries = new Map<string, Entry>(), names = new Map<string, Lookup>(), shifted = new Map<string, Snapshot>();
  let binding = '', generation = 0;
  let focused: { generation: number; key: string; id: string | null; query: string; start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } | undefined;
  const reset = () => { generation++; for (const entry of entries.values()) entry.handle.destroy(); entries.clear(); names.clear(); shifted.clear(); binding = ''; focused = undefined; };
  const paint = (entry: Entry) => {
    const selected = entry.handle.getValue(), value = selected ? names.get(selected.id) : undefined;
    if (selected && value) { entry.selection = { id: selected.id, label: value.label }; entry.handle.setValue(entry.selection); }
    let notice = entry.shell.querySelector<HTMLElement>(`[data-${kind}-picker-status]`);
    if (!notice) {
      notice = entry.shell.ownerDocument.createElement('div'); notice.setAttribute(`data-${kind}-picker-status`, ''); notice.className = 'data-row-subtle work-reference-picker-status';
      const message = notice.ownerDocument.createElement('span'); message.setAttribute('role', 'status'); message.setAttribute(`data-${kind}-picker-message`, ''); notice.append(message);
      const retry = notice.ownerDocument.createElement('button'); retry.type = 'button'; retry.className = 'data-button'; retry.textContent = `Retry ${kind} ${kind === 'task' ? 'details' : 'name'}`; retry.setAttribute(`data-${kind}-picker-retry`, '');
      retry.addEventListener('click', () => { const id = entry.handle.getValue()?.id; if (id) loadName(id, true); }); notice.append(retry); entry.shell.append(notice);
    }
    notice.hidden = !entry.rejection && !value?.message;
    notice.querySelector<HTMLElement>(`[data-${kind}-picker-message]`)!.textContent = [entry.rejection, value?.message].filter(Boolean).join(' ');
    notice.querySelector<HTMLButtonElement>(`[data-${kind}-picker-retry]`)!.hidden = value?.state !== 'error' || !deps.get;
    mountRecentReferenceControl(entry.shell, kind, deps.recent, entry.handle, clearRecents);
  };
  const paintAll = () => { for (const entry of entries.values()) paint(entry); };
  const clearRecents = () => {
    for (const entry of entries.values()) if (!entry.handle.getQuery().trim() || entry.handle.getQuery() === entry.handle.getValue()?.label) entry.handle.refresh();
    paintAll();
  };
  const loadName = (id: string, force = false, rememberKey?: string) => {
    if (!force && names.has(id)) return;
    const current = generation;
    const owner = rememberKey ? entries.get(rememberKey) : undefined, epoch = deps.recent?.clearEpoch(kind);
    const prior = [...entries.values()].find(entry => entry.handle.getValue()?.id === id)?.handle.getValue()?.label;
    const pending: Lookup = { state: 'loading', label: prior || `Loading ${kind}…`, message: `Loading linked ${kind} ${kind === 'task' ? 'details' : 'name'}…` };
    names.set(id, pending); paintAll();
    void (async () => {
      try {
        if (!deps.get) throw new Error(`${capital(kind)} details are unavailable on this server.`);
        const response = await deps.get({ kind, id });
        if (current !== generation || names.get(id) !== pending) return;
        const lookup = referenceLabel(kind, id, response, deps.sources()); names.set(id, lookup);
        if (lookup.state === 'ready' && response.entity && (response.entity._kind === 'task' || response.entity._kind === 'project')
          && owner && entries.get(rememberKey!) === owner && owner.handle.getValue()?.id === id && epoch === deps.recent?.clearEpoch(kind))
          deps.recent?.remember(workReferenceChoice(response.entity));
      } catch {
        if (current !== generation || names.get(id) !== pending) return;
        names.set(id, { state: 'error', label: prior && prior !== `Loading ${kind}…` ? prior : `${capital(kind)} ${kind === 'task' ? 'details' : 'name'} unavailable`,
          message: `This ${kind} ${kind === 'task' ? 'name and status' : 'name'} could not be loaded. Its link is kept. Retry, or search for another ${kind}.` });
      }
      paintAll();
    })();
  };
  const excluded = (key: string): Set<string> => new Set(kind === 'task'
    ? [deps.currentTaskId?.(), ...[...entries].filter(([other]) => other !== key).map(([, entry]) => entry.handle.getValue()?.id)].filter((id): id is string => Boolean(id)) : []);
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
        if (entry.index > index) shifted.set(`${field}\0${entry.index - 1}`, { selection: entry.handle.getValue(), query: entry.handle.getQuery(), rejection: entry.rejection });
        entry.handle.destroy(); entries.delete(key);
      }
    },
    mount(form: HTMLElement | null, nextBinding: string) {
      if (binding !== nextBinding || !form) { reset(); binding = nextBinding; }
      if (!form) return;
      const restore = focused; focused = undefined;
      const seen = new Set<string>();
      form.querySelectorAll<HTMLElement>('[data-ref-picker]').forEach(shell => {
        const mirror = shell.querySelector<HTMLInputElement>(`[data-ref-picker-value][data-form-ref-target="data.${kind}"]`);
        const key = shell.getAttribute('data-ref-picker'); if (!mirror || !key) return;
        seen.add(key); const id = mirror.value.trim(), field = mirror.getAttribute('data-form-array-item') ?? undefined;
        const index = field ? Number(mirror.getAttribute('data-form-array-index')) : undefined;
        let entry = entries.get(key);
        if (entry && (entry.handle.getValue()?.id ?? '') !== id) { entry.handle.destroy(); entries.delete(key); entry = undefined; }
        if (entry) { entry.shell = shell; entry.handle.rewire(form); paint(entry); return; }
        const snapshotKey = `${field}\0${index}`, prior = shifted.get(snapshotKey); shifted.delete(snapshotKey);
        const snapshot = prior && (prior.selection?.id ?? '') === id ? prior : undefined;
        const handle = RefPicker.wireRefPicker(form, {
          minChars: deps.recent && deps.get ? 0 : 1,
          search: async query => {
            const current = generation, owner = entries.get(key);
            const selected = entries.get(key)?.handle.getValue();
            const title = selected && query === selected.label ? names.get(selected.id)?.searchQuery : undefined;
            const page = deps.recent && deps.get && !query.trim() ? await recentReferencePage(deps.recent, kind, async (choice, owns) => {
              const response = await deps.get!({ kind, id: choice.id }); if (!owns()) return null;
              const lookup = referenceLabel(kind, choice.id, response, deps.sources()), entity = response.entity;
              if (lookup.state !== 'ready' || !entity || entity._kind !== kind || (entity._kind !== 'task' && entity._kind !== 'project')
                || !sameReferenceChoice(choice, workReferenceChoice(entity))) return null;
              return { id: entity.id, label: lookup.label, ...(lookup.message ? { sublabel: lookup.message } : {}) };
            }, () => generation === current && entries.get(key) === owner) : await searchReferences(kind, deps.search, title ?? query);
            const omit = excluded(key);
            return { ...page, options: page.options.filter(option => !omit.has(option.id)) };
          },
          config: { pickerId: key, emptyText: kind === 'task' ? 'No other matching tasks. Try a different task name.' : 'No matching projects.',
            truncatedText: `More ${kind}s match. Type a more specific ${kind} name.` },
          initialValue: id ? { id, label: names.get(id)?.label ?? `Loading ${kind}…` } : null,
          onChange: selection => {
            const currentEntry = entries.get(key); if (!currentEntry) return;
            // A different slot may have chosen this task while these results
            // were open. Recheck at commit before the host captures any id.
            if (selection && excluded(key).has(selection.id)) {
              currentEntry.handle.setValue(currentEntry.selection);
              currentEntry.rejection = selection.id === deps.currentTaskId?.() ? 'A task cannot depend on itself.' : 'This task is already selected.';
              paint(currentEntry); return;
            }
            currentEntry.selection = selection; currentEntry.rejection = undefined;
            if (!selection) {
              const current = entries.get(key)?.shell.querySelector<HTMLInputElement>('[data-ref-picker-value]');
              const field = current?.getAttribute('data-form-array-item'), index = current?.getAttribute('data-form-array-index');
              // An empty ref is not a valid array member. Use the host's row
              // removal so Clear preserves the other links and their focus.
              if (field && typeof index === 'string') { deps.clearArrayItem(field, Number(index)); return; }
            }
            deps.changed(); if (selection) loadName(selection.id, true, key); else paintAll();
          },
        });
        entry = { shell, handle, selection: handle.getValue(), field, index, rejection: snapshot?.rejection }; entries.set(key, entry);
        if (snapshot && snapshot.query !== snapshot.selection?.label && (snapshot.query !== '' || snapshot.selection !== null)) handle.setQuery(snapshot.query);
        if (id) loadName(id); paint(entry);
      });
      for (const [key, entry] of entries) if (!seen.has(key)) { entry.handle.destroy(); entries.delete(key); }
      const active = restore && restore.generation === generation ? entries.get(restore.key) : undefined;
      const input = active?.shell.querySelector<HTMLInputElement>('[data-ref-picker-input]');
      if (restore && input && input.ownerDocument.activeElement === input && (active!.handle.getValue()?.id ?? null) === restore.id
        && active!.handle.getQuery() === restore.query && restore.start !== null && restore.end !== null) {
        input.setSelectionRange(restore.start, restore.end, restore.direction ?? undefined);
      }
    },
  };
};

export const createWorkProjectPickers = (deps: Dependencies<'project'>) => createWorkReferencePickers('project', deps);
export const createWorkTaskPickers = (deps: Dependencies<'task'> & { currentTaskId: () => string | undefined }) => createWorkReferencePickers('task', deps);
