/** D-148 § A.4.1 — webclient local-storage abstraction.
 *
 *  Encodes the closed-list 5 fields the webclient persists. Anything
 *  outside this set is a CI-gate failure (the role-boundary lint
 *  scans for unexpected stores). The Settings → Privacy page reads
 *  this same shape so users can verify the webclient is not hiding
 *  state.
 *
 *  Two backends ship: an in-memory store for tests + the cold-boot
 *  path before IndexedDB initializes; an IndexedDB-backed store for
 *  production. Both reject unknown keys at set-time so the storage
 *  substrate cannot drift from the spec's 5-field promise.
 */

import {
  WEBCLIENT_LOCAL_STORAGE_FIELDS,
  WEBCLIENT_PROFILE_STORAGE_FIELDS,
  WEBCLIENT_INDEXED_DB_NAME,
  type WebclientLocalKey,
  type WebclientLocalStorage,
  type WebclientServerProfile,
} from '@recued/contracts';

import {
  EMPTY_ROSTER,
  activeProfile,
  beginPendingProfile,
  ensureActiveProfileFor,
  migrateLegacyFields,
  noteConnected,
  projectProfile,
  removeProfile as removeFromRoster,
  renameProfile as renameInRoster,
  setActiveField,
  switchTo,
  type ProfileRoster,
} from './server-profiles.js';

export const WEBCLIENT_LOCAL_KEYS: ReadonlyArray<WebclientLocalKey> =
  WEBCLIENT_LOCAL_STORAGE_FIELDS as ReadonlyArray<WebclientLocalKey>;

const ALLOWED_KEYS = new Set<string>(WEBCLIENT_LOCAL_STORAGE_FIELDS);

const blank = (): WebclientLocalStorage => ({
  server_url: null,
  webclient_token: null,
  server_public_key: null,
  pair_metadata: null,
  cert_pin_state: null,
});

/** Reject any key outside the closed-list. Both `set` and `remove`
 *  route through this guard so the storage substrate cannot drift
 *  from the spec's 5-field promise. */
const assertAllowedKey = (key: string): void => {
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(
      `webclient.local-store: refusing to write field outside spec § A.4.1: ${key}`,
    );
  }
};

/** Roster surface — the multi-server half of the store.
 *
 *  Separate from the five-key surface above on purpose: every existing
 *  consumer reads the ACTIVE server through `get`/`set` and needs to know
 *  nothing about profiles, while the switcher, the offline recovery paths,
 *  and pairing reach for these. */
export interface WebclientProfileStore {
  /** Every paired server, in roster order. */
  listProfiles(): Promise<ReadonlyArray<WebclientServerProfile>>;
  /** Which one the five-key surface currently resolves against. */
  activeProfileId(): Promise<string | null>;
  /** Add-or-activate by URL, returning the active id. Idempotent for a URL
   *  this browser already knows, so re-pairing never duplicates a row. */
  ensureProfile(server_url: string): Promise<string>;
  /** Point the five-key surface at another known profile. Unknown id is a
   *  no-op — a stale click must not strand the app with no server. */
  switchProfile(id: string): Promise<void>;
  /** Rename and return the canonical saved label, or null when a stale caller
   *  names a profile that no longer exists. */
  renameProfile(id: string, label: string): Promise<string | null>;
  /** Drop a profile and its stored bearer. Removing the active one falls
   *  back to the most recently connected survivor. */
  removeProfile(id: string): Promise<void>;
  /** Stamp a connect that reached `connected` — orders the switcher. */
  noteProfileConnected(id: string, at: number): Promise<void>;
  /** Open an add-a-server attempt — a pending profile, made active. The next
   *  boot reads no `server_url` and lands on the pair form; pairing adopts
   *  this record. Idempotent: an attempt already open is reused. */
  beginNewProfile(): Promise<void>;
}

export interface WebclientLocalStore {
  get<K extends WebclientLocalKey>(key: K): Promise<WebclientLocalStorage[K] | null>;
  set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]): Promise<void>;
  remove(key: WebclientLocalKey): Promise<void>;
  /** Returns the inspectable projection — the Settings → Privacy page
   *  renders this as the "What does this client store?" view. Always
   *  returns exactly the 5-field shape; missing values surface as
   *  `null`. */
  inspect(): Promise<WebclientLocalStorage>;
  /** Wipe all 5 fields. Implements "Clear this browser" on the
   *  durable side; sessionStorage + SW cache are wiped through
   *  `clearThisBrowser` (different surface). */
  clear(): Promise<void>;
}

/** What the concrete factories return: the five-key surface a consumer of
 *  the ACTIVE server needs, plus the roster surface only the switcher, the
 *  offline recovery paths, and pairing reach for.
 *
 *  Split deliberately. Most of the app — and every hand-rolled test fixture —
 *  speaks `WebclientLocalStore` and should not have to grow seven methods it
 *  never calls just to satisfy a type. */
export type WebclientProfileAwareStore = WebclientLocalStore & WebclientProfileStore;

