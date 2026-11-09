/** D-169 P2 Slice 4 — side-panel approvals gate on THIS bridge's mode.
 *
 *  `mount.render()` passes `onAnswer` to the approvals section ONLY when
 *  `state.bridge_mode.approval` is true; otherwise it withholds it so
 *  `renderApprovalsSection` falls to its read-only branch. The mode
 *  defaults both-off (fail-closed) and is re-read into the store on a
 *  periodic tick, so an approval-mode toggle flips the section between
 *  interactive and read-only live (TR-12 / I-10).
 *
 *  The interactive approval card uses real click handlers, so this builds
 *  an interactive fake document (the side-panel views' own FakeElement has
 *  no addEventListener) that ALSO supports getElementById + removeChild +
 *  firstChild (mountSidePanel needs the root + clearChildren on re-render).
 */

import { describe, expect, it, vi } from 'vitest';

import { mountSidePanel } from '../mount.js';
import {
  createSidePanelStore,
  DEFAULT_BRIDGE_MODE,
  type SidePanelStoreState,
} from '../store/local-store.js';
import { ASK_CARD_ATTR } from '@recued/ui-shared/approval-card';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
  readonly firstChild: FakeEl | null;
}

const makeFakeDocument = (): { doc: { createElement(t: string): FakeEl; getElementById(id: string): FakeEl | null }; root: FakeEl } => {
  const byId = new Map<string, FakeEl>();
  const make = (tagName: string): FakeEl => {
    const el: FakeEl = {
      tagName: tagName.toUpperCase(),
      className: '',
      textContent: '',
      type: '',
      disabled: false,
      hidden: false,
      attrs: new Map(),
      children: [],
      parent: null,
      listeners: new Map(),
      setAttribute(k, v) {
        el.attrs.set(k, v);
        if (k === 'id') byId.set(v, el);
      },
      getAttribute(k) {
        return el.attrs.get(k) ?? null;
      },
      hasAttribute(k) {
        return el.attrs.has(k);
      },
      appendChild(c) {
        el.children.push(c);
        c.parent = el;
        return c;
      },
      removeChild(c) {
        const idx = el.children.indexOf(c);
        if (idx < 0) throw new Error('removeChild: not a child');
        el.children.splice(idx, 1);
        c.parent = null;
        return c;
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
      get firstChild() {
        return el.children[0] ?? null;
      },
    };
    return el;
  };
  const root = make('main');
  root.setAttribute('id', 'root');
  return { root, doc: { createElement: make, getElementById: (id) => byId.get(id) ?? null } };
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};
const allText = (root: FakeEl, acc: string[] = []): string[] => {
  if (root.textContent) acc.push(root.textContent);
  for (const c of root.children) allText(c, acc);
  return acc;
};

const NOW = 1_800_000_000_000;
const ask = {
  ask_id: 'ask-9',
  title: 'Approval needed',
  text: 'Send the follow-up?',
  options: [
    { id: 'send', label: 'Send' },
    { id: 'hold', label: 'Hold' },
  ],
  created_at: NOW - 1000,
};

const storeWith = (
  bridge_mode: SidePanelStoreState['bridge_mode'],
) =>
  createSidePanelStore({
    pair: { paired: true, server_url: 'https://local.recued.test', server_display_name: 'Local' },
    approvals: { items: [ask], fetched_at: NOW, error: null },
    bridge_mode,
  });

describe('D-169 Slice 4 — approvals gate on this bridge approval mode', () => {
  it('renders READ-ONLY (no interactive card) when approval mode is OFF, even with onAnswer wired', () => {
    const { doc, root } = makeFakeDocument();
    const onAnswer = vi.fn();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith({ notification: true, approval: false }),
      now: () => NOW,
      onAnswer,
    });

    expect(collectByAttr(root, ASK_CARD_ATTR)).toHaveLength(0);
    // The read-only fallback still surfaces the pending ask + its options.
    expect(allText(root).join(' ')).toContain('Send');
  });

  it('renders INTERACTIVE cards when approval mode is ON', () => {
    const { doc, root } = makeFakeDocument();
    const onAnswer = vi.fn();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith({ notification: false, approval: true }),
      now: () => NOW,
      onAnswer,
    });

    const cards = collectByAttr(root, ASK_CARD_ATTR);
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute(ASK_CARD_ATTR)).toBe('ask-9');
  });

  it('is fail-closed by default: a fresh store (both modes off) renders read-only', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore({
      pair: { paired: true, server_url: 'https://x', server_display_name: 'X' },
      approvals: { items: [ask], fetched_at: NOW, error: null },
      // bridge_mode omitted -> DEFAULT_BRIDGE_MODE (both off).
    });
    expect(store.getState().bridge_mode).toEqual(DEFAULT_BRIDGE_MODE);

    mountSidePanel({ document: doc as unknown as Document, store, now: () => NOW, onAnswer: vi.fn() });

    expect(collectByAttr(root, ASK_CARD_ATTR)).toHaveLength(0);
  });

  it('flips live between read-only and interactive when applyBridgeMode toggles approval (TR-12)', () => {
    const { doc, root } = makeFakeDocument();
    const store = storeWith({ notification: false, approval: false });
    mountSidePanel({ document: doc as unknown as Document, store, now: () => NOW, onAnswer: vi.fn() });

    // Start read-only.
    expect(collectByAttr(root, ASK_CARD_ATTR)).toHaveLength(0);

    // User enables approval mode in Settings -> next mode poll applies it.
    store.applyBridgeMode({ notification: false, approval: true });
    expect(collectByAttr(root, ASK_CARD_ATTR)).toHaveLength(1);

    // ...and back off again.
    store.applyBridgeMode({ notification: false, approval: false });
    expect(collectByAttr(root, ASK_CARD_ATTR)).toHaveLength(0);
  });
});

describe('D-169 Slice 4 — store bridge_mode slice', () => {
  it('defaults to both modes off and applyBridgeMode patches + freezes', () => {
    const store = createSidePanelStore();
    expect(store.getState().bridge_mode).toEqual({ notification: false, approval: false });

    store.applyBridgeMode({ notification: true, approval: true });
    expect(store.getState().bridge_mode).toEqual({ notification: true, approval: true });

    // Frozen — a consumer cannot mutate the live mode through getState().
    expect(() => {
      (store.getState().bridge_mode as { approval: boolean }).approval = false;
    }).toThrow();
  });
});
