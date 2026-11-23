/** D-405 slice 4 — the "Set up" page: each line from what the server says, the step on each, and a read
 *  that fails said on its own line, never read as "nothing to set up". A stub DOM, not a browser: the
 *  webclient suite has none (the route needs createElement, append/remove, attributes and clicks). */
import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapSetupRoute,
  SETUP_RESTORE_ATTR,
  SETUP_ROUTE_ATTR,
  SETUP_ROW_ATTR,
  SETUP_ROW_STATE_ATTR,
  SETUP_SUMMARY_ATTR,
  type SetupRouteCallers,
} from '../bootstrap-setup-route.js';
import { watchPackNeeds } from '../setup-pack-needs.js';

interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  children: FakeNode[];
  parent: FakeNode | null;
  textContent: string;
  className: string;
  id: string;
  listeners: Map<string, () => void>;
  readonly firstChild: FakeNode | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  remove(): void;
  addEventListener(kind: string, fn: () => void): void;
}
const makeNode = (tagName: string): FakeNode => {
  const node: FakeNode = {
    tagName, attributes: new Map(), children: [], parent: null, textContent: '', className: '', id: '', listeners: new Map(),
    get firstChild() { return node.children[0] ?? null; },
    setAttribute: (name, value) => { node.attributes.set(name, value); },
    getAttribute: (name) => node.attributes.get(name) ?? null,
    appendChild: (child) => { node.children.push(child); child.parent = node; return child; },
    removeChild: (child) => { node.children = node.children.filter((c) => c !== child); child.parent = null; return child; },
    remove: () => { node.parent?.removeChild(node); },
    addEventListener: (kind, fn) => { node.listeners.set(kind, fn); },
  };
  return node;
};
const fakeDocument = () => {
  const head = makeNode('HEAD');
  const doc = { head: Object.assign(head, { querySelector: () => null }), createElement: (tag: string) => makeNode(tag.toUpperCase()) };
  return doc as unknown as Document;
};
const all = (node: FakeNode): FakeNode[] => [node, ...node.children.flatMap(all)];
const text = (node: FakeNode): string => all(node).map((n) => n.textContent).join(' ');
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const rows = (root: FakeNode): Array<{ key: string; state: string; text: string; href?: string }> =>
  all(root).filter((n) => n.attributes.has(SETUP_ROW_ATTR)).map((n) => {
    const anchor = all(n).find((c) => c.tagName === 'A');
    return { key: n.attributes.get(SETUP_ROW_ATTR)!, state: n.attributes.get(SETUP_ROW_STATE_ATTR)!, text: text(n).replace(/\s+/gu, ' ').trim(),
      ...(anchor !== undefined ? { href: anchor.attributes.get('href')! } : {}) };
  });
const summary = (root: FakeNode): string => all(root).find((n) => n.attributes.has(SETUP_SUMMARY_ATTR))!.textContent;

const BODY_PACK = { slug: 'body-signals', name: 'Body signals', installed: true, missing_things: [{ type_id: 'body', type_name: 'Body' }] };
const LEDGER = { slug: 'expense-ledger', name: 'Expense Ledger', installed: true };

const mount = (callers: Partial<SetupRouteCallers>) => {
  const document = fakeDocument();
  const container = makeNode('MAIN');
  const route = bootstrapSetupRoute({ container: container as unknown as HTMLElement, document, callers: {
    features: async () => ({ features: [{ feature: 'mail', connected: true }, { feature: 'calendar', connected: true }, { feature: 'file', connected: true }] }),
    chatReady: async () => true,
    anyRecipe: async () => true,
    packs: { listInstalled: async () => ({ packs: [LEDGER] as never }) },
    hints: { list: async () => ({ not_now: [] }), restore: async () => ({ restored: true }) },
    ...callers,
  } });
  const root = () => container.children.find((n) => n.attributes.has(SETUP_ROUTE_ATTR))!;
  return { route, container, root };
};

