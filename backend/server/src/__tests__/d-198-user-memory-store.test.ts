/** D-198 Slice 2 — `user_memory` store tests.
 *
 *  Covers the owner-authored store on the `Collection<V>` primitive + a
 *  content-addressing fake blob store:
 *    - the 64 KB inline / CAS split (+ denormalized preview + size_bytes)
 *    - get resolves the full body (inline or CAS); missing → null
 *    - update replaces body (blob→inline, inline→blob, clear) + frees the
 *      prior blob only when it becomes an orphan (refcount over rows)
 *    - delete hard-deletes + frees the blob unless another row shares it
 *    - origin is always stamped `user_self`; id carries the `umem_` domain
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInMemoryCollection } from '@recued/storage';
import type { BlobStore } from '../storage/blob-store.js';
import {
  createUserMemoryStore,
  USER_MEMORY_ID_PREFIX,
  USER_MEMORY_INLINE_CUTOFF_BYTES,
  USER_MEMORY_PREVIEW_CHARS,
  type UserMemoryRow,
} from '../user-memory-store.js';

/** Minimal content-addressing blob store: same bytes → same hash → one entry
 *  (mirrors the real store's dedup so refcount behavior is testable). */
const makeFakeBlobs = (): BlobStore & { count: () => number } => {
  const map = new Map<string, Buffer>();
  return {
    root: '/fake',
    async put(data) {
      const hash = createHash('sha256').update(data).digest('hex');
      map.set(hash, Buffer.from(data));
      return hash;
    },
    async get(hash) {
      return map.get(hash) ?? null;
    },
    async has(hash) {
      return map.has(hash);
    },
    async delete(hash) {
      map.delete(hash);
    },
    async sizeOf(hash) {
      return map.get(hash)?.length ?? null;
    },
    async sweepOrphans() {
      return 0;
    },
    async totalBytes() {
      let total = 0;
      for (const buf of map.values()) total += buf.length;
      return total;
    },
    count: () => map.size,
  };
};

/** Deterministic store: fixed clock + monotonic id sequence. */
const makeStore = () => {
  const blobs = makeFakeBlobs();
  const collection = createInMemoryCollection<UserMemoryRow>();
  let seq = 0;
  const store = createUserMemoryStore(collection, blobs, {
    now: () => 1000,
    mintId: () => `${USER_MEMORY_ID_PREFIX}${(seq += 1)}`,
  });
  return { store, blobs, collection };
};

const bigBody = (): string => 'x'.repeat(USER_MEMORY_INLINE_CUTOFF_BYTES + 100);

