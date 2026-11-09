/** D-341 slice A — the switch beside Send: "Don't ask about browser actions".
 *
 *  The owner: *"pre-approve this prompt until next prompt"*, then *"at a point when model is
 *  uncertain that pause and ask user, how should the pre-approval continue"*. Once on, it stays on
 *  for the conversation, shown as on ("Not asking about browser actions, since 10:32"), so a reply
 *  to a question the model asked goes on under it, until the owner turns it off or eight hours pass
 *  (`collection.contract.setRequestPass`). While on, the chat's Browser Toolkit writes run without
 *  asking; the owner's listed sites are still refused, and a secret is still asked for.
 *
 *  One element a conversation, kept across the composer's renders: the route builds its composer
 *  anew each time and places this same element in it. A new chat has no conversation until its first
 *  send, so its switch is held here and set on the server just before that send (`adopt`), which is
 *  how the owner approves the very first request ahead. */

import type { BrowserRequestPass } from '@recued/contracts';

export interface BrowserActionsSwitchCallers {
  readonly get: (args: { session_id: string }) => Promise<{ pass?: BrowserRequestPass }>;
  readonly set: (args: { session_id: string; allow: boolean }) => Promise<{ pass?: BrowserRequestPass }>;
}

export interface BrowserActionsSwitch {
  /** The conversation, or '' for a new chat not yet sent, whose switch is held here until then. */
  readonly session_id: string;
  /** A new chat got its conversation, at its first send: the switch the owner set on the draft is
   *  set on the server before the message goes, so that first request runs under it. */
  adopt(session_id: string): Promise<void>;
  readonly element: HTMLElement;
  /** Read the conversation's state again (after a turn: an ask may have changed it). */
  refresh(): Promise<void>;
  /** Read it again when the last read is older than `ms`: the composer's renders call it, so an
   *  ask's "Don't ask about browser actions in this chat" shows here soon after. */
  refreshIfOlder(ms: number): void;
  /** A message is going with the switch off here: it ends a request approved ahead that another
   *  device may have turned on since this one last read it, so the message runs as the owner sees. */
  endIfOff(session_id: string): Promise<void>;
  dispose(): void;
}

export const BROWSER_ACTIONS_SWITCH_ATTR = 'data-recued-browser-actions-switch';
/** How long a new chat's first send waits for its switch to be set on the server. Past it, the
 *  message goes, and its request asks as it would with the switch off: the safe side. */
export const BROWSER_ACTIONS_ADOPT_WAIT_MS = 5_000;

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const mountBrowserActionsSwitch = (opts: {
  readonly document: Document;
  readonly session_id: string;
  readonly callers: BrowserActionsSwitchCallers;
  /** Injectable for a test: how a start time is shown. */
  readonly formatTime?: (ms: number) => string;
  readonly now?: () => number;
}): BrowserActionsSwitch => {
  const now = opts.now ?? Date.now;
  let lastRead = 0;
  let session_id = opts.session_id;
  /** A new chat's switch, before it has a conversation. */
  let draftAllow = false;
  const doc = opts.document;
  const formatTime = opts.formatTime ?? timeOf;
  const wrap = doc.createElement('div');
  wrap.className = 'chat-browser-actions';
  wrap.setAttribute(BROWSER_ACTIONS_SWITCH_ATTR, opts.session_id);
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'chat-browser-actions-switch';
  const status = doc.createElement('span');
  status.className = 'chat-browser-actions-status';
  status.setAttribute('role', 'status');
  wrap.appendChild(button);
  wrap.appendChild(status);
  // Hidden until the server says what it is: a server from before the switch has no method for it.
  wrap.hidden = true;

  let pass: BrowserRequestPass | undefined;
  let busy = false;
  let disposed = false;
  const show = (): void => {
    if (disposed) return;
    const on = pass !== undefined || (session_id === '' && draftAllow);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.textContent = pass !== undefined ? `Not asking about browser actions, since ${formatTime(pass.started_at)}`
      : on ? 'Not asking about browser actions' : 'Don’t ask about browser actions';
    button.title = pass !== undefined
      ? `Until you turn this off, or until ${formatTime(pass!.expires_at)}. Your listed sites are still refused, `
        + 'and a password or a code is still asked for.'
      : 'Let this conversation act in your browser without asking, until you turn this off, for up to 8 hours.';
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  };
  const say = (text: string): void => { status.textContent = text; };
  /** True once the server answered. */
  const settle = async (run: () => Promise<{ pass?: BrowserRequestPass }>): Promise<boolean> => {
    try {
      const answer = await run();
      pass = answer.pass;
      wrap.hidden = false;
      say('');
      return true;
    } catch {
      if (!wrap.hidden) say('Recued could not change it. Try again.');
      return false;
    }
  };
  button.addEventListener('click', () => {
    if (busy || disposed) return;
    if (session_id === '') {
      draftAllow = !draftAllow;
      show();
      return;
    }
    busy = true;
    show();
    const allow = pass === undefined;
    void settle(() => opts.callers.set({ session_id, allow })).finally(() => {
      busy = false;
      show();
    });
  });
  const refresh = async (): Promise<void> => {
    if (session_id === '') return;
    lastRead = now();
    await settle(() => opts.callers.get({ session_id }));
    show();
  };
  // A new chat's switch shows at once; whether the server has the switch is learned at its send.
  if (session_id === '') wrap.hidden = false;
  show();
  void refresh();
  return {
    get session_id() { return session_id; },
    adopt: async (next) => {
      if (session_id !== '' || disposed) return;
      session_id = next;
      wrap.setAttribute(BROWSER_ACTIONS_SWITCH_ATTR, next);
      lastRead = now();
      // Left off on the draft, the send waits for nothing: the conversation is read beside it.
      if (!draftAllow) {
        void settle(() => opts.callers.get({ session_id: next })).then(show);
        return;
      }
      draftAllow = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), BROWSER_ACTIONS_ADOPT_WAIT_MS); });
      const answered = await Promise.race([settle(() => opts.callers.set({ session_id: next, allow: true })), late]);
      clearTimeout(timer);
      // A server without the switch: it goes, as on a conversation that never had one.
      if (!answered) {
        say('');
        wrap.hidden = true;
      }
      show();
    },
    element: wrap,
    refresh,
    endIfOff: async (sending) => {
      if (disposed || sending !== session_id || session_id === '' || pass !== undefined || wrap.hidden) return;
      await opts.callers.set({ session_id, allow: false }).catch(() => undefined);
    },
    refreshIfOlder: (ms) => {
      if (!busy && !disposed && now() - lastRead >= ms) void refresh();
    },
    dispose: () => {
      disposed = true;
      wrap.remove?.();
    },
  };
};

/** Self-scoped CSS, for the chat route's style bundle. */
export const BROWSER_ACTIONS_SWITCH_STYLES = `
.chat-browser-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 6px;
  font-size: 12px;
}
.chat-browser-actions-switch {
  min-width: 0;
  font: inherit;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.chat-browser-actions-switch[aria-pressed="true"] {
  border-color: var(--accent, var(--border));
  color: var(--fg);
}
.chat-browser-actions-status {
  color: var(--danger);
}
`;
