/** D-402 slice F4d (§7.9, rulings 4 and 12) — "what runs without asking" on the owner's pages
 *  (`contracts/caller-preapproval-panel.ts`): one card per caller and recipe, by name; **End it** asks
 *  once more, ends everything that caller may do with that recipe (`stopAllowing`), and says what it
 *  ended; an AI app's page ends them all at once. A recipe's page and an app's page list only their own.
 *  Nothing to list, or a server from before it: the section is hidden. The route mounts (Contracts, a
 *  recipe's page, an AI app's contract page) are checked in a real browser. */

import { describe, expect, it, vi } from 'vitest';
import type { CallerPreapprovalView, PreapprovalCaller, StopAllowingResult } from '@recued/contracts';

import {
  CALLER_PREAPPROVAL_LIVE_REFRESH_MS,
  CALLER_PREAPPROVAL_PANEL_BROADCAST_KINDS,
  CALLER_PREAPPROVAL_PANEL_CONFIRM_ATTR,
  CALLER_PREAPPROVAL_PANEL_END_ALL_ATTR,
  CALLER_PREAPPROVAL_PANEL_END_ATTR,
  CALLER_PREAPPROVAL_PANEL_ERROR_ATTR,
  CALLER_PREAPPROVAL_PANEL_NOTE_ATTR,
  CALLER_PREAPPROVAL_PANEL_ROW_ATTR,
  mountCallerPreapprovalPanel,
} from '../contracts/caller-preapproval-panel.js';
import { WEBCLIENT_DEFAULT_SUBSCRIPTIONS } from '../realtime/subscriber.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  tabIndex: number;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  hidden: boolean;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  remove(): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  contains(other: FakeEl | null): boolean;
  addEventListener(type: string, fn: () => void): void;
  focus(): void;
  click(): void;
}

const fakeDocument = () => {
  const doc = { activeElement: null as FakeEl | null, body: null as unknown as FakeEl, createElement: (tag: string) => element(tag) };
  const element = (tag: string): FakeEl => {
    const el: FakeEl = {
      tagName: tag.toUpperCase(), className: '', textContent: '', type: '', tabIndex: 0, attrs: new Map(), children: [],
      parent: null, hidden: false, listeners: new Map(),
      get firstChild() { return el.children[0] ?? null; },
      remove() { el.parent?.removeChild(el); },
      setAttribute(k, v) { el.attrs.set(k, v); },
      getAttribute(k) { return el.attrs.get(k) ?? null; },
      appendChild(c) { el.children.push(c); c.parent = el; return c; },
      removeChild(c) {
        el.children.splice(el.children.indexOf(c), 1);
        c.parent = null;
        // As a browser does: focus inside a removed node falls to <body>.
        if (doc.activeElement !== null && (c === doc.activeElement || c.contains(doc.activeElement))) doc.activeElement = doc.body;
        return c;
      },
      contains(other) {
        for (let at = other; at !== null; at = at.parent) if (at === el) return true;
        return false;
      },
      addEventListener(type, fn) { el.listeners.set(type, [...(el.listeners.get(type) ?? []), fn]); },
      focus() { doc.activeElement = el; },
      click() { for (const fn of el.listeners.get('click') ?? []) fn(); },
    };
    return el;
  };
  doc.body = element('body');
  return doc;
};

const all = (root: FakeEl, attr: string, value?: string): FakeEl[] => [
  ...(root.attrs.has(attr) && (value === undefined || root.attrs.get(attr) === value) ? [root] : []),
  ...root.children.flatMap((c) => all(c, attr, value)),
];
const one = (root: FakeEl, attr: string, value?: string): FakeEl => {
  const found = all(root, attr, value);
  if (found.length !== 1) throw new Error(`expected one [${attr}${value !== undefined ? `=${value}` : ''}], found ${found.length}`);
  return found[0]!;
};
const text = (root: FakeEl): string => [root.textContent, ...root.children.map(text)].join(' ').replace(/\s+/gu, ' ').trim();
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

