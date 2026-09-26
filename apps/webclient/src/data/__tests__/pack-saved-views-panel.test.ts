/** D-289 — the Saved views panel's pack group.
 *
 *  ⛔ WHAT THIS PINS IS AN OWNERSHIP BOUNDARY, NOT A LAYOUT. A pack owns its
 *  view's name and settings and re-asserts them on every update, so Rename and
 *  Delete on a pack row would be controls the next install silently undoes —
 *  D-145 PA10's rule. Hide is the owner's, and survives. The tests below check
 *  exactly that the refused controls are ABSENT and the permitted one works.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SavedDataView } from '@recued/contracts';

import { bootstrapSavedDataRoute } from '../saved-data-route.js';

const el = (tag: string): Record<string, unknown> => {
  const attrs = new Map<string, string>();
  const children: Array<Record<string, unknown>> = [];
  const node: Record<string, unknown> = {
    tagName: tag.toUpperCase(), innerHTML: '', textContent: '', children, attrs,
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute: (k: string, v: string) => { attrs.set(k, v); },
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
    appendChild: (c: Record<string, unknown>) => { children.push(c); return c; },
    removeChild: () => undefined, remove: () => undefined,
    listeners: new Map<string, Array<(e: unknown) => void>>(),
    addEventListener(type: string, fn: (e: unknown) => void) {
      const m = node.listeners as Map<string, Array<(e: unknown) => void>>;
      m.set(type, [...(m.get(type) ?? []), fn]);
    },
    removeEventListener: () => undefined,
    closest: () => null, focus: () => undefined,
  };
  return node;
};
const doc = (): Record<string, unknown> => ({
  head: { querySelector: () => ({}), appendChild: () => undefined },
  createElement: (t: string) => el(t),
  addEventListener: () => undefined, removeEventListener: () => undefined,
  activeElement: null,
});

const ownerView = (): SavedDataView => ({
  id: 'view_00000000-0000-4000-8000-00000000000a', name: 'My contacts',
  definition: { tab: 'contact', query: '' }, revision: 1, created_at: 1, updated_at: 1,
});
const packView = (over: Partial<SavedDataView> = {}): SavedDataView => ({
  id: 'view_00000000-0000-4000-8000-00000000000b', name: 'Overdue invoices',
  definition: { tab: 'records', owner: { publisher: 'recued-core', pack_slug: 'invoice-desk' }, entity: 'invoice' },
  revision: 3, created_at: 1, updated_at: 1,
  pack: { publisher: 'recued-core', slug: 'invoice-desk' },
  ...over,
});

const mount = (views: SavedDataView[], update = vi.fn()) => {
  const root = el('div');
  const route = bootstrapSavedDataRoute({
    // D-291 — the LIST lives on `#views`. `#data` keeps only "Save current
    // view", so mounting this rig with the default chrome would assert against
    // a surface that deliberately renders no list.
    chrome: 'views',
    root: root as never, document: doc() as never, initialTab: 'contact',
    contactListCaller: async () => ({ contacts: [], total: 0 }),
    savedViews: {
      list: async () => ({ views }),
      get: async () => ({ view: null }),
      create: async () => { throw new Error('Unexpected write'); },
      update: update as never,
      rename: async () => { throw new Error('Unexpected write'); },
      delete: async () => { throw new Error('Unexpected write'); },
    },
  } as never);
  // ⚠ The route builds `root → frame → [tools, content]`, so the panel's
  // markup is a GRANDCHILD. Reading `root.children[*].innerHTML` returns the
  // frame's, which is always '' — walk the tree instead.
  const walk = (node: Record<string, unknown>): Array<Record<string, unknown>> =>
    [node, ...(node.children as Array<Record<string, unknown>> ?? []).flatMap(walk)];
  const html = () => walk(root).map((n) => String(n.innerHTML ?? '')).join('\n');
  /** Deliver a real click to whichever descendant wired one. */
  const clickView = (action: string, id: string): void => {
    // ⚠ The handler reaches its control via `target.closest('[data-view-action]')`,
    // so the target must ANSWER that lookup with itself — a `closest` returning
    // null makes the handler early-return and the test pass for nothing.
    // `hasAttribute` is here because the walk also reaches the content pane's
    // retry listener, which reads it off the same target.
    const control: Record<string, unknown> = {
      getAttribute: (k: string) => k === 'data-view-action' ? action
        : k === 'data-view-id' ? id : null,
      hasAttribute: (k: string) => k === 'data-view-action' || k === 'data-view-id',
    };
    control.closest = (sel: string) => (sel === '[data-view-action]' ? control : null);
    for (const node of walk(root)) {
      const m = node.listeners as Map<string, Array<(e: unknown) => void>> | undefined;
      for (const fn of m?.get('click') ?? []) fn({ target: control, preventDefault: () => {} });
    }
  };
  return { route, root, html, update, clickView };
};

