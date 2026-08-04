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
  CHAT_ROUTE_SEND_ATTR,
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
  publish(event: ServerEvent): void;
}

const mountChatRoute = (
  sendImpl: () => Promise<{ turn_id: string }>,
): RouteHarness => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const listeners = new Map<BroadcastEventKind, Array<(event: ServerEvent) => void>>();
  const connSpy = vi.fn<RawConn>(async (method, payload) => {
    if (method === 'chat.sessions.list') {
      return { sessions: [sessionSummary('chat_1'), sessionSummary('chat_2')] };
    }
    if (method === 'chat.session.get') {
      const id = (payload as { session_id: string }).session_id;
      return { ...chatSession(id), messages: [] };
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

  const route = bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn: connSpy as unknown as ChatRouteConn,
    subscribe,
  });

  return {
    root,
    route,
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

  /** ⛔ THIS ASSERTED THE OPPOSITE UNTIL `b2da7fa69`, AND THE CONTRACT INVERTED.
   *
   *  It used to require that switching sessions mid-pending CLEARED the lock, on
   *  the reasoning that the old turn could never settle once you had navigated
   *  away. `retainPendingSend` removed the premise instead: a pending turn now
   *  keeps its thread, so the switch is refused and the turn CAN still settle —
   *  "a pending turn stays owned by its current thread", per the source. The
   *  composer stays editable so a rejected change returns to the textarea rather
   *  than moving or disabling it.
   *
   *  Rewritten rather than deleted: the file's subject is what releases the send
   *  lock, and "a navigation attempt does NOT release it" is now part of that. */
  it('refuses a session switch mid-pending and keeps the turn attached, so it can still settle', async () => {
    const h = mountChatRoute(async () => ({ turn_id: 't1' }));
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('still running');
    expect(sendButton(h.root).disabled).toBe(true);

    await h.route.openSession('chat_2');
    await tick();

    // The switch was refused: the turn is still in flight and still locked, and
    // a draft cannot unlock it — only the turn settling can.
    expect(h.route.getThread().inflight?.turn_id).toBe('t1');
    typeDraft(h.root);
    expect(sendButton(h.root).disabled).toBe(true);
    expect(sendButton(h.root).textContent).toBe('Sending...');

    // …and because the thread was retained, the original turn still settles it.
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
});
