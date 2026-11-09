/** D-320 — the Access tab's Connections block (`pack-connections-controls.ts`):
 *  a pack's connections per sign-in, its default, Add another / Make default /
 *  Remove over `packs.connections.*`.
 *
 *  The callers are fakes that answer like the server: each write returns the
 *  pack's new view, so what the block shows after a click is what the server
 *  said, not what the block assumed. Self-contained fake-DOM harness, cribbed
 *  from the sibling packs suites. */

import { describe, expect, it } from 'vitest';

import type { ConnectionView, PackListEntry } from '@recued/contracts';

import {
  PACK_CONNECTIONS_ACTION_ATTR,
  PACK_CONNECTIONS_ADD_ATTR,
  PACK_CONNECTIONS_ADD_SELECT_ATTR,
  PACK_CONNECTIONS_ATTR,
  PACK_CONNECTIONS_EFFECT_ATTR,
  PACK_CONNECTIONS_ERROR_ATTR,
  PACK_CONNECTIONS_FIX_ATTR,
  PACK_CONNECTIONS_HELD_BY_ATTR,
  PACK_CONNECTIONS_NO_DEFAULT_ATTR,
  PACK_CONNECTIONS_PROBLEM_ATTR,
  PACK_CONNECTIONS_RECIPE_EFFECT_ATTR,
  PACK_CONNECTIONS_ROW_ATTR,
  PACK_CONNECTIONS_SET_UP_ATTR,
  createPackConnectionsController,
  type PackConnectionsCallers,
  type PackConnectionsView,
} from '../settings/pack-connections-controls.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  type: string;
  title: string;
  value: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    type: '',
    title: '',
    value: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => {
      attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    click: () => {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of [...(listeners.get('click') ?? [])]) fn({ target: el });
    },
  };
  return el;
};

const doc = { createElement: (tag: string) => makeFakeElement(tag) } as unknown as Document;

const all = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.hasAttribute(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};
const one = (root: FakeElement, attr: string, value?: string): FakeElement | null =>
  all(root, attr).find((e) => value === undefined || e.getAttribute(attr) === value) ?? null;
const text = (root: FakeElement): string =>
  (root.textContent ?? '') + root.children.map(text).join('');
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const PACK = 'hubspot';
const pack = { slug: PACK } as unknown as PackListEntry;

const entry = (name: string, alias: string, isDefault: boolean, enrolled = true) =>
  ({ connection_name: name, display_name: alias, enrolled, is_default: isDefault });

/** A fake server: holds one pack's connections and answers the four calls. */
const fakeServer = (initial: { listed: Array<[string, string]>; default?: string; candidates: Array<[string, string]> }) => {
  const listed = [...initial.listed];
  let theDefault = initial.default;
  let candidates = [...initial.candidates];
  const calls: string[] = [];
  const view = (): PackConnectionsView => ({
    pack_slug: PACK,
    slots: [{
      slot: 'hubspot',
      catalogs: ['hubspot-catalog'],
      connections: listed.map(([name, alias]) =>
        entry(name, alias, name === (theDefault ?? (listed.length === 1 ? listed[0]![0] : undefined)))),
      candidates: candidates.map(([connection_name, display_name]) => ({ connection_name, display_name })),
    }],
  });
  const callers: PackConnectionsCallers = {
    list: async (args) => {
      calls.push(`list ${args.pack_slug}`);
      return view();
    },
    add: async (args) => {
      calls.push(`add ${args.connection_name}`);
      const joined = candidates.find(([n]) => n === args.connection_name)!;
      if (listed.length === 1 && theDefault === undefined) theDefault = listed[0]![0];
      listed.push(joined);
      candidates = candidates.filter(([n]) => n !== args.connection_name);
      return view();
    },
    remove: async (args) => {
      calls.push(`remove ${args.connection_name}`);
      const gone = listed.findIndex(([n]) => n === args.connection_name);
      candidates.push(listed[gone]!);
      listed.splice(gone, 1);
      if (theDefault === args.connection_name) theDefault = undefined;
      return view();
    },
    setDefault: async (args) => {
      calls.push(`default ${args.connection_name}`);
      theDefault = args.connection_name;
      return view();
    },
  };
  return { callers, calls };
};

