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
  WEBCLIENT_INDEXED_DB_NAME,
  type WebclientLocalKey,
  type WebclientLocalStorage,
} from '@recued/contracts';

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

interface InMemoryBackend {
  data: Partial<Record<WebclientLocalKey, WebclientLocalStorage[WebclientLocalKey]>>;
}

/** In-memory implementation. Used by tests + the SW boot-flow before
 *  the IndexedDB backend is initialized. */
export const createInMemoryWebclientLocalStore = (
  initial?: Partial<WebclientLocalStorage>,
): WebclientLocalStore => {
  const backend: InMemoryBackend = { data: {} };
  if (initial) {
    for (const [k, v] of Object.entries(initial)) {
      if (ALLOWED_KEYS.has(k)) {
        (backend.data as Record<string, unknown>)[k] = v as unknown;
      }
    }
  }

  return {
    async get(key) {
      assertAllowedKey(key);
      return (backend.data[key] as WebclientLocalStorage[typeof key] | undefined) ?? null;
    },
    async set(key, value) {
      assertAllowedKey(key);
      (backend.data as Record<string, unknown>)[key] = value as unknown;
    },
    async remove(key) {
      assertAllowedKey(key);
      delete backend.data[key];
    },
    async inspect() {
      const out = blank();
      for (const k of WEBCLIENT_LOCAL_KEYS) {
        const v = backend.data[k];
        if (v !== undefined) {
          (out as unknown as Record<string, unknown>)[k] = v;
        }
      }
      return out;
    },
    async clear() {
      backend.data = {};
    },
  };
};

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

/** Build an IDB-backed local store. The supplied `kv` is a thin
 *  wrapper over `indexedDB.open('recued.webclient.v1')` opened against
 *  the `'recued.webclient.local_storage'` object store; the
 *  `WEBCLIENT_INDEXED_DB_NAME` constant is exported here so callers
 *  pass a well-known db name. */
export const createIndexedDbWebclientLocalStore = (kv: IndexedDbKeyValue): WebclientLocalStore => {
  const ensureKey = (key: string): WebclientLocalKey => {
    assertAllowedKey(key);
    return key as WebclientLocalKey;
  };

  return {
    async get(key) {
      const k = ensureKey(key);
      const v = await kv.get(k);
      return (v ?? null) as WebclientLocalStorage[typeof key] | null;
    },
    async set(key, value) {
      const k = ensureKey(key);
      await kv.set(k, value);
    },
    async remove(key) {
      const k = ensureKey(key);
      await kv.delete(k);
    },
    async inspect() {
      const out = blank();
      for (const k of WEBCLIENT_LOCAL_KEYS) {
        const v = await kv.get(k);
        if (v !== undefined && v !== null) {
          (out as unknown as Record<string, unknown>)[k] = v;
        }
      }
      return out;
    },
    async clear() {
      // Two-step: explicit per-key delete then a final `clear()` so
      // both code paths (per-key remove + bulk clear) are exercised
      // on every reset. This is the same disciplined wipe the
      // `clearThisBrowser` helper relies on.
      for (const k of WEBCLIENT_LOCAL_KEYS) {
        await kv.delete(k);
      }
      await kv.clear();
    },
  };
};

/** Expose the well-known IDB name so callers wiring the production
 *  backend reach for the same name the closed-list audit asserts. */
export { WEBCLIENT_INDEXED_DB_NAME };
