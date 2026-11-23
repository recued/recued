/** D-405 slice 3 — "Not now" on a hint under a chat answer. The owner's ruling (P3): a hint is never
 *  noise, and "Not now" on one is remembered per hint for a while (`CHAT_HINT_NOT_NOW_DAYS`).
 *
 *  A hint is a thing to add, a pack's setup, a feature to connect, a pack or a recipe to get: each row
 *  of those (`chat-fixes.ts`, `install-offers.ts`) offers "Not now". The server keeps the list, so the
 *  hint stays aside on every device and in what the model reads; here the row says it is set aside,
 *  until when, and offers to show it again.
 *
 *  A server without "Not now" never answers `chat.hints.list`: then no row offers it. */
import { chatHintsNotNowOf, type ChatHintNotNow } from '@recued/contracts';

/** On each "Not now" button: the hint's key. */
export const CHAT_HINT_NOT_NOW_ATTR = 'data-chat-hint-not-now';
/** On a hint set aside, in place of it: its key. */
export const CHAT_HINT_SET_ASIDE_ATTR = 'data-chat-hint-set-aside';
/** On each "Show it again" button: the hint's key. */
export const CHAT_HINT_RESTORE_ATTR = 'data-chat-hint-restore';

/** How the app reads and changes the list (`chat.hints.*`). Set once by the webclient's composition. */
export interface ChatHintActions {
  readonly list: () => Promise<{ readonly not_now?: unknown } | undefined>;
  readonly notNow: (key: string, label: string) => Promise<unknown>;
  readonly restore: (key: string) => Promise<unknown>;
}

/** A hint under an answer: its key (`chatHintKeyOfFix` / `chatHintKeyOfOffer`) and its link as shown. */
export interface ChatHint {
  readonly key: string;
  readonly label: string;
}

let actions: ChatHintActions | null = null;
/** The hints set aside, by key; null until the server said. */
let setAside: Map<string, ChatHintNotNow> | null = null;
let loading = false;
/** A "Not now" or a "Show it again" on its way, or the error it met, by key. */
const status = new Map<string, { readonly state: 'running' } | { readonly state: 'failed'; readonly error: string }>();

/** Null takes "Not now" off every row. */
export const setChatHintActions = (next: ChatHintActions | null): void => {
  actions = next;
  setAside = null;
  loading = false;
  status.clear();
};

/** Ask the server which hints are set aside, and `repaint` once it has said. Asked again at each mount
 *  of the chat: another device may have changed them. */
export const loadChatHints = (repaint: () => void): void => {
  const can = actions;
  if (can === null || loading) return;
  loading = true;
  void can.list().then(
    (answer) => {
      if (actions !== can) return;
      setAside = new Map(chatHintsNotNowOf(answer?.not_now).map((row) => [row.key, row]));
      repaint();
    },
    () => { /* A server without "Not now": no row offers it. */ },
  ).finally(() => { if (actions === can) loading = false; });
};

/** The hint as set aside now, or undefined: one past its time has come back. */
export const chatHintSetAside = (key: string, now: number = Date.now()): ChatHintNotNow | undefined => {
  const row = setAside?.get(key);
  return row !== undefined && row.until > now ? row : undefined;
};

/** Whether a row may offer "Not now": the server answered that it keeps them. */
export const chatHintsOffered = (): boolean => actions !== null && setAside !== null;

/** Why the last "Not now" or "Show it again" on this hint failed, if it did. */
export const chatHintError = (key: string): string | undefined => {
  const at = status.get(key);
  return at?.state === 'failed' ? at.error : undefined;
};

/** "19 December": the day a hint set aside comes back, in the owner's own way of writing dates. */
export const chatHintUntilText = (until: number): string =>
  new Date(until).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The "Not now" button beside a hint's link. */
export const buildChatHintNotNow = (doc: Document, hint: ChatHint, repaint: () => void): HTMLElement => {
  const button = doc.createElement('button');
  button.className = 'chat-fix-button chat-hint-not-now';
  button.setAttribute('type', 'button');
  button.setAttribute(CHAT_HINT_NOT_NOW_ATTR, hint.key);
  button.textContent = 'Not now';
  if (status.get(hint.key)?.state === 'running') button.setAttribute('disabled', '');
  button.addEventListener('click', () => {
    const can = actions;
    if (can === null || status.get(hint.key)?.state === 'running') return;
    status.set(hint.key, { state: 'running' });
    repaint();
    void can.notNow(hint.key, hint.label).then(
      (answer) => {
        status.delete(hint.key);
        const [row] = chatHintsNotNowOf([answer]);
        if (row !== undefined) (setAside ??= new Map()).set(row.key, row);
        repaint();
      },
      (err: unknown) => {
        status.set(hint.key, { state: 'failed', error: messageOf(err) });
        repaint();
      },
    );
  });
  return button;
};

/** A hint set aside, in its place: what it was, until when, and "Show it again". */
export const buildChatHintSetAside = (doc: Document, row: ChatHintNotNow, repaint: () => void): HTMLElement => {
  const item = doc.createElement('div');
  item.className = 'chat-fix chat-hint-set-aside';
  item.setAttribute(CHAT_HINT_SET_ASIDE_ATTR, row.key);
  const said = doc.createElement('p');
  said.className = 'chat-fix-lead chat-fix-done';
  said.textContent = `Not now: “${row.label}” is hidden until ${chatHintUntilText(row.until)}.`;
  item.appendChild(said);
  const controls = doc.createElement('div');
  controls.className = 'chat-fix-controls';
  const button = doc.createElement('button');
  button.className = 'chat-fix-button';
  button.setAttribute('type', 'button');
  button.setAttribute(CHAT_HINT_RESTORE_ATTR, row.key);
  button.textContent = 'Show it again';
  if (status.get(row.key)?.state === 'running') button.setAttribute('disabled', '');
  button.addEventListener('click', () => {
    const can = actions;
    if (can === null || status.get(row.key)?.state === 'running') return;
    status.set(row.key, { state: 'running' });
    repaint();
    void can.restore(row.key).then(
      () => {
        status.delete(row.key);
        setAside?.delete(row.key);
        repaint();
      },
      (err: unknown) => {
        status.set(row.key, { state: 'failed', error: messageOf(err) });
        repaint();
      },
    );
  });
  controls.appendChild(button);
  item.appendChild(controls);
  const error = chatHintError(row.key);
  if (error !== undefined) item.appendChild(buildChatHintErrorLine(doc, error));
  return item;
};

/** The line saying why "Not now" or "Show it again" failed. */
export const buildChatHintErrorLine = (doc: Document, error: string): HTMLElement => {
  const line = doc.createElement('p');
  line.className = 'chat-fix-error';
  line.setAttribute('role', 'alert');
  line.textContent = error;
  return line;
};
