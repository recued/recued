/** D-346 follow-up (2026-11-08) — what an answer's calls could not do and how the owner fixes
 *  it, under the answer: a link, or "Turn it on" for a switch of theirs. */
import { afterEach, describe, expect, it } from 'vitest';

import type { ChatMessage } from '@recued/contracts';

import { parseConnectionsAddress } from '../../connections/connections-navigation.js';
import { parseShellRoute } from '../../shell/route.js';
import {
  __resetChatFixStatus,
  buildChatFixes,
  CHAT_ASK_AGAIN_ATTR,
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

  // D-404 slice A — a type of thing the owner has none of: Yours' form with that type chosen,
  // and no button, since only the owner adds a thing.
  it('a thing to add links to Yours\' form with its type chosen, in the words the model was told', () => {
    setChatFixActions({ grant: async () => {}, program: async () => {} });
    const rows = chatFixRows(answer([{ kind: 'thing', type_id: 'travel_passport', type_name: 'Passport' }, MAIL_OFF]));
    expect(rows[0]).toEqual({
      key: 'thing:travel_passport',
      lead: 'No Passport in Yours yet.',
      link: { text: 'Add a Passport', href: '#yours/new/travel_passport' },
      hint: { key: 'thing:travel_passport', label: 'Add a Passport' },
    });
    expect(rows[1]!.lead).toBe("'mail.search' is turned off for you.");
    const drawn = buildChatFixes(doc, 'm3', rows.slice(0, 1), () => {}) as unknown as FakeNode;
    expect(all(drawn).some((node) => node.attributes.has(CHAT_FIX_ACTION_ATTR))).toBe(false);
    expect(all(drawn).find((node) => node.tagName === 'A')).toMatchObject({ href: '#yours/new/travel_passport', textContent: 'Add a Passport' });
  });

  // D-404 step 4 — a thing with no readings yet: the installed pack that feeds them, on its page.
  it('a thing with no readings links to the pack that feeds them, carrying its answer', () => {
    const rows = chatFixRows({ role: 'assistant', id: 'm7', session_id: 's1',
      fixes: [{ kind: 'source', thing_name: 'Anna’s body', pack_slug: 'body-signals-apple-health', pack_name: 'Body signals from Apple Health' }] } as never);
    expect(rows).toEqual([{ key: 'source:body-signals-apple-health', lead: 'No readings for Anna’s body yet.',
      link: { text: 'Set up Body signals from Apple Health', href: '#packs/body-signals-apple-health/return/chat/s1/m7' },
      hint: { key: 'source:body-signals-apple-health', label: 'Set up Body signals from Apple Health' } }]);
  });

  it('D-339 slice 23 — a step naming the Body opens Connect Apple Health on its page, with the way back to chat', () => {
    const fix = { kind: 'source', thing_name: 'Anna’s body', pack_slug: 'body-signals-apple-health', pack_name: 'Body signals from Apple Health', thing_id: 'body-1' };
    expect(chatFixRows({ role: 'assistant', id: 'm7', session_id: 's1', fixes: [fix] } as never)).toEqual([{ key: 'source:body-signals-apple-health',
      lead: 'No readings for Anna’s body yet.', link: { text: 'Connect Apple Health', href: '#yours/asset/body-1/setup/body-signals-apple-health/return/chat/s1/m7' },
      hint: { key: 'source:body-signals-apple-health', label: 'Connect Apple Health' } }]);
    // Another feeding pack is set up on its own page, named or not.
    const oura = { ...fix, pack_slug: 'body-signals-oura', pack_name: 'Body signals from Oura' };
    expect(chatFixRows({ role: 'assistant', id: 'm7', session_id: 's1', fixes: [oura] } as never)[0]!.link)
      .toEqual({ text: 'Set up Body signals from Oura', href: '#packs/body-signals-oura/return/chat/s1/m7' });
  });

  // D-404 slice B2 — from a stored answer, the link carries it, so Yours offers the way back.
  it('a thing\'s link carries its answer, when the answer has one', () => {
    const rows = chatFixRows({ role: 'assistant', id: 'm9', session_id: 's 1', fixes: [{ kind: 'thing', type_id: 'boiler', type_name: 'Boiler' }] } as never);
    expect(rows[0]!.link).toEqual({ text: 'Add a Boiler', href: '#yours/new/boiler/return/chat/s%201/m9' });
  });

  // D-405 slice 2 — a core feature with none connected: its lane on the Connections page.
  it('a feature with none connected links to its lane on the Connections page, in the words the model was told', () => {
    const rows = chatFixRows(answer([{ kind: 'feature', feature: 'mail' }, { kind: 'feature', feature: 'calendar' },
      { kind: 'feature', feature: 'file' }]));
    expect(rows).toEqual([
      { key: 'feature:mail', lead: 'No mailbox is connected yet.', link: { text: 'Connect your mail', href: '#connections/mail' },
        hint: { key: 'feature:mail', label: 'Connect your mail' } },
      { key: 'feature:calendar', lead: 'No calendar of yours is connected yet.', link: { text: 'Connect your calendar', href: '#connections/calendar' },
        hint: { key: 'feature:calendar', label: 'Connect your calendar' } },
      { key: 'feature:file', lead: 'No file source is connected yet.', link: { text: 'Connect your files', href: '#connections/file' },
        hint: { key: 'feature:file', label: 'Connect your files' } },
    ]);
    const drawn = buildChatFixes(doc, 'm11', rows.slice(0, 1), () => {}) as unknown as FakeNode;
    expect(all(drawn).find((node) => node.tagName === 'A')).toMatchObject({ href: '#connections/mail', textContent: 'Connect your mail' });
    // Each opens its own lane as the Connections page reads its address.
    expect(rows.map((row) => parseConnectionsAddress(parseShellRoute(row.link!.href))))
      .toEqual(['mail', 'calendar', 'file'].map((tab) => ({ kind: 'lane', tab })));
  });

  // D-405 slice 7 — the link carries the answer, as a thing's does, and the page reads it as the lane with
  // the way back. ⛔ Never as an account named "return", which is how slice 2's page would have read it.
  it('a stored answer\'s feature link carries it, and Connections reads it as the lane with the way back', () => {
    const stored = chatFixRows({ role: 'assistant', id: 'm12', session_id: 's1', fixes: [{ kind: 'feature', feature: 'calendar' }] } as never);
    expect(stored[0]!.link!.href).toBe('#connections/calendar/return/chat/s1/m12');
    expect(parseConnectionsAddress(parseShellRoute(stored[0]!.link!.href)))
      .toEqual({ kind: 'lane', tab: 'calendar', returnToChat: { sessionId: 's1', messageId: 'm12' } });
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
    expect(all(settled).map((node) => node.textContent)).toContain("'mail.search' is on now.");
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

// D-404 slice B1 (ruling P2) — once a step under the answer is done, the block ends with Ask again,
// which sends the request again; it may refuse, and says why in place.
describe('Ask again (D-404)', () => {
  const PASSPORT = { kind: 'thing', type_id: 'travel_passport', type_name: 'Passport' };
  const askButton = (node: FakeNode) => all(node).find((candidate) => candidate.attributes.has(CHAT_ASK_AGAIN_ATTR));

  it('a thing now in Yours reads so, with no link, and the block ends with Ask again', () => {
    const rows = chatFixRows(answer([PASSPORT]), new Set(['thing:travel_passport']));
    expect(rows).toEqual([{ key: 'thing:travel_passport', lead: 'A Passport is in Yours now.', link: null, landed: true }]);
    const drawn = buildChatFixes(doc, 'a1', rows, () => {}, async () => {}) as unknown as FakeNode;
    expect(askButton(drawn)?.textContent).toBe('Ask again');
  });

  it('a feature now connected reads so, with no link, and the block ends with Ask again (D-405 slice 2)', () => {
    const rows = chatFixRows(answer([{ kind: 'feature', feature: 'mail' }]), new Set(['feature:mail']));
    expect(rows).toEqual([{ key: 'feature:mail', lead: 'A mailbox is connected now.', link: null, landed: true }]);
    const drawn = buildChatFixes(doc, 'a9', rows, () => {}, async () => {}) as unknown as FakeNode;
    expect(askButton(drawn)?.textContent).toBe('Ask again');
  });

  it('none while nothing is done, nor without the chat to send it', () => {
    const waiting = buildChatFixes(doc, 'a2', chatFixRows(answer([PASSPORT])), () => {}, async () => {}) as unknown as FakeNode;
    expect(askButton(waiting)).toBeUndefined();
    const bare = buildChatFixes(doc, 'a3', chatFixRows(answer([PASSPORT]), new Set(['thing:travel_passport'])), () => {}) as unknown as FakeNode;
    expect(askButton(bare)).toBeUndefined();
  });

  it('sends once, says it asked, and a switch turned on here offers it too', async () => {
    let asked = 0;
    let release!: () => void;
    const askAgain = () => new Promise<void>((resolve) => { asked += 1; release = resolve; });
    setChatFixActions({ grant: async () => {}, program: async () => {} });
    const draw = () => buildChatFixes(doc, 'a4', chatFixRows(answer([MAIL_OFF])), () => {}, askAgain) as unknown as FakeNode;
    expect(askButton(draw())).toBeUndefined();
    all(draw()).find((node) => node.attributes.has(CHAT_FIX_ACTION_ATTR))!.listeners.get('click')!();
    await flush();
    const button = askButton(draw())!;
    button.listeners.get('click')!();
    button.listeners.get('click')!();
    expect(asked).toBe(1);
    expect(askButton(draw())!.attributes.has('disabled')).toBe(true);
    release();
    await flush();
    expect(askButton(draw())).toBeUndefined();
    expect(all(draw()).map((node) => node.textContent)).toContain('Asked again.');
  });

  it('says why it could not, and keeps the button', async () => {
    const draw = () => buildChatFixes(doc, 'a5', chatFixRows(answer([PASSPORT]), new Set(['thing:travel_passport'])), () => {},
      async () => { throw new Error('Send or clear the message you are writing, then ask again.'); }) as unknown as FakeNode;
    askButton(draw())!.listeners.get('click')!();
    await flush();
    expect(all(draw()).map((node) => node.textContent)).toContain('Send or clear the message you are writing, then ask again.');
    expect(askButton(draw())).toBeDefined();
  });
});
