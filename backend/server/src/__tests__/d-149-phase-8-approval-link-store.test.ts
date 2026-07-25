/** D-149 P8 § A.5.5 + § Must Hold I-11 — reception approval intent store tests.
 *
 *  Covers:
 *    - create + findById + findByEndpoint round-trips.
 *    - tryConsume succeeds on the first call + persists the encrypted
 *      columns + flips `consumed_at`.
 *    - tryConsume returns `'already_consumed'` on the second call.
 *    - SQLite EXCLUSIVE transaction race resolution: two parallel
 *      consume attempts at the same intent race to exactly one win +
 *      one already_consumed.
 *    - markProcessed flips `processing_outcome` once the engine reactive
 *      handler has processed the row. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createReceptionApprovalIntentStore,
  type ApprovalIntentConsumeResult,
} from '../storage/reception-approval-store.js';

const NOW = 1_700_000_000_000;

const buildDb = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return db;
};

const goodCreate = (overrides: Partial<{ intent_id: string; endpoint_id: string }> = {}) => ({
  intent_id: overrides.intent_id ?? 'i_1',
  endpoint_id: overrides.endpoint_id ?? 'e_1',
  action_kind: 'pick_time' as const,
  target_id: 'target_xyz',
});

const goodConsume = (
  intent_id: string = 'i_1',
  endpoint_id: string = 'e_1',
  overrides: Record<string, unknown> = {},
) => ({
  intent_id,
  endpoint_id,
  now: NOW,
  source_ip_hash: 'hash_a',
  visitor_email_encrypted: 'aGVsbG8=', // base64-ish placeholder
  visitor_name_encrypted: null,
  outcome_encrypted: 'YmxhaA==',
  ...overrides,
});

describe('D-149 P8 § A.5.5 — ApprovalIntentStore basic CRUD', () => {
  it('create persists a pre-consumption row', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    const row = store.create(goodCreate());
    expect(row.intent_id).toBe('i_1');
    expect(row.endpoint_id).toBe('e_1');
    expect(row.consumed_at).toBeNull();
    expect(row.processing_outcome).toBe('pending');
    expect(row.action_kind).toBe('pick_time');
    expect(row.target_id).toBe('target_xyz');
  });

  it('findById returns the row + null on miss', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    store.create(goodCreate());
    expect(store.findById('i_1')?.intent_id).toBe('i_1');
    expect(store.findById('missing')).toBeNull();
  });

  it('findByEndpoint returns the row + null on miss', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    store.create(goodCreate());
    expect(store.findByEndpoint('e_1')?.intent_id).toBe('i_1');
    expect(store.findByEndpoint('e_missing')).toBeNull();
  });
});

describe('D-149 P8 § A.5.5 + Must Hold I-11 — tryConsume single-use', () => {
  it('first consume succeeds + persists encrypted columns + flips consumed_at', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    store.create(goodCreate());
    const r = store.tryConsume(goodConsume());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.consumed_at).toBe(NOW);
    expect(r.row.consumed_by_visitor_email_encrypted).toBe('aGVsbG8=');
    expect(r.row.consumed_outcome_encrypted).toBe('YmxhaA==');
    expect(r.row.source_ip_hash).toBe('hash_a');
    expect(r.row.processing_outcome).toBe('pending');
  });

  it('second consume returns already_consumed; original row unchanged', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    store.create(goodCreate());
    const first = store.tryConsume(goodConsume());
    expect(first.ok).toBe(true);
    const second = store.tryConsume(
      goodConsume('i_1', 'e_1', {
        now: NOW + 1000,
        visitor_email_encrypted: 'b3Roa3M=',
        outcome_encrypted: 'aWRrYW55b25lc2Nob3dz',
      }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_consumed');
    const row = store.findById('i_1');
    expect(row?.consumed_at).toBe(NOW);
    expect(row?.consumed_by_visitor_email_encrypted).toBe('aGVsbG8=');
  });

  it('tryConsume against unknown intent returns not_found', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    const r = store.tryConsume(goodConsume('nope', 'e_nope'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
  });

  it('concurrent consume race: exactly one wins + one sees already_consumed', () => {
    // SQLite is synchronous in better-sqlite3 + ":memory:" stays
    // single-connection; the EXCLUSIVE transaction wrapper still
    // exercises the "WHERE consumed_at IS NULL" guard. We simulate
    // the race by interleaving calls back-to-back on the same store
    // instance — if the read-then-update isn't atomic the second
    // call's UPDATE would silently overwrite. The guard clause
    // protects the contract.
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    store.create(goodCreate());
    const results: ApprovalIntentConsumeResult[] = [];
    // Test inputs MUST be valid base64 since the store round-trips
    // ciphertexts through Buffer.from(.., 'base64'). Use a stable
    // family per-iteration so the first-write-wins assertion is
    // deterministic.
    const enc = (i: number) => Buffer.from(`enc_${i}`, 'utf8').toString('base64');
    const out = (i: number) => Buffer.from(`out_${i}`, 'utf8').toString('base64');
    for (let i = 0; i < 5; i += 1) {
      results.push(
        store.tryConsume(
          goodConsume('i_1', 'e_1', {
            now: NOW + i,
            visitor_email_encrypted: enc(i),
            outcome_encrypted: out(i),
          }),
        ),
      );
    }
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    losers.forEach((r) => {
      if (!r.ok) expect(r.reason).toBe('already_consumed');
    });
    // The single winner is the FIRST call (now === NOW + 0).
    const winner = winners[0];
    expect(winner?.ok).toBe(true);
    if (winner?.ok) {
      expect(winner.row.consumed_at).toBe(NOW);
      expect(winner.row.consumed_by_visitor_email_encrypted).toBe(enc(0));
    }
  });

  it('markProcessed flips terminal outcome + returns updated', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    store.create(goodCreate());
    store.tryConsume(goodConsume());
    const res = store.markProcessed({ intent_id: 'i_1', outcome: 'processed' });
    expect(res).toBe('updated');
    expect(store.findById('i_1')?.processing_outcome).toBe('processed');
  });

  it('markProcessed returns not_found for unknown intent', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    expect(store.markProcessed({ intent_id: 'nope', outcome: 'processed' })).toBe('not_found');
  });

  it('listPendingForEndpoint returns only consumed-but-unprocessed rows', () => {
    const db = buildDb();
    const store = createReceptionApprovalIntentStore(db);
    store.create(goodCreate({ intent_id: 'i_a', endpoint_id: 'e_1' }));
    store.create(goodCreate({ intent_id: 'i_b', endpoint_id: 'e_1' }));
    store.create(goodCreate({ intent_id: 'i_c', endpoint_id: 'e_2' }));
    store.tryConsume(goodConsume('i_a', 'e_1'));
    store.tryConsume(goodConsume('i_c', 'e_2'));
    store.tryConsume(goodConsume('i_b', 'e_1', { now: NOW + 100 }));
    store.markProcessed({ intent_id: 'i_a', outcome: 'processed' });

    const pending = store.listPendingForEndpoint('e_1');
    expect(pending.map((r) => r.intent_id)).toEqual(['i_b']);
  });
});
