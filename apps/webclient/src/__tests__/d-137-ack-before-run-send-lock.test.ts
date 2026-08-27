/** Ack-before-run flip — route send serialization.
 *
 *  The `chat.send` ack now resolves at the server's COMMIT POINT (user
 *  message durable, model-bound body still running), so the route keeps
 *  the composer locked on `pending_turn_id` until the sent turn
 *  SETTLES: its `chat.message_complete` lands, OR its failure paints
 *  (`turn_failures` — incl. the post-accept `engine.turn_failed`
 *  signal), OR the user navigates to another session (whose events
 *  would never settle the lock). Order-agnostic: under an ack-after-run
 *  server the completion precedes the ack and the lock settles at ack
 *  time. Harness mirrors `d-137-p3-plan-approval-card.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import type {
  BroadcastEventKind,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  ServerEvent,
} from '@recued/contracts';

import {
  bootstrapChatRoute,
  CHAT_ROUTE_INPUT_ATTR,
  CHAT_ROUTE_MESSAGE_ATTR,
  CHAT_ROUTE_SEND_ATTR,
  CHAT_ROUTE_HISTORY_DRAFT_GUARD_ATTR,
  CHAT_ROUTE_SESSION_ROW_ATTR,
  CHAT_ROUTE_SESSION_STATUS_ATTR,
  CHAT_ROUTE_TURN_FAILURE_ATTR,
  type ChatRoute,
  type ChatRouteConn,
} from '../chat/bootstrap-chat-route.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  listeners: Map<string, Array<(event?: unknown) => void>>;
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
  addEventListener(type: string, fn: (event?: unknown) => void): void;
  removeEventListener(type: string, fn: (event?: unknown) => void): void;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    value: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    remove() {
      if (el.parent === null) return;
      const idx = el.parent.children.indexOf(el);
      if (idx >= 0) el.parent.children.splice(idx, 1);
      el.parent = null;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    styleElements,
    listeners,
    head: {
      querySelector(sel) {
        const parsed = matchSelector(sel);
        if (parsed === null) return null;
        return (
          styleElements.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (list === undefined) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
  };
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};

const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const chatSession = (id = 'chat_1'): ChatSession => ({
  id,
  title: `Chat ${id}`,
  created_at: 1_000,
  last_active_at: 2_000,
  archived: false,
  picker_state: { current: 'self' },
  model_routing: {
    current: 'byok',
    provider: 'local',
    model_id: 'local-default',
    overridden: false,
  },
});

const sessionSummary = (id = 'chat_1'): ChatSessionSummary => ({
  id,
  title: `Chat ${id}`,
  created_at: 1_000,
  last_active_at: 2_000,
  message_count: 0,
  archived: false,
  picker_state: { current: 'self' },
  model_routing: {
    current: 'byok',
    provider: 'local',
    overridden: false,
  },
});

const assistantMessage = (
  id: string,
  session_id = 'chat_1',
): ChatMessage => ({
  id,
  session_id,
  role: 'assistant',
  contributor: 'model',
  content: 'Turn answer.',
  target_server: 'self',
  picker_at_send: {
    display_name: 'This server',
    signature: {
      server_kind: 'recued',
      version: '1.0.0',
      instance_id: 'inst_1',
    },
  },
  model_used: { provider: 'local', model_id: 'local-default' },
  ts: 2_000,
});

type RawConn = (method: string, payload?: unknown) => Promise<unknown>;

interface RouteHarness {
  root: FakeEl;
  route: ChatRoute;
  reconnect(): void;
  publish(event: ServerEvent): void;
}

const mountChatRoute = (
  sendImpl: () => Promise<{ turn_id: string }>,
  /** Hold a session's hydration open, so a switch can still be IN FLIGHT when
   *  a send starts — the one interleaving `retainPendingSend` cannot refuse. */
  sessionGetGates?: ReadonlyMap<string, Promise<unknown>>,
  /** Rewrite what `chat.session.get` returns, so a test can stand in for a
   *  history that moved on while this tab was not listening. */
  snapshotFor?: (session_id: string) => unknown,
  /** Absent ⇒ the list omits `busy_session_ids` entirely, which is what a
   *  server older than the busy registry sends. */
  serverBusy?: () => readonly string[],
  /** Drive the summaries the server reports, so a test can move a session's
   *  seen/total counts the way a real turn would. */
  summaries?: () => ChatSessionSummary[],
): RouteHarness => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const listeners = new Map<BroadcastEventKind, Array<(event: ServerEvent) => void>>();
  const connSpy = vi.fn<RawConn>(async (method, payload) => {
    if (method === 'chat.sessions.list') {
      const sessions = summaries === undefined
        ? [sessionSummary('chat_1'), sessionSummary('chat_2')]
        : summaries();
      return serverBusy === undefined
        ? { sessions }
        : { sessions, busy_session_ids: serverBusy() };
    }
    if (method === 'chat.session.mark_seen') return { ok: true };
    if (method === 'chat.session.get') {
      const id = (payload as { session_id: string }).session_id;
      const gate = sessionGetGates?.get(id);
      if (gate !== undefined) return gate;
      return snapshotFor?.(id) ?? { ...chatSession(id), messages: [] };
    }
    if (method === 'chat.send') return sendImpl();
    if (method === 'server.getLLMConfig') {
      // A configured LOCAL slot so `isAnyAiSourceConfigured` is true and Send
      // isn't gated by the "add a key first" cold-start affordance. The wire
      // redacts secrets to `has_key` (D-174 R28); a local slot is recognized by
      // its local base_url and needs no key at all.
      return {
        config: {
          slot_1: {
            provider: 'local',
            model: 'local-default',
            base_url: 'http://localhost:11434/v1',
          },
        },
      };
    }
    if (method === 'prefs.get') return { prefs: {} };
    throw new Error(`unexpected method ${method}`);
  });

  const subscribe = <K extends BroadcastEventKind>(
    kind: K,
    listener: (event: Extract<ServerEvent, { kind: K }>) => void,
  ): (() => void) => {
    const wrapped = listener as unknown as (event: ServerEvent) => void;
    const list = listeners.get(kind) ?? [];
    list.push(wrapped);
    listeners.set(kind, list);
    return () => {
      const current = listeners.get(kind) ?? [];
      listeners.set(
        kind,
        current.filter((fn) => fn !== wrapped),
      );
    };
  };

  const reconnectListeners: Array<() => void> = [];
  const route = bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn: connSpy as unknown as ChatRouteConn,
    subscribe,
    reconnect: (listener: () => void) => {
      reconnectListeners.push(listener);
      return () => {
        const index = reconnectListeners.indexOf(listener);
        if (index >= 0) reconnectListeners.splice(index, 1);
      };
    },
  });

  return {
    root,
    route,
    reconnect() {
      for (const listener of reconnectListeners) listener();
    },
    publish(event) {
      for (const listener of listeners.get(event.kind) ?? []) listener(event);
    },
  };
};

