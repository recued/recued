import type { ConversationFile, ConversationFileListRequest, ConversationFileListResult, FileAttachmentSelection } from '@recued/contracts';
import { serializeChatAnswerAddress, serializeSourceRecordAddress } from '../shell/route.js';
import { renderFileCloudCapture } from '../data/file-cloud-capture.js';
import { openFilePreview, type FilePreviewCallers } from '../files/file-preview.js';

export type ConversationFilesCaller = (args: ConversationFileListRequest) => Promise<ConversationFileListResult>;
export interface ConversationFilesDeps {
  document: Document;
  list: ConversationFilesCaller;
  select: (args: { record_id: string }) => Promise<FileAttachmentSelection>;
  canAttach: (sessionId: string) => boolean;
  attach: (sessionId: string, file: FileAttachmentSelection) => void;
  showMessage: (sessionId: string, messageId: string) => void;
  returnFocus: () => void;
  preview?: FilePreviewCallers;
}

/** The dialog has its own DOM lifetime, so thread streaming cannot rebuild it. */
export const createConversationFilesView = (deps: ConversationFilesDeps) => {
  const doc = deps.document;
  let current: { sessionId: string; refresh: () => void; close: () => void; reconcile: () => void } | null = null;
  const close = (): void => current?.close();
  const open = (sessionId: string): void => {
    close();
    const lifetime = new AbortController();
    const dialog = doc.createElement('dialog');
    dialog.setAttribute('aria-label', 'Conversation files');
    dialog.setAttribute('data-conversation-files', '');
    const style = doc.createElement('style');
    style.textContent = `dialog[data-conversation-files] { width:min(640px,94vw); max-height:85vh; box-sizing:border-box;
      padding:20px; border:1px solid var(--border,#666); border-radius:12px; background:var(--surface,#fff);
      color:var(--fg,#222); font:14px/1.45 system-ui,sans-serif; }
      dialog[data-conversation-files]::backdrop { background:#0006; }
      [data-conversation-files] h2 { margin:0 0 12px; font-size:1.2rem; }
      [data-conversation-files] .conversation-file-filters { display:flex; flex-wrap:wrap; gap:8px; }
      [data-conversation-files] input { flex:1; min-width:160px; }
      [data-conversation-files] input,[data-conversation-files] select,[data-conversation-files] button { padding:8px;
        font:inherit; color:var(--fg,#222); background:var(--surface,#fff); border:1px solid var(--border,#888); border-radius:6px; }
      [data-conversation-files] button { cursor:pointer; } [data-conversation-files] button:disabled { opacity:.55; cursor:default; }
      [data-conversation-file-list] { max-height:48vh; overflow:auto; padding:0; list-style:none; }
      [data-conversation-file-list] li { padding:12px 0; border-bottom:1px solid var(--border,#ddd); overflow-wrap:anywhere; }
      [data-conversation-file-list] p { margin:4px 0 8px; }
      [data-conversation-file-list] a { color:var(--accent,#3564cc); }
      [data-conversation-file-list] .conversation-file-actions { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
      [data-conversation-files] footer { display:flex; gap:8px; flex-wrap:wrap; }
      [data-conversation-files] [role=alert] { color:var(--danger,#b3261e); }`;
    const heading = doc.createElement('h2'); heading.textContent = 'Conversation files';
    const description = doc.createElement('p'); description.textContent = 'Files shared in this conversation, including older messages and Messenger attachments.';
    const filters = doc.createElement('div'); filters.className = 'conversation-file-filters';
    const query = doc.createElement('input'); query.type = 'search'; query.placeholder = 'Search file names'; query.maxLength = 200;
    query.setAttribute('aria-label', 'Search conversation file names');
    const type = doc.createElement('select'); type.setAttribute('aria-label', 'File type');
    for (const [value, label] of [['', 'All file types'], ['document', 'Documents'], ['image', 'Images'], ['voice', 'Audio'], ['other', 'Other files']]) {
      const option = doc.createElement('option'); option.value = value!; option.textContent = label!; type.append(option);
    }
    filters.append(query, type);
    const status = doc.createElement('p'); status.setAttribute('role', 'status');
    const error = doc.createElement('p'); error.setAttribute('role', 'alert'); error.hidden = true;
    const list = doc.createElement('ul'); list.setAttribute('data-conversation-file-list', '');
    const footer = doc.createElement('footer');
    const more = doc.createElement('button'); more.type = 'button'; more.textContent = 'Load more files'; more.hidden = true;
    const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh files';
    const done = doc.createElement('button'); done.type = 'button'; done.textContent = 'Close';
    footer.append(more, refresh, done); dialog.append(style, heading, description, filters, status, error, list, footer);
    let alive = true; let generation = 0; let cursor: string | undefined;
    let files: ConversationFile[] = []; let selecting: string | null = null;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    const showError = (failure: unknown): void => {
      error.textContent = failure instanceof Error ? failure.message : 'Could not load conversation files. Try again.';
      error.hidden = false;
    };
    const finish = (): void => {
      if (!alive) return; alive = false; generation++; clearTimeout(searchTimer);
      lifetime.abort();
      dialog.remove(); current = null; deps.returnFocus();
    };
    const reconcile = (): void => {
      const available = new Set(files.filter(file => file.availability === 'available').map(file => file.file_id));
      const allowed = selecting === null && deps.canAttach(sessionId);
      for (const button of list.querySelectorAll<HTMLButtonElement>('button[data-file-action="attach"]')) {
        button.disabled = !allowed || !available.has(button.getAttribute('data-file-id')!);
      }
    };
    const renderFiles = (): void => {
      const focused = doc.activeElement as HTMLElement | null;
      const focusId = focused?.getAttribute('data-file-id'); const focusAction = focused?.getAttribute('data-file-action');
      list.replaceChildren();
      const identify = (element: HTMLElement, file: ConversationFile, action: string): void => {
        element.setAttribute('data-file-id', file.file_id); element.setAttribute('data-file-action', action);
      };
      for (const file of files) {
        const row = doc.createElement('li'); row.setAttribute('data-conversation-file', file.file_id);
        const name = doc.createElement('strong'); name.textContent = file.filename; row.append(name);
        const details = doc.createElement('p');
        const availability = file.availability === 'deleted' ? 'File deleted' : file.availability === 'missing' ? 'Recued cannot get that file' : file.archived ? 'Archived' : null;
        details.textContent = [file.mime_type, `${file.size.toLocaleString()} bytes`,
          file.version_count > 1 ? `Version ${file.version_number} of ${file.version_count}` : null,
          `${file.message_count} message${file.message_count === 1 ? '' : 's'}`,
          `Last shared ${new Date(file.last_message_at).toLocaleString()}`, availability,
          file.legacy_capture ? 'Original version unverified' : null].filter(Boolean).join(' · ');
        row.append(details);
        row.insertAdjacentHTML('beforeend', renderFileCloudCapture(file.cloud_capture));
        const actions = doc.createElement('div'); actions.className = 'conversation-file-actions';
        const message = doc.createElement('a'); message.textContent = file.message_count > 1 ? 'Show latest message' : 'Show message';
        message.href = serializeChatAnswerAddress({ sessionId, messageId: file.last_message_id }); identify(message, file, 'message');
        message.addEventListener('click', event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          event.preventDefault(); finish(); deps.showMessage(sessionId, file.last_message_id);
        });
        actions.append(message);
        if (file.availability === 'available') {
          if (deps.preview) {
            const preview = doc.createElement('button'); preview.type = 'button'; preview.textContent = 'Preview'; identify(preview, file, 'preview');
            preview.setAttribute('aria-label', `Preview ${file.filename}`);
            preview.addEventListener('click', () => { void openFilePreview(doc,
              { record_id: file.file_id, filename: file.filename }, deps.preview!, lifetime.signal).then(() => {
                if (!alive) return;
                // Live session updates may have replaced the invoking row.
                const current = Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-file-action="preview"]'))
                  .find(button => button.getAttribute('data-file-id') === file.file_id);
                (current ?? query).focus({ preventScroll: true });
              }); }); actions.append(preview);
          }
          const data = doc.createElement('a'); data.textContent = 'Open in Data'; identify(data, file, 'data');
          data.href = serializeSourceRecordAddress({ tab: 'files', collectionSlug: 'received', recordId: file.file_id,
            returnToChat: { sessionId, messageId: file.last_message_id } }); actions.append(data);
        }
        const attach = doc.createElement('button'); attach.type = 'button'; identify(attach, file, 'attach');
        attach.textContent = selecting === file.file_id ? 'Adding…' : 'Attach again';
        attach.disabled = selecting !== null || file.availability !== 'available' || !deps.canAttach(sessionId);
        attach.addEventListener('click', () => {
          if (selecting !== null || !deps.canAttach(sessionId)) return;
          selecting = file.file_id; error.hidden = true; renderFiles();
          void deps.select({ record_id: file.file_id }).then(selection => {
            if (!alive) return;
            if (!deps.canAttach(sessionId)) throw new Error('Wait for the message being sent, then attach this file again.');
            if (selection.file_id !== file.file_id || !selection.selection_revision) throw new Error('This server cannot reuse that retained version. Refresh and try again.');
            finish(); deps.attach(sessionId, selection);
          }).catch(failure => { if (alive) showError(failure); })
            .finally(() => { if (alive) { selecting = null; renderFiles(); } });
        });
        actions.append(attach); row.append(actions); list.append(row);
      }
      if (focusId && focusAction) {
        Array.from(list.querySelectorAll<HTMLElement>('[data-file-id]')).find(element =>
          element.getAttribute('data-file-id') === focusId && element.getAttribute('data-file-action') === focusAction)?.focus({ preventScroll: true });
      }
    };
    const load = async (append = false): Promise<void> => {
      const request = ++generation; more.disabled = true; error.hidden = true; status.textContent = 'Loading files…';
      if (!append) { cursor = undefined; more.hidden = true; }
      try {
        const result = await deps.list({ session_id: sessionId, query: query.value,
          ...(type.value ? { media_class: type.value as NonNullable<ConversationFileListRequest['media_class']> } : {}),
          limit: 30, ...(append && cursor ? { cursor } : {}) });
        if (!alive || request !== generation) return;
        if (!result || !Array.isArray(result.files)) throw new Error('This server cannot keep files with a chat.');
        files = append ? [...new Map([...files, ...result.files].map(file => [file.file_id, file])).values()] : result.files;
        cursor = result.next_cursor; more.hidden = !cursor; more.disabled = false;
        renderFiles();
        status.textContent = files.length ? `${files.length} retained version${files.length === 1 ? '' : 's'} shown${cursor ? ' · More files available' : ''}.`
          : query.value.trim() || type.value ? 'No files match these filters.' : 'No files have been shared in this conversation.';
      } catch (failure) {
        if (!alive || request !== generation) return;
        showError(failure); status.textContent = files.length ? 'Showing the last loaded files.' : 'Files could not be loaded.';
        more.disabled = false;
      }
    };
    query.addEventListener('input', () => {
      generation++; clearTimeout(searchTimer); cursor = undefined; more.hidden = true; files = []; renderFiles();
      searchTimer = setTimeout(() => { if (alive) void load(); }, 150);
    });
    type.addEventListener('change', () => { clearTimeout(searchTimer); files = []; renderFiles(); void load(); });
    more.addEventListener('click', () => { void load(true); });
    refresh.addEventListener('click', () => { clearTimeout(searchTimer); void load(); });
    done.addEventListener('click', finish);
    // Search inputs consume native Escape to clear their text. This dialog owns
    // Escape consistently even while a filename filter has focus.
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); finish(); }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
    current = { sessionId, refresh: () => { clearTimeout(searchTimer); void load(); }, close: finish, reconcile };
    doc.body.append(dialog); dialog.showModal(); query.focus(); void load();
  };
  return { open, close, reconcile: () => current?.reconcile(),
    refresh: (sessionId: string) => { if (current?.sessionId === sessionId) current.refresh(); }, dispose: close };
};
