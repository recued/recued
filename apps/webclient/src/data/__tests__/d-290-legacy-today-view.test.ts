/** D-290 — a saved view created BEFORE Today left `#data`.
 *
 *  ⛔ THE ROW STILL EXISTS ON OWNERS' DISKS. `{ tab: 'today' }` was creatable
 *  until D-290 and carries no other field — it was a bookmark. Today is its own
 *  route now, so `initialTab = 'today'` is no longer a `DataTabId` and the Data
 *  route falls back to Contacts: the owner presses "My day" and lands on their
 *  contact list with nothing saying why.
 *
 *  ⛔⛔ AND THE FIX IS NOT TO DROP THE VOCABULARY MEMBER. `decode` in
 *  `saved-data-view-store.ts` THROWS when `parseSavedDataViewDefinition`
 *  returns null, and `list` maps decode over every row — so removing `'today'`
 *  from the union would take the owner's ENTIRE saved-view list down over one
 *  legacy row. The arm stays parseable; only the navigation changes.
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
    addEventListener: () => undefined, removeEventListener: () => undefined,
    closest: () => null, focus: () => undefined,
  };
  return node;
};

const rig = (definition: SavedDataView['definition']) => {
  const location = { hash: '#data/view/view_00000000-0000-4000-8000-00000000000c' };
  const doc: Record<string, unknown> = {
    head: { querySelector: () => ({}), appendChild: () => undefined },
    createElement: (t: string) => el(t),
    addEventListener: () => undefined, removeEventListener: () => undefined,
    activeElement: null,
    defaultView: { location },
  };
  const view: SavedDataView = {
    id: 'view_00000000-0000-4000-8000-00000000000c', name: 'My day',
    definition, revision: 1, created_at: 1, updated_at: 1,
  };
  const contactListCaller = vi.fn(async () => ({ contacts: [], total: 0 }));
  const route = bootstrapSavedDataRoute({
    root: el('div') as never, document: doc as never,
    savedViewId: view.id,
    contactListCaller: contactListCaller as never,
    savedViews: {
      list: async () => ({ views: [view] }),
      get: async () => ({ view }),
      create: async () => { throw new Error('Unexpected write'); },
      update: async () => { throw new Error('Unexpected write'); },
      rename: async () => { throw new Error('Unexpected write'); },
      delete: async () => { throw new Error('Unexpected write'); },
    },
  } as never);
  return { route, location, contactListCaller };
};

describe('D-290 a legacy `tab: today` saved view', () => {
  it('sends the owner to #today instead of silently landing on Contacts', async () => {
    const r = rig({ tab: 'today' });
    await r.route.whenLoaded();

    expect(r.location.hash).toBe('#today');
    // ⛔ THE SECOND HALF IS THE ACTUAL BUG. Navigating away is only right if we
    // did NOT also mount the Data route underneath — a contact read here means
    // the owner saw Contacts paint before the hash moved.
    expect(r.contactListCaller).not.toHaveBeenCalled();
    r.route.dispose();
  });

  it('still mounts a normal saved view where it is', async () => {
    const r = rig({ tab: 'contact', query: '' });
    await r.route.whenLoaded();

    expect(r.location.hash).toBe('#data/view/view_00000000-0000-4000-8000-00000000000c');
    expect(r.contactListCaller).toHaveBeenCalled();
    r.route.dispose();
  });
});
