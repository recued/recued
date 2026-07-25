/** D-172 resumable uploads — SHARED `upload_session` store tests.
 *
 *  Pins the lifecycle the resumable protocol relies on: contiguous offset
 *  advance (the offset-as-truth authority), conflict on gap/rewrite, expiry as
 *  the idle/abandoned reap signal, and the two abuse-cap queries
 *  (concurrent-per-scope + global pending-bytes, both recomputed from rows).
 *  `createUploadSessionStore` self-owns its schema. */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  createUploadSessionStore,
  type UploadSessionStore,
  UPLOAD_SESSION_TTL_MS,
} from '../upload-session-store.js';

let db: Database.Database;
let store: UploadSessionStore;
const NOW = 1_900_000_000_000;

const mk = (over: Partial<Parameters<UploadSessionStore['create']>[0]> = {}) =>
  store.create({
    upload_id: 'up_1',
    scope_kind: 'reception',
    scope_key: 'ep_1',
    filename: 'big.bin',
    declared_size: 1000,
    mime_reported: 'application/octet-stream',
    scratch_path: '/data/_uploads/up_1',
    source_ip_hash: 'iphash',
    now: NOW,
    ...over,
  });

beforeEach(() => {
  db = new Database(':memory:');
  store = createUploadSessionStore(db);
});

describe('create + get', () => {
  it('mints a session at offset 0 with expiry = now + TTL and round-trips', () => {
    const s = mk();
    expect(s.offset_bytes).toBe(0);
    expect(s.declared_size).toBe(1000);
    expect(s.scope_kind).toBe('reception');
    expect(s.scope_key).toBe('ep_1');
    expect(s.expires_at).toBe(NOW + UPLOAD_SESSION_TTL_MS);
    expect(store.get('up_1')).toEqual(s);
    expect(store.get('nope')).toBeNull();
  });

  it('round-trips a webclient-scoped session', () => {
    const s = mk({ upload_id: 'w_1', scope_kind: 'webclient', scope_key: 'owner_42' });
    expect(s.scope_kind).toBe('webclient');
    expect(s.scope_key).toBe('owner_42');
    expect(store.get('w_1')).toEqual(s);
  });

  it('honors a custom ttl_ms and round-trips a set fingerprint', () => {
    const s = mk({ upload_id: 'f_1', fingerprint: 'head:abc|tail:xyz', ttl_ms: 1000 });
    expect(s.fingerprint).toBe('head:abc|tail:xyz');
    expect(s.expires_at).toBe(NOW + 1000);
    expect(store.get('f_1')).toEqual(s);
  });

  it('defaults fingerprint and source_ip_hash to null when omitted', () => {
    const s = store.create({
      upload_id: 'd_1',
      scope_kind: 'webclient',
      scope_key: 'owner_1',
      filename: 'a.txt',
      declared_size: 10,
      mime_reported: 'text/plain',
      scratch_path: '/data/_uploads/d_1',
      now: NOW,
    });
    expect(s.fingerprint).toBeNull();
    expect(s.source_ip_hash).toBeNull();
    expect(store.get('d_1')).toEqual(s);
  });

  it('rejects a duplicate upload_id without replacing the original session', () => {
    const original = mk();
    // create is INSERT, not upsert — a PK clash throws and leaves the row intact.
    expect(() =>
      mk({ filename: 'other.bin', declared_size: 2000, scratch_path: '/data/_uploads/other' }),
    ).toThrow();
    expect(store.get('up_1')).toEqual(original);
  });
});

describe('advanceOffset — the offset-as-truth authority', () => {
  it('advances contiguously and bumps expiry', () => {
    mk();
    expect(store.advanceOffset({ upload_id: 'up_1', expected_offset: 0, new_offset: 400, now: NOW + 1000 })).toBe('ok');
    const s = store.get('up_1')!;
    expect(s.offset_bytes).toBe(400);
    expect(s.expires_at).toBe(NOW + 1000 + UPLOAD_SESSION_TTL_MS);
    expect(store.advanceOffset({ upload_id: 'up_1', expected_offset: 400, new_offset: 1000, now: NOW + 2000 })).toBe('ok');
    expect(store.get('up_1')!.offset_bytes).toBe(1000);
  });

  it('rejects a non-contiguous offset (gap / rewrite / stale re-send) as conflict, leaving the offset unchanged', () => {
    mk();
    store.advanceOffset({ upload_id: 'up_1', expected_offset: 0, new_offset: 400, now: NOW });
    // A client that thinks it is at 0 (stale) or skips to 800 is rejected.
    expect(store.advanceOffset({ upload_id: 'up_1', expected_offset: 0, new_offset: 500, now: NOW })).toBe('conflict');
    expect(store.advanceOffset({ upload_id: 'up_1', expected_offset: 800, new_offset: 900, now: NOW })).toBe('conflict');
    expect(store.get('up_1')!.offset_bytes).toBe(400);
  });

  it('returns not_found for an unknown session', () => {
    expect(store.advanceOffset({ upload_id: 'ghost', expected_offset: 0, new_offset: 1, now: NOW })).toBe('not_found');
  });

  it('honors a custom ttl_ms when bumping expiry on advance', () => {
    mk();
    store.advanceOffset({ upload_id: 'up_1', expected_offset: 0, new_offset: 100, now: NOW, ttl_ms: 500 });
    expect(store.get('up_1')!.expires_at).toBe(NOW + 500);
  });
});