describe('user_memory store — create + body split', () => {
  it('stores a small body inline (no blob) with a preview + size', async () => {
    const { store, blobs } = makeStore();
    const row = await store.create({ kind: 'note', body: 'hello world' });
    expect(row.memory_id).toBe(`${USER_MEMORY_ID_PREFIX}1`);
    expect(row.origin_actor).toBe('user_self');
    expect(row.ts).toBe(1000);
    expect(row.body_inline).toBe('hello world');
    expect(row.blob_hash).toBeUndefined();
    expect(row.body_preview).toBe('hello world');
    expect(row.size_bytes).toBe(11);
    expect(blobs.count()).toBe(0);
  });

  it('spills a > 64 KB body to CAS + keeps a clamped preview', async () => {
    const { store, blobs } = makeStore();
    const body = bigBody();
    const row = await store.create({ kind: 'doc', body });
    expect(row.body_inline).toBeUndefined();
    expect(row.blob_hash).toBeDefined();
    expect(row.size_bytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(row.body_preview?.length).toBe(USER_MEMORY_PREVIEW_CHARS);
    expect(blobs.count()).toBe(1);
  });

  it('a body-less entry carries neither inline nor blob (size 0)', async () => {
    const { store, blobs } = makeStore();
    const row = await store.create({ kind: 'marker', summary: 'just a summary' });
    expect(row.body_inline).toBeUndefined();
    expect(row.blob_hash).toBeUndefined();
    expect(row.body_preview).toBeUndefined();
    expect(row.size_bytes).toBe(0);
    expect(row.summary).toBe('just a summary');
    expect(blobs.count()).toBe(0);
  });

  it('carries optional reason_code / event_at / provenance through', async () => {
    const { store } = makeStore();
    const row = await store.create({
      kind: 'note',
      body: 'b',
      reason_code: 'owner_note',
      event_at: 42,
      provenance_entity_ids: ['a@x.com', 'b@x.com'],
    });
    expect(row.reason_code).toBe('owner_note');
    expect(row.event_at).toBe(42);
    expect(row.provenance_entity_ids).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('user_memory store — get', () => {
  it('resolves an inline body', async () => {
    const { store } = makeStore();
    const row = await store.create({ kind: 'note', body: 'inline text' });
    const resolved = await store.get(row.memory_id);
    expect(resolved?.body).toBe('inline text');
  });

  it('resolves a CAS body', async () => {
    const { store } = makeStore();
    const body = bigBody();
    const row = await store.create({ kind: 'doc', body });
    const resolved = await store.get(row.memory_id);
    expect(resolved?.body).toBe(body);
  });

  it('returns null for an unknown id + omits body when the entry is body-less', async () => {
    const { store } = makeStore();
    expect(await store.get('umem_missing')).toBeNull();
    const row = await store.create({ kind: 'marker' });
    const resolved = await store.get(row.memory_id);
    expect(resolved).not.toBeNull();
    expect(resolved?.body).toBeUndefined();
  });
});

describe('user_memory store — update', () => {
  it('patches kind/summary/event_at without touching the body', async () => {
    const { store } = makeStore();
    const row = await store.create({ kind: 'note', body: 'keep me' });
    const next = await store.update(row.memory_id, { kind: 'renamed', summary: 's', event_at: 7 });
    expect(next?.kind).toBe('renamed');
    expect(next?.summary).toBe('s');
    expect(next?.event_at).toBe(7);
    expect(next?.body_inline).toBe('keep me');
  });

  it('replaces an inline body with a CAS body and vice-versa', async () => {
    const { store, blobs } = makeStore();
    const row = await store.create({ kind: 'note', body: 'small' });
    const big = bigBody();
    const grown = await store.update(row.memory_id, { body: big });
    expect(grown?.body_inline).toBeUndefined();
    expect(grown?.blob_hash).toBeDefined();
    expect(blobs.count()).toBe(1);
    // Shrink back to inline — the prior blob is now an orphan and is freed.
    const shrunk = await store.update(row.memory_id, { body: 'tiny' });
    expect(shrunk?.body_inline).toBe('tiny');
    expect(shrunk?.blob_hash).toBeUndefined();
    expect(blobs.count()).toBe(0);
  });

  it('clearing the body (empty string) drops inline + blob', async () => {
    const { store, blobs } = makeStore();
    const row = await store.create({ kind: 'doc', body: bigBody() });
    const cleared = await store.update(row.memory_id, { body: '' });
    expect(cleared?.body_inline).toBeUndefined();
    expect(cleared?.blob_hash).toBeUndefined();
    expect(cleared?.size_bytes).toBe(0);
    expect(blobs.count()).toBe(0);
  });

  it('returns null for an unknown id', async () => {
    const { store } = makeStore();
    expect(await store.update('umem_nope', { summary: 'x' })).toBeNull();
  });
});

describe('user_memory store — delete + refcount', () => {
  it('hard-deletes a row and frees its (sole-referenced) blob', async () => {
    const { store, blobs, collection } = makeStore();
    const row = await store.create({ kind: 'doc', body: bigBody() });
    expect(blobs.count()).toBe(1);
    expect(await store.delete(row.memory_id)).toBe(true);
    expect(await collection.get(row.memory_id)).toBeNull();
    expect(blobs.count()).toBe(0);
  });

  it('keeps a shared blob until the LAST referencing row is deleted', async () => {
    const { store, blobs } = makeStore();
    const body = bigBody();
    const a = await store.create({ kind: 'doc', body });
    const b = await store.create({ kind: 'doc', body });
    // Content-addressed dedup: one physical blob, two rows.
    expect(blobs.count()).toBe(1);
    expect(a.blob_hash).toBe(b.blob_hash);
    // Deleting one leaves the blob (still referenced by the other).
    await store.delete(a.memory_id);
    expect(blobs.count()).toBe(1);
    // Deleting the last referencing row frees it.
    await store.delete(b.memory_id);
    expect(blobs.count()).toBe(0);
  });

  it('returns false for an unknown id', async () => {
    const { store } = makeStore();
    expect(await store.delete('umem_ghost')).toBe(false);
  });
});

describe('user_memory store — list', () => {
  it('returns all rows', async () => {
    const { store } = makeStore();
    await store.create({ kind: 'a', body: '1' });
    await store.create({ kind: 'b', body: '2' });
    const rows = await store.list();
    expect(rows.map((r) => r.kind).sort()).toEqual(['a', 'b']);
  });
});

describe('user_memory store — import', () => {
  it('merges user_self by memory_id (upsert) + inserts new / restored ids', async () => {
    const { store } = makeStore();
    const a = await store.create({ kind: 'note', body: 'v1' }); // umem_1
    const res = await store.import([
      { origin_actor: 'user_self', memory_id: a.memory_id, kind: 'note', body: 'v2' }, // merge
      { origin_actor: 'user_self', memory_id: 'umem_restored', kind: 'note', body: 'fresh' }, // insert-by-id
    ]);
    expect(res).toEqual({ merged: 1, inserted: 1, deduped: 0, skipped: 0 });
    expect((await store.get(a.memory_id))?.body).toBe('v2');
    expect((await store.get('umem_restored'))?.body).toBe('fresh');
  });

  it('mints a fresh umem_ id for a user_self entry with a missing / foreign id', async () => {
    const { store } = makeStore();
    const res = await store.import([
      { origin_actor: 'user_self', kind: 'note', body: 'no id' },
      { origin_actor: 'user_self', memory_id: 'run-xyz', kind: 'note', body: 'foreign id' },
    ]);
    expect(res).toMatchObject({ merged: 0, inserted: 2 });
    const rows = await store.list();
    expect(rows.every((r) => r.memory_id.startsWith('umem_'))).toBe(true);
  });

  it('content-dedups "other" entries + stores them owner-vouched (user_self + imported)', async () => {
    const { store } = makeStore();
    const res = await store.import([
      { origin_actor: 'contracted_user', kind: 'fact', summary: 's', body: 'shared knowledge' },
      { origin_actor: 'system', kind: 'fact', summary: 's', body: 'shared knowledge' }, // same content → dedup
      { origin_actor: 'contracted_user', kind: 'fact', body: 'different knowledge' },
    ]);
    expect(res).toEqual({ merged: 0, inserted: 2, deduped: 1, skipped: 0 });
    const rows = await store.list();
    expect(rows.every((r) => r.origin_actor === 'user_self')).toBe(true); // owner-vouched
    expect(rows.every((r) => r.reason_code === 'imported')).toBe(true);
    expect(rows.every((r) => r.content_hash !== undefined)).toBe(true);
  });

  it('dedups an "other" re-import against an already-imported row (across calls)', async () => {
    const { store } = makeStore();
    await store.import([{ origin_actor: 'system', kind: 'fact', body: 'X' }]);
    const res = await store.import([{ origin_actor: 'system', kind: 'fact', body: 'X' }]);
    expect(res).toMatchObject({ inserted: 0, deduped: 1 });
  });

  it('skips entries with a blank kind', async () => {
    const { store } = makeStore();
    const res = await store.import([
      { origin_actor: 'user_self', kind: '   ', body: 'x' },
      { origin_actor: 'system', kind: '', body: 'y' },
    ]);
    expect(res).toMatchObject({ skipped: 2, inserted: 0 });
  });

  it('frees the prior blob when a merge shrinks a large body', async () => {
    const { store, blobs } = makeStore();
    const a = await store.create({ kind: 'doc', body: bigBody() }); // umem_1 → blob
    expect(blobs.count()).toBe(1);
    await store.import([{ origin_actor: 'user_self', memory_id: a.memory_id, kind: 'doc', body: 'small now' }]);
    expect(blobs.count()).toBe(0);
  });
});

describe('user_memory store — writeAuthored (AI / contracted origin, D-198 Slice 4)', () => {
  it('stamps the caller-supplied origin + session provenance on the umem_ domain', async () => {
    const { store } = makeStore();
    const row = await store.writeAuthored({
      origin_actor: 'contracted_user',
      kind: 'product-fact',
      summary: 'refund window is 30 days',
      body: 'Customers may request a refund within 30 days of purchase.',
      reason_code: 'response_synthesized',
      session: { channel_session_id: 'sess-7', contract_id: 'contract-9' },
    });
    expect(row.memory_id).toBe(`${USER_MEMORY_ID_PREFIX}1`); // same id domain as create
    expect(row.origin_actor).toBe('contracted_user');
    expect(row.channel_session_id).toBe('sess-7');
    expect(row.contract_id).toBe('contract-9');
    expect(row.summary).toBe('refund window is 30 days');
    expect(row.body_inline).toBe('Customers may request a refund within 30 days of purchase.');
    expect(row.reason_code).toBe('response_synthesized');
  });

  it('create() stays the user_self convenience — no session fields', async () => {
    const { store } = makeStore();
    const row = await store.create({ kind: 'note', body: 'mine' });
    expect(row.origin_actor).toBe('user_self');
    expect(row.channel_session_id).toBeUndefined();
    expect(row.contract_id).toBeUndefined();
  });

  it('writeAuthored spills a > 64 KB body to CAS like create', async () => {
    const { store, blobs } = makeStore();
    const row = await store.writeAuthored({
      origin_actor: 'contracted_user',
      kind: 'doc',
      summary: 's',
      body: bigBody(),
      reason_code: 'extraction_committed',
    });
    expect(row.blob_hash).toBeDefined();
    expect(row.body_inline).toBeUndefined();
    expect(blobs.count()).toBe(1);
  });

  it('writeAuthored with no body / no session is body-less + session-less', async () => {
    const { store } = makeStore();
    const row = await store.writeAuthored({
      origin_actor: 'contracted_user',
      kind: 'ping',
      summary: 'noted',
      reason_code: 'response_synthesized',
    });
    expect(row.size_bytes).toBe(0);
    expect(row.body_inline).toBeUndefined();
    expect(row.channel_session_id).toBeUndefined();
    expect(row.contract_id).toBeUndefined();
  });
});