describe('the Set up page', () => {
  it('says it is checking until the reads land', () => {
    const { root } = mount({ features: () => new Promise(() => undefined) });
    expect(summary(root())).toBe('Checking…');
    expect(rows(root()).find((row) => row.key === 'features')).toMatchObject({ state: 'checking' });
  });

  it('every line done: everything here is set up', async () => {
    const { root } = mount({});
    await flush();
    expect(summary(root())).toBe('Everything here is set up.');
    expect(rows(root()).map((row) => `${row.key} ${row.state}`)).toEqual([
      'chat done', 'feature:mail done', 'feature:calendar done', 'feature:file done', 'packs done', 'recipes done',
    ]);
    expect(rows(root()).find((row) => row.key === 'packs')?.text).toContain('The pack you installed has what it needs.');
  });

  it('what is missing, each with its step, in the chat\'s own words, and counted', async () => {
    const { root } = mount({
      features: async () => ({ features: [{ feature: 'mail', connected: false }, { feature: 'calendar', connected: true }, { feature: 'file', connected: false }] }),
      chatReady: async () => false,
      anyRecipe: async () => false,
      packs: { listInstalled: async () => ({ packs: [BODY_PACK, LEDGER] as never }) },
    });
    await flush();
    const lines = rows(root());
    expect(lines.find((row) => row.key === 'chat')).toMatchObject({ state: 'todo', href: '#settings/ai-models/setup/start' });
    expect(lines.find((row) => row.key === 'feature:mail')).toMatchObject({ state: 'todo', href: '#connections/mail' });
    expect(lines.find((row) => row.key === 'feature:mail')?.text).toContain('No mailbox is connected yet. Connect your mail');
    expect(lines.find((row) => row.key === 'feature:file')?.text).toContain('No file source is connected yet. Connect your files');
    expect(lines.find((row) => row.key === 'pack:body-signals')).toMatchObject({ state: 'todo', href: '#packs/body-signals' });
    expect(lines.find((row) => row.key === 'pack:body-signals')?.text).toContain('Needs a Body');
    expect(lines.find((row) => row.key === 'recipes')).toMatchObject({ state: 'todo', href: '#recipes' });
    // Chat, mail, files, the pack, recipes.
    expect(summary(root())).toBe('5 things to set up.');
  });

  it('⛔ a read that fails says so on its own line, and the page never says everything is set up', async () => {
    const { root } = mount({ features: async () => { throw new Error('offline'); } });
    await flush();
    expect(rows(root()).find((row) => row.key === 'features')).toMatchObject({ state: 'unknown' });
    expect(text(root())).toContain('Recued could not check your mail, calendar and files.');
    expect(summary(root())).toBe('Nothing else to set up that Recued could check.');
  });

  it('⛔ an answer naming no feature is a server that could not say, not "none connected"', async () => {
    const { root } = mount({ features: async () => ({}) });
    await flush();
    expect(rows(root()).find((row) => row.key === 'features')).toMatchObject({ state: 'unknown' });
    expect(text(root())).not.toContain('No mailbox is connected yet');
  });

  it('⛔ a feature the server cannot know (null) is said so, and is not counted as either', async () => {
    const { root } = mount({ features: async () => ({ features: [{ feature: 'mail', connected: true }, { feature: 'calendar', connected: true },
      { feature: 'file', connected: null }] }) });
    await flush();
    expect(rows(root()).find((row) => row.key === 'feature:file')).toMatchObject({ state: 'unknown' });
    expect(summary(root())).toBe('Nothing else to set up that Recued could check.');
  });

  it('packs: none installed, or the roster not read', async () => {
    const none = mount({ packs: { listInstalled: async () => ({ packs: [{ ...LEDGER, installed: false }] as never }) } });
    await flush();
    expect(rows(none.root()).find((row) => row.key === 'packs')).toMatchObject({ state: 'todo', href: '#packs' });
    expect(text(none.root())).toContain('No pack is installed yet.');
    const failed = mount({ packs: { listInstalled: async () => { throw new Error('no'); } } });
    await flush();
    expect(rows(failed.root()).find((row) => row.key === 'packs')).toMatchObject({ state: 'unknown' });
  });

  it('the hints set aside, each shown again from here', async () => {
    const until = Date.now() + 86_400_000;
    const restore = vi.fn(async () => ({ restored: true }));
    const { root } = mount({ hints: { list: async () => ({ not_now: [{ key: 'feature:mail', label: 'Connect your mail', until },
      { key: 'thing:passport', label: 'Add a Passport', until: Date.now() - 1 }] }), restore } });
    await flush();
    // One past its time is back already: not listed.
    expect(rows(root()).filter((row) => row.key.startsWith('hint:')).map((row) => row.key)).toEqual(['hint:feature:mail']);
    const button = all(root()).find((n) => n.attributes.get(SETUP_RESTORE_ATTR) === 'feature:mail')!;
    button.listeners.get('click')!();
    await flush();
    expect(restore).toHaveBeenCalledWith('feature:mail');
    expect(rows(root()).some((row) => row.key.startsWith('hint:'))).toBe(false);
  });

  it('says why "Show it again" failed, and keeps the line', async () => {
    const { root } = mount({ hints: { list: async () => ({ not_now: [{ key: 'feature:mail', label: 'Connect your mail', until: Date.now() + 1e6 }] }),
      restore: async () => { throw new Error('The server is paused.'); } } });
    await flush();
    all(root()).find((n) => n.attributes.get(SETUP_RESTORE_ATTR) === 'feature:mail')!.listeners.get('click')!();
    await flush();
    expect(all(root()).find((n) => n.attributes.get('role') === 'alert')?.textContent).toBe('The server is paused.');
    expect(rows(root()).some((row) => row.key === 'hint:feature:mail')).toBe(true);
  });

  it('dispose takes the page away, and a read that lands after it paints nothing', async () => {
    let answer: (value: { features: unknown }) => void = () => undefined;
    const { route, container } = mount({ features: () => new Promise((resolve) => { answer = resolve; }) });
    route.dispose();
    expect(container.children).toEqual([]);
    answer({ features: [] });
    await flush();
    expect(container.children).toEqual([]);
  });
});