/** Minimal IndexedDB-shaped surface the webclient depends on. Tests
 *  inject a fake; production wires `indexedDB.open` against the real
 *  global. The narrowness of this interface is deliberate — the
 *  webclient's IDB usage is one keyed object store, nothing more. */
export interface IndexedDbKeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  /** List every key currently in the store. The `clearThisBrowser`
   *  follow-up uses this to assert post-condition: zero keys live in
   *  the closed-list store after clear. */
  keys(): Promise<string[]>;
}

/** Every physical key the store may write: the roster pair, plus the five
 *  legacy singletons it still READS during migration. */
const PHYSICAL_KEYS: ReadonlyArray<string> = [
  ...WEBCLIENT_PROFILE_STORAGE_FIELDS,
  ...WEBCLIENT_LOCAL_STORAGE_FIELDS,
];

const [PROFILES_KEY, ACTIVE_KEY] = WEBCLIENT_PROFILE_STORAGE_FIELDS as readonly [string, string];

/** Cross-tab serialization for roster read-modify-write operations. A
 *  dedicated lock avoids re-entering the pairing/recovery lock while those
 *  flows call this store. */
export const WEBCLIENT_PROFILE_STORE_LOCK_NAME =
  'recued.webclient.server-profiles' as const;

export interface WebclientProfileStoreLockProvider {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface WebclientProfileStoreOptions {
  /** `undefined` resolves `navigator.locks`; null deliberately disables it. */
  lockProvider?: WebclientProfileStoreLockProvider | null;
}

const resolveProfileStoreLockProvider = (): WebclientProfileStoreLockProvider | null => {
  const nav = (
    globalThis as { navigator?: { locks?: WebclientProfileStoreLockProvider } }
  ).navigator;
  return typeof nav?.locks?.request === 'function' ? nav.locks : null;
};

let idCounter = 0;
/** Profile ids never leave the browser, so uniqueness within this origin is
 *  the whole requirement. `randomUUID` where the platform has it (the
 *  webclient already refuses to boot outside a secure context), a monotonic
 *  fallback for the in-memory store under node. */
const mintProfileId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  idCounter += 1;
  return `profile-${idCounter}`;
};

/** The shared roster-backed implementation. Both exported factories are this
 *  function over a different `kv`, so the in-memory store used by tests and
 *  the cold-boot path cannot drift from the IndexedDB one in production —
 *  the migration, the switch semantics, and the closed-list guard are
 *  written once. */
