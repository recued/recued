/** D-320 slice 2h (ruling 16) — the Connections page's grid per sign-in
 *  (`connections/sign-in-grid-controls.ts`): which connections each pack may use,
 *  and its default.
 *
 *  The callers are a fake server that answers like the real one: every write
 *  changes its state, and the grid reads `signins` again, so what the grid shows
 *  after a click is what the server said. Self-contained fake DOM. */

import { describe, expect, it } from 'vitest';
import { CONNECTIONS_PAGE_STYLES } from '@recued/ui-shared';

import {
  SIGNIN_CELL_ATTR,
  SIGNIN_CELL_STATE_ATTR,
  SIGNIN_CONFIRM_ACTION_ATTR,
  SIGNIN_CONFIRM_ATTR,
  SIGNIN_CONTROL_ATTR,
  SIGNIN_EFFECT_ATTR,
  SIGNIN_RECIPE_EFFECT_ATTR,
  SIGNIN_ERROR_ATTR,
  SIGNIN_GRID_ATTR,
  SIGNIN_OFFER_ACTION_ATTR,
  SIGNIN_OFFER_ATTR,
  SIGNIN_OFFER_PACK_ATTR,
  SIGNIN_ROW_ATTR,
  SIGNIN_USE_ALL_ATTR,
  createSignInGridController,
  type PackSignInsView,
  type SignInGridCallers,
} from '../connections/sign-in-grid-controls.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  type: string;
  name: string;
  title: string;
  scope: string;
  checked: boolean;
  children: FakeElement[];
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): { prevented: boolean };
}

