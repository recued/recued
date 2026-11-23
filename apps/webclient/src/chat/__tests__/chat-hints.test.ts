/** D-405 slice 3 — "Not now" on a hint under a chat answer, in the app: offered only once the server
 *  said it keeps the list, set aside in place with the day it comes back, and shown again on request. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@recued/contracts';

import { __resetChatFixStatus, buildChatFixes, chatFixRows, setChatFixActions } from '../chat-fixes.js';
import {
  CHAT_HINT_NOT_NOW_ATTR,
  CHAT_HINT_RESTORE_ATTR,
  CHAT_HINT_SET_ASIDE_ATTR,
  chatHintSetAside,
  chatHintUntilText,
  loadChatHints,
  setChatHintActions,
  type ChatHintActions,
} from '../chat-hints.js';
import { buildChatInstallOffers, chatInstallOfferLinks } from '../install-offers.js';

interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  children: FakeNode[];
  textContent: string;
  href?: string;
  className?: string;
  listeners: Map<string, () => void>;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeNode): FakeNode;
  addEventListener(kind: string, fn: () => void): void;
}
const makeNode = (tagName: string): FakeNode => {
  const node: FakeNode = {
    tagName, attributes: new Map(), children: [], textContent: '', listeners: new Map(),
    setAttribute: (name, value) => { node.attributes.set(name, value); },
    appendChild: (child) => { node.children.push(child); return child; },
    addEventListener: (kind, fn) => { node.listeners.set(kind, fn); },
  };
  return node;
};
const doc = { createElement: (tag: string) => makeNode(tag.toUpperCase()) } as unknown as Document;
const all = (node: FakeNode): FakeNode[] => [node, ...node.children.flatMap(all)];
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
const withAttr = (node: FakeNode, attr: string): FakeNode[] => all(node).filter((candidate) => candidate.attributes.has(attr));
const text = (node: FakeNode): string => all(node).map((candidate) => candidate.textContent).join(' ');

const answer = (fixes: unknown): Pick<ChatMessage, 'role' | 'fixes'> => ({ role: 'assistant', fixes } as Pick<ChatMessage, 'role' | 'fixes'>);
const MAIL = { kind: 'feature', feature: 'mail' };
const PASSPORT = { kind: 'thing', type_id: 'passport', type_name: 'Passport' };
const SWITCH_OFF = { kind: 'switch', entry_key: 'primitive.mail.search', label: "'mail.search'" };
const DAY = 86_400_000;

/** Actions over a fake server list; each call kept. */
const server = (initial: Array<{ key: string; label: string; until: number }> = []) => {
  const rows = new Map(initial.map((row) => [row.key, row]));
  const calls: string[] = [];
  const actions: ChatHintActions = {
    list: vi.fn(async () => ({ not_now: [...rows.values()] })),
    notNow: vi.fn(async (key: string, label: string) => {
      calls.push(`not_now ${key} ${label}`);
      const row = { key, label, until: Date.now() + 30 * DAY };
      rows.set(key, row);
      return row;
    }),
    restore: vi.fn(async (key: string) => { calls.push(`restore ${key}`); return { restored: rows.delete(key) }; }),
  };
  return { actions, calls, rows };
};

const drawFixes = (fixes: unknown[]): FakeNode =>
  buildChatFixes(doc, 'm1', chatFixRows(answer(fixes)), () => {}) as unknown as FakeNode;

afterEach(() => {
  setChatHintActions(null);
  setChatFixActions(null);
  __resetChatFixStatus();
  vi.restoreAllMocks();
});

describe('when "Not now" is offered', () => {
  it('⛔ not before the server said it keeps the list, nor by a server without it', async () => {
    const { actions } = server();
    setChatHintActions(actions);
    expect(withAttr(drawFixes([MAIL]), CHAT_HINT_NOT_NOW_ATTR)).toEqual([]);
    setChatHintActions({ ...actions, list: async () => { throw new Error('unknown method chat.hints.list'); } });
    loadChatHints(() => {});
    await flush();
    expect(withAttr(drawFixes([MAIL]), CHAT_HINT_NOT_NOW_ATTR)).toEqual([]);
  });

  it('on a thing, a pack\'s setup and a feature; ⛔ never on a fix for a call that failed', async () => {
    const { actions } = server();
    setChatHintActions(actions);
    const repaint = vi.fn();
    loadChatHints(repaint);
    await flush();
    expect(repaint).toHaveBeenCalled();
    const drawn = drawFixes([MAIL, PASSPORT, SWITCH_OFF,
      { kind: 'source', thing_name: 'Anna’s body', pack_slug: 'body-signals-apple-health', pack_name: 'Body signals from Apple Health' }]);
    expect(withAttr(drawn, CHAT_HINT_NOT_NOW_ATTR).map((node) => node.attributes.get(CHAT_HINT_NOT_NOW_ATTR)))
      .toEqual(['feature:mail', 'thing:passport', 'source:body-signals-apple-health']);
    expect(withAttr(drawn, CHAT_HINT_NOT_NOW_ATTR)[0]!.textContent).toBe('Not now');
  });

  it('⛔ not on a step already done (a thing now in Yours)', async () => {
    const { actions } = server();
    setChatHintActions(actions);
    loadChatHints(() => {});
    await flush();
    const drawn = buildChatFixes(doc, 'm2', chatFixRows(answer([PASSPORT]), new Set(['thing:passport'])), () => {}) as unknown as FakeNode;
    expect(withAttr(drawn, CHAT_HINT_NOT_NOW_ATTR)).toEqual([]);
  });
});

