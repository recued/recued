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
  pinStoreToActiveProfile,
  retireActiveProfile,
  type IndexedDbKeyValue,
  type WebclientLocalStore,
  type WebclientProfileStoreLockProvider,
} from '../storage/local-store.js';
import { readStoredPairState } from '../boot/stored-pair-state.js';

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
  it.each(['navigator', 'locks', 'request'] as const)(
    'keeps roster operations ordered when Web Locks access throws at %s', async blocked => {
      const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      const denied = (): never => { throw new Error('private browser policy detail'); };
      const locks = Object.defineProperty({}, 'request', { get: denied });
      const navigator = blocked === 'locks'
        ? Object.defineProperty({}, 'locks', { get: denied }) : { locks };
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        ...(blocked === 'navigator' ? { get: denied } : { value: navigator }),
      });
      try {
        const store = createIndexedDbWebclientLocalStore(sharedKv());
        const id = await store.ensureProfile('wss://home.example/ws');
        await Promise.all([
          store.renameProfile(id, 'Home workspace'),
          store.noteProfileConnected(id, 1_700_000_000_000),
        ]);
        expect(await store.listProfiles()).toEqual([
          expect.objectContaining({ id, label: 'Home workspace', last_connected_at: 1_700_000_000_000 }),
        ]);
      } finally {
        if (original) Object.defineProperty(globalThis, 'navigator', original);
        else Reflect.deleteProperty(globalThis, 'navigator');
      }
    },
  );

  it('propagates an available lock request failure before writing the roster', async () => {
    const error = new Error('lock request denied');
    const values = new Map<string, unknown>();
    const store = createIndexedDbWebclientLocalStore({
      async get(key) { return values.get(key); },
      async set(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
      async clear() { values.clear(); },
      async keys() { return [...values.keys()]; },
    }, { lockProvider: { request: () => Promise.reject(error) } });
    await expect(store.ensureProfile('wss://home.example/ws')).rejects.toBe(error);
    expect(values.size).toBe(0);
  });

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

  // ── retargetProfile (D-148) ─────────────────────────────────────────────
  // ⛔ THE JOIN NOBODY TESTED. The roster algebra has its own suite and the
  // orchestration has its own suite; this METHOD is what translates between
  // them, and mutation testing found two survivors here — reporting success
  // for a refused write, and dropping the re-sealed token on the way through.
  // Two suites either side of one boundary, the join never run. Again.

  const seedTwo = async () => {
    const store = createInMemoryWebclientLocalStore();
    const a = await store.ensureProfile('wss://a.example/ws');
    await store.set('webclient_token', {
      token_id: 'tok-a', ciphertext_b64: 'A', iv_b64: 'ia', issued_at: 1,
    });
    const b = await store.ensureProfile('wss://b.example/ws');
    return { store, a, b };
  };

  it('moves the address and returns the saved URL', async () => {
    const { store, a } = await seedTwo();
    await store.switchProfile(a);
    const saved = await store.retargetProfile(a, 'wss://a.example:4433/ws', {
      token_id: 'tok-a', ciphertext_b64: 'RESEALED', iv_b64: 'iz', issued_at: 2,
    });
    expect(saved).toBe('wss://a.example:4433/ws');
    expect(await store.get('server_url')).toBe('wss://a.example:4433/ws');
  });

  it('⛔ carries the RE-SEALED token through — dropping it destroys the bearer', async () => {
    const { store, a } = await seedTwo();
    await store.switchProfile(a);
    await store.retargetProfile(a, 'wss://a.example:4433/ws', {
      token_id: 'tok-a', ciphertext_b64: 'RESEALED', iv_b64: 'iz', issued_at: 2,
    });
    // The whole point of re-sealing: the record that survives the move is the
    // v2 one. A method that passed `null` here would leave the user re-pairing.
    expect(await store.get('webclient_token')).toEqual({
      token_id: 'tok-a', ciphertext_b64: 'RESEALED', iv_b64: 'iz', issued_at: 2,
    });
  });

  it('⛔ returns null when the roster REFUSES, rather than claiming success', async () => {
    const { store, a, b } = await seedTwo();
    // `b` already holds that address.
    const saved = await store.retargetProfile(a, 'wss://b.example/ws', null);
    expect(saved).toBeNull();
    // ...and nothing moved.
    const profiles = await store.listProfiles();
    expect(profiles.find((p) => p.id === a)!.server_url).toBe('wss://a.example/ws');
    expect(profiles.filter((p) => p.server_url === 'wss://b.example/ws')).toHaveLength(1);
    void b;
  });

  it('returns null for a stale profile id', async () => {
    const { store } = await seedTwo();
    expect(await store.retargetProfile('no-such-id', 'wss://c.example/ws', null)).toBeNull();
  });

  it('returns null for a blank address, and keeps the old one', async () => {
    const { store, a } = await seedTwo();
    expect(await store.retargetProfile(a, '   ', null)).toBeNull();
    const profiles = await store.listProfiles();
    expect(profiles.find((p) => p.id === a)!.server_url).toBe('wss://a.example/ws');
  });

  it('⚠ reports the TRIMMED address it actually stored', async () => {
    // The caller compares what it asked for against what came back; returning
    // an untrimmed string it never stored would make a successful write look
    // like a refusal.
    const { store, a } = await seedTwo();
    expect(await store.retargetProfile(a, '  wss://a.example:4433/ws  ', null))
      .toBe('wss://a.example:4433/ws');
  });

  it('leaves OTHER profiles untouched', async () => {
    const { store, a, b } = await seedTwo();
    await store.retargetProfile(a, 'wss://a.example:4433/ws', null);
    const profiles = await store.listProfiles();
    expect(profiles.find((p) => p.id === b)!.server_url).toBe('wss://b.example/ws');
  });
});