const makeFakeElement = (tagName: string): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    className: '',
    type: '',
    name: '',
    title: '',
    scope: '',
    checked: false,
    children: [],
    attrs: new Map(),
    listeners: new Map(),
    setAttribute: (k, v) => void el.attrs.set(k, v),
    getAttribute: (k) => el.attrs.get(k) ?? null,
    hasAttribute: (k) => el.attrs.has(k),
    appendChild: (next) => {
      el.children.push(next);
      return next;
    },
    addEventListener: (name, fn) => {
      el.listeners.set(name, [...(el.listeners.get(name) ?? []), fn]);
    },
    click: () => {
      const ev = { prevented: false, preventDefault() { ev.prevented = true; } };
      if (el.attrs.has('disabled')) return ev;
      for (const fn of [...(el.listeners.get('click') ?? [])]) fn(ev);
      return ev;
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
const text = (root: FakeElement): string => (root.textContent ?? '') + root.children.map(text).join('');
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

type Row = { pack_slug: string; pack_name: string; listed: string[]; default?: string; can: string[]; members?: string[] };

/** A fake server holding the HubSpot sign-in (two packs) and a one-connection
 *  Stripe sign-in, answering the grid's calls. */
const fakeServer = () => {
  const calls: string[] = [];
  const connections = [
    { connection_name: 'hubspot-key', display_name: 'Service Key' },
    { connection_name: 'hubspot-app', display_name: 'Sales app' },
  ];
  const rows: Row[] = [
    { pack_slug: 'hubspot', pack_name: 'HubSpot CRM', listed: ['hubspot-key'], default: 'hubspot-key', can: ['hubspot-app'] },
    { pack_slug: 'deal-desk', pack_name: 'Deal Desk', listed: ['hubspot-key', 'hubspot-app'], default: 'hubspot-app', can: [], members: ['Deal Desk Notes'] },
    { pack_slug: 'old-portal', pack_name: 'Old Portal', listed: [], can: [] },
  ];
  const view = (): PackSignInsView => ({
    signins: [
      {
        slot: 'hubspot',
        label: 'HubSpot',
        vendor: 'hubspot',
        connections,
        rows: rows.map((r) => ({
          pack_slug: r.pack_slug,
          pack_name: r.pack_name,
          members: (r.members ?? []).map((m) => ({ pack_slug: m.toLowerCase().replace(/ /g, '-'), pack_name: m })),
          cells: Object.fromEntries(connections.map((a) => [
            a.connection_name,
            r.default === a.connection_name ? 'default'
              : r.listed.includes(a.connection_name) ? 'listed'
                : r.can.includes(a.connection_name) ? 'available' : 'unavailable',
          ])) as Record<string, 'default' | 'listed' | 'available' | 'unavailable'>,
          ...(r.default !== undefined ? { default: r.default } : {}),
        })),
      },
      {
        slot: 'stripe',
        label: 'Stripe',
        connections: [{ connection_name: 'stripe-live', display_name: 'Stripe' }],
        rows: [{ pack_slug: 'stripe', pack_name: 'Stripe', members: [], cells: { 'stripe-live': 'default' }, default: 'stripe-live' }],
      },
    ],
  });
  const rowOf = (pack: string): Row => rows.find((r) => r.pack_slug === pack)!;
  const callers: SignInGridCallers = {
    signins: async () => {
      calls.push('signins');
      return view();
    },
    add: async (args) => {
      calls.push(`add ${args.pack_slug} ${args.connection_name}`);
      const row = rowOf(args.pack_slug);
      row.listed.push(args.connection_name);
      row.can = row.can.filter((c) => c !== args.connection_name);
      return {};
    },
    remove: async (args) => {
      calls.push(`remove ${args.pack_slug} ${args.connection_name}`);
      const row = rowOf(args.pack_slug);
      row.listed = row.listed.filter((c) => c !== args.connection_name);
      row.can.push(args.connection_name);
      if (row.default === args.connection_name) delete row.default;
      if (row.listed.length === 1) row.default = row.listed[0];
      return {};
    },
    setDefault: async (args) => {
      calls.push(`default ${args.pack_slug} ${args.connection_name}`);
      rowOf(args.pack_slug).default = args.connection_name;
      return {};
    },
    addMany: async (args) => {
      calls.push(`add_many ${args.connection_name} ${args.targets.map((t) => `${t.pack_slug}/${t.slot}`).join(',')}`);
      for (const t of args.targets) {
        const row = rowOf(t.pack_slug);
        row.listed.push(args.connection_name);
        row.can = row.can.filter((c) => c !== args.connection_name);
      }
      return view();
    },
    removal: async (args) => {
      calls.push(`removal ${args.pack_slug} ${args.connection_name}`);
      return {
        connection_name: args.connection_name,
        packs: [{
          pack_slug: args.pack_slug,
          pack_name: rowOf(args.pack_slug).pack_name,
          slot: 'hubspot',
          members: [],
          outcome: 'moves',
          after: { connection_name: 'hubspot-key', display_name: 'Service Key' },
          remaining: [{ connection_name: 'hubspot-key', display_name: 'Service Key' }],
        }],
      };
    },
  };
  return { callers, calls };
};

const mount = (callers?: SignInGridCallers) => {
  let grids: FakeElement | null = null;
  const controller = createSignInGridController({
    document: doc,
    ...(callers !== undefined ? { callers } : {}),
    onChange: () => {
      grids = controller.render() as unknown as FakeElement | null;
    },
  });
  grids = controller.render() as unknown as FakeElement | null;
  return {
    controller,
    get grids(): FakeElement | null {
      return grids;
    },
    settle: async () => {
      await controller.whenSettled();
      await flush();
    },
  };
};

const cell = (root: FakeElement, pack: string, connection: string): FakeElement =>
  one(root, SIGNIN_CELL_ATTR, `${pack}::${connection}`)!;
const control = (root: FakeElement, pack: string, connection: string, which: 'list' | 'default'): FakeElement | null =>
  one(cell(root, pack, connection), SIGNIN_CONTROL_ATTR, which);

describe("D-320 slice 2h — the Connections page's grid per sign-in", () => {
  it('shows nothing without the calls', () => {
    expect(mount().grids).toBeNull();
  });

  it('draws a grid for a sign-in with two or more connections only, each cell as the server says', async () => {
    const m = mount(fakeServer().callers);
    expect(text(m.grids!)).toContain('Loading which packs use which connection');
    await m.settle();
    const grids = m.grids!;
    expect(all(grids, SIGNIN_GRID_ATTR).map((g) => g.getAttribute(SIGNIN_GRID_ATTR))).toEqual(['hubspot']);
    expect(text(grids)).toContain('HubSpot · 2 connections');
    const state = (pack: string, connection: string) => cell(grids, pack, connection).getAttribute(SIGNIN_CELL_STATE_ATTR);
    expect([state('hubspot', 'hubspot-key'), state('hubspot', 'hubspot-app')]).toEqual(['default', 'available']);
    expect([state('deal-desk', 'hubspot-key'), state('deal-desk', 'hubspot-app')]).toEqual(['listed', 'default']);
    expect(state('old-portal', 'hubspot-key')).toBe('unavailable');
    // Ticked and chosen; ticked; unticked with no default to choose; a dash.
    expect(control(grids, 'hubspot', 'hubspot-key', 'list')!.checked).toBe(true);
    expect(control(grids, 'hubspot', 'hubspot-key', 'default')!.checked).toBe(true);
    expect(control(grids, 'deal-desk', 'hubspot-key', 'default')!.checked).toBe(false);
    expect(control(grids, 'hubspot', 'hubspot-app', 'list')!.checked).toBe(false);
    expect(control(grids, 'hubspot', 'hubspot-app', 'default')).toBeNull();
    expect(control(grids, 'old-portal', 'hubspot-key', 'list')).toBeNull();
    expect(text(cell(grids, 'old-portal', 'hubspot-key'))).toBe('—');
  });

  it('names a family once, its members listed under its row', async () => {
    const m = mount(fakeServer().callers);
    await m.settle();
    const row = one(m.grids!, SIGNIN_ROW_ATTR, 'deal-desk')!;
    expect(text(row)).toContain('and 1 pack that signs in through it');
    expect(text(row)).toContain('Deal Desk Notes');
  });

  it('ticking a connection adds it, the browser\'s own toggle cancelled, and the grid reads the server again', async () => {
    const server = fakeServer();
    const m = mount(server.callers);
    await m.settle();
    const ev = control(m.grids!, 'hubspot', 'hubspot-app', 'list')!.click();
    expect(ev.prevented).toBe(true);
    await m.settle();
    expect(server.calls).toEqual(['signins', 'add hubspot hubspot-app', 'signins']);
    expect(cell(m.grids!, 'hubspot', 'hubspot-app').getAttribute(SIGNIN_CELL_STATE_ATTR)).toBe('listed');
  });

  it('unticking asks first, saying where the runs go; Keep leaves it, Remove takes it off', async () => {
    const server = fakeServer();
    const m = mount(server.callers);
    await m.settle();
    control(m.grids!, 'deal-desk', 'hubspot-app', 'list')!.click();
    await m.settle();
    expect(text(one(m.grids!, SIGNIN_CONFIRM_ATTR)!)).toContain('Stop using Sales app for Deal Desk?');
    expect(one(m.grids!, SIGNIN_EFFECT_ATTR)!.getAttribute(SIGNIN_EFFECT_ATTR)).toBe('moves');
    expect(text(one(m.grids!, SIGNIN_EFFECT_ATTR)!)).toBe('Deal Desk will run on Service Key from now on.');
    one(m.grids!, SIGNIN_CONFIRM_ACTION_ATTR, 'keep')!.click();
    expect(one(m.grids!, SIGNIN_CONFIRM_ATTR)).toBeNull();
    expect(server.calls.filter((c) => c.startsWith('remove '))).toEqual([]);

    control(m.grids!, 'deal-desk', 'hubspot-app', 'list')!.click();
    await m.settle();
    one(m.grids!, SIGNIN_CONFIRM_ACTION_ATTR, 'remove')!.click();
    await m.settle();
    expect(server.calls).toContain('remove deal-desk hubspot-app');
    expect(cell(m.grids!, 'deal-desk', 'hubspot-app').getAttribute(SIGNIN_CELL_STATE_ATTR)).toBe('available');
    expect(cell(m.grids!, 'deal-desk', 'hubspot-key').getAttribute(SIGNIN_CELL_STATE_ATTR)).toBe('default');
  });

  it("D-320 audit — says a recipe whose runs stop where the pack's move, under the pack's line", async () => {
    const server = fakeServer();
    const removal = server.callers.removal!;
    const m = mount({
      ...server.callers,
      removal: async (args) => ({
        ...(await removal(args)),
        recipes: [{
          recipe_id: 'deal-desk-digest',
          recipe_name: 'Deal desk digest',
          slot: 'hubspot',
          packs: [
            { pack_slug: 'deal-desk', pack_name: 'Deal Desk' },
            { pack_slug: 'hubspot', pack_name: 'HubSpot CRM' },
          ],
          outcome: 'stops',
          before: { connection_name: 'hubspot-app', display_name: 'Sales app' },
          remaining: [],
        }],
      }),
    });
    await m.settle();
    control(m.grids!, 'deal-desk', 'hubspot-app', 'list')!.click();
    await m.settle();
    expect(text(one(m.grids!, SIGNIN_EFFECT_ATTR)!)).toBe('Deal Desk will run on Service Key from now on.');
    expect(text(one(m.grids!, SIGNIN_RECIPE_EFFECT_ATTR, 'deal-desk-digest')!)).toBe(
      "Deal desk digest reads both Deal Desk's and HubSpot CRM's lists, and no connection will be on both: its runs stop until one is.",
    );
  });

  it('choosing another default makes it the default', async () => {
    const server = fakeServer();
    const m = mount(server.callers);
    await m.settle();
    control(m.grids!, 'deal-desk', 'hubspot-key', 'default')!.click();
    await m.settle();
    expect(server.calls).toContain('default deal-desk hubspot-key');
    expect(cell(m.grids!, 'deal-desk', 'hubspot-key').getAttribute(SIGNIN_CELL_STATE_ATTR)).toBe('default');
    // Choosing the one already the default asks nothing.
    control(m.grids!, 'deal-desk', 'hubspot-key', 'default')!.click();
    await m.settle();
    expect(server.calls.filter((c) => c.startsWith('default '))).toHaveLength(1);
  });

  it('"Use with all" adds the connection to every row that could take it, in one call', async () => {
    const server = fakeServer();
    const m = mount(server.callers);
    await m.settle();
    expect(one(m.grids!, SIGNIN_USE_ALL_ATTR, 'hubspot-key')).toBeNull(); // every row that can, has it
    one(m.grids!, SIGNIN_USE_ALL_ATTR, 'hubspot-app')!.click();
    await m.settle();
    expect(server.calls).toContain('add_many hubspot-app hubspot/hubspot');
    expect(cell(m.grids!, 'hubspot', 'hubspot-app').getAttribute(SIGNIN_CELL_STATE_ATTR)).toBe('listed');
    expect(one(m.grids!, SIGNIN_USE_ALL_ATTR, 'hubspot-app')).toBeNull();
  });

  it('a server without the calls shows nothing; a failed read says so, with a retry; a failed write says so', async () => {
    const older = mount({
      ...fakeServer().callers,
      signins: async () => { throw Object.assign(new Error('no such method'), { code: 'unknown_method' }); },
    });
    await older.settle();
    expect(older.grids).toBeNull();

    let fail = true;
    const server = fakeServer();
    const flaky = mount({
      ...server.callers,
      signins: async () => {
        if (fail) throw new Error('boom');
        return server.callers.signins();
      },
    });
    await flaky.settle();
    expect(one(flaky.grids!, SIGNIN_ERROR_ATTR)).not.toBeNull();
    fail = false;
    const retry = flaky.grids!.children.find((c) => c.tagName === 'BUTTON')!;
    retry.click();
    await flaky.settle();
    expect(all(flaky.grids!, SIGNIN_GRID_ATTR)).toHaveLength(1);

    const refusing = mount({ ...fakeServer().callers, add: async () => { throw new Error('nope'); } });
    await refusing.settle();
    control(refusing.grids!, 'hubspot', 'hubspot-app', 'list')!.click();
    await refusing.settle();
    expect(text(one(refusing.grids!, SIGNIN_ERROR_ATTR)!)).toContain('That did not work');
  });

  it('shows nothing when no sign-in has two connections', async () => {
    const m = mount({
      ...fakeServer().callers,
      signins: async () => ({ signins: [{ slot: 'stripe', label: 'Stripe', connections: [{ connection_name: 's', display_name: 'S' }], rows: [] }] }),
    });
    await m.settle();
    expect(m.grids).toBeNull();
  });

  it('draws no footer under a grid where every pack has every connection (found by a visual pass)', async () => {
    const m = mount({
      ...fakeServer().callers,
      signins: async () => ({
        signins: [{
          slot: 'hubspot',
          label: 'HubSpot',
          connections: [
            { connection_name: 'hubspot-key', display_name: 'Service Key' },
            { connection_name: 'hubspot-app', display_name: 'Sales app' },
          ],
          rows: [{
            pack_slug: 'hubspot',
            pack_name: 'HubSpot',
            members: [],
            cells: { 'hubspot-key': 'default', 'hubspot-app': 'listed' },
            default: 'hubspot-key',
          }],
        }],
      }),
    });
    await m.settle();
    const walk = (n: FakeElement): FakeElement[] => [n, ...n.children.flatMap(walk)];
    expect(walk(m.grids!).some((n) => n.tagName === 'TFOOT')).toBe(false);
    expect(all(m.grids!, SIGNIN_USE_ALL_ATTR)).toEqual([]);
  });

  it('reads again after refresh', async () => {
    const server = fakeServer();
    const m = mount(server.callers);
    await m.settle();
    m.controller.refresh();
    m.controller.render();
    await m.settle();
    expect(server.calls).toEqual(['signins', 'signins']);
  });
});

describe('D-320 slice 2i — a new connection asks which packs may use it', () => {
  type Cell = 'default' | 'listed' | 'available' | 'unavailable';
  const signin = (rows: Array<{ pack: string; name: string; cells: Record<string, Cell>; default?: string; members?: number }>) => ({
    slot: 'hubspot',
    label: 'HubSpot',
    connections: [
      { connection_name: 'hubspot-key', display_name: 'Service Key' },
      { connection_name: 'hubspot-new', display_name: 'Client portal' },
    ],
    rows: rows.map((r) => ({
      pack_slug: r.pack,
      pack_name: r.name,
      members: Array.from({ length: r.members ?? 0 }, (_, i) => ({ pack_slug: `${r.pack}-m${i}`, pack_name: `${r.name} ${i}` })),
      cells: r.cells,
      ...(r.default !== undefined ? { default: r.default } : {}),
    })),
  });
  const offerServer = (view: PackSignInsView) => {
    const calls: string[] = [];
    const callers: SignInGridCallers = {
      ...fakeServer().callers,
      signins: async () => {
        calls.push('signins');
        return view;
      },
      addMany: async (args) => {
        calls.push(`add_many ${args.connection_name} ${args.targets.map((x) => x.pack_slug).join(',')}${args.make_default === true ? ' default' : ''}`);
        return view;
      },
    };
    return { callers, calls };
  };
  const twoPacks = (): PackSignInsView => ({
    signins: [signin([
      { pack: 'hubspot', name: 'HubSpot CRM', cells: { 'hubspot-key': 'default', 'hubspot-new': 'available' }, default: 'hubspot-key' },
      { pack: 'deal-desk', name: 'Deal Desk', cells: { 'hubspot-key': 'default', 'hubspot-new': 'available' }, default: 'hubspot-key', members: 2 },
    ])],
  });
  const ask = async (view: PackSignInsView) => {
    const server = offerServer(view);
    const m = mount(server.callers);
    await m.settle();
    m.controller.offerNewConnection('hubspot-new');
    await m.settle();
    return { m, server };
  };
  const offerOf = (m: { grids: FakeElement | null }) => one(m.grids!, SIGNIN_OFFER_ATTR);
  const action = (m: { grids: FakeElement | null }, name: string) => one(offerOf(m)!, SIGNIN_OFFER_ACTION_ATTR, name)!;

  it('offers every pack that could use it, all ticked, and says the default stays', async () => {
    const { m } = await ask(twoPacks());
    const box = offerOf(m)!;
    // Under the section's heading and intro, above the grids (found by a visual pass).
    const order = m.grids!.children.map((c) => c.hasAttribute(SIGNIN_OFFER_ATTR) ? 'offer'
      : c.hasAttribute(SIGNIN_GRID_ATTR) ? 'grid' : c.className);
    expect(order).toEqual(['sg-heading', 'sg-note', 'offer', 'grid']);
    expect(box.getAttribute(SIGNIN_OFFER_ATTR)).toBe('hubspot-new');
    expect(text(box)).toContain('Client portal is connected.');
    expect(text(box)).toContain('Which HubSpot packs may use it?');
    expect(all(box, SIGNIN_OFFER_PACK_ATTR).map((b) => [b.getAttribute(SIGNIN_OFFER_PACK_ATTR), b.checked]))
      .toEqual([['hubspot::hubspot', true], ['deal-desk::hubspot', true]]);
    expect(text(box)).toContain('Deal Desk and 2 packs that sign in through it');
    expect(text(box)).toContain('Their default stays Service Key.');
  });

  it('Done puts it on every ticked pack\'s list, the default left, and closes', async () => {
    const { m, server } = await ask(twoPacks());
    action(m, 'done').click();
    await m.settle();
    expect(server.calls).toContain('add_many hubspot-new hubspot,deal-desk');
    expect(offerOf(m)).toBeNull();
  });

  it('an unticked pack is left out; "Make it the default" changes the ticked ones\' default', async () => {
    const { m, server } = await ask(twoPacks());
    const ev = one(offerOf(m)!, SIGNIN_OFFER_PACK_ATTR, 'hubspot::hubspot')!.click();
    expect(ev.prevented).toBe(true);
    expect(one(offerOf(m)!, SIGNIN_OFFER_PACK_ATTR, 'hubspot::hubspot')!.checked).toBe(false);
    action(m, 'make-default').click();
    await m.settle();
    expect(server.calls).toContain('add_many hubspot-new deal-desk default');
  });

  it('"Not now" writes nothing; nothing ticked writes nothing', async () => {
    const first = await ask(twoPacks());
    action(first.m, 'not-now').click();
    expect(offerOf(first.m)).toBeNull();
    expect(first.server.calls.filter((c) => c.startsWith('add_many'))).toEqual([]);

    const second = await ask(twoPacks());
    one(offerOf(second.m)!, SIGNIN_OFFER_PACK_ATTR, 'hubspot::hubspot')!.click();
    one(offerOf(second.m)!, SIGNIN_OFFER_PACK_ATTR, 'deal-desk::hubspot')!.click();
    action(second.m, 'done').click();
    await second.m.settle();
    expect(offerOf(second.m)).toBeNull();
    expect(second.server.calls.filter((c) => c.startsWith('add_many'))).toEqual([]);
  });

  it('a first connection: it becomes their only connection, with no default to change', async () => {
    const { m } = await ask({
      signins: [{
        ...signin([{ pack: 'hubspot', name: 'HubSpot CRM', cells: { 'hubspot-new': 'available' } }]),
        connections: [{ connection_name: 'hubspot-new', display_name: 'Client portal' }],
      }],
    });
    // One connection: no grid, but the question is asked.
    expect(all(m.grids!, SIGNIN_GRID_ATTR)).toEqual([]);
    expect(text(offerOf(m)!)).toContain('It will be their only connection, so they will use it.');
    expect(one(offerOf(m)!, SIGNIN_OFFER_ACTION_ATTR, 'make-default')).toBeNull();
  });

  it('asks nothing when no pack could use the connection', async () => {
    const { m } = await ask({
      signins: [signin([
        { pack: 'hubspot', name: 'HubSpot CRM', cells: { 'hubspot-key': 'default', 'hubspot-new': 'listed' }, default: 'hubspot-key' },
        { pack: 'old', name: 'Old Portal', cells: { 'hubspot-key': 'unavailable', 'hubspot-new': 'unavailable' } },
      ])],
    });
    expect(m.grids === null || offerOf(m) === null).toBe(true);
  });

  it('a failed answer says so and keeps the question', async () => {
    const server = offerServer(twoPacks());
    const m = mount({ ...server.callers, addMany: async () => { throw new Error('nope'); } });
    await m.settle();
    m.controller.offerNewConnection('hubspot-new');
    await m.settle();
    action(m, 'done').click();
    await m.settle();
    expect(text(offerOf(m)!)).toContain('That did not work');
  });
});

describe('D-320 ruling 17 — the grid says connection, never account', () => {
  it('in every state it draws', async () => {
    const seen: string[] = [];
    const server = fakeServer();
    const m = mount(server.callers);
    seen.push(text(m.grids!));
    await m.settle();
    seen.push(text(m.grids!));
    // Its column heads keep the page's style for them, renamed with it.
    const heads: FakeElement[] = [];
    const walk = (n: FakeElement): void => {
      if (n.tagName === 'TH' && n.className === 'sg-connection') heads.push(n);
      n.children.forEach(walk);
    };
    walk(m.grids!);
    expect(heads.map((h) => h.textContent)).toEqual(['Service Key', 'Sales app']);
    expect(CONNECTIONS_PAGE_STYLES).toContain('.sg-connection {');
    control(m.grids!, 'deal-desk', 'hubspot-app', 'list')!.click();
    await m.settle();
    seen.push(text(one(m.grids!, SIGNIN_CONFIRM_ATTR)!));
    m.controller.offerNewConnection('hubspot-app');
    await m.settle();
    seen.push(text(one(m.grids!, SIGNIN_OFFER_ATTR)!));
    const failing = mount({ ...server.callers, signins: async () => { throw new Error('down'); } });
    await failing.settle();
    seen.push(text(failing.grids!));
    const words = seen.join('\n');
    expect(words).toContain('Loading which packs use which connection');
    expect(words).toContain('HubSpot · 2 connections');
    expect(words).toContain('Tick the connections each pack may use, and choose the one it uses by default.');
    expect(words).toContain('Which HubSpot packs may use it?');
    expect(words).toContain('Could not load which packs use which connection');
    for (const state of seen) expect(state).not.toMatch(/account/i);
  });
});
