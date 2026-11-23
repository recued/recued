/** What an owner is offered once first-run is behind them.
 *
 *  The three activation cards all sat behind ONE gate — `!hasCompletedChat` —
 *  so the whole surface retired the moment any session had a message. Right for
 *  "Ask Recued": after your first chat you have asked. Wrong for the other two,
 *  which describe exactly what somebody has NOT done after one chat, and which
 *  are the steps that make a self-hosted server worth running.
 *
 *  ⛔ AND YET THE GRID STAYS FIRST-RUN ONLY. Persisting it suppresses the
 *  returning-user greeting — they are alternatives in that layout — so an owner
 *  who has chatted for months but never connected a mailbox would get a card
 *  grid instead of a greeting on every new chat. Two shipped assertions objected
 *  to exactly that, and they were right. The returning owner gets one line.
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('../automation/prompt-schedules-panel.js', () => import('./fixtures/prompt-schedules-panel-stub.js'));
import type { BroadcastEventKind, ChatSession, ChatSessionSummary, ServerEvent } from '@recued/contracts';

import {
  bootstrapChatRoute,
  CHAT_ROUTE_ACTIVATION_CARD_ATTR,
  CHAT_ROUTE_ACTIVATION_POINTER_ATTR,
  CHAT_ROUTE_ACTIVATION_POINTER_LINK_ATTR,
  CHAT_ROUTE_GREETING_ATTR,
  type ChatRouteConn,
} from '../chat/bootstrap-chat-route.js';

interface FakeEl {
  tagName: string; className: string; textContent: string; type: string;
  disabled: boolean; value: string; attrs: Map<string, string>;
  children: FakeEl[]; parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(t: string, fn: () => void): void;
  click(): void;
  focus(): void;
}

const makeEl = (tag: string): FakeEl => {
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
      if (i >= 0) el.children.splice(i, 1);
      c.parent = null; return c;
    },
    remove() {
      if (el.parent === null) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener(t, fn) {
      const list = el.listeners.get(t) ?? [];
      list.push(fn); el.listeners.set(t, list);
    },
    click() { for (const fn of el.listeners.get('click') ?? []) fn(); },
    focus() {},
  };
  return el;
};

const makeDoc = () => {
  const styles: FakeEl[] = [];
  return {
    activeElement: null,
    head: {
      querySelector: () => styles[0] ?? null,
      appendChild: (el: FakeEl) => { styles.push(el); return el; },
    },
    createElement: (tag: string) => makeEl(tag),
    // `renderAnswerText` paints a formatted reply (**bold**, headings) from text
    // nodes (b41c8e0cd). A double is a closed list: without this, the first
    // fixture reply carrying markup throws. A text node is a bare element
    // carrying its text.
    createTextNode: (text: string): FakeEl => {
      const node = makeEl('#text');
      node.textContent = text;
      return node;
    },
    addEventListener() {}, removeEventListener() {},
  };
};

const collect = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collect(c, attr, out);
  return out;
};

const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };

const session = (id = 'chat_1'): ChatSession => ({
  id, title: 'Chat', created_at: 1, last_active_at: 2, archived: false,
  picker_state: { current: 'self' },
  model_routing: { current: 'byok', provider: 'local', model_id: 'm', overridden: false },
});
const summary = (id: string, message_count: number): ChatSessionSummary => ({
  id, title: 'Chat', created_at: 1, last_active_at: 2, message_count,
  archived: false, picker_state: { current: 'self' },
  model_routing: { current: 'byok', provider: 'local', overridden: false },
});

const mount = (opts: {
  sessions: ChatSessionSummary[];
  connections: number;
  recipes: number;
  /** D-405 slice 4b — the Set up page's mail, calendar and files; absent, the server is one from before
   *  it and refuses the method. */
  features?: Array<{ feature: string; connected: boolean | null }>;
}) => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  const conn = vi.fn(async (method: string) => {
    if (method === 'chat.sessions.list') return { sessions: opts.sessions };
    if (method === 'chat.session.get') return { ...session(), messages: [] };
    if (method === 'collection.connection.list') {
      return { connections: Array.from({ length: opts.connections }, () => ({})) };
    }
    if (method === 'chat.setup.features' && opts.features !== undefined) return { features: opts.features };
    if (method === 'recipe.list') {
      return { recipes: Array.from({ length: opts.recipes }, () => ({})) };
    }
    if (method === 'server.getLLMConfig') {
      return { config: { slot_1: { provider: 'local', model: 'm', base_url: 'http://x/v1' } } };
    }
    if (method === 'prefs.get') return { prefs: {} };
    throw new Error(`unexpected ${method}`);
  });
  const route = bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn: conn as unknown as ChatRouteConn,
    enableFirstRunActivation: true,
    subscribe: (<K extends BroadcastEventKind>(
      _k: K, _l: (e: Extract<ServerEvent, { kind: K }>) => void,
    ) => () => {}) as never,
  });
  return { root, route };
};

const cards = (root: FakeEl) =>
  collect(root, CHAT_ROUTE_ACTIVATION_CARD_ATTR)
    .map((c) => c.getAttribute(CHAT_ROUTE_ACTIVATION_CARD_ATTR));

