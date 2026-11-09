/** D-346 follow-up (2026-11-08) — what an answer's calls could not do and how the owner fixes
 *  it, under the answer: a link, or "Turn it on" for a switch of theirs. */
import { afterEach, describe, expect, it } from 'vitest';

import type { ChatMessage } from '@recued/contracts';

import {
  __resetChatFixStatus,
  buildChatFixes,
  CHAT_FIX_ACTION_ATTR,
  CHAT_FIXES_ATTR,
  chatFixRows,
  setChatFixActions,
} from '../chat-fixes.js';

const answer = (fixes: unknown): Pick<ChatMessage, 'role' | 'fixes'> =>
  ({ role: 'assistant', fixes } as Pick<ChatMessage, 'role' | 'fixes'>);
const MAIL_OFF = { kind: 'switch', entry_key: 'primitive.mail.search', label: "'mail.search'" };
const RG_OFF = {
  kind: 'run_need',
  need: { kind: 'switch', step_id: 'find', ingredient_id: 'rg-catalog', operation_id: 'search', pack_slug: 'ripgrep', label: 'Ripgrep' },
};
const RECONNECT = {
  kind: 'run_need',
  need: { kind: 'connection', step_id: 'deal', problem: 'reconnect', slot: 'hubspot', connection_name: 'hs-key', label: 'HubSpot' },
};

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
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

afterEach(() => {
  setChatFixActions(null);
  __resetChatFixStatus();
});

describe('the rows', () => {
  it('a switch of the owner\'s, a program switched off, a sign-in to reconnect', () => {
    setChatFixActions({ grant: async () => {}, program: async () => {} });
    const rows = chatFixRows(answer([MAIL_OFF, RG_OFF, RECONNECT]));
    expect(rows.map((row) => row.lead)).toEqual([
      "'mail.search' is turned off for you.",
      'Ripgrep runs a program on your server that is switched off for you, so the run stopped there.',
      'HubSpot did not accept this run’s sign-in. Reconnect it, then run again.',
    ]);
    expect(rows.map((row) => row.action?.text)).toEqual(['Turn it on', 'Turn it on', undefined]);
    expect(rows[0]!.link).toEqual({ text: 'Open Self (you)', href: '#contracts/user_self' });
  });

  it('links only when the chat cannot turn it on; nothing for the owner\'s own message', () => {
    expect(chatFixRows(answer([MAIL_OFF]))[0]!.action).toBeUndefined();
    expect(chatFixRows({ role: 'user', fixes: [MAIL_OFF] } as never)).toEqual([]);
    expect(chatFixRows(answer([{ kind: 'switch', entry_key: 'pub/cat.op', label: 'x' }]))).toEqual([]);
  });
});

describe('the block under the answer', () => {
  it('turns the switch on in one click, once, then says it is on', async () => {
    const turned: string[] = [];
    let release!: () => void;
    setChatFixActions({
      grant: (entry_key) => new Promise<void>((resolve) => { turned.push(entry_key); release = resolve; }),
      program: async () => {},
    });
    let paints = 0;
    const draw = (): FakeNode => buildChatFixes(doc, 'm1', chatFixRows(answer([MAIL_OFF])), () => { paints += 1; }) as unknown as FakeNode;
    const first = draw();
    expect(first.attributes.has(CHAT_FIXES_ATTR)).toBe(true);
    const button = all(first).find((node) => node.attributes.has(CHAT_FIX_ACTION_ATTR))!;
    expect(button.textContent).toBe('Turn it on');
    button.listeners.get('click')!();
    button.listeners.get('click')!();
    expect(turned).toEqual(['primitive.mail.search']);
    expect(all(draw()).find((node) => node.attributes.has(CHAT_FIX_ACTION_ATTR))!.attributes.has('disabled')).toBe(true);
    release();
    await flush();
    expect(paints).toBeGreaterThanOrEqual(2);
    const settled = draw();
    expect(all(settled).some((node) => node.attributes.has(CHAT_FIX_ACTION_ATTR))).toBe(false);
    // Once on, the line says so in place of what was off (live, 2026-11-08).
    expect(all(settled).map((node) => node.textContent)).toContain("'mail.search' is on now. Ask again.");
    expect(all(settled).map((node) => node.textContent)).not.toContain("'mail.search' is turned off for you.");
  });

  it('says why when it fails, and keeps the button', async () => {
    setChatFixActions({ grant: async () => { throw new Error('the server is locked'); }, program: async () => {} });
    const draw = (): FakeNode => buildChatFixes(doc, 'm2', chatFixRows(answer([MAIL_OFF])), () => {}) as unknown as FakeNode;
    all(draw()).find((node) => node.attributes.has(CHAT_FIX_ACTION_ATTR))!.listeners.get('click')!();
    await flush();
    const settled = draw();
    expect(all(settled).map((node) => node.textContent)).toContain('the server is locked');
    expect(all(settled).some((node) => node.attributes.has(CHAT_FIX_ACTION_ATTR))).toBe(true);
  });
});
