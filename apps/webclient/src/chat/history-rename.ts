import { CHAT_SESSION_TITLE_MAX_LENGTH, type ChatSessionRenameRequest, type ChatSessionRenameResult, type ChatSessionSummary } from '@recued/contracts';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

const CONTROL = 'data-chat-rename-control';
export const RENAME_SESSION_ATTR = 'data-chat-rename-session';
type Focus = { sessionId: string; control: string; start?: number | null; end?: number | null };

/** One view-local editor. Naming a conversation never changes its composer. */
export const createHistoryRename = (options: {
  document: Document;
  root(): HTMLElement;
  rename(request: ChatSessionRenameRequest): Promise<ChatSessionRenameResult>;
  changed(): void;
  renamed(request: ChatSessionRenameRequest, result: ChatSessionRenameResult): void;
  focusRow(sessionId: string): void;
}) => {
  const doc = options.document;
  let disposed = false;
  let draft: { session: ChatSessionSummary; title: string; pending: boolean; error: string; inputId: string } | null = null;
  const control = (sessionId: string, name: string): HTMLElement | undefined =>
    Array.from(options.root().querySelectorAll<HTMLElement>(`[${CONTROL}]`))
      .find(node => node.getAttribute(RENAME_SESSION_ATTR) === sessionId && node.getAttribute(CONTROL) === name);
  const cancel = (): void => {
    if (!draft || draft.pending) return;
    draft = null; options.changed();
  };
  const save = async (): Promise<void> => {
    const current = draft;
    if (!current || current.pending || disposed) return;
    const title = current.title.trim();
    if (!title || title.length > CHAT_SESSION_TITLE_MAX_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
      current.error = `Enter a chat name on one line, up to ${CHAT_SESSION_TITLE_MAX_LENGTH} characters.`;
      options.changed(); return;
    }
    if (title === current.session.title) { cancel(); return; }
    current.pending = true; current.error = ''; options.changed();
    const request: ChatSessionRenameRequest = { session_id: current.session.id, title, expected_title: current.session.title ?? null };
    try {
      const result = await options.rename(request);
      if (disposed || draft !== current) return;
      if (result?.session_id !== request.session_id || result.title !== title) throw new Error('The new name was not confirmed. Try again.');
      options.renamed(request, result);
      draft = null; options.changed();
    } catch (error) {
      if (disposed || draft !== current) return;
      current.pending = false;
      const code = (error as { code?: string } | null)?.code;
      current.error = code === 'conflict' ? 'This chat was renamed elsewhere. Cancel and open Rename again to use its current name.'
        : code === 'unknown_method' || code === 'not_configured' ? 'Update your Recued server to rename chats.'
          : `Could not rename this chat. ${classifyRpcError(error).copy}`;
      options.changed();
    }
  };
  return {
    session: (): ChatSessionSummary | null => draft?.session ?? null,
    pending: (): boolean => draft?.pending === true,
    open(session: ChatSessionSummary): void {
      if (disposed || draft?.pending) return;
      draft = { session, title: session.title ?? '', pending: false, error: '', inputId: `chat-name-${crypto.randomUUID()}` };
      options.changed();
      const input = control(session.id, 'input') as HTMLInputElement | undefined;
      input?.focus?.({ preventScroll: true }); input?.select?.();
    },
    captureFocus(): Focus | null {
      const active = doc.activeElement as HTMLInputElement | null;
      const name = active?.getAttribute?.(CONTROL);
      const sessionId = active?.getAttribute?.(RENAME_SESSION_ATTR);
      return name && sessionId ? { sessionId, control: name,
        ...(name === 'input' ? { start: active?.selectionStart, end: active?.selectionEnd } : {}) } : null;
    },
    restoreFocus(focus: Focus): void {
      const target = control(focus.sessionId, focus.control) as HTMLInputElement | undefined;
      if (!target) { options.focusRow(focus.sessionId); return; }
      target.focus?.({ preventScroll: true });
      if (focus.control === 'input' && focus.start != null && focus.end != null) target.setSelectionRange?.(focus.start, focus.end);
    },
    mount(host: HTMLElement, sessionId: string): void {
      const current = draft;
      if (!current || current.session.id !== sessionId) return;
      const form = doc.createElement('form'); form.className = 'chat-session-rename'; form.noValidate = true;
      form.setAttribute('aria-label', 'Rename chat'); form.setAttribute('data-chat-rename-editor', sessionId);
      const label = doc.createElement('label'); label.htmlFor = current.inputId; label.textContent = 'Chat name'; form.appendChild(label);
      const input = doc.createElement('input'); input.id = current.inputId; input.type = 'text'; input.value = current.title;
      input.maxLength = CHAT_SESSION_TITLE_MAX_LENGTH; input.required = true; input.readOnly = current.pending; input.autocomplete = 'off';
      const mark = (element: HTMLElement, name: string): void => { element.setAttribute(CONTROL, name); element.setAttribute(RENAME_SESSION_ATTR, sessionId); };
      mark(input, 'input'); form.appendChild(input);
      const error = doc.createElement('p'); error.id = `${current.inputId}-error`; error.setAttribute('role', 'alert');
      error.className = 'chat-history-action-error'; error.textContent = current.error; error.hidden = !current.error;
      if (current.error) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', error.id); }
      input.addEventListener('input', () => {
        if (draft !== current || current.pending) return;
        current.title = input.value; current.error = ''; error.hidden = true; input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
      });
      const actions = doc.createElement('div'); actions.className = 'chat-history-guard-actions';
      const saveButton = doc.createElement('button'); saveButton.type = 'submit'; saveButton.className = 'chat-history-guard-action';
      mark(saveButton, 'save'); saveButton.textContent = current.pending ? 'Saving…' : 'Save';
      saveButton.setAttribute('aria-disabled', String(current.pending));
      if (current.pending) saveButton.setAttribute('aria-busy', 'true');
      saveButton.addEventListener('click', () => saveButton.focus?.({ preventScroll: true }));
      const cancelButton = doc.createElement('button'); cancelButton.type = 'button'; cancelButton.className = 'chat-history-guard-action';
      mark(cancelButton, 'cancel'); cancelButton.textContent = 'Cancel'; cancelButton.disabled = current.pending;
      cancelButton.addEventListener('click', () => { cancelButton.focus?.({ preventScroll: true }); cancel(); });
      actions.append(saveButton, cancelButton); form.append(actions, error);
      form.addEventListener('submit', event => { event.preventDefault(); if (!current.pending) { saveButton.focus?.({ preventScroll: true }); void save(); } });
      form.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } });
      host.appendChild(form);
    },
    dispose(): void { disposed = true; draft = null; },
  };
};

export const CHAT_HISTORY_RENAME_STYLES = `
.chat-session-rename { grid-column: 1 / -1; display: grid; gap: 8px; padding: 10px; border-top: 1px solid var(--border); font-size: 13px; }
.chat-session-rename label { color: var(--muted); }
.chat-session-rename input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 40px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
.chat-session-rename input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chat-session-rename [hidden] { display: none; }
@media (pointer: coarse) { .chat-session-rename input, .chat-session-rename button { min-height: 44px; } }
`;
