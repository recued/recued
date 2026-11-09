/** D-148 P3 — idempotency cache tests.
 *
 *  Covers spec § A.3.3 idempotency replay + 24h TTL sweep + drift
 *  detection via lookupByIdempotencyKey. */

import { describe, it, expect } from 'vitest';
import { BRIDGE_IDEMPOTENCY_TTL_MS, type BridgeResult } from '@recued/contracts';
import {
  createInMemoryIdempotencyCache,
  stampIdempotencyResult,
} from '../idempotency/cache.js';

const buildResult = (command_id: string, status: BridgeResult['status'] = 'ok'): BridgeResult => ({
  command_id,
  status,
  outputs: { mock: true },
  duration_ms: 10,
  bridge_version: '0.0.1',
  idempotency_key_seen: false,
});

describe('D-148 P3 — idempotency cache replay', () => {
  it('keeps unresolved admission through receipt clearing and permits a verified original completion', async () => {
    let now = 1_000;
    const cache = createInMemoryIdempotencyCache({ now: () => now });
    expect((await cache.claim('original', 'same-key')).kind).toBe('claimed');
    await cache.store('original', 'same-key', buildResult('original', 'timeout'));
    now += BRIDGE_IDEMPOTENCY_TTL_MS;
    await cache.sweepExpired(now); await cache.clear();
    expect((await cache.claim('retry', 'same-key')).kind).toBe('in_flight');
    await cache.store('original', 'same-key', buildResult('original'));
    expect(await cache.claim('retry', 'same-key')).toMatchObject({ kind: 'completed', entry: { command_id: 'original' } });
  });

  it('store + lookup round-trip', async () => {
    const cache = createInMemoryIdempotencyCache({ now: () => 1000 });
    await cache.store('cmd-1', 'idem-1', buildResult('cmd-1'));
    const e = await cache.lookup('cmd-1');
    expect(e?.command_id).toBe('cmd-1');
    expect(e?.idempotency_key).toBe('idem-1');
    expect(e?.expires_at).toBe(1000 + BRIDGE_IDEMPOTENCY_TTL_MS);
  });

  it('lookup misses on absent command', async () => {
    const cache = createInMemoryIdempotencyCache();
    expect(await cache.lookup('absent')).toBeNull();
  });

  it('lookup returns null for expired entries (24h TTL)', async () => {
    let now = 1000;
    const cache = createInMemoryIdempotencyCache({ now: () => now });
    await cache.store('cmd-1', 'idem-1', buildResult('cmd-1'));
    now += BRIDGE_IDEMPOTENCY_TTL_MS + 1;
    expect(await cache.lookup('cmd-1')).toBeNull();
  });

  it('lookupByIdempotencyKey detects server retrying with new command_id', async () => {
    const cache = createInMemoryIdempotencyCache({ now: () => 1000 });
    await cache.store('cmd-original', 'idem-shared', buildResult('cmd-original'));
    const drifted = await cache.lookupByIdempotencyKey('idem-shared');
    expect(drifted?.command_id).toBe('cmd-original');
  });

  it('sweepExpired removes 24h-old entries + returns count', async () => {
    let now = 1000;
    const cache = createInMemoryIdempotencyCache({ now: () => now });
    await cache.store('cmd-1', 'idem-1', buildResult('cmd-1'));
    await cache.store('cmd-2', 'idem-2', buildResult('cmd-2'));
    now += BRIDGE_IDEMPOTENCY_TTL_MS + 1;
    const swept = await cache.sweepExpired(now);
    expect(swept).toBe(2);
    expect(await cache.list()).toHaveLength(0);
  });

  it('sweepExpired leaves fresh entries alone', async () => {
    const cache = createInMemoryIdempotencyCache({ now: () => 1000 });
    await cache.store('cmd-1', 'idem-1', buildResult('cmd-1'));
    const swept = await cache.sweepExpired(2000); // 1s elapsed << 24h
    expect(swept).toBe(0);
    expect(await cache.list()).toHaveLength(1);
  });
});

describe('D-148 P3 — stampIdempotencyResult', () => {
  it('flips idempotency_key_seen on cache-hit replay', () => {
    const fresh = buildResult('cmd-2');
    const stamped = stampIdempotencyResult(fresh, {
      command_id: 'cmd-1',
      idempotency_key: 'idem-1',
      result: buildResult('cmd-1'),
      stored_at: 1000,
      expires_at: 1000 + BRIDGE_IDEMPOTENCY_TTL_MS,
    });
    expect(stamped.idempotency_key_seen).toBe(true);
    expect(stamped.command_id).toBe('cmd-1'); // returns prior result, not fresh
  });

  it('passes idempotency_key_seen: false when no prior entry', () => {
    const fresh = buildResult('cmd-2');
    const stamped = stampIdempotencyResult(fresh, null);
    expect(stamped.idempotency_key_seen).toBe(false);
    expect(stamped.command_id).toBe('cmd-2');
  });
});