describe('commitPair', () => {
  const OLD = { token_id: 'tok-old', ciphertext_b64: 'c-old', iv_b64: 'iv-old', issued_at: 1 };
  const NEW = { token_id: 'tok-new', ciphertext_b64: 'c-new', iv_b64: 'iv-new', issued_at: 2 };
  const pairing = {
    server_public_key: 'spki-new',
    pair_metadata: {
      paired_at: 2,
      server_passport_fingerprint: 'fp-new',
      server_handle_at_pair: 'office',
    },
    cert_pin_state: null,
    webclient_token: NEW,
  };

  it('lands a pairing on its server’s saved record in ONE write, retiring the attempt', async () => {
    // ⛔ Field by field, re-adding a saved server cleared its working sign-in
    // first, so any later failure left it "Needs pairing again".
    const store = createInMemoryWebclientLocalStore();
    const office = await store.ensureProfile('wss://office.example/ws');
    await store.set('server_public_key', 'spki-old');
    await store.set('webclient_token', OLD);
    await store.beginNewProfile();
    const reads: Array<unknown> = [];
    const watched = store as unknown as { set: unknown; remove: unknown };
    watched.set = async (...args: unknown[]) => { reads.push(['set', ...args]); };
    watched.remove = async (...args: unknown[]) => { reads.push(['remove', ...args]); };

    expect(await store.commitPair('wss://office.example/ws', pairing)).toBe(office);

    expect(reads).toEqual([]);
    const profiles = await store.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: office,
      server_public_key: 'spki-new',
      webclient_token: NEW,
    });
  });

  it('adds a record for a new address, like ensureProfile', async () => {
    const store = createInMemoryWebclientLocalStore();
    await store.ensureProfile('wss://office.example/ws');
    await store.set('webclient_token', OLD);
    await store.beginNewProfile();
    const pending = await store.activeProfileId();

    expect(await store.commitPair('wss://lab.example/ws', pairing)).toBe(pending);

    const profiles = await store.listProfiles();
    expect(profiles.map((p) => p.server_url)).toEqual(['wss://office.example/ws', 'wss://lab.example/ws']);
    expect(profiles[0]?.webclient_token).toEqual(OLD);
    expect(profiles[1]?.webclient_token).toEqual(NEW);
  });
});

