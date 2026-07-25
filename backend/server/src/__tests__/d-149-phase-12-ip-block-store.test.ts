/** D-149 P12 § A.20.5 — `reception_ip_block_list` store tests.
 *
 *  Covers:
 *    - block / unblock / isBlocked round-trips.
 *    - idempotent re-ban (`already_blocked`) + idempotent unban (`not_found`).
 *    - per-endpoint keying — banning `(ep_a, hash)` does NOT block
 *      `(ep_b, hash)` (§ Must Hold I-9 no cross-endpoint correlation).
 *    - list + per-endpoint filter, newest-first.
 *    - listBlockedKeys produces `abuseInboxBlockKey`-encoded membership. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { abuseInboxBlockKey } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createReceptionIpBlockStore } from '../storage/reception-ip-block-store.js';

const NOW = 1_700_000_000_000;

const buildStore = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return createReceptionIpBlockStore(db);
};

describe('D-149 P12 § A.20.5 — ReceptionIpBlockStore', () => {
  it('block + isBlocked round-trip', () => {
    const store = buildStore();
    expect(store.isBlocked('ep_1', 'hash_a')).toBe(false);
    const outcome = store.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'hash_a',
      blocked_at: NOW,
      blocked_by_client_id: 'client_1',
      reason: 'brute-force',
    });
    expect(outcome).toBe('created');
    expect(store.isBlocked('ep_1', 'hash_a')).toBe(true);
  });

  it('re-banning the same pair is idempotent (already_blocked)', () => {
    const store = buildStore();
    store.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'hash_a',
      blocked_at: NOW,
      blocked_by_client_id: 'client_1',
      reason: null,
    });
    const second = store.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'hash_a',
      blocked_at: NOW + 1000,
      blocked_by_client_id: 'client_1',
      reason: null,
    });
    expect(second).toBe('already_blocked');
    expect(store.list()).toHaveLength(1);
  });

  it('unblock removes the ban; unblocking an unknown pair is idempotent', () => {
    const store = buildStore();
    store.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'hash_a',
      blocked_at: NOW,
      blocked_by_client_id: 'client_1',
      reason: null,
    });
    expect(store.unblock({ endpoint_id: 'ep_1', source_ip_hash: 'hash_a' })).toBe('removed');
    expect(store.isBlocked('ep_1', 'hash_a')).toBe(false);
    expect(store.unblock({ endpoint_id: 'ep_1', source_ip_hash: 'hash_a' })).toBe('not_found');
  });

  it('bans are per-endpoint — same hash on a sibling endpoint is NOT blocked (§ I-9)', () => {
    const store = buildStore();
    store.block({
      endpoint_id: 'ep_a',
      source_ip_hash: 'shared_hash',
      blocked_at: NOW,
      blocked_by_client_id: 'client_1',
      reason: null,
    });
    expect(store.isBlocked('ep_a', 'shared_hash')).toBe(true);
    expect(store.isBlocked('ep_b', 'shared_hash')).toBe(false);
  });

  it('list returns newest-first + supports a per-endpoint filter', () => {
    const store = buildStore();
    store.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'h1',
      blocked_at: NOW,
      blocked_by_client_id: 'c',
      reason: null,
    });
    store.block({
      endpoint_id: 'ep_2',
      source_ip_hash: 'h2',
      blocked_at: NOW + 5000,
      blocked_by_client_id: 'c',
      reason: 'spam',
    });
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all[0]!.endpoint_id).toBe('ep_2'); // newest first
    expect(all[0]!.reason).toBe('spam');

    const onlyEp1 = store.list({ endpoint_id: 'ep_1' });
    expect(onlyEp1).toHaveLength(1);
    expect(onlyEp1[0]!.endpoint_id).toBe('ep_1');
  });

  it('listBlockedKeys produces abuseInboxBlockKey-encoded membership', () => {
    const store = buildStore();
    store.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'h1',
      blocked_at: NOW,
      blocked_by_client_id: 'c',
      reason: null,
    });
    store.block({
      endpoint_id: 'ep_2',
      source_ip_hash: 'h2',
      blocked_at: NOW,
      blocked_by_client_id: 'c',
      reason: null,
    });
    const keys = store.listBlockedKeys();
    expect(keys.has(abuseInboxBlockKey('ep_1', 'h1'))).toBe(true);
    expect(keys.has(abuseInboxBlockKey('ep_2', 'h2'))).toBe(true);
    expect(keys.has(abuseInboxBlockKey('ep_1', 'h2'))).toBe(false);
    expect(keys.size).toBe(2);
  });

  it('a null reason persists as null', () => {
    const store = buildStore();
    store.block({
      endpoint_id: 'ep_1',
      source_ip_hash: 'h1',
      blocked_at: NOW,
      blocked_by_client_id: 'c',
      reason: null,
    });
    expect(store.list()[0]!.reason).toBeNull();
  });
});
