/** Shell-frame Step 4 — the composer buttons + [✎ Create] overlay (§D.L1).
 *
 *  Pins:
 *   - the [✎ Create] button renders only when an upsert caller is wired;
 *   - clicking it portals an overlay (to body) carrying the "Create" title,
 *     a Close button, and the mounted compose route's target chips;
 *   - Close / Escape / backdrop click all tear the overlay down;
 *   - a docked thread collapses the buttons into the `+` disclosure menu;
 *   - dispose() detaches an open (body-portaled) overlay.
 *
 *  The webclient has no jsdom — this file rolls a small query+dispatch
 *  capable fake document (the existing chat-route test's fake lacks
 *  `document.addEventListener` / `document.body`, both of which the portaled
 *  overlay needs).
 */

import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ChatSession } from '@recued/contracts';

import {
  bootstrapChatRoute,
  CHAT_ROUTE_COMPOSER_ACTION_ATTR,
  CHAT_ROUTE_COMPOSER_MORE_ATTR,
  CHAT_ROUTE_CREATE_CLOSE_ATTR,
  CHAT_ROUTE_CREATE_OVERLAY_ATTR,
  type ChatRouteConn,
} from '../chat/bootstrap-chat-route.js';
import { COMPOSE_ROUTE_TARGET_CHIP_ATTR } from '../compose/compose-route.js';

// ── fake DOM ──────────────────────────────────────────────────────

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  value: string;
  open: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  click(): void;
  focus(): void;
}

const matchAttr = (sel: string): string | null => {
  const m = sel.match(/^\[([\w-]+)\]$/);
  return m?.[1] ?? null;
};

const makeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    value: '',
    open: false,
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute: (k, v) => el.attrs.set(k, v),
    getAttribute: (k) => el.attrs.get(k) ?? null,
    hasAttribute: (k) => el.attrs.has(k),
    appendChild: (c) => {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild: (c) => {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    remove: () => {
      if (el.parent === null) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener: (t, fn) => {
      const list = el.listeners.get(t) ?? [];
      list.push(fn);
      el.listeners.set(t, list);
    },
    removeEventListener: (t, fn) => {
      const list = el.listeners.get(t);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    querySelector: (sel) => el.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel) => {
      const attr = matchAttr(sel);
      if (attr === null) return [];
      const out: FakeEl[] = [];
      const walk = (n: FakeEl): void => {
        for (const c of n.children) {
          if (c.attrs.has(attr)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    click: () => {
      if (el.disabled) return;
      for (const fn of [...(el.listeners.get('click') ?? [])]) fn({ target: el });
    },
    focus: () => undefined, // overridden per-document to track activeElement
  };
  return el;
};

interface FakeDoc {
  body: FakeEl;
  activeElement: FakeEl | null;
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  styles: FakeEl[];
  createElement(tag: string): FakeEl;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  fireKeydown(key: string): void;
}

const makeDoc = (): FakeDoc => {
  const styles: FakeEl[] = [];
  const keydown: Array<(ev: unknown) => void> = [];
  let activeElement: FakeEl | null = null;
  // createElement wires `focus()` to track the document's activeElement, so
  // the overlay's focus-in (on open) + focus-restore (on close) are testable.
  const create = (tag: string): FakeEl => {
    const el = makeEl(tag);
    el.focus = () => {
      activeElement = el;
    };
    return el;
  };
  const body = create('body');
  return {
    body,
    get activeElement() {
      return activeElement;
    },
    styles,
    head: {
      querySelector(sel) {
        const m = sel.match(/^style\[([\w-]+)\]$/);
        const attr = m?.[1];
        if (attr === undefined) return null;
        return styles.find((s) => s.attrs.has(attr)) ?? null;
      },
      appendChild(el) {
        styles.push(el);
        return el;
      },
    },
    createElement: create,
    addEventListener: (t, fn) => {
      if (t === 'keydown') keydown.push(fn);
    },
    removeEventListener: (t, fn) => {
      if (t !== 'keydown') return;
      const i = keydown.indexOf(fn);
      if (i >= 0) keydown.splice(i, 1);
    },
    fireKeydown(key) {
      for (const fn of [...keydown]) fn({ key });
    },
  };
};

const collectByAttr = (root: FakeEl, attr: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl): void => {
    if (n.attrs.has(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const allText = (root: FakeEl): string =>
  [root.textContent, ...root.children.map(allText)].join(' ');

const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const chatSession = (): ChatSession => ({
  id: 'chat_1',
  title: 'Ops chat',
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
} as unknown as ChatSession);

const chatMessage = (): ChatMessage => ({
  id: 'msg_1',
  session_id: 'chat_1',
  role: 'assistant',
  content: 'Hi',
  ts: 2_000,
} as unknown as ChatMessage);

const stubConn = ((method: string) => {
  if (method === 'chat.sessions.list') return Promise.resolve({ sessions: [] });
  if (method === 'server.getLLMConfig') return Promise.resolve({ config: {} });
  if (method === 'prefs.get') return Promise.resolve({ prefs: {} });
  if (method === 'chat.session.get') {
    return Promise.resolve({ ...chatSession(), messages: [chatMessage()] });
  }
  return Promise.resolve({});
}) as unknown as ChatRouteConn;

const mount = (withCallers: boolean) => {
  const doc = makeDoc();
  const root = doc.createElement('div');
  const route = bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn: stubConn,
    ...(withCallers
      ? {
          contactUpsertCaller: vi.fn(async () => ({ contact: {} as never })),
          workEntityUpsertCaller: vi.fn(async () => ({ entity: {} as never })),
        }
      : {}),
  });
  return { doc, root, route };
};

const createButton = (root: FakeEl): FakeEl | undefined =>
  collectByAttr(root, CHAT_ROUTE_COMPOSER_ACTION_ATTR).find(
    (b) => b.getAttribute(CHAT_ROUTE_COMPOSER_ACTION_ATTR) === 'create',
  );

// ── tests ─────────────────────────────────────────────────────────

describe('Shell-frame Step 4 — composer buttons + Create overlay', () => {
  it('renders the [✎ Create] button when an upsert caller is wired', async () => {
    const { root, route } = mount(true);
    await tick();
    const create = createButton(root);
    expect(create).toBeDefined();
    expect(create?.textContent).toContain('Create');
    route.dispose();
  });

  it('omits the Create button when no upsert caller is wired', async () => {
    const { root, route } = mount(false);
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_COMPOSER_ACTION_ATTR)).toHaveLength(0);
    route.dispose();
  });

  it('opens the overlay (portaled to body) with the Create title + compose targets', async () => {
    const { doc, root, route } = mount(true);
    await tick();
    createButton(root)?.click();

    const overlays = collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR);
    expect(overlays).toHaveLength(1);
    const overlay = overlays[0]!;
    expect(allText(overlay)).toContain('Create');
    expect(collectByAttr(overlay, CHAT_ROUTE_CREATE_CLOSE_ATTR)).toHaveLength(1);
    // The compose route mounted inside → its 4 target chips.
    expect(
      collectByAttr(overlay, COMPOSE_ROUTE_TARGET_CHIP_ATTR).length,
    ).toBeGreaterThanOrEqual(4);
    // It is NOT a child of the route root (portaled to body).
    expect(collectByAttr(root, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(0);
    route.dispose();
  });

  it('Close button tears the overlay down', async () => {
    const { doc, root, route } = mount(true);
    await tick();
    createButton(root)?.click();
    expect(collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(1);
    collectByAttr(doc.body, CHAT_ROUTE_CREATE_CLOSE_ATTR)[0]?.click();
    expect(collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(0);
    route.dispose();
  });

  it('Escape closes the overlay', async () => {
    const { doc, root, route } = mount(true);
    await tick();
    createButton(root)?.click();
    expect(collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(1);
    doc.fireKeydown('Escape');
    expect(collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(0);
    route.dispose();
  });

  it('backdrop click closes the overlay', async () => {
    const { doc, root, route } = mount(true);
    await tick();
    createButton(root)?.click();
    const overlay = collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)[0]!;
    overlay.click(); // target === overlay → backdrop close
    expect(collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(0);
    route.dispose();
  });

  it('only one overlay opens on repeated Create clicks', async () => {
    const { doc, root, route } = mount(true);
    await tick();
    const btn = createButton(root)!;
    btn.click();
    btn.click();
    expect(collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(1);
    route.dispose();
  });

  it('docked thread collapses the buttons into the + menu', async () => {
    const { root, route } = mount(true);
    await route.openSession('chat_1'); // a message-bearing thread → docked
    await tick();
    const more = collectByAttr(root, CHAT_ROUTE_COMPOSER_MORE_ATTR);
    expect(more).toHaveLength(1);
    expect(createButton(more[0]!)).toBeDefined();
    route.dispose();
  });

  it('dispose() closes an open overlay', async () => {
    const { doc, root, route } = mount(true);
    await tick();
    createButton(root)?.click();
    expect(collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(1);
    route.dispose();
    expect(collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)).toHaveLength(0);
  });

  it('moves focus into the dialog on open and restores it on close', async () => {
    const { doc, root, route } = mount(true);
    await tick();
    const btn = createButton(root)!;
    btn.focus(); // the Create button holds focus
    expect(doc.activeElement).toBe(btn);
    btn.click();
    const panel = collectByAttr(doc.body, CHAT_ROUTE_CREATE_OVERLAY_ATTR)[0]!
      .children[0]!;
    expect(doc.activeElement).toBe(panel); // focus moved into the dialog
    doc.fireKeydown('Escape');
    expect(doc.activeElement).toBe(btn); // restored on close
    route.dispose();
  });
});