describe('touch + delete', () => {
  it('touch bumps expiry; delete removes', () => {
    mk();
    expect(store.touch({ upload_id: 'up_1', now: NOW + 5000 })).toBe('ok');
    expect(store.get('up_1')!.expires_at).toBe(NOW + 5000 + UPLOAD_SESSION_TTL_MS);
    expect(store.touch({ upload_id: 'ghost', now: NOW })).toBe('not_found');
    expect(store.delete('up_1')).toBe('deleted');
    expect(store.get('up_1')).toBeNull();
    expect(store.delete('up_1')).toBe('not_found');
  });
});

describe('abuse-cap queries (recomputed from live rows)', () => {
  it('countActiveForScope counts only non-expired sessions of that scope', () => {
    mk({ upload_id: 'a', scope_kind: 'reception', scope_key: 'ep_1' });
    mk({ upload_id: 'b', scope_kind: 'reception', scope_key: 'ep_1' });
    mk({ upload_id: 'c', scope_kind: 'reception', scope_key: 'ep_2' });
    expect(store.countActiveForScope({ scope_kind: 'reception', scope_key: 'ep_1', now: NOW })).toBe(2);
    expect(store.countActiveForScope({ scope_kind: 'reception', scope_key: 'ep_2', now: NOW })).toBe(1);
    // After the TTL, the sessions are expired → not counted (the sweeper will reap them).
    expect(store.countActiveForScope({ scope_kind: 'reception', scope_key: 'ep_1', now: NOW + UPLOAD_SESSION_TTL_MS + 1 })).toBe(0);
  });

  it('countActiveForScope discriminates scope_kind even when scope_key collides', () => {
    // Same scope_key string under two kinds must NOT be conflated.
    mk({ upload_id: 'r', scope_kind: 'reception', scope_key: 'shared_key' });
    mk({ upload_id: 'w', scope_kind: 'webclient', scope_key: 'shared_key' });
    expect(store.countActiveForScope({ scope_kind: 'reception', scope_key: 'shared_key', now: NOW })).toBe(1);
    expect(store.countActiveForScope({ scope_kind: 'webclient', scope_key: 'shared_key', now: NOW })).toBe(1);
  });

  it('sumActivePendingBytes sums declared_size over live sessions only (across all scopes)', () => {
    mk({ upload_id: 'a', declared_size: 1000 });
    mk({ upload_id: 'b', scope_kind: 'webclient', scope_key: 'owner_1', declared_size: 2500 });
    expect(store.sumActivePendingBytes({ now: NOW })).toBe(3500);
    expect(store.sumActivePendingBytes({ now: NOW + UPLOAD_SESSION_TTL_MS + 1 })).toBe(0);
  });

  it('sumActivePendingBytes is 0 with no sessions', () => {
    expect(store.sumActivePendingBytes({ now: NOW })).toBe(0);
  });

  it('sumActivePendingBytes reserves declared_size regardless of offset progress', () => {
    // The disk-DoS budget reserves the FULL declared size, not bytes-so-far.
    mk({ upload_id: 'partial', declared_size: 1000 });
    store.advanceOffset({ upload_id: 'partial', expected_offset: 0, new_offset: 700, now: NOW + 1000 });
    mk({ upload_id: 'complete', declared_size: 2500 });
    store.advanceOffset({ upload_id: 'complete', expected_offset: 0, new_offset: 2500, now: NOW + 1000 });
    expect(store.sumActivePendingBytes({ now: NOW + 1000 })).toBe(3500);
  });

  it('treats expires_at === now as expired for the active-budget queries (strict >)', () => {
    mk({ upload_id: 'exact', declared_size: 1000, now: NOW - UPLOAD_SESSION_TTL_MS }); // expires_at === NOW
    mk({ upload_id: 'live', declared_size: 2500, now: NOW - UPLOAD_SESSION_TTL_MS + 1 }); // expires_at === NOW+1
    expect(store.countActiveForScope({ scope_kind: 'reception', scope_key: 'ep_1', now: NOW })).toBe(1);
    expect(store.sumActivePendingBytes({ now: NOW })).toBe(2500);
  });
});

describe('listExpired — the sweeper feed', () => {
  it('returns only sessions whose expires_at <= now, oldest first', () => {
    mk({ upload_id: 'old', now: NOW - UPLOAD_SESSION_TTL_MS - 10_000 }); // already expired
    mk({ upload_id: 'fresh', now: NOW });                                // live
    const expired = store.listExpired({ now: NOW });
    expect(expired.map((s) => s.upload_id)).toEqual(['old']);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) mk({ upload_id: `e${i}`, now: NOW - UPLOAD_SESSION_TTL_MS - 1000 - i });
    expect(store.listExpired({ now: NOW, limit: 3 })).toHaveLength(3);
  });

  it('includes sessions whose expires_at === now (inclusive <=, the dual of the budget queries)', () => {
    mk({ upload_id: 'old', now: NOW - UPLOAD_SESSION_TTL_MS - 1 });   // expires_at === NOW-1
    mk({ upload_id: 'exact', now: NOW - UPLOAD_SESSION_TTL_MS });     // expires_at === NOW
    mk({ upload_id: 'fresh', now: NOW - UPLOAD_SESSION_TTL_MS + 1 }); // expires_at === NOW+1
    expect(store.listExpired({ now: NOW }).map((s) => s.upload_id)).toEqual(['old', 'exact']);
  });
});
