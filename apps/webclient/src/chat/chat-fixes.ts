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
  chatHintKeyOfFix,
  chatNextStepKey,
  featureStepWords,
  sourceStepWords,
  thingPageSetupOf,
  thingStepWords,
  type ChatFix,
  type ChatMessage,
} from '@recued/contracts';

import { runNeedStep, type ProgramSwitchSet } from '../shell/run-needs-offer.js';
import { serializeShellRoute } from '../shell/route.js';
import {
  buildChatHintErrorLine,
  buildChatHintNotNow,
  buildChatHintSetAside,
  chatHintError,
  chatHintSetAside,
  chatHintsOffered,
  type ChatHint,
} from './chat-hints.js';

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

/** One fix as drawn: what happened, where to go, and the one-click fix when there is one.
 *  `landed` (D-404 slice B1): its step is done, as the server read it (a thing now in Yours). */
export interface ChatFixRow {
  readonly key: string;
  readonly lead: string;
  readonly link: { readonly text: string; readonly href: string } | null;
  readonly action?: { readonly text: string; readonly run: () => Promise<void>; readonly done: string };
  readonly landed?: true;
  /** D-405 slice 3 — a hint (a thing to add, a pack's setup, a feature to connect): "Not now" on it. */
  readonly hint?: ChatHint;
}

const keyOf = (fix: ChatFix): string =>
  fix.kind === 'feature'
    ? `feature:${fix.feature}`
    : fix.kind === 'source'
    ? `source:${fix.pack_slug}`
    : fix.kind === 'thing'
    ? `thing:${fix.type_id}`
    : fix.kind === 'switch'
      ? `grant:${fix.entry_key}`
      : fix.need.kind === 'switch'
        ? `program:${fix.need.ingredient_id}:${fix.need.operation_id}`
        : `${fix.need.kind}:${fix.need.step_id}`;

/** The rows an answer offers: none for any message but an answer, or with nothing stamped.
 *  `landed` holds the keys (`chatNextStepKey`) of its steps the server says are done. */
export const chatFixRows = (
  message: Pick<ChatMessage, 'role' | 'fixes'> & Partial<Pick<ChatMessage, 'id' | 'session_id'>>,
  landed: ReadonlySet<string> = new Set(),
): ChatFixRow[] => {
  if (message.role !== 'assistant') return [];
  const can = actions;
  return chatFixesOf(message.fixes).map((fix): ChatFixRow => {
    const key = keyOf(fix);
    // D-404 step 4 — a thing with no readings yet, and the installed pack that feeds them: its page,
    // where its setup is, carrying this answer so the page offers the way back. D-339 slice 23: a pack set up on
    // the thing's own page (a Body's Connect Apple Health) opens that form there instead (`#yours/asset/<id>/setup/<pack>`).
    if (fix.kind === 'source') {
      const onPage = thingPageSetupOf(fix);
      const words = sourceStepWords(fix.thing_name, fix.pack_name, onPage);
      const back = message.session_id !== undefined && message.id !== undefined ? ['return', 'chat', message.session_id, message.id] : [];
      const href = onPage !== undefined && fix.thing_id !== undefined
        ? serializeShellRoute('yours', 'asset', fix.thing_id, 'setup', fix.pack_slug, ...back)
        : serializeShellRoute('packs', fix.pack_slug, ...back);
      return { key, lead: words.lead, link: { text: words.link, href }, hint: { key: chatHintKeyOfFix(fix)!, label: words.link } };
    }
    // D-405 slice 2 — one of the owner's core features with none connected: its lane on the Connections
    // page, where the owner connects one. Once one is, the line says so and the block offers Ask again.
    if (fix.kind === 'feature') {
      const words = featureStepWords(fix.feature);
      if (landed.has(chatNextStepKey({ kind: 'feature', id: fix.feature }))) return { key, lead: words.landed, link: null, landed: true };
      // D-405 slice 7 — the link carries this answer, so the page offers "Back to chat" (and the first
      // mailbox's Proposals do too), back to this line saying one is connected.
      const back = message.session_id !== undefined && message.id !== undefined ? ['return', 'chat', message.session_id, message.id] : [];
      return { key, lead: words.lead, link: { text: words.link, href: serializeShellRoute('connections', fix.feature, ...back) },
        hint: { key: chatHintKeyOfFix(fix)!, label: words.link } };
    }
    // D-404 slice A — a type of thing the owner has none of: Yours' form, with that type chosen.
    // The owner adds it there; nothing here adds anything.
    if (fix.kind === 'thing') {
      const words = thingStepWords(fix.type_name);
      // D-404 slice B1 — once one is in Yours, the line says so, and the block offers Ask again.
      if (landed.has(chatNextStepKey({ kind: 'thing', id: fix.type_id }))) return { key, lead: words.landed, link: null, landed: true };
      // D-404 slice B2 — the link carries this answer, so Yours' form offers "Back to chat" and its save
      // returns here, where this line then says the thing is in Yours.
      const back = message.session_id !== undefined && message.id !== undefined ? ['return', 'chat', message.session_id, message.id] : [];
      return { key, lead: words.lead, link: { text: words.link, href: serializeShellRoute('yours', 'new', fix.type_id, ...back) },
        hint: { key: chatHintKeyOfFix(fix)!, label: words.link } };
    }
    if (fix.kind === 'switch') {
      return {
        key,
        lead: `${fix.label} is turned off for you.`,
        link: { text: 'Open Self (you)', href: serializeShellRoute('contracts', OWNER_CONTRACT_ID) },
        ...(can !== null
          ? { action: { text: 'Turn it on', run: () => can.grant(fix.entry_key), done: `${fix.label} is on now.` } }
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
              done: `${need.label !== undefined ? `${need.label}'s program` : 'The program'} is on now.`,
            },
          }
        : {}),
    };
  });
};

