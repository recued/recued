/** D-148 P4 — webclient local-store closed-list discipline. */

import { describe, expect, it } from 'vitest';
import {
  WEBCLIENT_LOCAL_STORAGE_FIELDS,
  WEBCLIENT_PROFILE_STORAGE_FIELDS,
} from '@recued/contracts';
import {
  WEBCLIENT_LOCAL_KEYS,
  WEBCLIENT_PROFILE_STORE_LOCK_NAME,
  createInMemoryWebclientLocalStore,
  createIndexedDbWebclientLocalStore,
  type IndexedDbKeyValue,
  type WebclientProfileStoreLockProvider,
} from '../storage/local-store.js';

const exclusiveLockProvider = (): WebclientProfileStoreLockProvider => {
  let tail: Promise<void> = Promise.resolve();
  return {
    request(name, options, callback) {
      expect(name).toBe(WEBCLIENT_PROFILE_STORE_LOCK_NAME);
      expect(options).toEqual({ mode: 'exclusive' });
      const run = tail.then(callback);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
};

const sharedKv = (): IndexedDbKeyValue => {
  const data = new Map<string, unknown>();
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async clear() { data.clear(); },
    async keys() { return [...data.keys()]; },
  };
};

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

  it('the PHYSICAL keys are the roster pair — five per-server fields, once per server', () => {
    // The five names above stay the logical view of the ACTIVE server; what
    // IndexedDB actually holds is the roster plus a pointer. Ratcheted here
    // so a third physical key cannot appear without this test being read.
    expect([...WEBCLIENT_PROFILE_STORAGE_FIELDS].sort()).toEqual([
      'active_profile_id',
      'server_profiles',
    ]);
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

  it('serializes same-tab roster mutations so recency cannot overwrite a rename', async () => {
    const store = createInMemoryWebclientLocalStore();
    const id = await store.ensureProfile('wss://home.example/ws');

    await Promise.all([
      store.renameProfile(id, 'Home workspace'),
      store.noteProfileConnected(id, 1_700_000_000_000),
    ]);

    expect(await store.listProfiles()).toEqual([
      expect.objectContaining({
        id,
        label: 'Home workspace',
        last_connected_at: 1_700_000_000_000,
      }),
    ]);
  });

  it('keeps same-tab reads behind a two-key roster write', async () => {
    const data = new Map<string, unknown>();
    const profilesKey = WEBCLIENT_PROFILE_STORAGE_FIELDS[0]!;
    let pauseNextProfilesWrite = false;
    let markProfilesWritten = (): void => undefined;
    let releaseProfilesWrite = (): void => undefined;
    const profilesWritten = new Promise<void>((resolve) => {
      markProfilesWritten = resolve;
    });
    const profilesWriteGate = new Promise<void>((resolve) => {
      releaseProfilesWrite = resolve;
    });
    const kv: IndexedDbKeyValue = {
      async get(key) { return data.get(key); },
      async set(key, value) {
        data.set(key, value);
        if (pauseNextProfilesWrite && key === profilesKey) {
          pauseNextProfilesWrite = false;
          markProfilesWritten();
          await profilesWriteGate;
        }
      },
      async delete(key) { data.delete(key); },
      async clear() { data.clear(); },
      async keys() { return [...data.keys()]; },
    };
    const store = createIndexedDbWebclientLocalStore(kv, { lockProvider: null });
    await store.ensureProfile('wss://home.example/ws');
    const officeId = await store.ensureProfile('wss://office.example/ws');

    pauseNextProfilesWrite = true;
    const removal = store.removeProfile(officeId);
    await profilesWritten;
    let readSettled = false;
    const activeUrl = store.get('server_url').then((value) => {
      readSettled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();

    // The profile array has been written but the active pointer has not. A
    // concurrent read must wait rather than projecting that half-state as an
    // unexplained credential loss.
    expect(readSettled).toBe(false);
    releaseProfilesWrite();
    await expect(activeUrl).resolves.toBe('wss://home.example/ws');
    await removal;
  });

  it('returns the canonical saved name and identifies a stale rename target', async () => {
    const store = createInMemoryWebclientLocalStore();
    const id = await store.ensureProfile('wss://home.example/ws');

    await expect(store.renameProfile(id, '  Home workspace  '))
      .resolves.toBe('Home workspace');
    await expect(store.renameProfile('removed-elsewhere', 'Ghost'))
      .resolves.toBeNull();
  });

  it('serializes sibling-tab roster mutations with a dedicated Web Lock', async () => {
    const kv = sharedKv();
    const lockProvider = exclusiveLockProvider();
    const firstTab = createIndexedDbWebclientLocalStore(kv, { lockProvider });
    const siblingTab = createIndexedDbWebclientLocalStore(kv, { lockProvider });
    const id = await firstTab.ensureProfile('wss://home.example/ws');

    await Promise.all([
      firstTab.renameProfile(id, 'Home workspace'),
      siblingTab.noteProfileConnected(id, 1_700_000_000_000),
    ]);

    expect(await firstTab.listProfiles()).toEqual([
      expect.objectContaining({
        id,
        label: 'Home workspace',
        last_connected_at: 1_700_000_000_000,
      }),
    ]);
  });

  it('does not let a queued recency write restore a sibling-cleared roster', async () => {
    const kv = sharedKv();
    const lockProvider = exclusiveLockProvider();
    const firstTab = createIndexedDbWebclientLocalStore(kv, { lockProvider });
    const siblingTab = createIndexedDbWebclientLocalStore(kv, { lockProvider });
    const id = await firstTab.ensureProfile('wss://home.example/ws');

    await Promise.all([
      firstTab.noteProfileConnected(id, 1_700_000_000_000),
      siblingTab.clear(),
    ]);

    expect(await firstTab.listProfiles()).toEqual([]);
    expect(await firstTab.inspect()).toEqual({
      server_url: null,
      webclient_token: null,
      server_public_key: null,
      pair_metadata: null,
      cert_pin_state: null,
    });
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
    const deleted = log.filter((e) => e.op === 'delete').map((e) => e.key);
    const clears = log.filter((e) => e.op === 'clear');
    // Both shapes: the roster pair AND the five legacy singletons a
    // not-yet-migrated browser may still hold. "Clear this browser" must not
    // leave one server behind because the store happened to be mid-migration.
    for (const k of [...WEBCLIENT_PROFILE_STORAGE_FIELDS, ...WEBCLIENT_LOCAL_KEYS]) {
      expect(deleted).toContain(k);
    }
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
