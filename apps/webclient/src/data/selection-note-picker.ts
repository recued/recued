import type { SourceRegistration, WorkEntityGetRpcResponse, WorkEntitySearchRpcRequest, WorkEntitySearchRpcResponse, Note } from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export type SelectionNoteDestination = { sources: SourceRegistration[]; sourceId: string; existing?: { note: Note; revision: string } };
export const createSelectionNotePicker = (deps: {
  document: Document;
  sources: () => Promise<{ sources: readonly SourceRegistration[] }>;
  search?: (args: WorkEntitySearchRpcRequest) => Promise<WorkEntitySearchRpcResponse>;
  get?: (args: { kind: 'note'; id: string }) => Promise<WorkEntityGetRpcResponse>;
}) => {
  let active: { current: () => boolean; close: (result?: SelectionNoteDestination) => void } | undefined;
  const reset = () => active?.close();
  return { reset, mount() { if (active && !active.current()) reset(); },
    open(current: () => boolean): Promise<SelectionNoteDestination | undefined> {
      reset();
      const doc = deps.document, before = doc.activeElement as HTMLElement | null;
      const dialog = doc.createElement('dialog'); dialog.setAttribute('aria-label', 'Save selection to a note'); dialog.setAttribute('data-selection-note-picker', '');
      const style = doc.createElement('style'); style.textContent = `dialog[data-selection-note-picker] { width:min(540px,calc(100vw - 24px)); max-height:85dvh; box-sizing:border-box; padding:20px; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--fg); font:inherit; overflow:auto; }
        [data-selection-note-picker]::backdrop { background:#0006; } [data-selection-note-picker] [hidden] { display:none !important; }
        [data-selection-note-picker] input,[data-selection-note-picker] select { width:100%; box-sizing:border-box; padding:10px; font:inherit; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); }
        [data-selection-note-picker] button { min-height:44px; padding:8px 12px; margin:4px 0; font:inherit; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); cursor:pointer; }
        [data-selection-note-picker] button:disabled { opacity:.55; cursor:default; } [data-selection-note-picker] label { display:block; margin-top:12px; }
        [data-selection-note-results] { display:grid; gap:6px; } [data-selection-note-results] button { text-align:left; overflow-wrap:anywhere; } [data-selection-note-results] small { display:block; }`;
      const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const node = doc.createElement(tag); if (text) node.textContent = text; return node; };
      const button = (text: string) => { const node = el('button', text); node.type = 'button'; return node; };
      const heading = el('h2', 'Save selection to a note'), description = el('p', 'Choose a destination. Review the quoted passage and its source link in the note editor before saving.');
      const sourceLabel = el('label', 'New note Source'), source = el('select'); source.setAttribute('aria-label', 'New note Source'); sourceLabel.append(source);
      const create = button('Create a new note'); create.disabled = true;
      const sourceStatus = el('p', 'Loading note Sources…'); sourceStatus.setAttribute('role', 'status'); const retrySources = button('Retry note Sources'); retrySources.hidden = true;
      const queryLabel = el('label', 'Find an existing note'), query = el('input'); query.type = 'search'; query.maxLength = 200; query.setAttribute('aria-label', 'Find an existing note'); queryLabel.append(query);
      const search = button('Search notes'), status = el('p', 'Type a title or words from a note.'); status.setAttribute('role', 'status');
      const results = el('div'); results.setAttribute('data-selection-note-results', ''); const more = button('Load more notes'); more.hidden = true;
      const cancel = button('Cancel'); dialog.append(style, heading, description, sourceLabel, create, sourceStatus, retrySources, queryLabel, search, status, results, more, cancel);
      let resolve!: (result?: SelectionNoteDestination) => void, closed = false, sequence = 0, offset = 0, selecting: number | null = null, sourceSequence = 0;
      let registered: SourceRegistration[] = [], writable = new Map<string, SourceRegistration>(), searching = '';
      const result = new Promise<SelectionNoteDestination | undefined>(done => { resolve = done; });
      const close = (value?: SelectionNoteDestination) => {
        if (closed) return; closed = true; sequence++; active = undefined; dialog.remove();
        if (before?.isConnected && current()) before.focus({ preventScroll: true });
        resolve(value);
      };
      const alive = () => !closed && current(); active = { current, close };
      const loadSources = async () => {
        const visit = ++sourceSequence; retrySources.hidden = true; create.disabled = true; query.disabled = search.disabled = true; sourceStatus.textContent = 'Loading note Sources…';
        try {
          const reply = await deps.sources(); if (!alive()) { close(); return; }
          if (visit !== sourceSequence) return;
          registered = [...reply.sources]; writable = new Map(registered.filter(row => row.top_tier_kind === 'note' && row.write_capable && row.sync_posture !== 'read_through').map(row => [row.id, row]));
          source.replaceChildren(); for (const row of writable.values()) { const item = el('option', row.source_label || row.id); item.value = row.id; source.append(item); }
          query.disabled = search.disabled = !deps.search || !deps.get; create.disabled = writable.size === 0; sourceStatus.textContent = writable.size ? '' : 'No writable note Source is available. Check Connections in Settings.';
        } catch (error) { if (alive() && visit === sourceSequence) { sourceStatus.textContent = humanizeRpcError(error); retrySources.hidden = false; } }
      };
      const choose = async (id: string, sourceId: string) => {
        if (!alive() || selecting !== null || !deps.get) return; const visit = ++sequence; selecting = visit; status.textContent = 'Checking the destination note…';
        try {
          const reply = await deps.get({ kind: 'note', id }); if (!alive()) { close(); return; } if (visit !== sequence) return;
          const note = reply.entity;
          if (note?._kind !== 'note' || note.id !== id || note.source_id !== sourceId || !writable.has(note.source_id) || note.sync_state !== 'live' || note.deleted_at != null || note.pending_write)
            throw new Error('This note cannot be edited now. Choose another note or refresh the search.');
          if (!/^[a-f0-9]{64}$/u.test(reply.note_edit_revision ?? '')) throw new Error('Update your Recued server to safely append to existing notes. You can still create a new note.');
          close({ sources: registered, sourceId: note.source_id, existing: { note, revision: reply.note_edit_revision! } });
        } catch (error) { if (alive() && visit === sequence) status.textContent = humanizeRpcError(error); }
        finally { if (selecting === visit) selecting = null; }
      };
      const runSearch = async (append = false) => {
        if (!alive() || selecting !== null || !deps.search) return;
        const text = query.value.trim(), visit = ++sequence; if (!text) { results.replaceChildren(); more.hidden = true; status.textContent = 'Type a title or words from a note.'; return; }
        if (!append) { offset = 0; searching = text; results.replaceChildren(); }
        const pageOffset = offset; search.disabled = more.disabled = true; status.textContent = 'Searching notes…';
        try {
          const reply = await deps.search({ kind: 'note', query: text, limit: 20, offset: pageOffset });
          if (!alive() || visit !== sequence || query.value.trim() !== text) return;
          const group = reply.groups[0];
          if (reply.groups.length !== 1 || group?.kind !== 'note' || group.error || group.offset !== pageOffset || !Array.isArray(group.matches) || group.matches.length > 20 || typeof group.more !== 'boolean') throw new Error('Notes could not be searched. Try again.');
          for (const match of group.matches) if (writable.has(match.source_id) && !match.pending_write && !match.stale && !match.source_incomplete) {
            const item = button(''); const title = el('span', match.title || 'Untitled note'), detail = el('small', match.source_label || writable.get(match.source_id)!.source_label); item.setAttribute('aria-label', 'Use note ' + (match.title || 'Untitled note')); item.append(title, detail);
            item.addEventListener('click', () => { void choose(match.id, match.source_id); }); results.append(item);
          }
          offset = pageOffset + group.matches.length; more.hidden = !group.more;
          if (group.more && group.matches.length === 0) throw new Error('The next note page was incomplete. Search again.');
          status.textContent = results.childElementCount ? 'Only writable, confirmed notes are shown.' : 'No writable notes found.';
        } catch (error) { if (alive() && visit === sequence) status.textContent = humanizeRpcError(error); }
        finally { if (alive() && visit === sequence) { search.disabled = more.disabled = false; } }
      };
      create.addEventListener('click', () => { if (alive() && selecting === null && writable.has(source.value)) close({ sources: registered, sourceId: source.value }); });
      cancel.addEventListener('click', () => close()); dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
      retrySources.addEventListener('click', () => { void loadSources(); }); search.addEventListener('click', () => { void runSearch(); }); more.addEventListener('click', () => { void runSearch(query.value.trim() === searching); });
      query.addEventListener('input', () => { sequence++; selecting = null; search.disabled = false; more.hidden = true; results.replaceChildren(); status.textContent = 'Choose Search notes or press Enter.'; });
      query.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void runSearch(); } });
      if (!deps.search || !deps.get) { queryLabel.hidden = search.hidden = true; status.textContent = 'Existing note search is unavailable on this server.'; }
      doc.body.append(dialog); dialog.showModal(); void loadSources(); cancel.focus({ preventScroll: true }); return result;
    },
  };
};