const OWNER: PreapprovalCaller = { kind: 'owner_chat' };
const CLAUDE: PreapprovalCaller = { kind: 'ai_app', contract_id: 'k-claude' };
const NONE: StopAllowingResult = { preapprovals: 0, site_passes: 0, session_grants: 0, delegations: 0, write_rules: 0 };

const row = (over: Partial<CallerPreapprovalView>): CallerPreapprovalView => ({
  id: 'p1', caller: OWNER, recipe_id: 'file-bill', recipe_sha256: 'a'.repeat(64), uses: 0, created_at: 1,
  state: 'live', recipe_name: 'File the water bill', caller_name: 'your chats',
  ...over,
});

/** Your chats: an "Always" for the bill (used twice, and an earlier version's, used once), and this
 *  run's "Yes" for the notes. Claude Desktop: an "Always" for the bill and for the notes. An ended one. */
const ROWS: CallerPreapprovalView[] = [
  row({ id: 'p1', uses: 2 }),
  row({ id: 'p2', uses: 1, recipe_sha256: 'b'.repeat(64), state: 'outdated' }),
  row({ id: 'p3', recipe_id: 'add-note', recipe_name: 'Add a note', run_id: 'run-1' }),
  row({ id: 'p4', caller: CLAUDE, caller_name: 'Claude Desktop', uses: 5 }),
  row({ id: 'p5', caller: CLAUDE, caller_name: 'Claude Desktop', recipe_id: 'add-note', recipe_name: 'Add a note', uses: 0 }),
  row({ id: 'p6', caller: CLAUDE, caller_name: 'Claude Desktop', recipe_id: 'old-recipe', recipe_name: 'Gone', state: 'revoked', revoked_at: 2 }),
];

const mount = (options: { rows?: CallerPreapprovalView[]; only?: { recipe_id?: string; contract_id?: string }; endAll?: boolean;
  list?: () => Promise<{ preapprovals: CallerPreapprovalView[] }>;
  stop?: (args: { caller: PreapprovalCaller; recipe_id: string }) => Promise<{ ended: StopAllowingResult }>;
  subscribe?: (kind: string, listener: (event: { holder: string }) => void) => () => void } = {}) => {
  const doc = fakeDocument();
  const host = doc.createElement('section');
  doc.body.appendChild(host);
  let rows = options.rows ?? ROWS;
  const list = vi.fn(options.list ?? (async () => ({ preapprovals: rows })));
  // As the server does: everything that caller held for the recipe ends.
  const stopAllowing = vi.fn(options.stop ?? (async (args: { caller: PreapprovalCaller; recipe_id: string }) => {
    const ending = rows.filter((one) => one.recipe_id === args.recipe_id && one.state !== 'revoked'
      && one.caller.kind === args.caller.kind && (one.caller.kind === 'owner_chat' || (args.caller.kind === 'ai_app' && one.caller.contract_id === args.caller.contract_id)));
    rows = rows.map((one) => (ending.includes(one) ? { ...one, state: 'revoked' as const, revoked_at: 3 } : one));
    return { ended: { ...NONE, preapprovals: ending.length, site_passes: args.recipe_id === 'file-bill' ? 2 : 0 } };
  }));
  const onEnded = vi.fn();
  const panel = mountCallerPreapprovalPanel({
    host: host as unknown as HTMLElement, document: doc as unknown as Document, callers: { list, stopAllowing }, onEnded,
    heading: 'Recipes that run without asking',
    ...(options.only !== undefined ? { only: options.only } : {}), ...(options.endAll !== undefined ? { endAll: options.endAll } : {}),
    ...(options.subscribe !== undefined ? { subscribe: options.subscribe as never } : {}),
  });
  return { doc, host, panel, list, stopAllowing, onEnded };
};