describe('retireActiveProfile', () => {
  const TOKEN = {
    token_id: 'tok-office',
    ciphertext_b64: 'ciphertext',
    iv_b64: 'iv',
    issued_at: 1,
  };

  it('swaps the active server for a pending record and leaves every other server signed in', async () => {
    // ⛔ Removing the active record instead hands the pointer to another
    // server: the next boot mounts it, and per-field removals write into it.
    const store = createInMemoryWebclientLocalStore();
    const office = await store.ensureProfile('wss://office.example/ws');
    await store.set('webclient_token', TOKEN);
    const alice = await store.ensureProfile('wss://alice.example/ws');

    await retireActiveProfile(store);

    const profiles = await store.listProfiles();
    expect(profiles.find((p) => p.id === office)?.webclient_token).toEqual(TOKEN);
    expect(profiles.some((p) => p.id === alice)).toBe(false);
    const activeId = await store.activeProfileId();
    expect(profiles.find((p) => p.id === activeId)?.server_url).toBe('');
    expect(await store.get('server_url')).toBeNull();
  });

  it('empties an attempt that holds leftovers, so it stops reading as an interrupted save', async () => {
    // ⛔ The pending record was reused as it was: a stray `cert_pin_state` kept
    // it "partial", so Clear changed nothing and the repair card came back on
    // every start.
    const store = createInMemoryWebclientLocalStore();
    const office = await store.ensureProfile('wss://office.example/ws');
    await store.set('webclient_token', TOKEN);
    await store.beginNewProfile();
    const pending = await store.activeProfileId();
    await store.set('cert_pin_state', { current_fingerprint: 'stray', current_valid_until: 1 });
    expect((await readStoredPairState(store)).kind).toBe('partial');

    await retireActiveProfile(store);

    expect(await readStoredPairState(store)).toEqual({ kind: 'empty' });
    expect(await store.activeProfileId()).toBe(pending);
    expect((await store.listProfiles()).find((p) => p.id === office)?.webclient_token)
      .toEqual(TOKEN);
  });

  it('keeps an attempt that is already pending', async () => {
    const store = createInMemoryWebclientLocalStore();
    await store.ensureProfile('wss://office.example/ws');
    await store.beginNewProfile();
    const pending = await store.activeProfileId();

    await retireActiveProfile(store);

    expect(await store.activeProfileId()).toBe(pending);
    expect((await store.listProfiles()).map((p) => p.server_url))
      .toEqual(['wss://office.example/ws', '']);
  });
});

