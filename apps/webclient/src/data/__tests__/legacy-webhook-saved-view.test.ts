/** A saved view of the removed "Webhook deliveries" tab (2026-10-10).
 *
 *  The tab browsed the Phase D webhook collection, which nothing in production
 *  ever created, so it was always empty and is gone. A row saved from it can
 *  still be on an owner's disk, and it must keep decoding: `decode` in
 *  `saved-data-view-store.ts` THROWS on a definition the parser rejects, and
 *  `list` maps decode over every row, so one such row would take the whole
 *  saved-view list down (the D-290 `today` precedent). Opening it goes to
 *  Connections → Webhooks, where the owner's webhooks and deliveries are.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseSavedDataViewDefinition, type SavedDataView } from '@recued/contracts';

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
  const location = { hash: '#views/view_00000000-0000-4000-8000-00000000000d' };
  const doc: Record<string, unknown> = {
    head: { querySelector: () => ({}), appendChild: () => undefined },
    createElement: (t: string) => el(t),
    addEventListener: () => undefined, removeEventListener: () => undefined,
    activeElement: null,
    defaultView: { location },
  };
  const view: SavedDataView = {
    id: 'view_00000000-0000-4000-8000-00000000000d', name: 'Intake deliveries',
    definition, revision: 1, created_at: 1, updated_at: 1,
  };
  const contactListCaller = vi.fn(async () => ({ contacts: [], total: 0 }));
  const collectionListInstancesCaller = vi.fn(async () => ({ instances: [] }));
  const route = bootstrapSavedDataRoute({
    root: el('div') as never, document: doc as never,
    savedViewId: view.id,
    contactListCaller: contactListCaller as never,
    collectionListInstancesCaller: collectionListInstancesCaller as never,
    savedViews: {
      list: async () => ({ views: [view] }),
      get: async () => ({ view }),
      create: async () => { throw new Error('Unexpected write'); },
      update: async () => { throw new Error('Unexpected write'); },
      rename: async () => { throw new Error('Unexpected write'); },
      delete: async () => { throw new Error('Unexpected write'); },
    },
  } as never);
  return { route, location, contactListCaller, collectionListInstancesCaller };
};

describe('a saved view of the removed Webhook deliveries tab', () => {
  it('still parses, so it cannot take the saved-view list down', () => {
    expect(parseSavedDataViewDefinition({ tab: 'webhook', collection_slug: 'intake' }))
      .toEqual({ tab: 'webhook', collection_slug: 'intake' });
    expect(parseSavedDataViewDefinition({ tab: 'webhook', collection_slug: null }))
      .toEqual({ tab: 'webhook', collection_slug: null });
  });

  it('opens Connections → Webhooks instead of mounting the Data route', async () => {
    const r = rig({ tab: 'webhook', collection_slug: 'intake' });
    await r.route.whenLoaded();

    expect(r.location.hash).toBe('#connections/webhooks');
    // Nothing of the Data route painted under the hash change.
    expect(r.contactListCaller).not.toHaveBeenCalled();
    expect(r.collectionListInstancesCaller).not.toHaveBeenCalled();
    r.route.dispose();
  });
});