describe('D-289 pack views in the Saved views panel', () => {
  it('lists a pack view under its own group, attributed to the pack', async () => {
    const rig = mount([ownerView(), packView()]);
    await rig.route.whenLoaded();
    const html = rig.html();

    expect(html).toContain('From packs');
    expect(html).toContain('From invoice-desk');
    expect(html).toContain('Overdue invoices');
    rig.route.dispose();
  });

  /** ⛔ THE BOUNDARY. Rename/Delete exist for the owner's own view in the same
   *  list, so their absence on the pack row is a decision, not an oversight —
   *  which is why both halves are asserted together. */
  it('offers Rename and Delete on an owner view and NEITHER on a pack view', async () => {
    const rig = mount([ownerView(), packView()]);
    await rig.route.whenLoaded();
    const html = rig.html();

    expect(html).toContain('aria-label="Rename My contacts"');
    expect(html).toContain('aria-label="Delete My contacts"');
    expect(html).not.toContain('aria-label="Rename Overdue invoices"');
    expect(html).not.toContain('aria-label="Delete Overdue invoices"');
    expect(html).toContain('aria-label="Hide Overdue invoices"');
    rig.route.dispose();
  });

  it('hides a pack view through the update path, CASing on its revision', async () => {
    const update = vi.fn(async () => ({ view: packView({ hidden: true, revision: 4 }) }));
    const rig = mount([packView()], update);
    await rig.route.whenLoaded();

    rig.clickView('hide', packView().id);
    await rig.route.whenLoaded();

    // ⛔ The REVISION is the point: hiding CASes against the row the owner was
    // looking at, so a pack update that landed meanwhile is a conflict rather
    // than a silent overwrite.
    expect(update).toHaveBeenCalledWith({
      id: packView().id, expected_revision: 3, hidden: true,
    });
    rig.route.dispose();
  });

  it('keeps a hidden pack view listed, marked, and offering Show', async () => {
    const rig = mount([packView({ hidden: true })]);
    await rig.route.whenLoaded();
    const html = rig.html();

    // ⛔ Still listed: the only way back from Hide is a row you can still see.
    expect(html).toContain('Overdue invoices');
    expect(html).toContain('Hidden');
    expect(html).toContain('aria-label="Show Overdue invoices"');
    rig.route.dispose();
  });
});

describe('D-300 — a view a pack update replaced asks the owner what to do', () => {
  const replaced = (): SavedDataView => packView({
    id: 'view_00000000-0000-4000-8000-00000000000c', name: 'Overdue',
    retired: {
      at: 5,
      replacements: [{ id: 'view_00000000-0000-4000-8000-00000000000d', name: 'Past due' }],
      alert: { enabled: true, time_zone: 'UTC' },
    },
  });
  const mountRetired = (opts: { withResolve?: boolean } = {}) => {
    const root = el('div');
    const list = vi.fn(async () => ({ views: [packView()], retired: [replaced()] }));
    const resolveRetired = vi.fn(async () => ({ view: null }));
    const route = bootstrapSavedDataRoute({
      chrome: 'views',
      root: root as never, document: doc() as never, initialTab: 'contact',
      contactListCaller: async () => ({ contacts: [], total: 0 }),
      savedViews: {
        list,
        get: async () => ({ view: null }),
        create: async () => { throw new Error('Unexpected write'); },
        update: async () => { throw new Error('Unexpected write'); },
        rename: async () => { throw new Error('Unexpected write'); },
        delete: async () => { throw new Error('Unexpected write'); },
        ...(opts.withResolve === false ? {} : { resolveRetired }),
      },
    } as never);
    const walk = (node: Record<string, unknown>): Array<Record<string, unknown>> =>
      [node, ...(node.children as Array<Record<string, unknown>> ?? []).flatMap(walk)];
    const html = () => walk(root).map((n) => String(n.innerHTML ?? '')).join('\n');
    const click = (action: string, to: string | null = null): void => {
      const control: Record<string, unknown> = {
        getAttribute: (k: string) => k === 'data-view-action' ? action
          : k === 'data-view-id' ? replaced().id : k === 'data-view-to' ? to : null,
        hasAttribute: (k: string) => k === 'data-view-action' || k === 'data-view-id' || (k === 'data-view-to' && to !== null),
      };
      control.closest = (sel: string) => (sel === '[data-view-action]' ? control : null);
      for (const node of walk(root)) {
        const m = node.listeners as Map<string, Array<(e: unknown) => void>> | undefined;
        for (const fn of m?.get('click') ?? []) fn({ target: control, preventDefault: () => {} });
      }
    };
    const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
    return { route, html, click, list, resolveRetired, settle };
  };

  it('⛔ names the view, what the owner had set up, and the three answers', async () => {
    const rig = mountRetired();
    await rig.route.whenLoaded();
    const html = rig.html();
    expect(html).toContain('⚠ The invoice-desk update replaced “Overdue”, and you had an alert on it.');
    expect(html).toContain('>Set up “Past due” the same way</button>');
    expect(html).toContain('>Keep it as my own view</button>');
    expect(html).toContain('>Dismiss</button>');
    rig.route.dispose();
  });

  it('Set up … the same way sends the replacement, then reloads the list', async () => {
    const rig = mountRetired();
    await rig.route.whenLoaded();
    const before = rig.list.mock.calls.length;
    rig.click('retired-apply', 'view_00000000-0000-4000-8000-00000000000d');
    await rig.settle();
    expect(rig.resolveRetired).toHaveBeenCalledWith({
      id: replaced().id, action: 'apply', to_id: 'view_00000000-0000-4000-8000-00000000000d',
    });
    expect(rig.list.mock.calls.length).toBeGreaterThan(before);
    rig.route.dispose();
  });

  it('keep and dismiss send their answer', async () => {
    const rig = mountRetired();
    await rig.route.whenLoaded();
    rig.click('retired-keep');
    await rig.settle();
    rig.click('retired-dismiss');
    await rig.settle();
    expect(rig.resolveRetired.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { id: replaced().id, action: 'keep' },
      { id: replaced().id, action: 'dismiss' },
    ]);
    rig.route.dispose();
  });

  it('an older host that cannot resolve is offered nothing', async () => {
    const rig = mountRetired({ withResolve: false });
    await rig.route.whenLoaded();
    expect(rig.html()).not.toContain('update replaced');
    rig.route.dispose();
  });
});