describe('what each pack still needs, as the Packs page reads it', () => {
  it('the roster\'s own needs at once, then each other read as it lands; a failed read adds nothing', async () => {
    const views: unknown[] = [];
    let unrunnable: (value: { findings: Array<{ slug: string }> }) => void = () => undefined;
    const stop = watchPackNeeds({
      listInstalled: async () => ({ packs: [BODY_PACK, LEDGER] as never }),
      listUnrunnable: () => new Promise((resolve) => { unrunnable = resolve; }),
      listToolStatus: async () => { throw new Error('probe timed out'); },
    }, (view) => { views.push(view); });
    await flush();
    expect(views.at(-1)).toEqual({ installed: 2, needs: [{ slug: 'body-signals', name: 'Body signals', labels: ['Needs a Body'] }] });
    unrunnable({ findings: [{ slug: 'expense-ledger' }] });
    await flush();
    expect(views.at(-1)).toMatchObject({ needs: [{ slug: 'body-signals' }, { slug: 'expense-ledger', labels: ['Needs update'] }] });
    stop();
  });

  it('⛔ an answer with no roster in it is one that could not be read, never "no packs"; other odd answers add nothing', async () => {
    const views: unknown[] = [];
    watchPackNeeds({ listInstalled: async () => ({}) as never }, (view) => { views.push(view); });
    await flush();
    expect(views).toEqual([null]);
    const odd: unknown[] = [];
    watchPackNeeds({ listInstalled: async () => ({ packs: [BODY_PACK] as never }), listUnrunnable: async () => ({}) as never,
      listToolStatus: async () => ({}) as never }, (view) => { odd.push(view); });
    await flush();
    expect(odd.at(-1)).toEqual({ installed: 1, needs: [{ slug: 'body-signals', name: 'Body signals', labels: ['Needs a Body'] }] });
  });

  it('null when the roster cannot be read; nothing once stopped', async () => {
    const views: unknown[] = [];
    watchPackNeeds({ listInstalled: async () => { throw new Error('no'); } }, (view) => { views.push(view); });
    await flush();
    expect(views).toEqual([null]);
    const later: unknown[] = [];
    const stop = watchPackNeeds({ listInstalled: async () => ({ packs: [BODY_PACK] as never }) }, (view) => { later.push(view); });
    stop();
    await flush();
    expect(later).toEqual([]);
  });
});

