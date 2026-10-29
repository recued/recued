/** Chat keeps the composer focused, caret and all, when a read that finishes
 *  after it opened re-renders the page.
 *
 *  ⛔ Found by the paired browser drive (2026-10-19): it typed a draft into Chat
 *  as it opened, and in Chromium the box was empty afterwards. The model
 *  preference and transparency reads re-render with a plain `render()`, which
 *  replaces the textarea; focus fell to the page, so the next keystrokes went
 *  nowhere and text inserted during the render was lost.
 *
 *  The double models what this depends on and the other Chat doubles do not:
 *  removing the focused element moves focus to the page, an element knows
 *  whether it is still in the page, and a textarea has a caret. */

import { describe, expect, it, vi } from 'vitest';
vi.mock('../automation/prompt-schedules-panel.js', () => import('./fixtures/prompt-schedules-panel-stub.js'));
import type { BroadcastEventKind, ServerEvent } from '@recued/contracts';

import {
  bootstrapChatRoute,
  CHAT_ROUTE_HISTORY_TOGGLE_ATTR,
  CHAT_ROUTE_INPUT_ATTR,
  type ChatRouteConn,
} from '../chat/bootstrap-chat-route.js';

interface FakeEl {
  tagName: string; className: string; textContent: string; type: string;
  disabled: boolean; readOnly: boolean; value: string; id: string;
  selectionStart: number; selectionEnd: number;
  attrs: Map<string, string>; children: FakeEl[]; parent: FakeEl | null;
  listeners: Map<string, Array<(event?: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  readonly isConnected: boolean;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: (event?: unknown) => void): void;
  removeEventListener(type: string, fn: (event?: unknown) => void): void;
  click(): void;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  querySelector(selector: string): FakeEl | null;
  querySelectorAll(selector: string): FakeEl[];
  closest(selector: string): FakeEl | null;
  contains(candidate: FakeEl | null): boolean;
}

const attrOf = (selector: string): string | null => selector.match(/^\[([\w-]+)\]$/)?.[1] ?? null;

const makeWorld = () => {
  const doc = {
    activeElement: null as FakeEl | null,
    body: null as unknown as FakeEl,
    head: { querySelector: (): null => null, appendChild: (el: FakeEl): FakeEl => el },
    createElement: (tag: string): FakeEl => makeEl(tag),
    createTextNode: (text: string): FakeEl => { const node = makeEl('#text'); node.textContent = text; return node; },
    addEventListener(): void {},
    removeEventListener(): void {},
  };
  const makeEl = (tag: string): FakeEl => {
    const el: FakeEl = {
      tagName: tag.toUpperCase(), className: '', textContent: '', type: '', id: '',
      disabled: false, readOnly: false, value: '', selectionStart: 0, selectionEnd: 0,
      attrs: new Map(), children: [], parent: null, listeners: new Map(),
      get firstChild() { return el.children[0] ?? null; },
      get isConnected() {
        let node: FakeEl | null = el;
        while (node !== null) { if (node === doc.body) return true; node = node.parent; }
        return false;
      },
      setAttribute(k, v) { el.attrs.set(k, v); },
      getAttribute(k) { return el.attrs.get(k) ?? null; },
      hasAttribute(k) { return el.attrs.has(k); },
      removeAttribute(k) { el.attrs.delete(k); },
      appendChild(c) { c.parent = el; el.children.push(c); return c; },
      removeChild(c) {
        const i = el.children.indexOf(c);
        if (i < 0) throw new Error('removeChild: not a child');
        el.children.splice(i, 1); c.parent = null;
        // As a browser does: focus inside a removed subtree falls to the page.
        if (c.contains(doc.activeElement)) doc.activeElement = doc.body;
        return c;
      },
      remove() { el.parent?.removeChild(el); },
      addEventListener(type, fn) {
        const list = el.listeners.get(type) ?? [];
        list.push(fn); el.listeners.set(type, list);
      },
      removeEventListener(type, fn) {
        el.listeners.set(type, (el.listeners.get(type) ?? []).filter((each) => each !== fn));
      },
      click() { if (!el.disabled) for (const fn of el.listeners.get('click') ?? []) fn({ target: el }); },
      focus() { doc.activeElement = el; },
      setSelectionRange(start, end) { el.selectionStart = start; el.selectionEnd = end; },
      querySelector(selector) { return el.querySelectorAll(selector)[0] ?? null; },
      querySelectorAll(selector) {
        const attr = attrOf(selector);
        if (attr === null) return [];
        const found: FakeEl[] = [];
        const visit = (node: FakeEl): void => {
          for (const child of node.children) { if (child.attrs.has(attr)) found.push(child); visit(child); }
        };
        visit(el);
        return found;
      },
      closest(selector) {
        const attr = attrOf(selector);
        for (let node: FakeEl | null = el; node !== null; node = node.parent) {
          if (attr !== null && node.attrs.has(attr)) return node;
        }
        return null;
      },
      contains(candidate) {
        for (let node = candidate; node !== null; node = node.parent) if (node === el) return true;
        return false;
      },
    };
    return el;
  };
  doc.body = makeEl('body');
  return doc;
};

const tick = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

/** Chat on a new conversation, with the transparency read held until `release`. */
const mount = () => {
  const doc = makeWorld();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  let release: () => void = () => {};
  const prefsRead = new Promise<{ prefs: Record<string, never> }>((done) => { release = () => done({ prefs: {} }); });
  const conn = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'chat.sessions.list') return { sessions: [] };
    if (method === 'server.getLLMConfig') {
      return { config: { slot_1: { provider: 'local', model: 'local-default', base_url: 'http://localhost:11434/v1' } } };
    }
    if (method === 'prefs.get') return prefsRead;
    throw new Error(`not served here: ${method}`);
  });
  bootstrapChatRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    conn: conn as unknown as ChatRouteConn,
    subscribe: <K extends BroadcastEventKind>(_kind: K, _listener: (e: Extract<ServerEvent, { kind: K }>) => void) => () => {},
  });
  const composer = (): FakeEl => root.querySelector(`[${CHAT_ROUTE_INPUT_ATTR}]`)!;
  return { doc, root, composer, release: async () => { release(); await tick(); } };
};

describe('a read finishing while the owner types in Chat', () => {
  it('keeps the composer focused, with the text and the caret where they were', async () => {
    const chat = mount();
    await tick();
    const typing = chat.composer();
    typing.focus();
    typing.value = 'Hello there';
    typing.setSelectionRange(5, 5);
    for (const fn of typing.listeners.get('input') ?? []) fn({ target: typing });

    await chat.release();

    const now = chat.composer();
    // The read did re-render: the textarea the owner was typing in is gone.
    expect(now).not.toBe(typing);
    expect(typing.isConnected).toBe(false);
    expect(chat.doc.activeElement).toBe(now);
    expect(now.value).toBe('Hello there');
    expect([now.selectionStart, now.selectionEnd]).toEqual([5, 5]);
  });

  it('does not take focus for the composer when the owner was elsewhere', async () => {
    const chat = mount();
    await tick();
    chat.root.querySelector(`[${CHAT_ROUTE_HISTORY_TOGGLE_ATTR}]`)!.focus();

    await chat.release();

    expect(chat.doc.activeElement).not.toBe(chat.composer());
  });
});