/** Where each one-click fix stands, by message and fix, so a repaint keeps it. */
const status = new Map<string, { state: 'running' | 'done' | 'failed'; error?: string }>();

/** D-404 slice B1 (ruling P2) — "Ask again" under an answer once a step under it landed: it sends the
 *  request that started the turn again, and nothing else. It may refuse (the composer holds a draft),
 *  and says why in place. Marked by this attribute. */
export const CHAT_ASK_AGAIN_ATTR = 'data-chat-ask-again';

/** The "Ask again" button for one answer, its state kept by message so a repaint keeps it. */
export const buildAskAgain = (
  doc: Document,
  messageId: string,
  askAgain: () => Promise<void>,
  repaint: () => void,
): HTMLElement => {
  const id = `${messageId}\u0000ask-again`;
  const at = status.get(id);
  const host = doc.createElement('div');
  host.className = 'chat-ask-again';
  if (at?.state === 'done') {
    const said = doc.createElement('p');
    said.className = 'chat-fix-lead chat-fix-done';
    said.setAttribute('role', 'status');
    said.textContent = 'Asked again.';
    host.appendChild(said);
    return host;
  }
  const button = doc.createElement('button');
  button.className = 'chat-fix-button';
  button.setAttribute('type', 'button');
  button.setAttribute(CHAT_ASK_AGAIN_ATTR, messageId);
  button.textContent = 'Ask again';
  if (at?.state === 'running') button.setAttribute('disabled', '');
  button.addEventListener('click', () => {
    if (status.get(id)?.state === 'running') return;
    status.set(id, { state: 'running' });
    repaint();
    void askAgain().then(
      () => { status.set(id, { state: 'done' }); repaint(); },
      (err: unknown) => { status.set(id, { state: 'failed', error: err instanceof Error ? err.message : String(err) }); repaint(); },
    );
  });
  host.appendChild(button);
  if (at?.state === 'failed' && at.error !== undefined) {
    const error = doc.createElement('p');
    error.className = 'chat-fix-error';
    error.setAttribute('role', 'alert');
    error.textContent = at.error;
    host.appendChild(error);
  }
  return host;
};

/** Draw the fixes. `messageId` scopes each fix's state; `repaint` redraws once one settles.
 *  `askAgain` (D-404 slice B1): once a row's step is done (a thing in Yours, a switch turned on
 *  here), the block ends with "Ask again". */
export const buildChatFixes = (
  doc: Document,
  messageId: string,
  rows: readonly ChatFixRow[],
  repaint: () => void,
  askAgain?: () => Promise<void>,
): HTMLElement => {
  const root = doc.createElement('div');
  root.className = 'chat-fixes';
  root.setAttribute(CHAT_FIXES_ATTR, '');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'What this needed');
  for (const row of rows) {
    // D-405 slice 3 — a hint the owner set aside: said so in its place, with "Show it again".
    const setAside = row.hint !== undefined ? chatHintSetAside(row.hint.key) : undefined;
    if (setAside !== undefined) {
      root.appendChild(buildChatHintSetAside(doc, setAside, repaint));
      continue;
    }
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
    if (row.hint !== undefined && row.landed !== true && chatHintsOffered()) controls.appendChild(buildChatHintNotNow(doc, row.hint, repaint));
    item.appendChild(controls);
    const hintError = row.hint !== undefined ? chatHintError(row.hint.key) : undefined;
    if (hintError !== undefined) item.appendChild(buildChatHintErrorLine(doc, hintError));
    if (at?.state === 'failed' && at.error !== undefined) {
      const error = doc.createElement('p');
      error.className = 'chat-fix-error';
      error.setAttribute('role', 'alert');
      error.textContent = at.error;
      item.appendChild(error);
    }
    root.appendChild(item);
  }
  const landedHere = rows.some((row) => row.landed === true
    || (row.action !== undefined && status.get(`${messageId}\u0000${row.key}`)?.state === 'done'));
  if (askAgain !== undefined && landedHere) root.appendChild(buildAskAgain(doc, messageId, askAgain, repaint));
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
/* D-405 slice 3 — "Not now" sits after the hint's own link, quieter than it. */
.chat-hint-not-now { font-weight: 400; color: var(--muted); background: transparent; }
.chat-fix-link { font-size: 13px; font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
.chat-fix-link:hover, .chat-fix-link:focus-visible { text-decoration: underline; }
.chat-fix-done { font-size: 13px; color: var(--muted); }
.chat-fix-error { margin: 0; font-size: 12px; color: var(--danger, var(--fg)); overflow-wrap: anywhere; }
`;