describe('a store pinned to the server a tab started on', () => {
  const token = (token_id: string) => ({
    token_id,
    ciphertext_b64: 'ciphertext',
    iv_b64: 'iv',
    issued_at: 1,
  });

  /** Home is where this tab started; Office is another saved server. */
  const twoServers = async (officeSignedIn: boolean) => {
    const store = createInMemoryWebclientLocalStore();
    const office = await store.ensureProfile('wss://office.example/ws');
    if (officeSignedIn) await store.set('webclient_token', token('tok-office'));
    const home = await store.ensureProfile('wss://home.example/ws');
    await store.set('webclient_token', token('tok-home'));
    await store.set('server_public_key', 'KEY-HOME');
    const pinned = await pinStoreToActiveProfile(store);
    return { store, office, home, pinned };
  };

  for (const officeSignedIn of [true, false]) {
    it(`keeps reading its own server after another tab switches (Office ${officeSignedIn ? 'signed in' : 'without a sign-in'})`, async () => {
      // ⛔ Read through the active pointer, the tab's next reconnect dialed
      // Office — and with HOME's token when Office had none.
      const { store, office, pinned } = await twoServers(officeSignedIn);
      await store.switchProfile(office);

      expect(await pinned.get('server_url')).toBe('wss://home.example/ws');
      expect((await pinned.get('webclient_token'))?.token_id).toBe('tok-home');
      expect(await pinned.get('server_public_key')).toBe('KEY-HOME');
      expect((await pinned.inspect()).server_url).toBe('wss://home.example/ws');
    });
  }

  it('writes land on its own server, never on the active one', async () => {
    // A token rotation or a restore in this tab, after another tab switched.
    const { store, office, home, pinned } = await twoServers(true);
    await store.switchProfile(office);

    await pinned.set('webclient_token', token('tok-home-rotated'));
    await pinned.set('cert_pin_state', { state: 'pinned' } as never);

    const profiles = await store.listProfiles();
    expect(profiles.find((p) => p.id === home)?.webclient_token?.token_id).toBe('tok-home-rotated');
    expect(profiles.find((p) => p.id === office)?.webclient_token?.token_id).toBe('tok-office');
    expect(profiles.find((p) => p.id === office)?.cert_pin_state ?? null).toBeNull();
    expect(await store.activeProfileId()).toBe(office);
  });

  it('once its server is forgotten elsewhere, reads nothing and writes nowhere', async () => {
    const { store, office, home, pinned } = await twoServers(true);
    await store.removeProfile(home);

    expect(await pinned.get('server_url')).toBeNull();
    expect(await pinned.get('webclient_token')).toBeNull();
    await pinned.set('webclient_token', token('tok-stray'));
    const profiles = await store.listProfiles();
    expect(profiles.map((p) => p.id)).toEqual([office]);
    expect(profiles[0]?.webclient_token?.token_id).toBe('tok-office');
  });

  it('keeps its address: moving it is retargetProfile; removing it removes only that server', async () => {
    const { store, office, home, pinned } = await twoServers(true);
    await store.switchProfile(office);

    await pinned.set('server_url', 'wss://home.example/ws'); // same address: nothing to do
    await expect(pinned.set('server_url', 'wss://elsewhere.example/ws')).rejects.toThrow('retargetProfile');
    await pinned.remove('server_url');

    expect((await store.listProfiles()).map((p) => p.id)).toEqual([office]);
    expect(await store.activeProfileId()).toBe(office);
    expect(home).not.toBe(office);
  });

  it('clear still wipes the whole browser', async () => {
    const { store, pinned } = await twoServers(true);
    await pinned.clear();
    expect(await store.listProfiles()).toEqual([]);
  });

  it('a store without a roster has nothing to pin and comes back as it is', async () => {
    const plain: WebclientLocalStore = {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
      inspect: async () => ({
        server_url: null, webclient_token: null, server_public_key: null, pair_metadata: null, cert_pin_state: null,
      }),
      clear: async () => undefined,
    };
    expect(await pinStoreToActiveProfile(plain)).toBe(plain);
  });
});

describe('moving a saved server to a new address', () => {
  const token = (token_id: string) => ({
    token_id,
    ciphertext_b64: 'ciphertext',
    iv_b64: 'iv',
    issued_at: 1,
  });

  it('applies only while the stored sign-in is still the one the edit read', async () => {
    const store = createInMemoryWebclientLocalStore();
    const id = await store.ensureProfile('wss://home.example/ws');
    await store.set('webclient_token', token('tok-rotated'));

    // The edit read `tok-old`; another tab has rotated it since.
    expect(await store.retargetProfile(id, 'wss://moved.example/ws', token('tok-old'), 'tok-old'))
      .toBeNull();
    const kept = (await store.listProfiles()).find((p) => p.id === id);
    expect(kept?.server_url).toBe('wss://home.example/ws');
    expect(kept?.webclient_token?.token_id).toBe('tok-rotated');

    expect(await store.retargetProfile(id, 'wss://moved.example/ws', token('tok-rotated'), 'tok-rotated'))
      .toBe('wss://moved.example/ws');
  });
});