// D-405 slice 9 — the page stays current while it is open: each event reads again the lines it can change,
// quietly and once for a burst, and coming back to the page's tab reads every line.
describe('the Set up page while it is open', () => {
  type Listener = (event: unknown) => void;
  /** The app's subscriber, as the page is handed it: listeners by kind, and a way to send an event. */
  const bus = () => {
    const listeners = new Map<string, Listener[]>();
    const subscribe = ((kind: string, listener: Listener) => {
      listeners.set(kind, [...(listeners.get(kind) ?? []), listener]);
      return () => { listeners.set(kind, (listeners.get(kind) ?? []).filter((held) => held !== listener)); };
    }) as unknown as NonNullable<Parameters<typeof bootstrapSetupRoute>[0]['subscribe']>;
    const emit = (kind: string, event: object = {}) => { for (const listener of listeners.get(kind) ?? []) listener({ kind, cursor: 1, ...event }); };
    const count = () => [...listeners.values()].reduce((n, held) => n + held.length, 0);
    return { subscribe, emit, count };
  };
  /** A document whose tab can be hidden and shown. */
  const tabbedDocument = () => {
    const document = fakeDocument() as unknown as Record<string, unknown>;
    const shown: Array<() => void> = [];
    document.visibilityState = 'visible';
    document.addEventListener = (kind: string, fn: () => void) => { if (kind === 'visibilitychange') shown.push(fn); };
    document.removeEventListener = (kind: string, fn: () => void) => { if (kind === 'visibilitychange') shown.splice(shown.indexOf(fn), 1); };
    const show = (state: 'visible' | 'hidden') => { document.visibilityState = state; for (const fn of [...shown]) fn(); };
    return { document: document as unknown as Document, show, listening: () => shown.length };
  };
  const live = (callers: Partial<SetupRouteCallers>, document = fakeDocument()) => {
    const events = bus();
    const container = makeNode('MAIN');
    const route = bootstrapSetupRoute({ container: container as unknown as HTMLElement, document, subscribe: events.subscribe, callers: {
      features: async () => ({ features: [{ feature: 'mail', connected: true }, { feature: 'calendar', connected: true }, { feature: 'file', connected: true }] }),
      chatReady: async () => true,
      anyRecipe: async () => true,
      packs: { listInstalled: async () => ({ packs: [LEDGER] as never }) },
      hints: { list: async () => ({ not_now: [] }), restore: async () => ({ restored: true }) },
      ...callers,
    } });
    const root = () => container.children.find((n) => n.attributes.has(SETUP_ROUTE_ATTR))!;
    return { route, root, events };
  };
  const NO_MAIL = { features: [{ feature: 'mail', connected: false }, { feature: 'calendar', connected: true }, { feature: 'file', connected: true }] };
  const ALL_THREE = { features: [{ feature: 'mail', connected: true }, { feature: 'calendar', connected: true }, { feature: 'file', connected: true }] };
  const lineState = (root: FakeNode, key: string) => rows(root).find((row) => row.key === key)?.state;

  it('a pack installed elsewhere: packs and recipes read again, once for a burst, never shown as checking', async () => {
    vi.useFakeTimers();
    try {
      let installed = false;
      const listInstalled = vi.fn(async () => ({ packs: (installed ? [LEDGER] : []) as never }));
      const anyRecipe = vi.fn(async () => installed);
      const features = vi.fn(async () => ALL_THREE);
      const chatReady = vi.fn(async () => true);
      const { root, events } = live({ packs: { listInstalled }, anyRecipe, features, chatReady });
      await flush();
      expect([lineState(root(), 'packs'), lineState(root(), 'recipes')]).toEqual(['todo', 'todo']);
      installed = true;
      events.emit('pack_installed', { slug: 'expense-ledger' });
      events.emit('pack_installed', { slug: 'expense-ledger' });
      events.emit('pack_uninstalled', { slug: 'other' });
      vi.advanceTimersByTime(499);
      await flush();
      expect(listInstalled).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      // Read again, and meanwhile the lines still say what they said.
      expect([lineState(root(), 'packs'), lineState(root(), 'recipes')]).toEqual(['todo', 'todo']);
      await flush();
      expect(listInstalled).toHaveBeenCalledTimes(2);
      expect(anyRecipe).toHaveBeenCalledTimes(2);
      expect([lineState(root(), 'packs'), lineState(root(), 'recipes')]).toEqual(['done', 'done']);
      // What a pack cannot change is not read again.
      expect(features).toHaveBeenCalledTimes(1);
      expect(chatReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mail records arriving: the mail line reads again until it says one is connected, then a sync reads nothing more', async () => {
    vi.useFakeTimers();
    try {
      let answer: object = NO_MAIL;
      const features = vi.fn(async () => answer);
      const { root, events } = live({ features });
      await flush();
      expect(lineState(root(), 'feature:mail')).toBe('todo');
      answer = ALL_THREE;
      events.emit('warehouse', { collection: 'mail', op: 'insert', id: 'm1' });
      vi.advanceTimersByTime(500);
      await flush();
      expect(features).toHaveBeenCalledTimes(2);
      expect(lineState(root(), 'feature:mail')).toBe('done');
      events.emit('warehouse', { collection: 'mail', op: 'insert', id: 'm2' });
      events.emit('warehouse', { collection: 'contact', op: 'insert', id: 'anna@example.com' });
      vi.advanceTimersByTime(500);
      await flush();
      expect(features).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a connection or a sign-in that changes what recipes can run: the packs and the files line read again', async () => {
    vi.useFakeTimers();
    try {
      const features = vi.fn(async () => ALL_THREE);
      const listInstalled = vi.fn(async () => ({ packs: [LEDGER] as never }));
      const chatReady = vi.fn(async () => true);
      const { events } = live({ features, packs: { listInstalled }, chatReady });
      await flush();
      events.emit('recipe_runnability_changed', { recipes: [] });
      vi.advanceTimersByTime(500);
      await flush();
      events.emit('connection.vendor_oauth_completed', { name: 'drive' });
      vi.advanceTimersByTime(500);
      await flush();
      expect(features).toHaveBeenCalledTimes(3);
      expect(listInstalled).toHaveBeenCalledTimes(3);
      expect(chatReady).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('back to the page\'s tab: every line reads again; hidden, nothing does', async () => {
    vi.useFakeTimers();
    try {
      const tab = tabbedDocument();
      const features = vi.fn(async () => ALL_THREE);
      const chatReady = vi.fn(async () => true);
      const hintsList = vi.fn(async () => ({ not_now: [] }));
      live({ features, chatReady, hints: { list: hintsList, restore: async () => ({}) } }, tab.document);
      await flush();
      tab.show('hidden');
      vi.advanceTimersByTime(500);
      await flush();
      expect(features).toHaveBeenCalledTimes(1);
      tab.show('visible');
      vi.advanceTimersByTime(500);
      await flush();
      expect([features, chatReady, hintsList].map((read) => read.mock.calls.length)).toEqual([2, 2, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read that changes nothing leaves the page as drawn; one that changes a line draws it again', async () => {
    vi.useFakeTimers();
    try {
      let answer: object = ALL_THREE;
      const { root, events } = live({ features: async () => answer });
      await flush();
      const before = all(root()).find((n) => n.attributes.get(SETUP_ROW_ATTR) === 'feature:mail');
      events.emit('recipe_runnability_changed', { recipes: [] });
      vi.advanceTimersByTime(500);
      await flush();
      expect(all(root()).find((n) => n.attributes.get(SETUP_ROW_ATTR) === 'feature:mail')).toBe(before);
      answer = NO_MAIL;
      events.emit('recipe_runnability_changed', { recipes: [] });
      vi.advanceTimersByTime(500);
      await flush();
      expect(all(root()).find((n) => n.attributes.get(SETUP_ROW_ATTR) === 'feature:mail')).not.toBe(before);
      expect(lineState(root(), 'feature:mail')).toBe('todo');
    } finally {
      vi.useRealTimers();
    }
  });

  it('⛔ another line read again never drops a line\'s own read still on its way', async () => {
    vi.useFakeTimers();
    try {
      let land!: (value: object) => void;
      const features = vi.fn(() => new Promise<object>((resolve) => { land = resolve; }));
      const { root, events } = live({ features });
      await flush();
      expect(lineState(root(), 'features')).toBe('checking');
      events.emit('pack_installed', { slug: 'expense-ledger' });
      vi.advanceTimersByTime(500);
      await flush();
      land(ALL_THREE);
      await flush();
      expect(lineState(root(), 'feature:mail')).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('⛔ an older read of a line that lands after a newer one is dropped', async () => {
    vi.useFakeTimers();
    try {
      const lands: Array<(value: object) => void> = [];
      const features = vi.fn(() => new Promise<object>((resolve) => { lands.push(resolve); }));
      const { root, events } = live({ features });
      lands[0]!(NO_MAIL);
      await flush();
      events.emit('recipe_runnability_changed', { recipes: [] });
      vi.advanceTimersByTime(500);
      await flush();
      events.emit('connection.vendor_oauth_completed', { name: 'drive' });
      vi.advanceTimersByTime(500);
      await flush();
      lands[2]!(ALL_THREE);
      await flush();
      lands[1]!(NO_MAIL);
      await flush();
      expect(lineState(root(), 'feature:mail')).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closed: it stops listening, and nothing reads again', async () => {
    vi.useFakeTimers();
    try {
      const tab = tabbedDocument();
      const features = vi.fn(async () => ALL_THREE);
      const { route, events } = live({ features }, tab.document);
      await flush();
      events.emit('pack_installed', { slug: 'expense-ledger' });
      route.dispose();
      expect(events.count()).toBe(0);
      expect(tab.listening()).toBe(0);
      vi.advanceTimersByTime(500);
      await flush();
      expect(features).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
