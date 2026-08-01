/** D-115 Phase 6 — watcher dispatcher composition tests. */

import { describe, it, expect, vi } from 'vitest';
import type { KernelWatcherSlug } from '@recued/ingredients';
import type { AuditLogStore } from '@recued/storage';

import type { CollectionRegistry } from '../../collections/registry.js';
import type { Collection } from '../../collections/types.js';
import { createWatcherDispatcher } from '../index.js';

const mkAuditLog = (): AuditLogStore => ({
  append: async () => {},
  listRecent: async () => [],
  listByRecipe: async () => [],
  listByChannelSession: async () => [],
  listByCognitionSession: async () => [],
  listByCorrelation: async () => [],
  listByDish: async () => [],
  latestByDishes: async () => new Map(),
  get: async () => null,
  clearOlderThan: async () => 0,
  clearByRecipe: async () => 0,
  exportAll: async () => [],
  size: async () => 0,
  clearAll: async () => {},
  logActivity: async () => {},
  listActivities: async () => [],
  exportActivities: async () => [],
  clearOldestActivities: async () => 0,
  clearOldestEntries: async () => 0,
  countReserveEntries: async () => 0,
  countReserveActivities: async () => 0,
  lastSuccessfulBridgeDispatch: async () => null,
});

describe('createWatcherDispatcher — routing', () => {
  it('routes time-watcher to evaluateTimeWatcher', async () => {
    const dispatch = createWatcherDispatcher({});
    const r = await dispatch({ slug: 'time-watcher', args: {} });
    expect(r.should_run).toBe(true);
  });

  it('routes recipe-watcher when auditLog present', async () => {
    const dispatch = createWatcherDispatcher({ auditLog: mkAuditLog() });
    const r = await dispatch({
      slug: 'recipe-watcher',
      args: { kind: 'succeeded_since', recipe_id: 't', since_ms: 0 },
    });
    expect(r.should_run).toBe(false);
  });

  it('recipe-watcher returns SERVER_NOT_REACHABLE without auditLog', async () => {
    const dispatch = createWatcherDispatcher({});
    await expect(
      dispatch({
        slug: 'recipe-watcher',
        args: { kind: 'succeeded_since', recipe_id: 't', since_ms: 0 },
      }),
    ).rejects.toMatchObject({
      name: 'IngredientError',
      code: 'SERVER_NOT_REACHABLE',
    });
  });

  it('routes http-watcher through evaluateHttpWatcher', async () => {
    const fetchFn = vi.fn(async () => new Response('x', { status: 200 }));
    const dispatch = createWatcherDispatcher({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const r = await dispatch({
      slug: 'http-watcher',
      args: { target_url: 'https://example.com' },
    });
    expect(r.should_run).toBe(true);
  });

  it('calendar-watcher returns SERVER_NOT_REACHABLE without collectionRegistry', async () => {
    const dispatch = createWatcherDispatcher({});
    await expect(
      dispatch({ slug: 'calendar-watcher', args: { slug: 'work', kind: 'starting_soon' } }),
    ).rejects.toMatchObject({ name: 'IngredientError', code: 'SERVER_NOT_REACHABLE' });
  });

  it('calendar-watcher returns SERVER_NOT_REACHABLE without calendarWatcherCursors', async () => {
    const registry = {
      get: () => undefined,
      register() {},
      list: () => [],
      async dispose() {},
    } as unknown as CollectionRegistry;
    const dispatch = createWatcherDispatcher({ collectionRegistry: registry });
    await expect(
      dispatch({ slug: 'calendar-watcher', args: { slug: 'work', kind: 'starting_soon' } }),
    ).rejects.toMatchObject({ name: 'IngredientError', code: 'SERVER_NOT_REACHABLE' });
  });

  it('routes calendar-watcher through collectionRegistry', async () => {
    const listSnapshots = vi.fn(() => []);
    const collection = {
      platform: 'calendar',
      slug: 'work',
      table: { listSnapshots },
    } as unknown as Collection;
    const registry = {
      get: (platform: string, slug: string) =>
        platform === 'calendar' && slug === 'work' ? collection : undefined,
      register() {},
      list: () => [],
      async dispose() {},
    } as unknown as CollectionRegistry;
    const cursors = {
      get: () => null,
      set: () => {},
      clear: () => {},
    };
    const dispatch = createWatcherDispatcher({
      collectionRegistry: registry,
      calendarWatcherCursors: cursors,
    });
    const r = await dispatch({
      slug: 'calendar-watcher',
      args: { slug: 'work', kind: 'starting_soon', minutes_ahead: 15 },
    });
    expect(listSnapshots).toHaveBeenCalled();
    expect(r.should_run).toBe(false);
  });

  it('routes mail-watcher through collectionRegistry', async () => {
    const records = [{
      record_id: 'a',
      received_at: 1000,
      modified_at: 1000,
      hot_fields: { from: 'x@y.com' },
      size_bytes: 500,
      source_id: 'imap',
    }];
    const collection = {
      platform: 'mail',
      slug: 'primary',
      list: () => records,
      get: () => null,
      search: () => [],
      async close() {},
    } as unknown as Collection;
    const registry = {
      get: (platform: string, slug: string) =>
        platform === 'mail' && slug === 'primary' ? collection : undefined,
      register() {},
      list: () => [],
      async dispose() {},
    } as unknown as CollectionRegistry;
    const dispatch = createWatcherDispatcher({ collectionRegistry: registry });
    const r = await dispatch({ slug: 'mail-watcher', args: { slug: 'primary' } });
    expect(r.should_run).toBe(true);
  });

  it('mail-watcher returns SERVER_NOT_REACHABLE without collectionRegistry', async () => {
    const dispatch = createWatcherDispatcher({});
    await expect(
      dispatch({ slug: 'mail-watcher', args: { slug: 'primary' } }),
    ).rejects.toMatchObject({ name: 'IngredientError', code: 'SERVER_NOT_REACHABLE' });
  });

  it('routes file-watcher through collectionRegistry', async () => {
    const records = [{
      record_id: 'a',
      received_at: 1000,
      modified_at: 1000,
      hot_fields: { path: '/notes/a.md' },
      size_bytes: 500,
      source_id: 'fs',
    }];
    const collection = {
      platform: 'file',
      slug: 'home',
      list: () => records,
      get: () => null,
      search: () => [],
      async close() {},
    } as unknown as Collection;
    const registry = {
      get: (platform: string, slug: string) =>
        platform === 'file' && slug === 'home' ? collection : undefined,
      register() {},
      list: () => [],
      async dispose() {},
    } as unknown as CollectionRegistry;
    const dispatch = createWatcherDispatcher({ collectionRegistry: registry });
    const r = await dispatch({ slug: 'file-watcher', args: { slug: 'home' } });
    expect(r.should_run).toBe(true);
  });

  it('file-watcher returns SERVER_NOT_REACHABLE without collectionRegistry', async () => {
    const dispatch = createWatcherDispatcher({});
    await expect(
      dispatch({ slug: 'file-watcher', args: { slug: 'home' } }),
    ).rejects.toMatchObject({ name: 'IngredientError', code: 'SERVER_NOT_REACHABLE' });
  });

  it('routes webhook-watcher through webhookQueue', async () => {
    const { createWebhookWatcherQueue } = await import('../webhook-watcher.js');
    const queue = createWebhookWatcherQueue({ now: () => 1000 });
    queue.enqueue('r1', 's1', {
      delivery_id: 'a',
      received_at: 1000,
      method: 'POST',
      headers: {},
      body: 'x',
      source_ip: null,
    });
    const dispatch = createWatcherDispatcher({ webhookQueue: queue });
    const r = await dispatch({
      slug: 'webhook-watcher',
      args: { recipe_id: 'r1', slug: 's1' },
    });
    expect(r.should_run).toBe(true);
  });

  it('webhook-watcher returns SERVER_NOT_REACHABLE without queue', async () => {
    const dispatch = createWatcherDispatcher({});
    await expect(
      dispatch({ slug: 'webhook-watcher', args: { recipe_id: 'r1', slug: 's1' } }),
    ).rejects.toMatchObject({ name: 'IngredientError', code: 'SERVER_NOT_REACHABLE' });
  });

  it('an unknown / retired watcher slug fails closed with SERVER_NOT_REACHABLE', async () => {
    // The runWatcher / testTrigger rpc boundary casts `slug: string` into the
    // union, so a stale slug (e.g. the retired `dom-watcher`) or a typo reaches
    // the dispatcher at runtime — the `default` arm must fail closed, not fall
    // through to an undefined return the rpc handler then dereferences.
    const dispatch = createWatcherDispatcher({ auditLog: mkAuditLog() });
    await expect(
      dispatch({ slug: 'dom-watcher' as KernelWatcherSlug, args: {} }),
    ).rejects.toMatchObject({ name: 'IngredientError', code: 'SERVER_NOT_REACHABLE' });
  });
});