/** Mount the controller with a host that re-renders on change, as the panel does. */
const mount = (callers?: PackConnectionsCallers) => {
  let block: FakeElement | null = null;
  const controller = createPackConnectionsController({
    document: doc,
    ...(callers !== undefined ? { callers } : {}),
    onChange: () => {
      block = controller.renderForPack(pack) as unknown as FakeElement | null;
    },
  });
  block = controller.renderForPack(pack) as unknown as FakeElement | null;
  return {
    controller,
    get block(): FakeElement | null {
      return block;
    },
    settle: async () => {
      await controller.whenSettled();
      await flush();
    },
  };
};

const action = (block: FakeElement, connection: string, name: string): FakeElement | null => {
  const row = one(block, PACK_CONNECTIONS_ROW_ATTR, connection);
  return row === null ? null : one(row, PACK_CONNECTIONS_ACTION_ATTR, name);
};

describe('D-320 — the Access tab Connections block', () => {
  it('shows nothing without the calls', () => {
    expect(mount().block).toBeNull();
  });

  it('loads on first sight, then lists the connections by alias with the default marked', async () => {
    const server = fakeServer({ listed: [['hubspot-key', 'Service Key']], candidates: [['hubspot-app', 'HubSpot app']] });
    const m = mount(server.callers);
    expect(text(m.block!)).toContain('Loading connections');
    await m.settle();
    const block = m.block!;
    expect(block.getAttribute(PACK_CONNECTIONS_ATTR)).toBe(PACK);
    expect(text(block)).toContain('Service Key');
    expect(text(one(block, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-key')!)).toContain('Default');
    expect(action(block, 'hubspot-key', 'make-default')).toBeNull();
    expect(one(block, PACK_CONNECTIONS_ADD_SELECT_ATTR, 'hubspot')!.value).toBe('hubspot-app');
    expect(server.calls).toEqual([`list ${PACK}`]);
  });

  it('Add another adds the chosen candidate; the first stays the default', async () => {
    const server = fakeServer({ listed: [['hubspot-key', 'Service Key']], candidates: [['hubspot-app', 'HubSpot app']] });
    const m = mount(server.callers);
    await m.settle();
    one(m.block!, PACK_CONNECTIONS_ADD_ATTR, 'hubspot')!.click();
    await m.settle();
    expect(server.calls).toContain('add hubspot-app');
    expect(one(m.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-app')).not.toBeNull();
    expect(text(one(m.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-key')!)).toContain('Default');
    expect(action(m.block!, 'hubspot-app', 'make-default')).not.toBeNull();
  });

  it('Make default moves the default', async () => {
    const server = fakeServer({
      listed: [['hubspot-key', 'Service Key'], ['hubspot-app', 'HubSpot app']],
      default: 'hubspot-key',
      candidates: [],
    });
    const m = mount(server.callers);
    await m.settle();
    action(m.block!, 'hubspot-app', 'make-default')!.click();
    await m.settle();
    expect(server.calls).toContain('default hubspot-app');
    expect(text(one(m.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-app')!)).toContain('Default');
    expect(action(m.block!, 'hubspot-key', 'make-default')).not.toBeNull();
  });

  it('Remove asks first; Keep leaves it, Remove takes it off', async () => {
    const server = fakeServer({
      listed: [['hubspot-key', 'Service Key'], ['hubspot-app', 'HubSpot app']],
      default: 'hubspot-key',
      candidates: [],
    });
    const m = mount(server.callers);
    await m.settle();
    action(m.block!, 'hubspot-app', 'remove')!.click();
    expect(text(one(m.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-app')!)).toContain('Stop using HubSpot app for this pack?');
    action(m.block!, 'hubspot-app', 'keep')!.click();
    expect(action(m.block!, 'hubspot-app', 'confirm-remove')).toBeNull();
    expect(server.calls.filter((c) => c.startsWith('remove'))).toEqual([]);

    action(m.block!, 'hubspot-app', 'remove')!.click();
    action(m.block!, 'hubspot-app', 'confirm-remove')!.click();
    await m.settle();
    expect(server.calls).toContain('remove hubspot-app');
    expect(one(m.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-app')).toBeNull();
  });

  it('says so when two or more are listed and none is the default', async () => {
    const server = fakeServer({
      listed: [['hubspot-key', 'Service Key'], ['hubspot-app', 'HubSpot app']],
      candidates: [],
    });
    const m = mount(server.callers);
    await m.settle();
    const warning = one(m.block!, PACK_CONNECTIONS_NO_DEFAULT_ATTR);
    expect(warning).not.toBeNull();
    expect(text(warning!)).toContain('scheduled runs fail until you choose one');
  });

  it('with no other connection to add, points to Connections', async () => {
    const server = fakeServer({ listed: [['hubspot-key', 'Service Key']], candidates: [] });
    const m = mount(server.callers);
    await m.settle();
    expect(one(m.block!, PACK_CONNECTIONS_ADD_ATTR)).toBeNull();
    expect(text(m.block!)).toContain('set it up under Connections first');
  });

  it('marks a connection that is no longer set up', async () => {
    const callers: PackConnectionsCallers = {
      list: async () => ({
        pack_slug: PACK,
        slots: [{
          slot: 'hubspot',
          catalogs: ['hubspot-catalog'],
          connections: [entry('hubspot-key', 'hubspot-key', true, false)],
          candidates: [],
        }],
      }),
      add: async () => { throw new Error('unused'); },
      remove: async () => { throw new Error('unused'); },
      setDefault: async () => { throw new Error('unused'); },
    };
    const m = mount(callers);
    await m.settle();
    // D-321 P4 — "Not set up", never "No longer": installing with no connection
    // leaves its name on the list, and it was never set up. With no vendor named,
    // the way there is Connections.
    expect(text(m.block!)).toContain('Not set up.');
    expect(text(m.block!)).not.toContain('No longer');
    const fix = one(one(m.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-key')!, PACK_CONNECTIONS_FIX_ATTR)!;
    expect(fix.getAttribute(PACK_CONNECTIONS_FIX_ATTR)).toBe('not_set_up');
    expect(text(fix)).toBe('Set it up under Connections →');
    expect(fix.getAttribute('href')).toBe('#connections/others');
  });

  it('shows nothing for a pack that signs in to nothing, or a server without the calls', async () => {
    const empty = mount({
      list: async () => ({ pack_slug: PACK, slots: [] }),
      add: async () => ({ pack_slug: PACK, slots: [] }),
      remove: async () => ({ pack_slug: PACK, slots: [] }),
      setDefault: async () => ({ pack_slug: PACK, slots: [] }),
    });
    await empty.settle();
    expect(empty.block).toBeNull();

    const old = mount({
      list: async () => { throw Object.assign(new Error('no such method'), { code: 'unknown_method' }); },
      add: async () => { throw new Error('unused'); },
      remove: async () => { throw new Error('unused'); },
      setDefault: async () => { throw new Error('unused'); },
    });
    await old.settle();
    expect(old.block).toBeNull();
  });

  it('a failed load offers Try again; a failed write says so and keeps the list', async () => {
    let fail = true;
    const server = fakeServer({ listed: [['hubspot-key', 'Service Key']], candidates: [['hubspot-app', 'HubSpot app']] });
    const callers: PackConnectionsCallers = {
      ...server.callers,
      list: async (args) => {
        if (fail) throw new Error('server unreachable');
        return server.callers.list(args);
      },
      add: async () => { throw new Error('refused by the server'); },
    };
    const m = mount(callers);
    await m.settle();
    expect(one(m.block!, PACK_CONNECTIONS_ERROR_ATTR)).not.toBeNull();
    fail = false;
    one(m.block!, PACK_CONNECTIONS_ACTION_ATTR, 'retry')!.click();
    await m.settle();
    expect(text(m.block!)).toContain('Service Key');

    one(m.block!, PACK_CONNECTIONS_ADD_ATTR, 'hubspot')!.click();
    await m.settle();
    expect(text(one(m.block!, PACK_CONNECTIONS_ERROR_ATTR)!)).toContain('That did not work');
    expect(one(m.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-key')).not.toBeNull();
  });

  it('a pack signing in through another shows that list read-only, with a link to it', async () => {
    const view = {
      pack_slug: PACK,
      slots: [{
        slot: 'wise',
        catalogs: ['wise-quotes'],
        connections: [entry('wise-business', 'Wise Business', true), entry('wise-personal', 'Wise Personal', false)],
        candidates: [],
        held_by: 'wise-core',
      }],
    };
    const m = mount({
      list: async () => view,
      add: async () => view,
      remove: async () => view,
      setDefault: async () => view,
    });
    await m.settle();
    const note = one(m.block!, PACK_CONNECTIONS_HELD_BY_ATTR);
    expect(note?.getAttribute(PACK_CONNECTIONS_HELD_BY_ATTR)).toBe('wise-core');
    expect(text(note!)).toContain('Uses the connections of wise-core');
    const link = note!.children.find((c) => c.tagName === 'A');
    expect(link?.getAttribute('href')).toBe('#packs/wise-core');
    expect(text(m.block!)).toContain('Wise Personal');
    expect(all(m.block!, PACK_CONNECTIONS_ACTION_ATTR)).toEqual([]);
    expect(one(m.block!, PACK_CONNECTIONS_ADD_ATTR)).toBeNull();
  });

  it('D-320 slice 2h — names the holder, and the packs sharing a list, by their names', async () => {
    const borrower = {
      pack_slug: PACK,
      slots: [{
        slot: 'wise',
        catalogs: ['wise-quotes'],
        connections: [entry('wise-business', 'Wise Business', true)],
        candidates: [],
        held_by: 'wise-core',
        held_by_name: 'Wise Core',
      }],
    };
    const m = mount({ list: async () => borrower, add: async () => borrower, remove: async () => borrower, setDefault: async () => borrower });
    await m.settle();
    const note = one(m.block!, PACK_CONNECTIONS_HELD_BY_ATTR)!;
    expect(text(note)).toBe('Uses the connections of Wise Core. Change them there.');
    expect(note.children.find((c) => c.tagName === 'A')?.getAttribute('href')).toBe('#packs/wise-core');

    const holder = {
      pack_slug: PACK,
      slots: [{
        slot: 'wise',
        catalogs: ['wise-core'],
        connections: [entry('wise-business', 'Wise Business', true)],
        candidates: [],
        shared_with: ['wise-quotes', 'wise-transfers'],
        shared_with_names: ['Wise Quotes', 'Wise Transfers'],
      }],
    };
    const h = mount({ list: async () => holder, add: async () => holder, remove: async () => holder, setDefault: async () => holder });
    await h.settle();
    expect(text(h.block!)).toContain('Also used by Wise Quotes, Wise Transfers.');
  });

  it('a holder names the packs that share its connections', async () => {
    const view = {
      pack_slug: PACK,
      slots: [{
        slot: 'wise',
        catalogs: ['wise-core'],
        connections: [entry('wise-business', 'Wise Business', true)],
        candidates: [],
        shared_with: ['wise-quotes', 'wise-transfers'],
      }],
    };
    const m = mount({
      list: async () => view,
      add: async () => view,
      remove: async () => view,
      setDefault: async () => view,
    });
    await m.settle();
    expect(text(m.block!)).toContain('Also used by wise-quotes, wise-transfers.');
    expect(action(m.block!, 'wise-business', 'remove')).not.toBeNull();
  });

  it('reloads after refresh, when the packs list changed', async () => {
    const server = fakeServer({ listed: [['hubspot-key', 'Service Key']], candidates: [] });
    const m = mount(server.callers);
    await m.settle();
    m.controller.refresh();
    m.controller.renderForPack(pack);
    await m.settle();
    expect(server.calls).toEqual([`list ${PACK}`, `list ${PACK}`]);
  });
});

describe('D-320 slice 2g — Remove says where the pack\'s runs go', () => {
  type Removal = NonNullable<PackConnectionsCallers['removal']>;
  const moves = (connection_name: string, after: [string, string]): Awaited<ReturnType<Removal>> => ({
    connection_name,
    packs: [{
      pack_slug: PACK,
      pack_name: 'HubSpot CRM',
      slot: 'hubspot',
      members: [],
      outcome: 'moves',
      after: { connection_name: after[0], display_name: after[1] },
      remaining: [{ connection_name: after[0], display_name: after[1] }],
    }],
  });
  const twoListed = () => fakeServer({
    listed: [['hubspot-key', 'Service Key'], ['hubspot-app', 'HubSpot app']],
    default: 'hubspot-key',
    candidates: [],
  });

  it('asks the server on Remove and says it under the question; Keep closes both', async () => {
    const server = twoListed();
    const asked: string[] = [];
    const m = mount({
      ...server.callers,
      removal: async (args) => {
        asked.push(`${args.pack_slug} ${args.connection_name}`);
        return moves(args.connection_name, ['hubspot-app', 'HubSpot app']);
      },
    });
    await m.settle();
    action(m.block!, 'hubspot-key', 'remove')!.click();
    expect(one(m.block!, PACK_CONNECTIONS_EFFECT_ATTR)!.getAttribute(PACK_CONNECTIONS_EFFECT_ATTR)).toBe('loading');
    await m.settle();
    const line = one(m.block!, PACK_CONNECTIONS_EFFECT_ATTR)!;
    expect(line.getAttribute(PACK_CONNECTIONS_EFFECT_ATTR)).toBe('moves');
    expect(text(line)).toBe('This pack will run on HubSpot app from now on.');
    // It sits on the row being asked about.
    expect(one(one(m.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-key')!, PACK_CONNECTIONS_EFFECT_ATTR)).not.toBeNull();
    expect(asked).toEqual([`${PACK} hubspot-key`]);
    action(m.block!, 'hubspot-key', 'keep')!.click();
    expect(one(m.block!, PACK_CONNECTIONS_EFFECT_ATTR)).toBeNull();
  });

  it("D-320 audit — says, under the pack's line, a recipe whose runs stop where the pack's move", async () => {
    const m = mount({
      ...twoListed().callers,
      removal: async (args) => ({
        ...moves(args.connection_name, ['hubspot-app', 'HubSpot app']),
        recipes: [
          {
            recipe_id: 'deal-and-ticket-brief',
            recipe_name: 'Deal and ticket brief',
            slot: 'hubspot',
            packs: [
              { pack_slug: PACK, pack_name: 'HubSpot CRM' },
              { pack_slug: 'hubspot-service', pack_name: 'HubSpot Service' },
            ],
            outcome: 'stops',
            before: { connection_name: 'hubspot-key', display_name: 'Service Key' },
            remaining: [],
          },
          {
            recipe_id: 'kept',
            recipe_name: 'Kept',
            slot: 'hubspot',
            packs: [
              { pack_slug: PACK, pack_name: 'HubSpot CRM' },
              { pack_slug: 'hubspot-service', pack_name: 'HubSpot Service' },
            ],
            outcome: 'unchanged',
            before: { connection_name: 'hubspot-app', display_name: 'HubSpot app' },
            after: { connection_name: 'hubspot-app', display_name: 'HubSpot app' },
            remaining: [{ connection_name: 'hubspot-app', display_name: 'HubSpot app' }],
          },
        ],
      }),
    });
    await m.settle();
    action(m.block!, 'hubspot-key', 'remove')!.click();
    await m.settle();
    expect(text(one(m.block!, PACK_CONNECTIONS_EFFECT_ATTR)!)).toBe('This pack will run on HubSpot app from now on.');
    const recipe = one(m.block!, PACK_CONNECTIONS_RECIPE_EFFECT_ATTR, 'deal-and-ticket-brief')!;
    expect(text(recipe)).toBe(
      "Deal and ticket brief reads both HubSpot CRM's and HubSpot Service's lists, and no connection will be on both: its runs stop until one is.",
    );
    // Only the recipes whose runs change.
    expect(one(m.block!, PACK_CONNECTIONS_RECIPE_EFFECT_ATTR, 'kept')).toBeNull();
    action(m.block!, 'hubspot-key', 'keep')!.click();
    expect(one(m.block!, PACK_CONNECTIONS_RECIPE_EFFECT_ATTR, 'deal-and-ticket-brief')).toBeNull();
  });

  it('says it could not check when the call fails, and nothing when the server lacks it', async () => {
    const failing = mount({ ...twoListed().callers, removal: async () => { throw new Error('boom'); } });
    await failing.settle();
    action(failing.block!, 'hubspot-key', 'remove')!.click();
    await failing.settle();
    const line = one(failing.block!, PACK_CONNECTIONS_EFFECT_ATTR)!;
    expect(line.getAttribute(PACK_CONNECTIONS_EFFECT_ATTR)).toBe('failed');
    expect(text(line)).toBe('Could not check where its runs go next.');
    // The removal itself still works.
    expect(action(failing.block!, 'hubspot-key', 'confirm-remove')).not.toBeNull();

    const older = mount({
      ...twoListed().callers,
      removal: async () => { throw Object.assign(new Error('no such method'), { code: 'unknown_method' }); },
    });
    await older.settle();
    action(older.block!, 'hubspot-key', 'remove')!.click();
    await older.settle();
    expect(one(older.block!, PACK_CONNECTIONS_EFFECT_ATTR)).toBeNull();
    expect(text(one(older.block!, PACK_CONNECTIONS_ROW_ATTR, 'hubspot-key')!)).toContain('Stop using Service Key for this pack?');
  });

  it('asks again when the list changes while the question is open', async () => {
    const server = fakeServer({
      listed: [['hubspot-key', 'Service Key'], ['hubspot-app', 'HubSpot app']],
      default: 'hubspot-key',
      candidates: [['hubspot-other', 'Old portal']],
    });
    const asked: string[] = [];
    const m = mount({
      ...server.callers,
      removal: async (args) => {
        asked.push(args.connection_name);
        const first = moves(args.connection_name, ['hubspot-app', 'HubSpot app']);
        return asked.length === 1
          ? first
          : { ...first, packs: [{ ...first.packs[0]!, outcome: 'no_default' as const, after: undefined as never }] };
      },
    });
    await m.settle();
    action(m.block!, 'hubspot-key', 'remove')!.click();
    await m.settle();
    expect(one(m.block!, PACK_CONNECTIONS_EFFECT_ATTR)!.getAttribute(PACK_CONNECTIONS_EFFECT_ATTR)).toBe('moves');
    // Another connection joins while the question is open: the answer it gave is
    // stale (with three, the key leaving leaves no default), so it is asked again.
    one(m.block!, PACK_CONNECTIONS_ADD_ATTR, 'hubspot')!.click();
    await m.settle();
    expect(server.calls).toContain('add hubspot-other');
    expect(asked).toEqual(['hubspot-key', 'hubspot-key']);
    expect(one(m.block!, PACK_CONNECTIONS_EFFECT_ATTR)!.getAttribute(PACK_CONNECTIONS_EFFECT_ATTR)).toBe('no_default');
  });
});

describe('D-320 slice 2j — "Set up a new connection" opens the vendor\'s form', () => {
  const viewWith = (over: { vendor?: string; candidates?: Array<[string, string]> }): PackConnectionsView => ({
    pack_slug: PACK,
    slots: [{
      slot: 'hubspot',
      catalogs: ['hubspot-catalog'],
      connections: [entry('hubspot-key', 'Service Key', true)],
      candidates: (over.candidates ?? []).map(([connection_name, display_name]) => ({ connection_name, display_name })),
      ...(over.vendor !== undefined ? { vendor: over.vendor } : {}),
    }],
  });
  const mountView = async (view: PackConnectionsView) => {
    const m = mount({ list: async () => view, add: async () => view, remove: async () => view, setDefault: async () => view });
    await m.settle();
    return m;
  };

  it('sits beside Add another', async () => {
    const m = await mountView(viewWith({ vendor: 'hubspot', candidates: [['hubspot-app', 'HubSpot app']] }));
    const link = one(m.block!, PACK_CONNECTIONS_SET_UP_ATTR)!;
    expect(link.getAttribute('href')).toBe('#connections/others/enroll/hubspot/pack/hubspot/hubspot');
    expect(text(link)).toBe('Set up a new connection');
    expect(one(m.block!, PACK_CONNECTIONS_ADD_ATTR, 'hubspot')).not.toBeNull();
  });

  it('with no other connection to add, it is the way to one', async () => {
    const m = await mountView(viewWith({ vendor: 'hubspot' }));
    expect(text(m.block!)).toContain('No other connection can join yet.');
    expect(one(m.block!, PACK_CONNECTIONS_SET_UP_ATTR)?.getAttribute('href')).toBe('#connections/others/enroll/hubspot/pack/hubspot/hubspot');
  });

  it('a server that names no vendor keeps the link to Connections', async () => {
    const m = await mountView(viewWith({}));
    expect(one(m.block!, PACK_CONNECTIONS_SET_UP_ATTR)).toBeNull();
    expect(text(m.block!)).toContain('To add another connection, set it up under Connections first.');
  });
});

describe('D-320 ruling 17 — the block says connection, never account', () => {
  const viewOf = (over: { listed?: Array<[string, string, boolean]>; candidates?: Array<[string, string]>; vendor?: string }): PackConnectionsView => ({
    pack_slug: PACK,
    slots: [{
      slot: 'hubspot',
      catalogs: ['hubspot-catalog'],
      connections: (over.listed ?? [['hubspot-key', 'Service Key', true]]).map(([name, alias, isDefault]) => entry(name, alias, isDefault)),
      candidates: (over.candidates ?? []).map(([connection_name, display_name]) => ({ connection_name, display_name })),
      ...(over.vendor !== undefined ? { vendor: over.vendor } : {}),
    }],
  });

  it('in every state it draws', async () => {
    const seen: string[] = [];
    const show = async (view: PackConnectionsView, removal?: PackConnectionsCallers['removal']) => {
      const m = mount({
        list: async () => view, add: async () => view, remove: async () => view, setDefault: async () => view,
        ...(removal !== undefined ? { removal } : {}),
      });
      seen.push(text(m.block!));
      await m.settle();
      seen.push(text(m.block!));
      return m;
    };
    await show(viewOf({ vendor: 'hubspot', candidates: [['hubspot-app', 'HubSpot app']] }));
    await show(viewOf({ vendor: 'hubspot' }));
    await show(viewOf({}));
    const asking = await show(
      viewOf({ listed: [['hubspot-key', 'Service Key', false], ['hubspot-app', 'HubSpot app', false]] }),
      async (args) => ({
        connection_name: args.connection_name,
        packs: [{
          pack_slug: PACK, pack_name: 'HubSpot CRM', slot: 'hubspot', members: [], outcome: 'moves',
          after: { connection_name: 'hubspot-app', display_name: 'HubSpot app' },
          remaining: [{ connection_name: 'hubspot-app', display_name: 'HubSpot app' }],
        }],
      }),
    );
    action(asking.block!, 'hubspot-key', 'remove')!.click();
    await asking.settle();
    seen.push(text(asking.block!));
    const words = seen.join('\n');
    expect(words).toContain('The connections this pack signs in with. A run uses the default.');
    expect(words).toContain('Set up a new connection');
    expect(words).toContain('No other connection can join yet.');
    expect(words).toContain('To add another connection, set it up under Connections first.');
    expect(words).toContain('No default: runs ask which connection to use');
    expect(words).toContain('This pack will run on HubSpot app from now on.');
    for (const state of seen) expect(state).not.toMatch(/account/i);
  });
});

/** D-321 P4 — the block is the pack's one Connections block now, above its tabs,
 *  so each connection on the list says whether it works for this pack, by the rule
 *  the readiness rows use before install (`connectionProblem`). */
describe('D-321 P4 — each connection on the list says whether it works here', () => {
  const listView = (rows: Array<[string, string, boolean, boolean?]>): PackConnectionsView => ({
    pack_slug: PACK,
    slots: [{
      slot: 'hubspot',
      catalogs: ['hubspot-catalog'],
      connections: rows.map(([name, alias, isDefault, enrolled]) => entry(name, alias, isDefault, enrolled ?? true)),
      candidates: [],
      vendor: 'hubspot',
    }],
  });
  const viewOf = (name: string, over: Partial<ConnectionView> = {}): ConnectionView =>
    ({ name, kind: 'api', display_name: name, ...over }) as ConnectionView;
  const mountWith = async (
    list: PackConnectionsView,
    views: ConnectionView[] | null,
    needed: string[] = [],
  ): Promise<() => FakeElement> => {
    let block: FakeElement | null = null;
    const scoped = { slug: PACK, required_scopes_by_connection: { hubspot: needed } } as unknown as PackListEntry;
    const controller = createPackConnectionsController({
      document: doc,
      callers: { list: async () => list, add: async () => list, remove: async () => list, setDefault: async () => list },
      onChange: () => {
        block = controller.renderForPack(scoped) as unknown as FakeElement | null;
      },
      connectionViews: () => views,
    });
    block = controller.renderForPack(scoped) as unknown as FakeElement | null;
    await controller.whenSettled();
    await flush();
    return () => block!;
  };

  it('a turned-down sign-in says so, and Reconnect opens that connection', async () => {
    const block = await mountWith(
      listView([['hubspot-key', 'Service Key', true]]),
      [viewOf('hubspot-key', { health: { status: 'auth_failed', last_probed_at: 1 } })],
    );
    const row = one(block(), PACK_CONNECTIONS_ROW_ATTR, 'hubspot-key')!;
    expect(one(row, PACK_CONNECTIONS_PROBLEM_ATTR)?.getAttribute(PACK_CONNECTIONS_PROBLEM_ATTR)).toBe('rejected');
    expect(text(row)).toContain('Sign-in not accepted.');
    const fix = one(row, PACK_CONNECTIONS_FIX_ATTR)!;
    expect(text(fix)).toBe('Reconnect →');
    expect(fix.getAttribute('href')).toBe('#connections/others/review-access/api/hubspot-key');
  });

  it("a sign-in short of a scope signs in again with the pack's; a pasted key gains it at the vendor", async () => {
    const needed = ['crm.objects.deals.read', 'crm.objects.deals.write'];
    const app = await mountWith(
      listView([['hubspot-app', 'Sales app', true]]),
      [viewOf('hubspot-app', { granted_scopes: ['crm.objects.deals.read'] })],
      needed,
    );
    const appRow = one(app(), PACK_CONNECTIONS_ROW_ATTR, 'hubspot-app')!;
    expect(text(appRow)).toContain('Missing crm.objects.deals.write.');
    expect(text(one(appRow, PACK_CONNECTIONS_FIX_ATTR)!)).toBe('Re-authorize →');
    expect(one(appRow, PACK_CONNECTIONS_FIX_ATTR)!.getAttribute('href'))
      .toBe('#connections/others/enroll/hubspot/pack/hubspot/hubspot');
    const key = await mountWith(
      listView([['hubspot-key', 'Service Key', true]]),
      [viewOf('hubspot-key', { granted_scopes: [], auth_type: 'bearer' })],
      needed,
    );
    const keyFix = one(one(key(), PACK_CONNECTIONS_ROW_ATTR, 'hubspot-key')!, PACK_CONNECTIONS_FIX_ATTR)!;
    expect(text(keyFix)).toBe('Add them to the key, then Probe →');
    expect(keyFix.getAttribute('href')).toBe('#connections/others');
  });

  it('one that works, one no longer set up, or a list not read yet: the rows say what they did', async () => {
    const works = await mountWith(
      listView([['hubspot-key', 'Service Key', true]]),
      [viewOf('hubspot-key', { health: { status: 'ok', last_probed_at: 1 } })],
    );
    expect(one(works(), PACK_CONNECTIONS_PROBLEM_ATTR)).toBeNull();
    const gone = await mountWith(
      listView([['hubspot-old', 'Old portal', true, false]]),
      [viewOf('hubspot-old', { health: { status: 'auth_failed' } })],
    );
    // Not set up: the vendor's form for this pack, never a problem drawn from a stale view.
    expect(text(gone())).toContain('Not set up.');
    expect(one(gone(), PACK_CONNECTIONS_PROBLEM_ATTR)).toBeNull();
    const setUp = one(one(gone(), PACK_CONNECTIONS_ROW_ATTR, 'hubspot-old')!, PACK_CONNECTIONS_FIX_ATTR)!;
    expect(text(setUp)).toBe('Set up →');
    expect(setUp.getAttribute('href')).toBe('#connections/others/enroll/hubspot/pack/hubspot/hubspot');
    const unread = await mountWith(listView([['hubspot-key', 'Service Key', true]]), null);
    expect(one(unread(), PACK_CONNECTIONS_PROBLEM_ATTR)).toBeNull();
  });
});
