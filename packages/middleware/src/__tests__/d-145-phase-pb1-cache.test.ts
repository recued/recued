/** D-145 PB1.3 — cache + invalidation tests. */

import { describe, expect, it, beforeEach } from 'vitest';

import * as capacity from '../capacity/index.js';
import { CAPACITY_CACHE_POLICIES, capacityKey } from '@recued/contracts';

type CapacityCacheRow = capacity.CapacityCacheRow;

const ctx = (bridge_instance_id?: string) => ({
  audit_emitter: {
    async emitOk() {},
    async emitGap() {},
  },
  transparency_emitter: { async emit() {} },
  ...(bridge_instance_id ? { bridge_instance_id } : {}),
});

describe('D-145 PB1.3 — cache read / write', () => {
  it('writes + reads a cacheable row', () => {
    const cache = capacity.createCapacityCache();
    const key = capacityKey({ kind: 'bridge_online' });
    const row: CapacityCacheRow = {
      capacity_kind: 'bridge_online',
      capacity_key: key,
      result: { ok: true },
      checked_at: 1000,
    };
    cache.write(key, ctx(), row);
    const read = cache.read(key, ctx());
    expect(read).not.toBeNull();
    expect(read?.checked_at).toBe(1000);
  });

  it('returns null for non-cacheable kinds', () => {
    const cache = capacity.createCapacityCache();
    const key = capacityKey({ kind: 'annotation', ref: 'data.contact.X.aliases.facebook' });
    cache.write(key, ctx(), {
      capacity_kind: 'annotation',
      capacity_key: key,
      result: { ok: true },
      checked_at: 1000,
    });
    const read = cache.read(key, ctx());
    expect(read).toBeNull();
  });

  it('partitions bridge_online cache by bridge_instance_id', () => {
    const cache = capacity.createCapacityCache();
    const key = capacityKey({ kind: 'bridge_online' });
    cache.write(key, ctx('bridge-A'), {
      capacity_kind: 'bridge_online',
      capacity_key: key,
      bridge_instance_id: 'bridge-A',
      result: { ok: true },
      checked_at: 1000,
    });
    cache.write(key, ctx('bridge-B'), {
      capacity_kind: 'bridge_online',
      capacity_key: key,
      bridge_instance_id: 'bridge-B',
      result: { ok: false },
      checked_at: 2000,
    });
    expect(cache.read(key, ctx('bridge-A'))?.checked_at).toBe(1000);
    expect(cache.read(key, ctx('bridge-B'))?.checked_at).toBe(2000);
  });
});

