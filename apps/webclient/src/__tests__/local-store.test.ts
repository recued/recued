/** D-148 P4 — webclient local-store closed-list discipline. */

import { describe, expect, it } from 'vitest';
import { WEBCLIENT_LOCAL_STORAGE_FIELDS } from '@recued/contracts';
import {
  WEBCLIENT_LOCAL_KEYS,
  createInMemoryWebclientLocalStore,
  createIndexedDbWebclientLocalStore,
  type IndexedDbKeyValue,
} from '../storage/local-store.js';

describe('D-148 P4 — webclient local-store closed-list', () => {
  it('exports the documented 5 fields', () => {
    expect([...WEBCLIENT_LOCAL_KEYS].sort()).toEqual([
      'cert_pin_state',
      'pair_metadata',
      'server_public_key',
      'server_url',
      'webclient_token',
    ]);
    expect(WEBCLIENT_LOCAL_STORAGE_FIELDS.length).toBe(5);
  });

  it('inMemory: round-trips set/get/inspect/clear', async () => {
    const store = createInMemoryWebclientLocalStore();
    expect(await store.get('server_url')).toBeNull();
    await store.set('server_url', 'wss://alice.recued.cloud:8443/ws');
    expect(await store.get('server_url')).toBe('wss://alice.recued.cloud:8443/ws');
    const inspect = await store.inspect();
    expect(inspect.server_url).toBe('wss://alice.recued.cloud:8443/ws');
    expect(inspect.webclient_token).toBeNull();
    expect(inspect.cert_pin_state).toBeNull();
    await store.clear();
    expect(await store.get('server_url')).toBeNull();
  });

  it('inMemory: rejects unknown key at set + remove + get', async () => {
    const store = createInMemoryWebclientLocalStore();
    await expect(
      store.set('vault' as never, { recipes: [] } as never),
    ).rejects.toThrow(/spec § A.4.1/);
    await expect(store.remove('engine' as never)).rejects.toThrow(/spec § A.4.1/);
    await expect(store.get('recipes' as never)).rejects.toThrow(/spec § A.4.1/);
  });

  it('inMemory: initial value drops unknown keys', async () => {
    const store = createInMemoryWebclientLocalStore({
      server_url: 'wss://x',
      // @ts-expect-error — testing the runtime guard
      vault: { tokens: ['secret'] },
    });
    const inspect = await store.inspect();
    expect(inspect.server_url).toBe('wss://x');
    expect((inspect as unknown as Record<string, unknown>).vault).toBeUndefined();
  });

  it('idb: clear() exercises both per-key delete + bulk clear', async () => {
    const log: Array<{ op: string; key?: string }> = [];
    const data = new Map<string, unknown>();
    const kv: IndexedDbKeyValue = {
      async get(key) {
        log.push({ op: 'get', key });
        return data.get(key);
      },
      async set(key, value) {
        log.push({ op: 'set', key });
        data.set(key, value);
      },
      async delete(key) {
        log.push({ op: 'delete', key });
        data.delete(key);
      },
      async clear() {
        log.push({ op: 'clear' });
        data.clear();
      },
      async keys() {
        return [...data.keys()];
      },
    };
    const store = createIndexedDbWebclientLocalStore(kv);
    await store.set('server_url', 'wss://z');
    await store.set('server_public_key', 'pk');
    await store.clear();
    const deletes = log.filter((e) => e.op === 'delete');
    const clears = log.filter((e) => e.op === 'clear');
    expect(deletes.length).toBe(WEBCLIENT_LOCAL_KEYS.length);
    expect(clears.length).toBe(1);
    expect(await kv.keys()).toEqual([]);
  });

  it('idb: inspect skips null values + reports closed-list shape', async () => {
    const kv: IndexedDbKeyValue = {
      async get(key) {
        if (key === 'server_url') return 'wss://x';
        return null;
      },
      async set() {},
      async delete() {},
      async clear() {},
      async keys() {
        return ['server_url'];
      },
    };
    const store = createIndexedDbWebclientLocalStore(kv);
    const out = await store.inspect();
    expect(out.server_url).toBe('wss://x');
    expect(out.webclient_token).toBeNull();
    expect(out.pair_metadata).toBeNull();
    expect(out.cert_pin_state).toBeNull();
    expect(out.server_public_key).toBeNull();
  });
});