const sendButton = (root: FakeEl): FakeEl =>
  collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!;

/** Put a real draft in the composer.
 *
 *  ⛔ REQUIRED BEFORE ASSERTING Send IS ENABLED. `0ff7af11e` made
 *  `send.disabled` also depend on the draft being non-empty, and sending clears
 *  the composer — so after a turn settles the button stays disabled for a reason
 *  that has nothing to do with this file's subject. Typing first leaves the
 *  SEND LOCK as the only thing that can still be holding it, which is what these
 *  tests are actually about. That commit updated d-174-p2 the same way and
 *  missed this file; nothing ran it, so it went unnoticed for two days. */
const typeDraft = (root: FakeEl, text = 'another message'): void => {
  const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
  input.value = text;
  for (const listener of input.listeners.get('input') ?? []) listener();
};

describe('D-137 ack-before-run — route send lock', () => {
  it('keeps the composer locked after the early ack until message_complete settles it', async () => {
    const h = mountChatRoute(async () => ({ turn_id: 't1' }));
    await tick();
    await h.route.openSession('chat_1');

    await h.route.sendMessage('run something slow');

    // Ack landed (in-flight scaffold exists) but the turn has not
    // completed — the composer must stay locked.
    expect(h.route.getThread().inflight?.turn_id).toBe('t1');
    expect(sendButton(h.root).disabled).toBe(true);
    expect(sendButton(h.root).textContent).toBe('Sending...');

    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 't1',
      final: assistantMessage('msg_1'),
      cursor: 1,
    });
    await tick();

    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);
    expect(sendButton(h.root).textContent).toBe('Send');

    h.route.dispose();
  });

  it('settles the lock on a post-accept engine.turn_failed failure paint (no message_complete)', async () => {
    const h = mountChatRoute(async () => ({ turn_id: 't1' }));
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('turn that dies after accept');
    expect(sendButton(h.root).disabled).toBe(true);

    h.publish({
      kind: 'chat.transparency',
      session_id: 'chat_1',
      turn_id: 't1',
      event: { kind: 'engine.turn_failed' },
      cursor: 1,
    });
    await tick();

    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);
    const notices = collectByAttr(h.root, CHAT_ROUTE_TURN_FAILURE_ATTR);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.children[0]!.textContent).toBe(
      'this turn failed before completing — your message was saved; send it again to retry',
    );

    h.route.dispose();
  });

  it('settles immediately at ack time under ack-after-run ordering (completion preceded the ack)', async () => {
    const send = deferred<{ turn_id: string }>();
    const h = mountChatRoute(() => send.promise);
    await tick();
    await h.route.openSession('chat_1');

    const sending = h.route.sendMessage('old ordering');
    await tick();
    // Production ack-after-run: the whole turn broadcasts BEFORE the
    // rpc resolves.
    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 't1',
      final: assistantMessage('msg_1'),
      cursor: 1,
    });
    send.resolve({ turn_id: 't1' });
    await sending;
    await tick();

    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);
    expect(sendButton(h.root).textContent).toBe('Send');

    h.route.dispose();
  });

  /** ⛔ THIS TEST HAS NOW INVERTED TWICE. READ BOTH TURNS BEFORE A THIRD.
   *
   *  v1 required that switching sessions mid-pending CLEARED the lock, because
   *  the old turn could never settle once you navigated away. `b2da7fa69`
   *  inverted it: `retainPendingSend` REFUSED the switch instead, so the turn
   *  stayed attached and could still settle.
   *
   *  v2 (here) removes the refusal. The premise both versions shared — that a
   *  turn belongs to a THREAD — was the mistake. A turn belongs to its SESSION,
   *  on the server, which never needed this tab to sit still: `chat.send` takes
   *  no lock and D-160 messenger surfaces already deliver concurrent turns. So
   *  the switch is allowed, the turn keeps running, and the lock follows the
   *  session rather than the tab.
   *
   *  🔑 What v1 got right and v2 keeps: the lock must still exist somewhere, or
   *  a second turn lands in a session whose history tail the first is still
   *  writing. `turnsInFlightBySession` is where it lives now — RETURNING to a
   *  running session re-takes the lock. That is the assertion to protect. */
  it('lets you leave a pending turn, keeps it running, and re-locks on return', async () => {
    const h = mountChatRoute(async () => ({ turn_id: 't1' }));
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('still running');
    expect(sendButton(h.root).disabled).toBe(true);

    // Leaving is allowed now, and it releases the composer HERE.
    await h.route.openSession('chat_2');
    await tick();
    expect(h.route.getThread().session?.id).toBe('chat_2');
    expect(h.route.getThread().inflight).toBeNull();
    typeDraft(h.root, 'a fresh thought in the other chat');
    expect(sendButton(h.root).disabled).toBe(false);

    // …but chat_1 is still working, and both the row and the shell say so.
    expect(h.route.hasInFlightWork()).toBe(true);
    const busyRow = collectByAttr(h.root, CHAT_ROUTE_SESSION_ROW_ATTR).find(
      (row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === 'chat_1',
    )!;
    expect(
      collectByAttr(busyRow, CHAT_ROUTE_SESSION_STATUS_ATTR)[0]
        ?.getAttribute(CHAT_ROUTE_SESSION_STATUS_ATTR),
    ).toBe('working');

    // ⛔ Returning RE-LOCKS: two turns in one session would read the same
    // history tail at start and append into it blind.
    await h.route.openSession('chat_1');
    await tick();
    expect(sendButton(h.root).disabled).toBe(true);
    expect(sendButton(h.root).textContent).toBe('Sending...');

    // The original turn still settles it — the thing v1 could not deliver.
    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 't1',
      final: assistantMessage('msg_1'),
      cursor: 1,
    });
    await tick();

    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);
    expect(sendButton(h.root).textContent).toBe('Send');
    expect(h.route.hasInFlightWork()).toBe(false);

    h.route.dispose();
  });

  /** The other half of leaving a turn: you have to be able to TELL it finished,
   *  or backgrounding one is just a way to forget it.
   *
   *  ⛔ THE MARK IS THE SERVER'S NOW, not a tab-lifetime `Set`. The old one
   *  died on reload — you could be told an answer had arrived, refresh, and be
   *  told nothing. Browser storage is not the alternative either: this route
   *  persists nothing there by house rule, so unread is
   *  `message_count > last_seen_message_count`, which survives a closed tab and
   *  reads the same on every client the owner has. */
  it('marks a chat whose message count has moved past what the owner has seen', async () => {
    let counts = { seen: 2, total: 2 };
    const h = mountChatRoute(
      async () => ({ turn_id: 't1' }),
      undefined,
      undefined,
      undefined,
      () => [
        { ...sessionSummary('chat_1'),
          message_count: counts.total,
          last_seen_message_count: counts.seen },
        sessionSummary('chat_2'),
      ],
    );
    await tick(6);
    await h.route.openSession('chat_2');
    await tick();

    const statusOf = (id: string) => {
      const row = collectByAttr(h.root, CHAT_ROUTE_SESSION_ROW_ATTR).find(
        (r) => r.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === id,
      )!;
      return collectByAttr(row, CHAT_ROUTE_SESSION_STATUS_ATTR)[0]
        ?.getAttribute(CHAT_ROUTE_SESSION_STATUS_ATTR) ?? null;
    };
    expect(statusOf('chat_1')).toBe(null);

    // A turn lands in chat_1 while the owner is in chat_2.
    counts = { seen: 2, total: 4 };
    await h.route.refresh();
    await tick(6);
    expect(statusOf('chat_1')).toBe('answered');

    // Opening it is what clears the mark, and the SERVER is what remembers.
    counts = { seen: 4, total: 4 };
    await h.route.openSession('chat_1');
    await tick(6);
    expect(statusOf('chat_1')).toBe(null);

    h.route.dispose();
  });

  /** ⛔ ABSENT MEANS SEEN. A session predating the column carries no
   *  `last_seen_message_count`, and reading that as "zero seen" would light up
   *  every chat the owner has on the first boot after an upgrade — a wall of
   *  false marks is worse than no marks. */
  it('leaves a pre-column session unmarked rather than guessing it is unread', async () => {
    const h = mountChatRoute(
      async () => ({ turn_id: 't1' }),
      undefined,
      undefined,
      undefined,
      () => [
        { ...sessionSummary('chat_1'), message_count: 40 },
        sessionSummary('chat_2'),
      ],
    );
    await tick(6);
    await h.route.openSession('chat_2');
    await tick();
    const row = collectByAttr(h.root, CHAT_ROUTE_SESSION_ROW_ATTR).find(
      (r) => r.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === 'chat_1',
    )!;
    expect(collectByAttr(row, CHAT_ROUTE_SESSION_STATUS_ATTR)).toHaveLength(0);
    h.route.dispose();
  });

  /** ⛔ THE ONE WINDOW `retainPendingSend` CANNOT CLOSE — IT CHECKS AT ENTRY.
   *
   *  A switch that is already awaiting its `chat.session.get` when the send
   *  starts resolves AFTER the ack, and `openSession` drops the send lock on
   *  purpose ("a pending turn belongs to the session being left"). The ack
   *  path used to scaffold its in-flight turn onto `state.thread` with no
   *  identity re-check, so the turn's "Preparing your answer…" bubble landed
   *  on whichever session was now on screen — where its session-gated
   *  `chat.message_complete` can never arrive. Driven live before the fix:
   *  chat_2 rendered bubble `t_A` and kept it after chat_1's completion.
   *
   *  The message itself was always dispatched to the right session; only the
   *  client-side paint diverged. Dropping the scaffold loses nothing — the
   *  turn is durable server-side and rehydrates when chat_1 is reopened. */
  it('does not scaffold the acked turn onto a session opened while the send was in flight', async () => {
    const hydrateChat2 = deferred<unknown>();
    const send = deferred<{ turn_id: string }>();
    const h = mountChatRoute(
      () => send.promise,
      new Map([['chat_2', hydrateChat2.promise]]),
    );
    await tick();
    await h.route.openSession('chat_1');

    // The switch to chat_2 is in flight — its snapshot has not landed, so
    // chat_1 is still the visible thread and Send is still live.
    const switching = h.route.openSession('chat_2');
    await tick();
    expect(h.route.getThread().session?.id).toBe('chat_1');
    typeDraft(h.root, 'typed into the thread I can still see');
    expect(sendButton(h.root).disabled).toBe(false);
    sendButton(h.root).click();
    await tick();

    // chat_2 lands FIRST, then the ack for chat_1's turn.
    hydrateChat2.resolve({ ...chatSession('chat_2'), messages: [] });
    await switching;
    send.resolve({ turn_id: 't_A' });
    await tick();

    expect(h.route.getThread().session?.id).toBe('chat_2');
    expect(h.route.getThread().inflight).toBeNull();
    expect(collectByAttr(h.root, CHAT_ROUTE_MESSAGE_ATTR)).toHaveLength(0);

    // chat_1's completion is dropped by chat_2's session gate — which is
    // exactly why no scaffold may be left behind for it to settle.
    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 't_A',
      final: assistantMessage('msg_A'),
      cursor: 1,
    });
    await tick();
    expect(h.route.getThread().inflight).toBeNull();
    expect(collectByAttr(h.root, CHAT_ROUTE_MESSAGE_ATTR)).toHaveLength(0);
    // The composer belongs to chat_2 now: unlocked, no stranded pending turn.
    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);
    expect(sendButton(h.root).textContent).toBe('Send');

    h.route.dispose();
  });

  /** ⛔ A SECOND CLICK USED TO MEAN NOTHING AT ALL.
   *
   *  A session open is one awaited `chat.session.get`, and clicks land faster
   *  than that resolves. The wrapper refused re-entry while one was loading,
   *  so clicking chat_1 then chat_2 put you in chat_1 — the chat you clicked
   *  FIRST — with the second click dropped in silence. Rows carried
   *  `aria-disabled` and no CSS for it, so nothing on screen said so either.
   *
   *  🔑 `openSession` was ALREADY re-entrant: the newer `beginThreadSnapshotLoad`
   *  invalidates the older generation, whose `finishThreadSnapshotLoad` returns
   *  null and aborts it untouched. Only the wrapper's refusal stood in the way. */
  it('lets a second click supersede a session open that is still loading', async () => {
    const openChat1 = deferred<unknown>();
    const h = mountChatRoute(
      async () => ({ turn_id: 't1' }),
      new Map([['chat_1', openChat1.promise]]),
    );
    await tick();

    const rowFor = (id: string) =>
      collectByAttr(h.root, CHAT_ROUTE_SESSION_ROW_ATTR).find(
        (row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === id,
      )!;

    rowFor('chat_1').click();
    await tick();
    // Mid-open the row is BUSY, not unavailable — the second click is valid.
    expect(rowFor('chat_1').getAttribute('aria-busy')).toBe('true');
    expect(rowFor('chat_2').getAttribute('aria-disabled')).toBe(null);

    rowFor('chat_2').click();
    await tick(8);
    expect(h.route.getThread().session?.id).toBe('chat_2');

    // ⛔ And chat_1 landing LATE must not drag the screen back to itself.
    openChat1.resolve({ ...chatSession('chat_1'), messages: [] });
    await tick(8);
    expect(h.route.getThread().session?.id).toBe('chat_2');

    h.route.dispose();
  });

  /** The draft guard runs ONCE, at click time. Words typed after that — while
   *  the chat is still loading — never existed when it asked, and hydration
   *  used to wipe them without a prompt. */
  it('keeps a draft typed while the next chat was still loading', async () => {
    const openChat2 = deferred<unknown>();
    const h = mountChatRoute(
      async () => ({ turn_id: 't1' }),
      new Map([['chat_2', openChat2.promise]]),
    );
    await tick();
    await h.route.openSession('chat_1');
    await tick();

    collectByAttr(h.root, CHAT_ROUTE_SESSION_ROW_ATTR)
      .find((row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === 'chat_2')!
      .click();
    await tick();
    typeDraft(h.root, 'a thought I had while it opened');

    openChat2.resolve({ ...chatSession('chat_2'), messages: [] });
    await tick(8);
    expect(h.route.getThread().session?.id).toBe('chat_2');
    expect(collectByAttr(h.root, CHAT_ROUTE_INPUT_ATTR)[0]!.value)
      .toBe('a thought I had while it opened');
    // Still protected, so the NEXT switch asks about it properly.
    expect(h.route.hasUnsavedChanges()).toBe(true);

    h.route.dispose();
  });

  /** A draft that was there BEFORE the click is what the switch agreed to
   *  discard, and it still goes — otherwise every switch would drag the last
   *  chat's half-sentence into the next one. */
  it('still clears the draft the switch was asked about', async () => {
    const h = mountChatRoute(async () => ({ turn_id: 't1' }));
    await tick();
    await h.route.openSession('chat_1');
    typeDraft(h.root, 'typed before I clicked away');

    // The guard asks; discarding is the answer it acts on.
    collectByAttr(h.root, CHAT_ROUTE_SESSION_ROW_ATTR)
      .find((row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === 'chat_2')!
      .click();
    await tick();
    const discard = collectByAttr(h.root, CHAT_ROUTE_HISTORY_DRAFT_GUARD_ATTR)[0]!
      .children.flatMap((child) => child.children)
      .find((button) => button.textContent === 'Discard and open')!;
    discard.click();
    await tick(8);

    expect(h.route.getThread().session?.id).toBe('chat_2');
    expect(collectByAttr(h.root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');

    h.route.dispose();
  });

  /** ⛔ A COMPOSER STUCK ON "Sending…" FOREVER, AND IT PREDATES THE BACKGROUND
   *  TURN WORK ENTIRELY.
   *
   *  `hydrateThreadFromSnapshot` reset `completed_turn_ids` to `[]`, and the
   *  only thing that ever refilled it was a live `chat.message_complete`. So a
   *  turn that finished while the socket was down was, to this tab, a turn that
   *  never finished: reconnect re-read the history, `settlePendingSend` found
   *  nothing to match its `pending_turn_id`, and the send lock stayed shut with
   *  no way out but a reload.
   *
   *  `turn_id` on `ChatMessage` is what closes it — the answer in the history
   *  now says which turn wrote it, so completion is provable from durable truth
   *  instead of from having been connected at the right moment. */
  it('unlocks from durable history when the turn completed while the socket was down', async () => {
    let history: readonly ChatMessage[] = [];
    const h = mountChatRoute(
      async () => ({ turn_id: 't1' }),
      undefined,
      (id) => ({ ...chatSession(id), messages: history }),
    );
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('answer this while I drop off');
    expect(sendButton(h.root).disabled).toBe(true);

    // The outage: the turn completes server-side and its broadcast is lost.
    history = [{ ...assistantMessage('msg_1'), turn_id: 't1' }];
    h.reconnect();
    await tick(10);

    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);
    expect(sendButton(h.root).textContent).toBe('Send');
    expect(h.route.hasInFlightWork()).toBe(false);

    h.route.dispose();
  });

  /** The discriminating case. The history PROVES the server stamps turns, and
   *  no assistant row bears this one — so it really is still running, and the
   *  lock has to hold. This is what the blanket reconnect clear used to get
   *  wrong: it reopened the double-send window on every socket blip. */
  it('keeps the visible lock across a reconnect when the turn is genuinely unfinished', async () => {
    let history: readonly ChatMessage[] = [];
    const h = mountChatRoute(
      async () => ({ turn_id: 't1' }),
      undefined,
      (id) => ({ ...chatSession(id), messages: history }),
    );
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('a long one');

    // ⛔ The evidence that t1 is still out is t1's OWN QUESTION, sitting in the
    // history with nothing answering it — the server writes the user row at
    // turn start, before the model runs. An unrelated earlier turn would prove
    // only that this server stamps turns, which is not the same claim.
    history = [
      {
        ...assistantMessage('msg_0'),
        id: 'msg_q',
        role: 'user' as const,
        content: 'a long one',
        turn_id: 't1',
      },
    ];
    h.reconnect();
    await tick(10);

    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(true);
    expect(sendButton(h.root).textContent).toBe('Sending...');

    // …and the real completion, whenever it lands, still settles it.
    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 't1',
      final: assistantMessage('msg_1'),
      cursor: 1,
    });
    await tick();
    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);

    h.route.dispose();
  });

  /** ⛔ AND THE CASE THAT MUST FAIL OPEN. A paired webclient talks to the
   *  OWNER'S server, updated on their schedule — so a history with no
   *  `turn_id` anywhere is not an old turn, it is a server that cannot answer
   *  the question at all. Holding a lock on an unanswerable question bricks
   *  the chat; releasing it risks a second turn. Release. */
  it('releases the lock when the history carries no turn ids to reason from', async () => {
    let history: readonly ChatMessage[] = [];
    const h = mountChatRoute(
      async () => ({ turn_id: 't1' }),
      undefined,
      (id) => ({ ...chatSession(id), messages: history }),
    );
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('sent to an older server');

    // Same history shape as the test above, minus the stamping.
    history = [assistantMessage('msg_0')];
    h.reconnect();
    await tick(10);

    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);
    expect(h.route.hasInFlightWork()).toBe(false);

    h.route.dispose();
  });

  /** 🔑 THE SERVER SAYS SO, AND THAT ENDS THE GUESSING. This tab never
   *  dispatched the turn — it started on another surface, or in another client
   *  — so nothing local could ever have known about it. */
  it('shows a chat as working when only the server knows a turn is running', async () => {
    const h = mountChatRoute(
      async () => ({ turn_id: 't1' }),
      undefined,
      undefined,
      () => ['chat_2'],
    );
    await tick(6);

    const busyRow = collectByAttr(h.root, CHAT_ROUTE_SESSION_ROW_ATTR).find(
      (row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === 'chat_2',
    )!;
    expect(
      collectByAttr(busyRow, CHAT_ROUTE_SESSION_STATUS_ATTR)[0]
        ?.getAttribute(CHAT_ROUTE_SESSION_STATUS_ATTR),
    ).toBe('working');
    expect(h.route.hasInFlightWork()).toBe(true);

    h.route.dispose();
  });

  /** ⛔ THE CASE NO AMOUNT OF READING THE HISTORY COULD SETTLE. The turn
   *  FAILED, so there is no assistant row to find and no `chat.message_complete`
   *  coming. The idle transition is the only word this tab will ever get, and
   *  it has to be enough to release the composer. */
  it('releases the composer on the server idle transition, with no completion', async () => {
    const h = mountChatRoute(async () => ({ turn_id: 't1' }));
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('a turn that will die');
    expect(sendButton(h.root).disabled).toBe(true);

    h.publish({
      kind: 'chat.session_changed',
      session_id: 'chat_1',
      field: 'busy',
      value: false,
      cursor: 1,
    } as unknown as ServerEvent);
    await tick();

    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(false);
    expect(sendButton(h.root).textContent).toBe('Send');
    expect(h.route.hasInFlightWork()).toBe(false);

    h.route.dispose();
  });

  /** ⛔ AN OLDER SERVER SAYS NOTHING, AND SAYING NOTHING IS NOT SAYING "NONE".
   *  Reading an absent `busy_session_ids` as an empty set would unlock every
   *  session on this tab's very first list read.
   *
   *  ⚠ Asserted on the BACKGROUND row, not on the send lock. The first cut of
   *  this test watched `hasInFlightWork()` and the send button, and both are
   *  held up by `state.sending`, which adoption never touches — so it passed
   *  just as happily with the collapse in place. It was pinning nothing. */
  it('keeps its own tracking when the server sends no busy set at all', async () => {
    const h = mountChatRoute(async () => ({ turn_id: 't1' }));
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('sent to an older server');
    await h.route.openSession('chat_2');
    await tick();

    const workingRow = () =>
      collectByAttr(h.root, CHAT_ROUTE_SESSION_ROW_ATTR)
        .find((row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === 'chat_1')!;
    expect(
      collectByAttr(workingRow(), CHAT_ROUTE_SESSION_STATUS_ATTR)[0]
        ?.getAttribute(CHAT_ROUTE_SESSION_STATUS_ATTR),
    ).toBe('working');

    // A list refresh is exactly what would wipe it if absence read as "none".
    await h.route.refresh();
    await tick(6);

    expect(
      collectByAttr(workingRow(), CHAT_ROUTE_SESSION_STATUS_ATTR)[0]
        ?.getAttribute(CHAT_ROUTE_SESSION_STATUS_ATTR),
    ).toBe('working');

    h.route.dispose();
  });
});