describe('D-145 PB1.3 — invalidateByTopic dispatcher', () => {
  let cache: ReturnType<typeof capacity.createCapacityCache>;
  beforeEach(() => {
    cache = capacity.createCapacityCache();
  });

  it('drops bridge_online rows on bridge.online_state_changed', () => {
    cache.write(capacityKey({ kind: 'bridge_online' }), ctx(), {
      capacity_kind: 'bridge_online',
      capacity_key: 'bridge_online',
      result: { ok: true },
      checked_at: 1,
    });
    expect(cache.size()).toBe(1);
    cache.invalidateByTopic({ topic: 'bridge.online_state_changed' });
    expect(cache.size()).toBe(0);
  });

  // ⛔ 'source.enabled_changed drops only matching vendor (PA11 join)' was
  // DELETED with the topic (D-187 Sources half). Its shape is already covered
  // by 'connection.disabled drops matching connection_active row' below —
  // same matcher, same rows, a topic that can actually fire.

  it('ingredient.bumped drops the matching selector_freshness row', () => {
    cache.write('selector_freshness:webchat-gemini', ctx(), {
      capacity_kind: 'selector_freshness',
      capacity_key: 'selector_freshness:webchat-gemini',
      slug: 'webchat-gemini',
      result: { ok: true },
      checked_at: 1,
    });
    expect(cache.size()).toBe(1);
    cache.invalidateByTopic({ topic: 'ingredient.bumped', slug: 'webchat-gemini' });
    expect(cache.size()).toBe(0);
  });

  it('ingredient.installed drops matching ingredient_installed', () => {
    cache.write('ingredient_installed:foo', ctx(), {
      capacity_kind: 'ingredient_installed',
      capacity_key: 'ingredient_installed:foo',
      slug: 'foo',
      result: { ok: true },
      checked_at: 1,
    });
    cache.write('ingredient_installed:bar', ctx(), {
      capacity_kind: 'ingredient_installed',
      capacity_key: 'ingredient_installed:bar',
      slug: 'bar',
      result: { ok: true },
      checked_at: 1,
    });
    cache.invalidateByTopic({ topic: 'ingredient.installed', slug: 'foo' });
    expect(cache.size()).toBe(1);
  });

  it('quota.headroom_changed drops matching pool_quota_available row', () => {
    cache.write('pool_quota_available:free', ctx(), {
      capacity_kind: 'pool_quota_available',
      capacity_key: 'pool_quota_available:free',
      pool: 'free',
      result: { ok: true },
      checked_at: 1,
    });
    cache.invalidateByTopic({ topic: 'quota.headroom_changed', pool: 'free' });
    expect(cache.size()).toBe(0);
  });

  it('permission.grant_changed drops matching row', () => {
    cache.write('permission_grant:write_enrichment', ctx(), {
      capacity_kind: 'permission_grant',
      capacity_key: 'permission_grant:write_enrichment',
      permission: 'write_enrichment',
      result: { ok: true },
      checked_at: 1,
    });
    cache.invalidateByTopic({
      topic: 'permission.grant_changed',
      permission: 'write_enrichment',
    });
    expect(cache.size()).toBe(0);
  });

  it('connection.disabled drops matching connection_active row', () => {
    cache.write('connection_active:hubspot:task:c1', ctx(), {
      capacity_kind: 'connection_active',
      capacity_key: 'connection_active:hubspot:task:c1',
      vendor: 'hubspot',
      entity: 'task',
      connection_id: 'c1',
      result: { ok: true },
      checked_at: 1,
    });
    cache.invalidateByTopic({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
      connection_id: 'c1',
    });
    expect(cache.size()).toBe(0);
  });

  it('logged_in invalidation respects bridge_instance_id + site filters', () => {
    cache.write('logged_in:gemini.google.com', ctx('bridge-A'), {
      capacity_kind: 'logged_in',
      capacity_key: 'logged_in:gemini.google.com',
      bridge_instance_id: 'bridge-A',
      site: 'gemini.google.com',
      result: { ok: true },
      checked_at: 1,
    });
    cache.invalidateByTopic({
      topic: 'bridge.login_state_changed',
      bridge_instance_id: 'bridge-B',
    });
    // Bridge B != Bridge A — no drop.
    expect(cache.size()).toBe(1);
    cache.invalidateByTopic({
      topic: 'bridge.login_state_changed',
      bridge_instance_id: 'bridge-A',
    });
    expect(cache.size()).toBe(0);
  });
});

