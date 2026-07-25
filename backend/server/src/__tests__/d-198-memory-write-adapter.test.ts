/** D-198 Slice 4 — store-backed `MemoryWriteAdapter` tests.
 *
 *  The AI / customer write path: `adapter.write(req)` → `store.writeAuthored`,
 *  origin + session BOUND at construction (never from the request), payload
 *  coerced to a text body, provenance edges reported. */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInMemoryCollection } from '@recued/storage';
import type { BlobStore } from '../storage/blob-store.js';
import {
  createUserMemoryStore,
  USER_MEMORY_ID_PREFIX,
  type UserMemoryRow,
} from '../user-memory-store.js';
import { createStoreBackedMemoryWriteAdapter } from '../memory-write-adapter.js';

const makeBlobs = (): BlobStore => {
  const map = new Map<string, Buffer>();
  return {
    root: '/fake',
    async put(data) {
      const hash = createHash('sha256').update(data).digest('hex');
      map.set(hash, Buffer.from(data));
      return hash;
    },
    async get(hash) { return map.get(hash) ?? null; },
    async has(hash) { return map.has(hash); },
    async delete(hash) { map.delete(hash); },
    async sizeOf(hash) { return map.get(hash)?.length ?? null; },
    async sweepOrphans() { return 0; },
    async totalBytes() { return 0; },
  };
};

const makeStore = () => {
  let seq = 0;
  return createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), makeBlobs(), {
    now: () => 1000,
    mintId: () => `${USER_MEMORY_ID_PREFIX}${(seq += 1)}`,
  });
};

describe('store-backed MemoryWriteAdapter', () => {
  it('stamps the bound origin + session and persists to the store', async () => {
    const store = makeStore();
    const adapter = createStoreBackedMemoryWriteAdapter({
      store,
      origin_actor: 'contracted_user',
      session: { channel_session_id: 'sess-1', contract_id: 'c-1' },
    });
    const result = await adapter.write({
      kind: 'product-fact',
      summary: 'ships in 2 days',
      reason_code: 'response_synthesized',
      payload: 'Orders ship within 2 business days.',
    });
    expect(result.memory_id).toBe(`${USER_MEMORY_ID_PREFIX}1`);
    const resolved = await store.get(result.memory_id);
    expect(resolved?.row.origin_actor).toBe('contracted_user');
    expect(resolved?.row.channel_session_id).toBe('sess-1');
    expect(resolved?.row.contract_id).toBe('c-1');
    expect(resolved?.row.summary).toBe('ships in 2 days');
    expect(resolved?.body).toBe('Orders ship within 2 business days.');
  });

  it('coerces a non-string payload to a JSON body', async () => {
    const store = makeStore();
    const adapter = createStoreBackedMemoryWriteAdapter({ store, origin_actor: 'contracted_user' });
    const result = await adapter.write({
      kind: 'fact',
      summary: 's',
      reason_code: 'extraction_committed',
      payload: { a: 1, b: 'two' },
    });
    const resolved = await store.get(result.memory_id);
    expect(resolved?.body).toBe(JSON.stringify({ a: 1, b: 'two' }));
  });

  it('reports provenance edges from the entity ids', async () => {
    const store = makeStore();
    const adapter = createStoreBackedMemoryWriteAdapter({ store, origin_actor: 'contracted_user' });
    const result = await adapter.write({
      kind: 'fact',
      summary: 's',
      reason_code: 'response_synthesized',
      provenance_entity_ids: ['e1', 'e2'],
    });
    expect(result.provenance_edges_written).toBe(2);
  });

  it('a body-less write (no payload) is summary-only', async () => {
    const store = makeStore();
    const adapter = createStoreBackedMemoryWriteAdapter({ store, origin_actor: 'contracted_user' });
    const result = await adapter.write({
      kind: 'ping',
      summary: 'noted',
      reason_code: 'response_synthesized',
    });
    const resolved = await store.get(result.memory_id);
    expect(resolved?.row.size_bytes).toBe(0);
    expect(resolved?.body).toBeUndefined();
    expect(result.provenance_edges_written).toBe(0);
  });
});