describe('first run — the card grid', () => {
  it('offers every step a brand-new owner has not taken', async () => {
    const h = mount({ sessions: [], connections: 0, recipes: 0 });
    await tick(12);
    expect(cards(h.root)).toEqual(['ask', 'connect', 'automate']);
    h.route.dispose();
  });

  /** The card knows its own answer now. Somebody who connected during setup is
   *  not told to go and connect. */
  it('drops a card whose step is already done', async () => {
    const h = mount({ sessions: [], connections: 2, recipes: 0 });
    await tick(12);
    expect(cards(h.root)).toEqual(['ask', 'automate']);
    h.route.dispose();
  });
});

describe('after first run — the pointer', () => {
  /** ⛔ THE REGRESSION THE SHIPPED TESTS CAUGHT. A returning owner keeps their
   *  greeting; the grid does not come back to displace it. */
  it('keeps the greeting and offers one line instead of the grid', async () => {
    const h = mount({ sessions: [summary('chat_1', 4)], connections: 0, recipes: 0 });
    await tick(12);
    expect(cards(h.root)).toEqual([]);
    expect(collect(h.root, CHAT_ROUTE_GREETING_ATTR)).toHaveLength(1);
    const pointer = collect(h.root, CHAT_ROUTE_ACTIVATION_POINTER_ATTR);
    expect(pointer).toHaveLength(1);
    const link = collect(pointer[0]!, CHAT_ROUTE_ACTIVATION_POINTER_LINK_ATTR)[0]!;
    // D-405 slice 4b — the owner's own Set up page, in the app, not the public guide.
    expect(link.getAttribute('href')).toBe('#setup');
    expect(link.getAttribute('target')).toBeNull();
    h.route.dispose();
  });

  it('names only what is outstanding', async () => {
    const h = mount({ sessions: [summary('chat_1', 4)], connections: 3, recipes: 0 });
    await tick(12);
    const link = collect(h.root, CHAT_ROUTE_ACTIVATION_POINTER_LINK_ATTR)[0]!;
    expect(link.textContent).toBe('Look through ready-made Recipes');
    expect(link.getAttribute('href')).toBe('#recipes');
    h.route.dispose();
  });

  /** ⛔ AND IT DISAPPEARS ENTIRELY once there is nothing to offer. A permanent
   *  line under the greeting is the nagging this whole shape exists to avoid. */
  it('shows nothing at all to a fully set-up owner', async () => {
    const h = mount({ sessions: [summary('chat_1', 4)], connections: 2, recipes: 5 });
    await tick(12);
    expect(cards(h.root)).toEqual([]);
    expect(collect(h.root, CHAT_ROUTE_ACTIVATION_POINTER_ATTR)).toHaveLength(0);
    expect(collect(h.root, CHAT_ROUTE_GREETING_ATTR)).toHaveLength(1);
    h.route.dispose();
  });
});

// D-405 slice 4b — "connected" is the Set up page's own fact too: a mailbox, a calendar of the owner's or a
// file source counts beside an API connection. ⛔ It read the API connections alone.
describe('what counts as connected (D-405 slice 4b)', () => {
  const MAIL = [{ feature: 'mail', connected: true }, { feature: 'calendar', connected: false }, { feature: 'file', connected: false }];
  const NONE = [{ feature: 'mail', connected: false }, { feature: 'calendar', connected: false }, { feature: 'file', connected: null }];

  it('a connected mailbox counts: no "Connect my work" for an owner with mail and no API connection', async () => {
    const h = mount({ sessions: [], connections: 0, recipes: 0, features: MAIL });
    await tick(12);
    expect(cards(h.root)).toEqual(['ask', 'automate']);
    h.route.dispose();
  });

  it('nothing of theirs connected and no API connection: the card, and the line opens Set up', async () => {
    const first = mount({ sessions: [], connections: 0, recipes: 0, features: NONE });
    await tick(12);
    expect(cards(first.root)).toEqual(['ask', 'connect', 'automate']);
    first.route.dispose();
    const back = mount({ sessions: [summary('chat_1', 4)], connections: 0, recipes: 3, features: NONE });
    await tick(12);
    const link = collect(back.root, CHAT_ROUTE_ACTIVATION_POINTER_LINK_ATTR)[0]!;
    expect(link.textContent).toBe('Connect your mail, calendar and files');
    expect(link.getAttribute('href')).toBe('#setup');
    back.route.dispose();
  });

  it('a returning owner with mail connected is offered only recipes, and nothing once there are some', async () => {
    const h = mount({ sessions: [summary('chat_1', 4)], connections: 0, recipes: 0, features: MAIL });
    await tick(12);
    expect(collect(h.root, CHAT_ROUTE_ACTIVATION_POINTER_LINK_ATTR)[0]!.textContent).toBe('Look through ready-made Recipes');
    h.route.dispose();
    const done = mount({ sessions: [summary('chat_1', 4)], connections: 0, recipes: 2, features: MAIL });
    await tick(12);
    expect(collect(done.root, CHAT_ROUTE_ACTIVATION_POINTER_ATTR)).toHaveLength(0);
    done.route.dispose();
  });
});