describe('"Not now", and "Show it again"', () => {
  it('sets the hint aside with what the owner saw, says until when in its place, and brings it back', async () => {
    const { actions, calls } = server();
    setChatHintActions(actions);
    loadChatHints(() => {});
    await flush();
    let drawn = drawFixes([MAIL]);
    withAttr(drawn, CHAT_HINT_NOT_NOW_ATTR)[0]!.listeners.get('click')!();
    // Once: a second click while it is on its way does nothing.
    withAttr(drawFixes([MAIL]), CHAT_HINT_NOT_NOW_ATTR)[0]!.listeners.get('click')!();
    await flush();
    expect(calls).toEqual(['not_now feature:mail Connect your mail']);
    drawn = drawFixes([MAIL]);
    const aside = withAttr(drawn, CHAT_HINT_SET_ASIDE_ATTR);
    expect(aside.map((node) => node.attributes.get(CHAT_HINT_SET_ASIDE_ATTR))).toEqual(['feature:mail']);
    const until = chatHintSetAside('feature:mail')!.until;
    expect(text(drawn)).toContain(`Not now: “Connect your mail” is hidden until ${chatHintUntilText(until)}.`);
    expect(all(drawn).some((node) => node.tagName === 'A')).toBe(false);
    withAttr(drawn, CHAT_HINT_RESTORE_ATTR)[0]!.listeners.get('click')!();
    await flush();
    expect(calls).toEqual(['not_now feature:mail Connect your mail', 'restore feature:mail']);
    drawn = drawFixes([MAIL]);
    expect(withAttr(drawn, CHAT_HINT_SET_ASIDE_ATTR)).toEqual([]);
    expect(all(drawn).find((node) => node.tagName === 'A')?.textContent).toBe('Connect your mail');
  });

  it('a hint set aside on another device is set aside here; one past its time is back', async () => {
    const now = Date.now();
    const { actions } = server([
      { key: 'thing:passport', label: 'Add a Passport', until: now + DAY },
      { key: 'feature:mail', label: 'Connect your mail', until: now - 1 },
    ]);
    setChatHintActions(actions);
    loadChatHints(() => {});
    await flush();
    const drawn = drawFixes([PASSPORT, MAIL]);
    expect(withAttr(drawn, CHAT_HINT_SET_ASIDE_ATTR).map((node) => node.attributes.get(CHAT_HINT_SET_ASIDE_ATTR))).toEqual(['thing:passport']);
    expect(withAttr(drawn, CHAT_HINT_NOT_NOW_ATTR).map((node) => node.attributes.get(CHAT_HINT_NOT_NOW_ATTR))).toEqual(['feature:mail']);
  });

  it('says why when it fails, and keeps the button', async () => {
    const { actions } = server();
    setChatHintActions({ ...actions, notNow: async () => { throw new Error('The server is paused.'); } });
    loadChatHints(() => {});
    await flush();
    withAttr(drawFixes([MAIL]), CHAT_HINT_NOT_NOW_ATTR)[0]!.listeners.get('click')!();
    await flush();
    const drawn = drawFixes([MAIL]);
    expect(withAttr(drawn, CHAT_HINT_NOT_NOW_ATTR)).toHaveLength(1);
    expect(all(drawn).find((node) => node.attributes.get('role') === 'alert')?.textContent).toBe('The server is paused.');
  });
});

describe('an offer to get a pack or a recipe', () => {
  const PACK = { kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: ['Collect the rent'] };
  const RECIPE = { kind: 'recipe', slug: 'summarize-pdf', name: 'Summarize a PDF', publisher: 'recued-core', recipes: [] };
  const drawOffers = (): FakeNode => buildChatInstallOffers(doc,
    chatInstallOfferLinks({ role: 'assistant', install_offers: [PACK, RECIPE] } as Pick<ChatMessage, 'role' | 'install_offers'>),
    { messageId: 'm3', landed: new Set(), askAgain: async () => {}, repaint: () => {} }) as unknown as FakeNode;

  it('offers "Not now" on each, and sets one aside in its place', async () => {
    const { actions, calls } = server();
    setChatHintActions(actions);
    loadChatHints(() => {});
    await flush();
    const drawn = drawOffers();
    const buttons = withAttr(drawn, CHAT_HINT_NOT_NOW_ATTR);
    expect(buttons.map((node) => node.attributes.get(CHAT_HINT_NOT_NOW_ATTR))).toEqual(['offer:pack:rental-book', 'offer:recipe:summarize-pdf']);
    buttons[0]!.listeners.get('click')!();
    await flush();
    expect(calls).toEqual(['not_now offer:pack:rental-book Get Rental Book']);
    const after = drawOffers();
    expect(withAttr(after, CHAT_HINT_SET_ASIDE_ATTR).map((node) => node.attributes.get(CHAT_HINT_SET_ASIDE_ATTR))).toEqual(['offer:pack:rental-book']);
    expect(all(after).filter((node) => node.tagName === 'A').map((node) => node.textContent)).toEqual(['Get Summarize a PDF']);
  });
});
