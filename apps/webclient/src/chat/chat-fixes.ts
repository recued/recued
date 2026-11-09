/** D-346 follow-up (2026-11-08) — what an answer's calls could not do and how the owner fixes
 *  it, under the answer: the run dialog's fixes (reconnect, set up, a program's page, a program
 *  switched off) and the owner's own switches that refused a call ("'mail.search' is turned off
 *  for you"). The owner's ruling: show the run dialog's fixes in chat, the way install offers
 *  already are.
 *
 *  The fixes come from a typed field the server stamped from the turn's own tool results
 *  (`ChatMessage.fixes`), never from the model's text, and are checked again here with the
 *  shared reader. A switch is turned on from here in one click ("Turn it on"): the owner's own
 *  switch, in the owner's own chat, which the button names. Anything else links to the page
 *  that fixes it. */
import {
  OWNER_CONTRACT_ID,
  chatFixesOf,
  type ChatFix,
  type ChatMessage,
} from '@recued/contracts';

import { runNeedStep, type ProgramSwitchSet } from '../shell/run-needs-offer.js';
import { serializeShellRoute } from '../shell/route.js';

/** Marks the fixes under an answer — what a host or a drive asserts on. */
export const CHAT_FIXES_ATTR = 'data-chat-fixes';
/** On each "Turn it on" button: the fix's key. */
export const CHAT_FIX_ACTION_ATTR = 'data-chat-fix-action';

/** How the chat turns a switch on: the owner's own grant (`contract.grant.write`) and a
 *  program's (`cli.reachability.set`). Set once by the webclient's composition. */
export interface ChatFixActions {
  readonly grant: (entry_key: string) => Promise<void>;
  readonly program: ProgramSwitchSet;
}

let actions: ChatFixActions | null = null;

/** Null leaves every fix a link. */
export const setChatFixActions = (next: ChatFixActions | null): void => {
  actions = next;
};

/** One fix as drawn: what happened, where to go, and the one-click fix when there is one. */
export interface ChatFixRow {
  readonly key: string;
  readonly lead: string;
  readonly link: { readonly text: string; readonly href: string } | null;
  readonly action?: { readonly text: string; readonly run: () => Promise<void>; readonly done: string };
}

const keyOf = (fix: ChatFix): string =>
  fix.kind === 'switch'
    ? `grant:${fix.entry_key}`
    : fix.need.kind === 'switch'
      ? `program:${fix.need.ingredient_id}:${fix.need.operation_id}`
      : `${fix.need.kind}:${fix.need.step_id}`;

/** The rows an answer offers: none for any message but an answer, or with nothing stamped. */
export const chatFixRows = (message: Pick<ChatMessage, 'role' | 'fixes'>): ChatFixRow[] => {
  if (message.role !== 'assistant') return [];
  const can = actions;
  return chatFixesOf(message.fixes).map((fix): ChatFixRow => {
    const key = keyOf(fix);
    if (fix.kind === 'switch') {
      return {
        key,
        lead: `${fix.label} is turned off for you.`,
        link: { text: 'Open Self (you)', href: serializeShellRoute('contracts', OWNER_CONTRACT_ID) },
        ...(can !== null
          ? { action: { text: 'Turn it on', run: () => can.grant(fix.entry_key), done: `${fix.label} is on now. Ask again.` } }
          : {}),
      };
    }
    const step = runNeedStep(fix.need);
    const need = fix.need;
    return {
      key,
      lead: step.lead,
      link: step.link,
      ...(can !== null && need.kind === 'switch'
        ? {
            action: {
              text: 'Turn it on',
              run: () => can.program({ ingredient_id: need.ingredient_id, operation_id: need.operation_id }),
              done: `${need.label !== undefined ? `${need.label}'s program` : 'The program'} is on now. Ask again.`,
            },
          }
        : {}),
    };
  });
};

/** Where each one-click fix stands, by message and fix, so a repaint keeps it. */
const status = new Map<string, { state: 'running' | 'done' | 'failed'; error?: string }>();

/** Draw the fixes. `messageId` scopes each fix's state; `repaint` redraws once one settles. */
export const buildChatFixes = (
  doc: Document,
  messageId: string,
  rows: readonly ChatFixRow[],
  repaint: () => void,
): HTMLElement => {
  const root = doc.createElement('div');
  root.className = 'chat-fixes';
  root.setAttribute(CHAT_FIXES_ATTR, '');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'What this needed');
  for (const row of rows) {
    const item = doc.createElement('div');
    item.className = 'chat-fix';
    const at = status.get(`${messageId}\u0000${row.key}`);
    // Once turned on, the line says so in place of what was off (live, 2026-11-08: "… is turned
    // off for you." stood above "It is on now.").
    const done = row.action !== undefined && at?.state === 'done';
    const lead = doc.createElement('p');
    lead.className = done ? 'chat-fix-lead chat-fix-done' : 'chat-fix-lead';
    if (done) lead.setAttribute('role', 'status');
    lead.textContent = done ? row.action!.done : row.lead;
    item.appendChild(lead);
    const controls = doc.createElement('div');
    controls.className = 'chat-fix-controls';
    if (row.action !== undefined) {
      if (!done) {
        const button = doc.createElement('button');
        button.className = 'chat-fix-button';
        button.setAttribute('type', 'button');
        button.setAttribute(CHAT_FIX_ACTION_ATTR, row.key);
        button.textContent = row.action.text;
        if (at?.state === 'running') button.setAttribute('disabled', '');
        const run = row.action.run;
        button.addEventListener('click', () => {
          const id = `${messageId}\u0000${row.key}`;
          if (status.get(id)?.state === 'running') return;
          status.set(id, { state: 'running' });
          repaint();
          void run().then(
            () => { status.set(id, { state: 'done' }); repaint(); },
            (err: unknown) => {
              status.set(id, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
              repaint();
            },
          );
        });
        controls.appendChild(button);
      }
    }
    if (row.link !== null && at?.state !== 'done') {
      const anchor = doc.createElement('a');
      anchor.className = 'chat-fix-link';
      anchor.href = row.link.href;
      anchor.textContent = row.link.text;
      controls.appendChild(anchor);
    }
    item.appendChild(controls);
    if (at?.state === 'failed' && at.error !== undefined) {
      const error = doc.createElement('p');
      error.className = 'chat-fix-error';
      error.setAttribute('role', 'alert');
      error.textContent = at.error;
      item.appendChild(error);
    }
    root.appendChild(item);
  }
  return root;
};

/** Test seam: forget every fix's state. */
export const __resetChatFixStatus = (): void => {
  status.clear();
};

export const CHAT_FIXES_STYLES = `
.chat-fixes { display: grid; gap: 8px; margin-top: 8px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 0.5rem; background: var(--surface-sunk); color: var(--fg); }
.chat-fix { display: grid; gap: 6px; min-width: 0; }
.chat-fix-lead { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.chat-fix-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.chat-fix-button { font: inherit; font-size: 13px; font-weight: 600; padding: 4px 10px; border-radius: 0.375rem;
  border: 1px solid var(--border); background: var(--surface); color: var(--fg); cursor: pointer; }
.chat-fix-button[disabled] { opacity: 0.6; cursor: progress; }
.chat-fix-link { font-size: 13px; font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
.chat-fix-link:hover, .chat-fix-link:focus-visible { text-decoration: underline; }
.chat-fix-done { font-size: 13px; color: var(--muted); }
.chat-fix-error { margin: 0; font-size: 12px; color: var(--danger, var(--fg)); overflow-wrap: anywhere; }
`;