const createProfileBackedStore = (
  kv: IndexedDbKeyValue,
  options: WebclientProfileStoreOptions = {},
): WebclientProfileAwareStore => {
  // A roster write spans two physical keys. Serialize every same-tab roster
  // operation so a read cannot observe the new profile array with the old
  // active pointer, and so a connection-recency stamp cannot race a rename or
  // removal and restore an older snapshot. The Web Lock extends that invariant
  // across sibling documents when the platform provides it.
  let operationTail: Promise<void> = Promise.resolve();
  const lockProvider = options.lockProvider === undefined
    ? resolveProfileStoreLockProvider()
    : options.lockProvider;
  const withRosterLock = <T>(fn: () => Promise<T>): Promise<T> =>
    lockProvider === null
      ? fn()
      : lockProvider.request(
          WEBCLIENT_PROFILE_STORE_LOCK_NAME,
          { mode: 'exclusive' },
          fn,
        );
  const ensureKey = (key: string): WebclientLocalKey => {
    assertAllowedKey(key);
    return key as WebclientLocalKey;
  };

  const enqueueOperation = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = operationTail.then(fn);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const writeRoster = async (roster: ProfileRoster): Promise<void> => {
    await kv.set(PROFILES_KEY, roster.profiles);
    await kv.set(ACTIVE_KEY, roster.activeId);
  };

  /** Read the roster, folding pre-profiles storage in on first touch.
   *
   *  Migration is lazy + idempotent: it fires only when the roster key is
   *  absent and either a usable legacy URL or credential residue is present,
   *  then deletes the legacy keys in the same pass. A browser that never
   *  paired migrates to nothing; interrupted residue becomes a filtered
   *  pending profile so startup repair can see it. A browser already on the
   *  new shape never re-reads the legacy keys at all. */
  const readRosterUnlocked = async (): Promise<ProfileRoster> => {
    const stored = await kv.get(PROFILES_KEY);
    if (Array.isArray(stored)) {
      const activeId = await kv.get(ACTIVE_KEY);
      return {
        profiles: stored as ReadonlyArray<WebclientServerProfile>,
        activeId: typeof activeId === 'string' ? activeId : null,
      };
    }
    const legacy: Partial<WebclientLocalStorage> = {};
    for (const k of WEBCLIENT_LOCAL_KEYS) {
      const v = await kv.get(k);
      if (v !== undefined && v !== null) {
        (legacy as Record<string, unknown>)[k] = v;
      }
    }
    const migrated = migrateLegacyFields(legacy, mintProfileId);
    if (migrated === null) return EMPTY_ROSTER;
    await writeRoster(migrated);
    for (const k of WEBCLIENT_LOCAL_KEYS) await kv.delete(k);
    return migrated;
  };

  const readRoster = (): Promise<ProfileRoster> =>
    enqueueOperation(() => withRosterLock(readRosterUnlocked));

  const mutate = (
    fn: (roster: ProfileRoster) => ProfileRoster,
  ): Promise<ProfileRoster> =>
    enqueueOperation(() => withRosterLock(async () => {
      const next = fn(await readRosterUnlocked());
      await writeRoster(next);
      return next;
    }));

  return {
    async get(key) {
      const k = ensureKey(key);
      const projected = projectProfile(activeProfile(await readRoster()));
      // The projection is the five-field union; the caller's `K` narrows it.
      return (projected[k] ?? null) as WebclientLocalStorage[typeof key] | null;
    },

    async set(key, value) {
      const k = ensureKey(key);
      // `server_url` is a profile's IDENTITY, not one of its fields: writing
      // it selects which profile the other four land on. Pairing and boot use
      // `ensureProfile` outright; this interception remains for legacy
      // five-key callers and compatibility hosts that do not expose a roster.
      if (k === 'server_url') {
        if (typeof value !== 'string' || value.length === 0) return;
        await mutate((r) => ensureActiveProfileFor(r, value, mintProfileId));
        return;
      }
      await mutate((r) => setActiveField(r, k, value, mintProfileId));
    },

    async remove(key) {
      const k = ensureKey(key);
      // Removing the identity removes the profile; removing any other field
      // nulls it on the active record.
      await mutate((r) => {
        if (k !== 'server_url') return setActiveField(r, k, null, mintProfileId);
        return r.activeId === null ? r : removeFromRoster(r, r.activeId);
      });
    },

    async inspect() {
      const out = blank();
      const projected = projectProfile(activeProfile(await readRoster()));
      for (const k of WEBCLIENT_LOCAL_KEYS) {
        const v = projected[k];
        if (v !== undefined && v !== null) {
          (out as unknown as Record<string, unknown>)[k] = v;
        }
      }
      return out;
    },

    async clear() {
      // Every physical key — roster pair AND any legacy singleton a
      // not-yet-migrated browser still holds — then a bulk clear. "Clear this
      // browser" must not leave one server behind because the store happened
      // to be mid-migration.
      await enqueueOperation(() => withRosterLock(async () => {
        for (const k of PHYSICAL_KEYS) await kv.delete(k);
        await kv.clear();
      }));
    },

    async listProfiles() {
      return (await readRoster()).profiles;
    },

    async activeProfileId() {
      return (await readRoster()).activeId;
    },

    async ensureProfile(server_url) {
      const next = await mutate((r) =>
        ensureActiveProfileFor(r, server_url, mintProfileId),
      );
      return next.activeId as string;
    },

    async switchProfile(id) {
      await mutate((r) => switchTo(r, id));
    },

    async renameProfile(id, label) {
      const next = await mutate((r) => renameInRoster(r, id, label));
      return next.profiles.find((profile) => profile.id === id)?.label ?? null;
    },

    async removeProfile(id) {
      await mutate((r) => removeFromRoster(r, id));
    },

    async noteProfileConnected(id, at) {
      await mutate((r) => noteConnected(r, id, at));
    },

    async beginNewProfile() {
      await mutate((r) => beginPendingProfile(r, mintProfileId));
    },
  };
};

/** In-memory implementation. Used by tests + the SW boot-flow before
 *  the IndexedDB backend is initialized. `initial` seeds the five legacy
 *  field names, which the shared migration folds into one profile on first
 *  read — so a test fixture written against the old shape still describes a
 *  paired browser. It is document-local, so it does not auto-discover Web
 *  Locks; tests that specifically exercise locking may inject a provider. */
export const createInMemoryWebclientLocalStore = (
  initial?: Partial<WebclientLocalStorage>,
  options?: WebclientProfileStoreOptions,
): WebclientProfileAwareStore => {
  const data = new Map<string, unknown>();
  if (initial) {
    for (const [k, v] of Object.entries(initial)) {
      if (ALLOWED_KEYS.has(k) && v !== undefined && v !== null) data.set(k, v);
    }
  }
  return createProfileBackedStore({
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async clear() { data.clear(); },
    async keys() { return [...data.keys()]; },
  }, options ?? { lockProvider: null });
};

/** Build an IDB-backed local store. The supplied `kv` is a thin
 *  wrapper over `indexedDB.open('recued.webclient.v1')` opened against
 *  the `'recued.webclient.local_storage'` object store; the
 *  `WEBCLIENT_INDEXED_DB_NAME` constant is exported here so callers
 *  pass a well-known db name. */
export const createIndexedDbWebclientLocalStore = (
  kv: IndexedDbKeyValue,
  options?: WebclientProfileStoreOptions,
): WebclientProfileAwareStore => createProfileBackedStore(kv, options);

/** Expose the well-known IDB name so callers wiring the production
 *  backend reach for the same name the closed-list audit asserts. */
export { WEBCLIENT_INDEXED_DB_NAME };
