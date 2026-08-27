/** Streaming must not rebuild the route once per token.
 *
 *  Every broadcast tears the whole route down and rebuilds it, and a streaming
 *  answer emits one broadcast per token. That drops the reader's text
 *  selection, re-creates every node in a long transcript, and only holds its
 *  scroll position because it is carried across by hand. A token adds
 *  characters to one text node.
 *
 *  🔑 NODE IDENTITY IS THE ASSERTION. Comparing rendered TEXT cannot tell a
 *  fast path from a full rebuild — both end with the right characters on
 *  screen. Holding a reference to the content element and checking it is the
 *  SAME object afterwards is what distinguishes "patched" from "re-created",
 *  and it is the only thing that would have failed before this existed.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  BroadcastEventKind,
  ChatSession,
  ChatSessionSummary,
  ServerEvent,
} from '@recued/contracts';

import {
  bootstrapChatRoute,
  CHAT_ROUTE_ACTIVITY_ROW_ATTR,
  CHAT_ROUTE_ANSWER_CONTENT_ATTR,
  CHAT_ROUTE_ANSWER_WAITING_ATTR,
  CHAT_ROUTE_MESSAGE_ATTR,
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
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
  focus(): void;
  querySelector(selector: string): FakeEl | null;
  querySelectorAll(selector: string): FakeEl[];
  closest(selector: string): FakeEl | null;
  contains(candidate: FakeEl): boolean;
  setSelectionRange(): void;
}

const attrOf = (selector: string): string | null =>
  selector.match(/^\[([\w-]+)\]$/)?.[1] ?? null;

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(), className: '', textContent: '', type: '',
    disabled: false, value: '', attrs: new Map(), children: [], parent: null,
    listeners: new Map(),
    get firstChild() { return el.children[0] ?? null; },
    setAttribute(k, v) { el.attrs.set(k, v); },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    removeAttribute(k) { el.attrs.delete(k); },
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1); c.parent = null; return c;
    },
    remove() {
      if (el.parent === null) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn); el.listeners.set(type, list);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
    focus() {},
    setSelectionRange() {},
    querySelector(selector) { return el.querySelectorAll(selector)[0] ?? null; },
    querySelectorAll(selector) {
      const attr = attrOf(selector);
      if (attr === null) return [];
      const found: FakeEl[] = [];
      const visit = (node: FakeEl): void => {
        for (const child of node.children) {
          if (child.attrs.has(attr)) found.push(child);
          visit(child);
        }
      };
      visit(el);
      return found;
    },
    closest(selector) {
      const attr = attrOf(selector);
      if (attr === null) return null;
      let node: FakeEl | null = el;
      while (node !== null) {
        if (node.attrs.has(attr)) return node;
        node = node.parent;
      }
      return null;
    },
    contains(candidate) {
      if (candidate === el) return true;
      return el.children.some((child) => child.contains(candidate));
    },
  };
  return el;
};

const makeFakeDocument = () => {
  const styleElements: FakeEl[] = [];
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  return {
    activeElement: null as FakeEl | null,
    head: {
      querySelector(sel: string) {
        const attr = attrOf(sel.replace(/^[\w-]+/, ''));
        return attr === null
          ? null
          : styleElements.find((s) => s.attrs.has(attr)) ?? null;
      },
      appendChild(el: FakeEl) { styleElements.push(el); return el; },
    },
    createElement: (tag: string) => makeFakeEl(tag),
    addEventListener(type: string, fn: (event?: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn); listeners.set(type, list);
    },
    removeEventListener() {},
  };
};

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const chatSession = (id = 'chat_1'): ChatSession => ({
  id, title: `Chat ${id}`, created_at: 1000, last_active_at: 2000,
  archived: false, picker_state: { current: 'self' },
  model_routing: {
    current: 'byok', provider: 'local', model_id: 'local-default',
    overridden: false,
  },
});

const sessionSummary = (id = 'chat_1'): ChatSessionSummary => ({
  id, title: `Chat ${id}`, created_at: 1000, last_active_at: 2000,
  message_count: 0, archived: false, picker_state: { current: 'self' },
  model_routing: { current: 'byok', provider: 'local', overridden: false },
});

const mount = () => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const listeners = new Map<BroadcastEventKind, Array<(e: ServerEvent) => void>>();
  const conn = vi.fn(async (method: string, payload?: unknown) => {
    if (method === 'chat.sessions.list') return { sessions: [sessionSummary()] };
    if (method === 'chat.session.get') {
      const id = (payload as { session_id: string }).session_id;
      return { ...chatSession(id), messages: [] };
    }
    if (method === 'chat.send') return { turn_id: 't1' };
    if (method === 'server.getLLMConfig') {
      return {
        config: {
          slot_1: {
            provider: 'local', model: 'local-default',
            base_url: 'http://localhost:11434/v1',
          },
        },
      };
    }
    if (method === 'prefs.get') return { prefs: {} };
    throw new Error(`unexpected ${method}`);
  });
  const route: ChatRoute = bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn: conn as unknown as ChatRouteConn,
    subscribe: <K extends BroadcastEventKind>(
      kind: K,
      listener: (e: Extract<ServerEvent, { kind: K }>) => void,
    ) => {
      const wrapped = listener as unknown as (e: ServerEvent) => void;
      const list = listeners.get(kind) ?? [];
      list.push(wrapped);
      listeners.set(kind, list);
      return () => {};
    },
  });
  return {
    root, route,
    publish(event: ServerEvent) {
      for (const l of listeners.get(event.kind) ?? []) l(event);
    },
  };
};

const token = (delta: string, turn_id = 't1'): ServerEvent => ({
  kind: 'chat.token_streamed',
  session_id: 'chat_1',
  turn_id,
  delta,
  cursor: 1,
} as unknown as ServerEvent);

const contentNode = (root: FakeEl): FakeEl | null => {
  const row = root
    .querySelectorAll(`[${CHAT_ROUTE_MESSAGE_ATTR}]`)
    .find((r) => r.getAttribute(CHAT_ROUTE_MESSAGE_ATTR) === 't1');
  return row?.querySelector(`[${CHAT_ROUTE_ANSWER_CONTENT_ATTR}]`) ?? null;
};

describe('streamed-token painting', () => {
  it('patches the same node instead of rebuilding, once content is up', async () => {
    const h = mount();
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('stream me an answer');
    await tick();

    // The scaffold is up and still showing the waiting placeholder.
    const waiting = contentNode(h.root);
    expect(waiting?.getAttribute(CHAT_ROUTE_ANSWER_WAITING_ATTR)).toBe('');

    // ⛔ The FIRST token is a structural swap — placeholder out, content in —
    // and is deliberately left to the full render.
    h.publish(token('Hel'));
    await tick();
    const afterFirst = contentNode(h.root);
    expect(afterFirst).not.toBe(waiting);
    expect(afterFirst?.getAttribute(CHAT_ROUTE_ANSWER_WAITING_ATTR)).toBe(null);
    expect(afterFirst?.textContent).toBe('Hel');

    // …and every token after it is a text edit on the SAME element.
    h.publish(token('lo, '));
    await tick();
    expect(contentNode(h.root)).toBe(afterFirst);
    expect(afterFirst?.textContent).toBe('Hello, ');

    h.publish(token('world'));
    await tick();
    expect(contentNode(h.root)).toBe(afterFirst);
    expect(afterFirst?.textContent).toBe('Hello, world');

    h.route.dispose();
  });

  /** ⚠ RENAMED TWICE, AND THE SECOND TIME THE BEHAVIOUR ACTUALLY CHANGED.
   *  It first claimed to cover the reference-equality gate and did not — a
   *  `tool_call_started` never reached the painter, because the gate tested the
   *  event KIND first, so it passed with the rest of the gate disabled. Then
   *  the painter learned to handle structure, and "still rebuilds" stopped
   *  being true of the ROUTE: the row survives now and only its children are
   *  rebuilt.
   *
   *  What it pins today is the narrower, still-important half — the CONTENT
   *  NODE is rebuilt rather than merely patched when structure moves, so a new
   *  activity row cannot be lost by the cheap text path. The row's own
   *  survival is asserted separately, below. */
  it('rebuilds the bubble contents, not just the text, when a tool call lands', async () => {
    const h = mount();
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('stream me an answer');
    await tick();
    h.publish(token('working'));
    await tick();
    const streaming = contentNode(h.root);
    expect(streaming?.textContent).toBe('working');

    // A tool call arriving mid-stream changes the activity rows, which the
    // painter has no business touching — the route must rebuild.
    h.publish({
      kind: 'chat.tool_call_started',
      session_id: 'chat_1',
      turn_id: 't1',
      tool_name: 'core.data.mail.list',
      tier: 1,
      args: {},
      cursor: 2,
    } as unknown as ServerEvent);
    await tick();
    expect(contentNode(h.root)).not.toBe(streaming);
    expect(contentNode(h.root)?.textContent).toBe('working');

    h.route.dispose();
  });

  it('ignores a token for a turn that is not the one in flight', async () => {
    const h = mount();
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('stream me an answer');
    await tick();
    h.publish(token('mine'));
    await tick();
    const mine = contentNode(h.root);

    h.publish(token('theirs', 'some-other-turn'));
    await tick();
    expect(contentNode(h.root)).toBe(mine);
    expect(mine?.textContent).toBe('mine');

    h.route.dispose();
  });

  /** ⛔ THE ONE THIS SLICE EXISTS FOR. A tool starting mid-answer used to tear
   *  down and rebuild the ENTIRE route — 45.5ms against a full window, and it
   *  wiped the reader's text selection every time, so highlighting an answer
   *  while the turn was still working was impossible. The bubble is repainted
   *  in place now, so the row survives and everything outside it is untouched. */
  it('repaints the bubble in place when a tool row appears mid-answer', async () => {
    const h = mount();
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('use a tool');
    await tick();
    h.publish(token('thinking'));
    await tick();
    const row = h.root
      .querySelectorAll(`[${CHAT_ROUTE_MESSAGE_ATTR}]`)
      .find((r) => r.getAttribute(CHAT_ROUTE_MESSAGE_ATTR) === 't1')!;

    h.publish({
      kind: 'chat.tool_call_started',
      session_id: 'chat_1',
      turn_id: 't1',
      tool_name: 'core.data.mail.list',
      tier: 1,
      args: {},
      cursor: 2,
    } as unknown as ServerEvent);
    await tick();

    // The ROW is the same node — nothing outside it was rebuilt…
    const after = h.root
      .querySelectorAll(`[${CHAT_ROUTE_MESSAGE_ATTR}]`)
      .find((r) => r.getAttribute(CHAT_ROUTE_MESSAGE_ATTR) === 't1')!;
    expect(after).toBe(row);
    // …and its INSIDE moved, carrying the new activity row and keeping the text.
    expect(after.querySelectorAll(`[${CHAT_ROUTE_ACTIVITY_ROW_ATTR}]`).length)
      .toBeGreaterThan(0);
    expect(contentNode(h.root)?.textContent).toBe('thinking');

    h.route.dispose();
  });

  it('keeps painting tokens into the bubble after activity has appeared', async () => {
    const h = mount();
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('use a tool');
    await tick();
    h.publish(token('one'));
    await tick();
    h.publish({
      kind: 'chat.tool_call_started',
      session_id: 'chat_1', turn_id: 't1',
      tool_name: 'core.data.mail.list', tier: 1, args: {}, cursor: 2,
    } as unknown as ServerEvent);
    await tick();
    const row = h.root
      .querySelectorAll(`[${CHAT_ROUTE_MESSAGE_ATTR}]`)
      .find((r) => r.getAttribute(CHAT_ROUTE_MESSAGE_ATTR) === 't1')!;

    h.publish(token(' two'));
    await tick();
    // ⚠ Still the same row, and the activity did not vanish — the two paint
    // strategies have to compose, not overwrite each other.
    expect(
      h.root.querySelectorAll(`[${CHAT_ROUTE_MESSAGE_ATTR}]`)
        .find((r) => r.getAttribute(CHAT_ROUTE_MESSAGE_ATTR) === 't1'),
    ).toBe(row);
    expect(contentNode(h.root)?.textContent).toBe('one two');
    expect(row.querySelectorAll(`[${CHAT_ROUTE_ACTIVITY_ROW_ATTR}]`).length)
      .toBeGreaterThan(0);

    h.route.dispose();
  });

  /** ⛔ A FAILURE-CLASS transparency event paints a notice OUTSIDE the bubble,
   *  so it must fall through to the full render however cheap the fast path
   *  looks. The reference-equality check on `turn_failures` is what catches it. */
  it('falls back to a full render when a turn failure paints', async () => {
    const h = mount();
    await tick();
    await h.route.openSession('chat_1');
    await h.route.sendMessage('this one dies');
    await tick();
    h.publish(token('partial'));
    await tick();
    const row = h.root
      .querySelectorAll(`[${CHAT_ROUTE_MESSAGE_ATTR}]`)
      .find((r) => r.getAttribute(CHAT_ROUTE_MESSAGE_ATTR) === 't1')!;

    h.publish({
      kind: 'chat.transparency',
      session_id: 'chat_1', turn_id: 't1',
      event: { kind: 'engine.turn_failed' },
      cursor: 3,
    } as unknown as ServerEvent);
    await tick();

    expect(
      h.root.querySelectorAll(`[${CHAT_ROUTE_MESSAGE_ATTR}]`)
        .find((r) => r.getAttribute(CHAT_ROUTE_MESSAGE_ATTR) === 't1'),
    ).not.toBe(row);

    h.route.dispose();
  });
});