describe('D-145 PB1.3 — Codex P2 fold: broader-row invalidation', () => {
  let cache: ReturnType<typeof capacity.createCapacityCache>;
  beforeEach(() => {
    cache = capacity.createCapacityCache();
  });

  it('connection.disabled for narrow conn-id drops aggregate row (no connection_id)', () => {
    cache.write('connection_active:hubspot:task', ctx(), {
      capacity_kind: 'connection_active',
      capacity_key: 'connection_active:hubspot:task',
      vendor: 'hubspot',
      entity: 'task',
      // aggregate — no connection_id
      result: { ok: true },
      checked_at: 1,
    });
    expect(cache.size()).toBe(1);
    cache.invalidateByTopic({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
      connection_id: 'conn-42',
    });
    expect(cache.size()).toBe(0);
  });

  it('connection.disabled for narrow entity drops vendor-wide aggregate row', () => {
    cache.write('connection_active:hubspot:*', ctx(), {
      capacity_kind: 'connection_active',
      capacity_key: 'connection_active:hubspot:*',
      vendor: 'hubspot',
      // entity-wide aggregate — no entity
      result: { ok: true },
      checked_at: 1,
    });
    expect(cache.size()).toBe(1);
    cache.invalidateByTopic({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
    });
    expect(cache.size()).toBe(0);
  });

  it('connection.disabled with full narrowing drops both narrow + aggregate rows', () => {
    cache.write('connection_active:hubspot:task:c1', ctx(), {
      capacity_kind: 'connection_active',
      capacity_key: 'connection_active:hubspot:task:c1',
      vendor: 'hubspot',
      entity: 'task',
      connection_id: 'c1',
      result: { ok: true },
      checked_at: 1,
    });
    cache.write('connection_active:hubspot:task', ctx(), {
      capacity_kind: 'connection_active',
      capacity_key: 'connection_active:hubspot:task',
      vendor: 'hubspot',
      entity: 'task',
      result: { ok: true },
      checked_at: 1,
    });
    expect(cache.size()).toBe(2);
    cache.invalidateByTopic({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
      connection_id: 'c1',
    });
    expect(cache.size()).toBe(0);
  });

  it('narrow event does NOT drop unrelated vendor row', () => {
    cache.write('connection_active:salesforce:contact', ctx(), {
      capacity_kind: 'connection_active',
      capacity_key: 'connection_active:salesforce:contact',
      vendor: 'salesforce',
      entity: 'contact',
      result: { ok: true },
      checked_at: 1,
    });
    cache.invalidateByTopic({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
      connection_id: 'c1',
    });
    expect(cache.size()).toBe(1);
  });
});

describe('D-145 PB1.3 — invalidationSource subscriptions', () => {
  it('cache subscribes to every CACHE_POLICIES invalidation_topics topic', () => {
    const invalidationSource = capacity.createCapacityInvalidationSource();
    const dropped: { topic: string; count: number }[] = [];
    const cache = capacity.createCapacityCache({
      invalidationSource,
      onInvalidate: (topic, count) => dropped.push({ topic, count }),
    });
    cache.write('connection_active:hubspot:task', ctx(), {
      capacity_kind: 'connection_active',
      capacity_key: 'connection_active:hubspot:task',
      vendor: 'hubspot',
      entity: 'task',
      result: { ok: true },
      checked_at: 1,
    });
    invalidationSource.publish({
      topic: 'connection.disabled',
      vendor: 'hubspot',
      entity: 'task',
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.count).toBe(1);
  });
});

describe('D-145 PB1.3 — cache policy ratchet', () => {
  it('every kind has well-formed cache policy', () => {
    for (const k of Object.keys(CAPACITY_CACHE_POLICIES)) {
      const policy = CAPACITY_CACHE_POLICIES[k as keyof typeof CAPACITY_CACHE_POLICIES];
      expect(policy.capacity_kind).toBe(k);
      if (policy.cacheable) {
        expect(policy.ttl_ms).toBeGreaterThan(0);
      } else {
        expect(policy.ttl_ms).toBe(0);
      }
    }
  });
});

describe('D-145 PB1.3 — invalidation source pub/sub', () => {
  it('subscribers receive published payloads on their topic', () => {
    const src = capacity.createCapacityInvalidationSource();
    const received: string[] = [];
    const sub = src.subscribe('connection.disabled', () => {
      received.push('hit');
    });
    src.publish({ topic: 'connection.disabled' });
    expect(received).toEqual(['hit']);
    sub.unsubscribe();
    src.publish({ topic: 'connection.disabled' });
    expect(received).toEqual(['hit']);
  });

  it('cross-topic publishes do not fan out to unrelated subscribers', () => {
    const src = capacity.createCapacityInvalidationSource();
    let count = 0;
    src.subscribe('connection.disabled', () => {
      count += 1;
    });
    src.publish({ topic: 'bridge.online_state_changed' });
    expect(count).toBe(0);
  });
});
