import type { FileAttachmentListRequest, FileAttachmentListResult, FileAttachmentSelection, CloudFileSource, CloudFileSelection, CloudFileListRequest, CloudFileListResult, CloudFileImportRequest } from '@recued/contracts';
import { openFilePreview, type FilePreviewCallers } from '../files/file-preview.js';

export type ChatFileListCaller = (args: FileAttachmentListRequest) => Promise<FileAttachmentListResult>;
export interface CloudFileCallers {
  sources: () => Promise<{ sources: CloudFileSource[] }>;
  list: (args: CloudFileListRequest) => Promise<CloudFileListResult>;
  importFile: (args: CloudFileImportRequest) => Promise<FileAttachmentSelection>;
}
export interface FileChatCallers {
  preview?: FilePreviewCallers;
  get: (args: { record_id: string }) => Promise<FileAttachmentSelection>;
  sessions: () => Promise<{ sessions: ReadonlyArray<unknown> }>;
  cloud?: CloudFileCallers & {
    get: (args: { record_id: string }) => Promise<CloudFileSelection>;
  };
}

/** A native modal owns focus and Escape; abort retires pending reads on navigation. */
const picker = <T>(doc: Document, title: string, signal?: AbortSignal) => {
  const before = doc.activeElement as HTMLElement | null;
  const lifetime = new AbortController();
  const dialog = doc.createElement('dialog');
  dialog.setAttribute('aria-label', title);
  dialog.setAttribute('data-chat-file-picker', '');
  const style = doc.createElement('style');
  style.textContent = `dialog[data-chat-file-picker] { width:min(520px,90vw); max-height:80vh; box-sizing:border-box;
    padding:20px; border:1px solid var(--border,#666); border-radius:12px;
    background:var(--surface,#fff); color:var(--fg,#222); font:14px/1.45 system-ui,sans-serif; }
    dialog[data-chat-file-picker]::backdrop { background:#0006; }
    [data-chat-file-picker] [hidden] { display:none !important; }
    [data-chat-file-picker] select { width:100%; padding:8px; font:inherit; background:var(--surface,#fff); color:var(--fg,#222); border:1px solid var(--border,#888); border-radius:6px; }
    [data-chat-file-picker] h2 { margin:0 0 16px; font-size:1.2rem; }
    [data-chat-file-picker] input[type=search] { box-sizing:border-box; width:100%; margin:8px 0; padding:8px; }
    [data-chat-file-picker] .file-options { display:flex; flex-direction:column; gap:12px; max-height:40vh; overflow:auto; margin:16px 0; }
    [data-chat-file-picker] label { display:flex; gap:8px; align-items:center; overflow-wrap:anywhere; }
    [data-chat-file-picker] button { padding:8px 12px; margin:4px; font:inherit; border-radius:6px;
      border:1px solid var(--border,#888); background:var(--surface,#fff); color:var(--fg,#222); cursor:pointer; }
    [data-chat-file-picker] button:disabled { opacity:.55; cursor:default; }
    [data-chat-file-picker] input[type=search] { font:inherit; background:var(--surface,#fff); color:var(--fg,#222); border:1px solid var(--border,#888); border-radius:6px; }
    [data-chat-file-picker] [role=status] { margin:12px 0; }`;
  const heading = doc.createElement('h2'); heading.textContent = title;
  const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  dialog.append(style, heading);
  let closed = false; let resolve!: (value: T | null) => void;
  const result = new Promise<T | null>(done => { resolve = done; });
  const close = (value: T | null = null): void => {
    if (closed) return; closed = true;
    lifetime.abort();
    signal?.removeEventListener('abort', abort);
    dialog.remove();
    if (before?.isConnected) before.focus();
    resolve(value);
  };
  const abort = (): void => close();
  cancel.addEventListener('click', () => close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  // Native search inputs otherwise consume Escape by clearing the query first.
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); close();
  } });
  const show = (): void => {
    if (signal?.aborted) { close(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    dialog.append(cancel); doc.body.append(dialog); dialog.showModal();
  };
  return { dialog, cancel, result, close, show, signal: lifetime.signal, alive: () => !closed };
};

export const openExistingFilePicker = (
  doc: Document, list: ChatFileListCaller, alreadyAttached: readonly string[], signal?: AbortSignal, cloud?: CloudFileCallers, preview?: FilePreviewCallers,
): Promise<FileAttachmentSelection[] | null> => {
  const ui = picker<FileAttachmentSelection[]>(doc, 'Choose from Files', signal);
  const source = doc.createElement('select'); source.setAttribute('aria-label', 'File source');
  const saved = doc.createElement('option'); saved.value = ''; saved.textContent = 'Saved files'; source.append(saved); source.hidden = !cloud;
  const sourceStatus = doc.createElement('p'); sourceStatus.setAttribute('role', 'status'); sourceStatus.hidden = !cloud;
  const sourceRetry = doc.createElement('button'); sourceRetry.type = 'button'; sourceRetry.textContent = 'Reload connected sources'; sourceRetry.hidden = true;
  const query = doc.createElement('input'); query.type = 'search'; query.placeholder = 'Search file names';
  query.setAttribute('aria-label', 'Search file names'); query.maxLength = 200;
  const archivedLabel = doc.createElement('label'); const archived = doc.createElement('input'); archived.type = 'checkbox';
  archivedLabel.append(archived, doc.createTextNode('Show archived files'));
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const note = doc.createElement('p'); note.hidden = true;
  note.textContent = 'Import saves the current download as a copy in Files and adds it to your draft. Later cloud changes will not update it. Closing this picker leaves any saved copies in Files.';
  const options = doc.createElement('div'); options.className = 'file-options';
  const more = doc.createElement('button'); more.type = 'button'; more.textContent = 'Load more files'; more.hidden = true;
  const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.hidden = true;
  const attach = doc.createElement('button'); attach.type = 'button'; attach.textContent = 'Attach selected files'; attach.disabled = true;
  const chosen = doc.createElement('div'); chosen.setAttribute('aria-label', 'Selected files');
  const attachSaved = doc.createElement('button'); attachSaved.type = 'button'; attachSaved.textContent = 'Attach ready files'; attachSaved.hidden = true;
  type Choice = FileAttachmentSelection | CloudFileSelection;
  const idOf = (file: Choice): string => 'file_id' in file ? file.file_id : file.record_id;
  const keyOf = (file: Choice): string => `${idOf(file)}:${file.selection_revision}`;
  const selected = new Map<string, Choice>(); const attached = new Set(alreadyAttached);
  const imported = new Map<string, FileAttachmentSelection>(); const importIds = new Map<string, string>();
  let sources: CloudFileSource[] = []; let sourcesGeneration = 0;
  let generation = 0; let cursor: string | undefined; let failedMore = false; let importing = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const readyFiles = (): FileAttachmentSelection[] => [...selected.values()].flatMap(file => {
    const ready = 'file_id' in file ? file : imported.get(keyOf(file)); return ready ? [ready] : [];
  });
  const controls = (): void => {
    ui.cancel.textContent = importing ? 'Close' : 'Cancel';
    attach.disabled = importing || selected.size === 0;
    const remoteCount = [...selected.values()].filter(file => !('file_id' in file)).length;
    attach.textContent = importing ? 'Importing…' : remoteCount ? `Import and attach ${selected.size} file${selected.size === 1 ? '' : 's'}`
      : selected.size ? `Attach ${selected.size} file${selected.size === 1 ? '' : 's'}` : 'Attach selected files';
    note.hidden = !source.value && remoteCount === 0;
    chosen.replaceChildren();
    for (const [id, file] of selected) {
      const remove = doc.createElement('button'); remove.type = 'button'; remove.textContent = `Remove ${file.filename}`;
      remove.disabled = importing;
      remove.addEventListener('click', () => {
        selected.delete(id); attachSaved.hidden = true;
        for (const checkbox of options.querySelectorAll<HTMLInputElement>('input')) if (checkbox.dataset.fileId === id) checkbox.checked = false;
        controls();
      });
      chosen.append(remove);
    }
    source.disabled = query.disabled = archived.disabled = sourceRetry.disabled = importing;
    for (const checkbox of options.querySelectorAll<HTMLInputElement>('input')) checkbox.disabled = importing || checkbox.dataset.unavailable === 'true';
    for (const button of options.querySelectorAll<HTMLButtonElement>('button')) button.disabled = importing;
    more.disabled = importing; retry.disabled = importing;
  };
  const describeSource = (): void => {
    const current = sources.find(item => item.source_id === source.value);
    sourceStatus.textContent = current ? current.last_synced_at === null ? 'This source has not finished syncing yet.'
      : `Last synced ${new Date(current.last_synced_at).toLocaleString()}${current.stale ? '. This file list may be out of date.' : '.'}`
      : sources.length ? 'Choose a connected source to import a file.' : 'No connected file sources. Connect one in Settings to browse it here.';
  };
  const loadSources = async (): Promise<void> => {
    if (!cloud) return;
    const request = ++sourcesGeneration; sourceRetry.hidden = true; sourceStatus.textContent = 'Loading connected sources…';
    try {
      const result = await cloud.sources();
      if (!ui.alive() || request !== sourcesGeneration) return;
      if (!Array.isArray(result.sources)) throw new Error('This server cannot reach your connected places.');
      sources = result.sources; const previous = source.value; source.replaceChildren(saved);
      for (const item of sources) {
        const option = doc.createElement('option'); option.value = item.source_id;
        option.textContent = item.label; source.append(option);
      }
      source.value = sources.some(item => item.source_id === previous) ? previous : '';
      describeSource();
      if (source.value !== previous) { archivedLabel.hidden = false; controls(); void load(); }
    } catch (error) {
      if (!ui.alive() || request !== sourcesGeneration) return;
      sourceStatus.textContent = error instanceof Error ? error.message : 'Could not load connected sources.'; sourceRetry.hidden = false;
    }
  };
  const load = async (append = false): Promise<void> => {
    const request = ++generation; more.disabled = true; retry.hidden = true; status.textContent = 'Loading files…';
    if (!append) { options.replaceChildren(); cursor = undefined; more.hidden = true; }
    try {
      const response = source.value && cloud
        ? await cloud.list({ source_id: source.value, query: query.value, limit: 30, ...(append && cursor ? { cursor } : {}) })
        : await list({ query: query.value, archived: archived.checked, limit: 30, ...(append && cursor ? { cursor } : {}) });
      if (!ui.alive() || request !== generation || importing) return;
      if (!Array.isArray(response.files)) throw new Error('This server cannot choose from Files.');
      for (const file of response.files) {
        const id = idOf(file); const reason = 'record_id' in file ? file.unavailable_reason : undefined;
        const unavailable = attached.has(id) || !!reason;
        const label = doc.createElement('label'); const checkbox = doc.createElement('input'); checkbox.type = 'checkbox';
        checkbox.checked = selected.has(id) || attached.has(id); checkbox.disabled = unavailable; checkbox.dataset.unavailable = String(unavailable); checkbox.dataset.fileId = id;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selected.set(id, file); else selected.delete(id);
          attachSaved.hidden = true; controls();
        });
        const path = 'record_id' in file && file.path ? ` · ${file.path}` : '';
        const exported = 'record_id' in file && file.export_as ? ` · Saves as ${file.export_as.filename}` : '';
        const size = file.size !== undefined && !exported ? ` · ${file.size.toLocaleString()} bytes` : '';
        label.append(checkbox, doc.createTextNode(`${file.filename}${path}${size}${exported}${attached.has(id) ? ' · Already attached' : reason ? ` · ${reason}` : ''}`));
        const row = doc.createElement('div'); row.append(label);
        if (preview) {
          const inspect = doc.createElement('button'); inspect.type = 'button'; inspect.textContent = 'Preview';
          inspect.setAttribute('aria-label', `Preview ${file.filename}`);
          inspect.addEventListener('click', () => { if (!importing) void openFilePreview(doc,
            { record_id: id, filename: file.filename, selection_revision: file.selection_revision }, preview, ui.signal); });
          row.append(inspect);
        }
        options.append(row);
      }
      cursor = response.next_cursor; more.hidden = !cursor; more.disabled = false;
      status.textContent = options.childElementCount ? source.value ? 'Choose files to import.' : 'Selected files will be added to your draft.'
        : source.value ? 'No matching cloud files. The list updates when the source syncs.' : 'No retained files found.';
    } catch (error) {
      if (!ui.alive() || request !== generation) return;
      status.textContent = error instanceof Error ? error.message : 'Could not load files.';
      failedMore = append; retry.hidden = false; more.hidden = true;
    }
  };
  const importSelected = async (): Promise<void> => {
    if (importing || !selected.size) return;
    if (![...selected.values()].some(file => 'record_id' in file)) { ui.close(readyFiles()); return; }
    importing = true; generation++; clearTimeout(searchTimer); retry.hidden = true; attachSaved.hidden = true; controls();
    const count = selected.size; let completed = 0;
    try {
      for (const file of selected.values()) {
        if (!ui.alive()) return;
        status.textContent = `Saving ${++completed} of ${count}: ${file.filename}…`;
        if ('file_id' in file || imported.has(keyOf(file))) continue;
        if (!cloud) throw new Error('This server cannot reach your connected places.');
        const key = keyOf(file); const import_id = importIds.get(key) ?? globalThis.crypto.randomUUID(); importIds.set(key, import_id);
        const result = await cloud.importFile({ record_id: file.record_id, selection_revision: file.selection_revision, import_id });
        if (!ui.alive()) return;
        if (!result.file_id || !result.selection_revision) throw new Error('The server did not return a saved file. Retry the import.');
        imported.set(key, result);
      }
      ui.close(readyFiles());
    } catch (error) {
      if (!ui.alive()) return;
      const ready = readyFiles().length;
      status.textContent = `${ready} of ${count} files ready to attach. ${error instanceof Error ? error.message : 'Import failed.'} Retry the import or choose another file.`;
      attachSaved.hidden = ready === 0;
    } finally { importing = false; if (ui.alive()) controls(); }
  };
  query.addEventListener('input', () => {
    generation++; clearTimeout(searchTimer); more.hidden = true;
    searchTimer = setTimeout(() => { if (ui.alive()) void load(); }, 150);
  });
  source.addEventListener('change', () => {
    clearTimeout(searchTimer); archivedLabel.hidden = !!source.value;
    query.placeholder = source.value ? 'Search file names and paths' : 'Search file names';
    query.setAttribute('aria-label', query.placeholder); describeSource(); controls(); void load();
  });
  archived.addEventListener('change', () => { clearTimeout(searchTimer); void load(); });
  sourceRetry.addEventListener('click', () => { void loadSources(); });
  more.addEventListener('click', () => { void load(true); });
  retry.addEventListener('click', () => { void load(failedMore); });
  attach.addEventListener('click', () => { void importSelected(); });
  attachSaved.addEventListener('click', () => { if (!importing) ui.close(readyFiles()); });
  ui.dialog.append(source, sourceStatus, sourceRetry, query, archivedLabel, note, status, options, more, retry, chosen, attach, attachSaved); ui.show();
  if (ui.alive()) { query.focus(); void load(); void loadSources(); }
  void ui.result.then(() => { clearTimeout(searchTimer); });
  return ui.result;
};