describe('D-402 slice F4d — what runs without asking, and ending it', () => {
  it('one card per caller and recipe, by name; ended ones are gone; what is left of each, or why it covers nothing', async () => {
    const m = mount();
    await m.panel.whenLoaded();
    const cards = all(m.host, CALLER_PREAPPROVAL_PANEL_ROW_ATTR);
    expect(cards.map((card) => card.getAttribute(CALLER_PREAPPROVAL_PANEL_ROW_ATTR))).toEqual(
      ['owner_chat|file-bill', 'owner_chat|add-note', 'ai_app:k-claude|file-bill', 'ai_app:k-claude|add-note']);
    expect(cards.map(text)).toEqual([
      'File the water bill Your chats run it without asking Every time, until you end it · used 2 times End it',
      'Add a note Your chats run it without asking This run only: it ends with the run End it',
      'File the water bill Claude Desktop runs it without asking Every time, until you end it · used 5 times End it',
      'Add a note Claude Desktop runs it without asking Every time, until you end it End it',
    ]);
    expect(text(m.host)).not.toContain('Gone');
    // Only an earlier version left: it says so.
    const old = mount({ rows: [row({ state: 'outdated' })] });
    await old.panel.whenLoaded();
    expect(text(one(old.host, CALLER_PREAPPROVAL_PANEL_ROW_ATTR))).toContain('Not in use: the recipe changed since, so it asks again');
  });

  it('"End it" asks once more, then ends everything that caller may do with the recipe, and says what it ended', async () => {
    const m = mount();
    await m.panel.whenLoaded();
    one(m.host, CALLER_PREAPPROVAL_PANEL_END_ATTR, 'owner_chat|file-bill').click();
    expect(m.stopAllowing).not.toHaveBeenCalled();
    const confirm = one(m.host, CALLER_PREAPPROVAL_PANEL_CONFIRM_ATTR, 'owner_chat|file-bill');
    expect(m.doc.activeElement).toBe(confirm);
    confirm.click();
    await tick();
    expect(m.stopAllowing).toHaveBeenCalledTimes(1);
    expect(m.stopAllowing).toHaveBeenCalledWith({ caller: OWNER, recipe_id: 'file-bill' });
    expect(text(one(m.host, CALLER_PREAPPROVAL_PANEL_NOTE_ATTR)))
      .toBe('Ended 2 standing approvals and 2 site passes. It asks again from now on.');
    expect(m.onEnded).toHaveBeenCalledWith({ ...NONE, preapprovals: 2, site_passes: 2 });
    // Your chats' card for it is gone; Claude Desktop's is not.
    expect(all(m.host, CALLER_PREAPPROVAL_PANEL_ROW_ATTR).map((card) => card.getAttribute(CALLER_PREAPPROVAL_PANEL_ROW_ATTR)))
      .toEqual(['owner_chat|add-note', 'ai_app:k-claude|file-bill', 'ai_app:k-claude|add-note']);
  });

  it('a recipe\'s page lists who runs it; an app\'s page lists its recipes, and "End all" ends each', async () => {
    const recipe = mount({ only: { recipe_id: 'file-bill' } });
    await recipe.panel.whenLoaded();
    expect(all(recipe.host, CALLER_PREAPPROVAL_PANEL_ROW_ATTR).map(text)).toEqual([
      'Your chats Every time, until you end it · used 2 times End it',
      'Claude Desktop Every time, until you end it · used 5 times End it',
    ]);
    expect(all(recipe.host, CALLER_PREAPPROVAL_PANEL_END_ALL_ATTR)).toEqual([]);

    const app = mount({ only: { contract_id: 'k-claude' }, endAll: true });
    await app.panel.whenLoaded();
    expect(all(app.host, CALLER_PREAPPROVAL_PANEL_ROW_ATTR).map(text)).toEqual([
      'File the water bill Every time, until you end it · used 5 times End it',
      'Add a note Every time, until you end it End it',
    ]);
    one(app.host, CALLER_PREAPPROVAL_PANEL_END_ALL_ATTR).click();
    expect(app.stopAllowing).not.toHaveBeenCalled();
    one(app.host, CALLER_PREAPPROVAL_PANEL_CONFIRM_ATTR, 'all').click();
    await tick();
    expect(app.stopAllowing.mock.calls.map(([args]) => args)).toEqual([
      { caller: CLAUDE, recipe_id: 'file-bill' }, { caller: CLAUDE, recipe_id: 'add-note' }]);
    expect(text(one(app.host, CALLER_PREAPPROVAL_PANEL_NOTE_ATTR)))
      .toBe('Ended 2 standing approvals and 2 site passes. They ask again from now on.');
    expect(all(app.host, CALLER_PREAPPROVAL_PANEL_ROW_ATTR)).toEqual([]);
    // What it said stays until the owner moves on.
    expect(app.host.hidden).toBe(false);
  });

  it('a refusal says why and claims nothing; nothing to list, or a server from before it: hidden', async () => {
    const refused = mount({ stop: async () => { throw new Error('collection.contract.stopAllowing: the store is busy'); } });
    await refused.panel.whenLoaded();
    one(refused.host, CALLER_PREAPPROVAL_PANEL_END_ATTR, 'owner_chat|file-bill').click();
    one(refused.host, CALLER_PREAPPROVAL_PANEL_CONFIRM_ATTR, 'owner_chat|file-bill').click();
    await tick();
    expect(text(one(refused.host, CALLER_PREAPPROVAL_PANEL_ERROR_ATTR))).toBe('Recued could not end it: the store is busy');
    expect(all(refused.host, CALLER_PREAPPROVAL_PANEL_NOTE_ATTR)).toEqual([]);
    expect(refused.onEnded).not.toHaveBeenCalled();
    // The owner can try again from where they were.
    expect(refused.doc.activeElement).toBe(one(refused.host, CALLER_PREAPPROVAL_PANEL_CONFIRM_ATTR, 'owner_chat|file-bill'));

    const empty = mount({ rows: [] });
    expect(empty.host.hidden).toBe(true);
    await empty.panel.whenLoaded();
    expect(empty.host.hidden).toBe(true);
    const otherRecipe = mount({ only: { recipe_id: 'nothing-here' } });
    await otherRecipe.panel.whenLoaded();
    expect(otherRecipe.host.hidden).toBe(true);

    const old = mount({ list: async () => { throw Object.assign(new Error('collection.contract.listCallerPreapprovals: unknown method'), { code: 'unknown_method' }); } });
    await old.panel.whenLoaded();
    expect(old.host.hidden).toBe(true);
    expect(old.host.children).toEqual([]);
  });

  it('F5 — reads again on a change to a caller\'s anywhere, once for a burst; a trigger\'s reads nothing; disposed, it stops', async () => {
    vi.useFakeTimers();
    try {
      let listener: ((event: { holder: string }) => void) | undefined;
      const unsubscribe = vi.fn();
      const subscribe = vi.fn((_kind: string, fn: (event: { holder: string }) => void) => { listener = fn; return unsubscribe; });
      const m = mount({ subscribe });
      await m.panel.whenLoaded();
      expect(subscribe.mock.calls.map(([kind]) => kind)).toEqual(['contract.preapproval_changed']);
      expect(m.list).toHaveBeenCalledTimes(1);
      // A run's writes each spend a use: one read for all of them.
      listener!({ holder: 'caller' });
      listener!({ holder: 'caller' });
      listener!({ holder: 'caller' });
      expect(m.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CALLER_PREAPPROVAL_LIVE_REFRESH_MS);
      expect(m.list).toHaveBeenCalledTimes(2);
      listener!({ holder: 'trigger' });
      await vi.advanceTimersByTimeAsync(CALLER_PREAPPROVAL_LIVE_REFRESH_MS);
      expect(m.list).toHaveBeenCalledTimes(2);
      listener!({ holder: 'caller' });
      m.panel.dispose();
      await vi.advanceTimersByTimeAsync(CALLER_PREAPPROVAL_LIVE_REFRESH_MS);
      expect(m.list).toHaveBeenCalledTimes(2);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F5 — the kinds it reads again on are ones the web client names (one it does not name never arrives)', () => {
    for (const kind of CALLER_PREAPPROVAL_PANEL_BROADCAST_KINDS) expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain(kind);
  });
});
