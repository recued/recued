/** D-115 Phase 6C — webhook-watcher queue + handler tests. */

import { describe, it, expect } from 'vitest';
import { IngredientError } from '@recued/ingredients';

import {
  createWebhookWatcherQueue,
  handleWebhookWatcher,
  type WebhookWatcherQueue,
  type WebhookWatcherRequest,
} from '../webhook-watcher.js';

const mkReq = (
  overrides: Partial<WebhookWatcherRequest> & Pick<WebhookWatcherRequest, 'delivery_id' | 'received_at'>,
): WebhookWatcherRequest => ({
  delivery_id: overrides.delivery_id,
  received_at: overrides.received_at,
  method: overrides.method ?? 'POST',
  headers: overrides.headers ?? {},
  body: overrides.body ?? '',
  source_ip: overrides.source_ip ?? null,
});

describe('createWebhookWatcherQueue — enqueue/drain', () => {
  it('drain returns FIFO order', () => {
    let t = 1000;
    const q = createWebhookWatcherQueue({ now: () => t });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'a', received_at: t }));
    t += 10;
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'b', received_at: t }));
    t += 10;
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'c', received_at: t }));
    const drained = q.drain('r1', 's1');
    expect(drained.map((r) => r.delivery_id)).toEqual(['a', 'b', 'c']);
  });
  it('drain is destructive — second drain returns empty', () => {
    const q = createWebhookWatcherQueue({ now: () => 1000 });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'a', received_at: 1000 }));
    expect(q.drain('r1', 's1')).toHaveLength(1);
    expect(q.drain('r1', 's1')).toHaveLength(0);
  });
  it('drain with no entries returns empty array', () => {
    const q = createWebhookWatcherQueue({ now: () => 1000 });
    expect(q.drain('nobody', 'x')).toEqual([]);
  });
  it('segregates by (recipe_id, slug)', () => {
    const q = createWebhookWatcherQueue({ now: () => 1000 });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'a', received_at: 1000 }));
    q.enqueue('r1', 's2', mkReq({ delivery_id: 'b', received_at: 1000 }));
    q.enqueue('r2', 's1', mkReq({ delivery_id: 'c', received_at: 1000 }));
    expect(q.drain('r1', 's1').map((r) => r.delivery_id)).toEqual(['a']);
    expect(q.drain('r1', 's2').map((r) => r.delivery_id)).toEqual(['b']);
    expect(q.drain('r2', 's1').map((r) => r.delivery_id)).toEqual(['c']);
  });
});

describe('createWebhookWatcherQueue — size', () => {
  it('size reports current non-expired count', () => {
    const q = createWebhookWatcherQueue({ now: () => 1000 });
    expect(q.size('r1', 's1')).toBe(0);
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'a', received_at: 1000 }));
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'b', received_at: 1000 }));
    expect(q.size('r1', 's1')).toBe(2);
  });
});

describe('createWebhookWatcherQueue — per-key cap', () => {
  it('evicts oldest FIFO when cap exceeded', () => {
    const q = createWebhookWatcherQueue({ now: () => 1000, maxPerKey: 3 });
    for (let i = 0; i < 5; i++) {
      q.enqueue('r1', 's1', mkReq({ delivery_id: `d${i}`, received_at: 1000 }));
    }
    const drained = q.drain('r1', 's1');
    expect(drained.map((r) => r.delivery_id)).toEqual(['d2', 'd3', 'd4']);
  });
});

describe('createWebhookWatcherQueue — TTL eviction', () => {
  it('prunes entries older than ttlMs on drain', () => {
    let t = 1000;
    const q = createWebhookWatcherQueue({ now: () => t, ttlMs: 100 });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'stale', received_at: 1000 }));
    t = 1090;
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'fresh', received_at: 1090 }));
    // stale (1000) older than ttl=100 by drain at t=1110 (cutoff=1010);
    // fresh (1090) stays.
    t = 1110;
    const drained = q.drain('r1', 's1');
    expect(drained.map((r) => r.delivery_id)).toEqual(['fresh']);
  });
  it('prunes on enqueue too', () => {
    let t = 1000;
    const q = createWebhookWatcherQueue({ now: () => t, ttlMs: 100 });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'stale', received_at: 1000 }));
    t = 1200;
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'fresh', received_at: 1200 }));
    expect(q.size('r1', 's1')).toBe(1);
  });
  it('size() prunes before counting', () => {
    let t = 1000;
    const q = createWebhookWatcherQueue({ now: () => t, ttlMs: 100 });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'stale', received_at: 1000 }));
    t = 1200;
    expect(q.size('r1', 's1')).toBe(0);
  });
});

describe('createWebhookWatcherQueue — purgeRecipe', () => {
  it('drops every slug for a given recipe', () => {
    const q = createWebhookWatcherQueue({ now: () => 1000 });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'a', received_at: 1000 }));
    q.enqueue('r1', 's2', mkReq({ delivery_id: 'b', received_at: 1000 }));
    q.enqueue('r2', 's1', mkReq({ delivery_id: 'c', received_at: 1000 }));
    q.purgeRecipe('r1');
    expect(q.size('r1', 's1')).toBe(0);
    expect(q.size('r1', 's2')).toBe(0);
    expect(q.size('r2', 's1')).toBe(1);
  });
});

describe('handleWebhookWatcher — kernel handler', () => {
  const fixedNow = () => 1000;

  it('drains and returns requests when queue has entries', async () => {
    const q = createWebhookWatcherQueue({ now: fixedNow });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'a', received_at: 1000, body: 'hello' }));
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'b', received_at: 1000 }));
    const r = await handleWebhookWatcher(
      { queue: q },
      { recipe_id: 'r1', slug: 's1' },
    );
    expect(r.should_run).toBe(true);
    expect(r.requests.map((x) => x.delivery_id)).toEqual(['a', 'b']);
    expect(r.queue_size).toBe(0);
  });

  it('returns no-fire on empty queue', async () => {
    const q: WebhookWatcherQueue = createWebhookWatcherQueue({ now: fixedNow });
    const r = await handleWebhookWatcher(
      { queue: q },
      { recipe_id: 'r1', slug: 's1' },
    );
    expect(r.should_run).toBe(false);
    expect(r.requests).toEqual([]);
    expect(r.queue_size).toBe(0);
  });

  it('rejects missing recipe_id', async () => {
    const q = createWebhookWatcherQueue({ now: fixedNow });
    await expect(
      handleWebhookWatcher({ queue: q }, { slug: 's1' }),
    ).rejects.toThrow(IngredientError);
  });

  it('rejects empty slug', async () => {
    const q = createWebhookWatcherQueue({ now: fixedNow });
    await expect(
      handleWebhookWatcher({ queue: q }, { recipe_id: 'r1', slug: '' }),
    ).rejects.toThrow(/slug/);
  });

  it('subsequent tick returns empty after successful drain', async () => {
    const q = createWebhookWatcherQueue({ now: fixedNow });
    q.enqueue('r1', 's1', mkReq({ delivery_id: 'a', received_at: 1000 }));
    const r1 = await handleWebhookWatcher(
      { queue: q },
      { recipe_id: 'r1', slug: 's1' },
    );
    expect(r1.should_run).toBe(true);
    const r2 = await handleWebhookWatcher(
      { queue: q },
      { recipe_id: 'r1', slug: 's1' },
    );
    expect(r2.should_run).toBe(false);
  });
});