export const openFileChatPicker = (
  doc: Document, recordId: string, callers: FileChatCallers, signal?: AbortSignal,
): Promise<{ file: FileAttachmentSelection; sessionId: string | null } | null> => {
  const remote = recordId.startsWith('file:remote:');
  const ui = picker<{ file: FileAttachmentSelection; sessionId: string | null }>(doc, remote ? 'Import and use in Chat' : 'Use in Chat', signal);
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const note = doc.createElement('p'); note.hidden = !remote;
  note.textContent = 'Import saves the current download as a copy in Files and adds it to your draft. Later cloud changes will not update it. Closing this picker leaves any saved copies in Files. You choose when to send it.';
  const query = doc.createElement('input'); query.type = 'search'; query.placeholder = 'Find a conversation'; query.setAttribute('aria-label', 'Find a conversation');
  const options = doc.createElement('div'); options.className = 'file-options';
  const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.hidden = true;
  const use = doc.createElement('button'); use.type = 'button'; use.hidden = !remote; use.disabled = true;
  const chosen = doc.createElement('p');
  const inspect = doc.createElement('button'); inspect.type = 'button'; inspect.textContent = 'Preview file'; inspect.hidden = !callers.preview;
  let file: FileAttachmentSelection | CloudFileSelection | undefined;
  let sessions: ReadonlyArray<{ id: string; title: string }> = [];
  let destination: { sessionId: string | null; title: string } | undefined;
  let importing = false; let loading = false; let failedImport = false; let importId: string | undefined;
  const render = (): void => {
    query.disabled = importing || loading;
    retry.disabled = importing || loading;
    ui.cancel.textContent = importing ? 'Close' : 'Cancel';
    use.textContent = importing ? 'Importing…' : failedImport ? 'Retry import' : 'Import and use in Chat';
    use.disabled = importing || loading || !destination || !file || !('record_id' in file) || !!file.unavailable_reason;
    inspect.disabled = importing || loading || !file;
    chosen.hidden = !remote || !destination;
    chosen.textContent = destination ? `Selected conversation: ${destination.title}` : '';
    options.replaceChildren(); if (!file || ('record_id' in file && file.unavailable_reason)) return;
    const target = (title: string, sessionId: string | null): void => {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = title;
      button.disabled = importing || loading;
      if (remote) button.setAttribute('aria-pressed', String(destination?.sessionId === sessionId));
      button.addEventListener('click', () => {
        if (!file || importing || loading) return;
        if ('file_id' in file) ui.close({ file, sessionId });
        else { destination = { sessionId, title }; render(); use.focus(); }
      });
      options.append(button);
    };
    target('New chat', null);
    const needle = query.value.trim().toLocaleLowerCase();
    for (const session of sessions) if (session.title.toLocaleLowerCase().includes(needle) || session.id.includes(needle)) target(session.title || 'Untitled conversation', session.id);
  };
  const load = async (): Promise<void> => {
    if (loading || importing) return;
    loading = true;
    const previous = file; file = undefined; render();
    retry.hidden = true; status.textContent = 'Loading conversations…';
    try {
      const get = remote ? callers.cloud?.get : callers.get;
      if (!get) throw new Error('This server cannot bring in files from other places.');
      const [selection, result] = await Promise.all([get({ record_id: recordId }), callers.sessions()]);
      if (!ui.alive()) return;
      if (!selection.selection_revision || !Array.isArray(result.sessions)
        || (remote ? !('record_id' in selection) || selection.record_id !== recordId : !('file_id' in selection))) {
        throw new Error('This server cannot use it in Chat.');
      }
      if (previous?.selection_revision !== selection.selection_revision) { importId = undefined; failedImport = false; }
      file = selection;
      sessions = result.sessions.filter((session): session is { id: string; title: string } => session !== null && typeof session === 'object'
        && typeof (session as { id?: unknown }).id === 'string' && typeof (session as { title?: unknown }).title === 'string');
      if (destination?.sessionId !== null && destination && !sessions.some(session => session.id === destination!.sessionId)) destination = undefined;
      status.textContent = 'record_id' in file
        ? file.unavailable_reason ?? `${file.filename}${file.path ? ` · ${file.path}` : ''}.${file.export_as ? ` Saves as ${file.export_as.filename}.` : ''} Choose a conversation, then import.`
        : `${file.filename} will be added to the draft. You choose when to send it.`;
    } catch (error) {
      if (!ui.alive()) return;
      file = previous; // Keep receipt recovery available if a metadata reload fails.
      status.textContent = error instanceof Error ? error.message : 'Could not load conversations.';
      retry.textContent = 'Retry'; retry.hidden = false;
    } finally { loading = false; if (ui.alive()) render(); }
  };
  const importFile = async (): Promise<void> => {
    if (importing || loading || !file || !('record_id' in file) || file.unavailable_reason || !destination || !callers.cloud) return;
    const sessionId = destination.sessionId;
    importing = true; retry.hidden = true; render();
    status.textContent = `Saving ${file.export_as?.filename ?? file.filename} for ${destination.title}…`;
    try {
      importId ??= globalThis.crypto.randomUUID();
      const saved = await callers.cloud.importFile({ record_id: file.record_id, selection_revision: file.selection_revision, import_id: importId });
      if (!ui.alive()) return;
      if (!saved.file_id || !saved.selection_revision) throw new Error('The server did not return a saved file. Retry the import.');
      ui.close({ file: saved, sessionId });
    } catch (error) {
      if (!ui.alive()) return;
      failedImport = true;
      status.textContent = `${error instanceof Error ? error.message : 'Import failed.'} Retry to recover this import. If the source file changed, reload it before trying again.`;
      retry.textContent = 'Reload file'; retry.hidden = false;
    } finally { importing = false; if (ui.alive()) render(); }
  };
  query.addEventListener('input', render); retry.addEventListener('click', () => { void load(); });
  use.addEventListener('click', () => { void importFile(); });
  inspect.addEventListener('click', () => { if (file && callers.preview && !importing && !loading) void openFilePreview(doc,
    { record_id: recordId, filename: file.filename, selection_revision: file.selection_revision }, callers.preview, ui.signal); });
  ui.dialog.append(note, status, inspect, query, options, chosen, use, retry); ui.show();
  if (ui.alive()) { query.focus(); void load(); }
  return ui.result;
};
