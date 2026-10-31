/** D-335 slice D — a read of a page in the browser is never served from the
 *  cache. The page changes without the read's input changing: after a click,
 *  the same page handle has other HTML, and an inspection's refs are those its
 *  own read handed out. A read like any other `data` read was cached for at
 *  least 60 seconds, so the Browser Toolkit's "inspect, click, inspect again"
 *  would show the AI the page as it was. */

import { describe, expect, it } from 'vitest';
import { createInMemoryStore } from '@recued/cache';
import type { IngredientManifest } from '@recued/contracts';
import { withIngredientCache, type CacheStatus } from '../cache.js';
import type { IngredientExecutor } from '../types.js';

const read = (slug: string, kind: IngredientManifest['kind']): IngredientManifest => ({
  slug, name: slug, description: 'test', author: 'recued', kind, category: 'data', risk_tier: 'read', input: {}, output: {},
});

const twice = async (manifest: IngredientManifest) => {
  let reads = 0;
  const exec: IngredientExecutor = async () => `page as read ${++reads}`;
  const statuses: CacheStatus[] = [];
  const store = createInMemoryStore();
  const cached = withIngredientCache(exec, {
    manifestLoader: async slug => (slug === manifest.slug ? manifest : null),
    store, recipe_ttl: 0, recipe_id: 'inspect-web-page', onStatus: status => statuses.push(status),
  });
  const input = { target: '*://*/*', page: '812:6A1F' };
  const first = await cached(manifest.slug, input);
  const second = await cached(manifest.slug, input);
  return { first, second, reads, statuses, stored: await store.size() };
};

describe('a page read is never served from the cache', () => {
  it('reads the page again on the same input, and keeps nothing', async () => {
    const out = await twice(read('dom-inspect', 'dom'));
    expect([out.first, out.second]).toEqual(['page as read 1', 'page as read 2']);
    expect(out.reads).toBe(2);
    expect(out.stored).toBe(0);
    expect(out.statuses).toEqual(['skipped', 'skipped']);
  });

  it('control: the same read from any other kind is cached, so the case above can fail', async () => {
    const out = await twice(read('crm-read', 'http'));
    expect([out.first, out.second]).toEqual(['page as read 1', 'page as read 1']);
    expect(out.reads).toBe(1);
  });
});
