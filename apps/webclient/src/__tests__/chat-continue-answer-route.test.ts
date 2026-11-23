/** 2026-11-21 (the owner: "for the case when the 10 ceiling is hit, if 10 is kept, can it be resumed manually by user
 *  (present to user on what already has and basically user can continue maybe?)") — Continue in the chat route itself:
 *  under the conversation's latest answer when it stopped at its rounds, never under an older one, and pressing it
 *  sends "Continue." as the owner's next message. The fake DOM is `chat-streamed-token-paint.test.ts`'s. */

import { describe, expect, it, vi } from 'vitest';
vi.mock('../automation/prompt-schedules-panel.js', () => import('./fixtures/prompt-schedules-panel-stub.js'));
import { CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE, type ChatMessage, type ChatSession, type ChatSessionSummary } from '@recued/contracts';

import { bootstrapChatRoute, type ChatRoute, type ChatRouteConn } from '../chat/bootstrap-chat-route.js';
import { CONTINUE_ANSWER_ATTR, CONTINUE_MESSAGE } from '../chat/continue-answer.js';

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
    // `renderAnswerText` paints a formatted reply (**bold**, headings) from text
    // nodes (b41c8e0cd). A double is a closed list: without this, the first
    // fixture reply carrying markup throws. A text node is a bare element
    // carrying its text.
    createTextNode: (text: string): FakeEl => {
      const node = makeFakeEl('#text');
      node.textContent = text;
      return node;
    },
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


const STOPPED = `So far this turn reached “Poetry | Books to Scrape” (https://books.toscrape.com/poetry/).\n\n${CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE}`;
const message = (id: string, role: 'user' | 'assistant', content: string, ts: number): ChatMessage =>
  ({ id, session_id: 'chat_1', role, content, ts } as unknown as ChatMessage);

const mount = (messages: ChatMessage[]) => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const conn = vi.fn(async (method: string, payload?: unknown) => {
    if (method === 'chat.sessions.list') return { sessions: [sessionSummary()] };
    if (method === 'chat.session.get') return { ...chatSession((payload as { session_id: string }).session_id), messages };
    if (method === 'chat.send') return { turn_id: 't2' };
    if (method === 'server.getLLMConfig') {
      return { config: { slot_1: { provider: 'local', model: 'local-default', base_url: 'http://localhost:11434/v1' } } };
    }
    if (method === 'prefs.get') return { prefs: {} };
    throw new Error(`unexpected ${method}`);
  });
  const route: ChatRoute = bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn: conn as unknown as ChatRouteConn,
    subscribe: () => () => {},
  });
  const continues = (): FakeEl[] => root.querySelectorAll(`[${CONTINUE_ANSWER_ATTR}]`);
  const sent = (): unknown[] => conn.mock.calls.filter(([method]) => method === 'chat.send').map(([, payload]) => payload);
  return { route, continues, sent };
};

describe('Continue in the chat route', () => {
  it('is under the latest answer when it stopped at its rounds, and sends "Continue."', async () => {
    const h = mount([message('m1', 'user', 'Research the three sites.', 1_000), message('m2', 'assistant', STOPPED, 2_000)]);
    await tick();
    await h.route.openSession('chat_1');
    await tick();
    expect(h.continues().map((button) => button.getAttribute(CONTINUE_ANSWER_ATTR))).toEqual(['m2']);
    expect(h.continues()[0]!.textContent).toBe('Continue');
    h.continues()[0]!.click();
    await tick();
    expect(h.sent()).toEqual([expect.objectContaining({ session_id: 'chat_1', message: CONTINUE_MESSAGE })]);
  });

  it('is under no answer once a later one finished, nor under one that finished', async () => {
    const h = mount([
      message('m1', 'user', 'Research the three sites.', 1_000), message('m2', 'assistant', STOPPED, 2_000),
      message('m3', 'user', CONTINUE_MESSAGE, 3_000), message('m4', 'assistant', 'Born March 14, 1879.', 4_000),
    ]);
    await tick();
    await h.route.openSession('chat_1');
    await tick();
    expect(h.continues()).toHaveLength(0);
  });

  // 2026-11-21 (the owner: "recued sees the limit, stop the model, show a continue") — the server's mark, from history.
  it('is under the latest answer the server marked as ending at its round limit, whatever it says', async () => {
    const atLimit = { ...message('m2', 'assistant', 'The note was saved; reopening it to verify was not finished.', 2_000),
      reached_round_limit: true as const };
    const h = mount([message('m1', 'user', 'Edit the note and verify it.', 1_000), atLimit]);
    await tick();
    await h.route.openSession('chat_1');
    await tick();
    expect(h.continues().map((button) => button.getAttribute(CONTINUE_ANSWER_ATTR))).toEqual(['m2']);
  });
});
