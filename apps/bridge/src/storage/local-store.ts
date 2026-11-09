/** D-148 § A.3.4 + D-169 P0 Slice 2B — bridge local-storage abstraction.
 *
 *  Encodes the closed-list 10 fields the bridge persists. Anything
 *  outside this set is a CI-gate failure (Appendix I.15) — the popup
 *  inspector reads this same shape so users can verify the bridge is
 *  not hiding state.
 *
 *  D-169 P0 Slice 2B substrate alignment with the webclient (§ A.4.1):
 *  the raw `bridge_token` string field retired in favour of the same
 *  AES-GCM-wrapped `webclient_token` record the webclient persists
 *  (carrying `token_id` + `ciphertext_b64` + `iv_b64` + `issued_at`).
 *  Two § A.4.1 widenings joined the closed list — `pair_metadata`
 *  (non-secret pair-time metadata for the inspector + audit
 *  provenance) and `cert_pin_state` (§ A.6.5 two-pin overlap state so
 *  the bridge accepts a `next_fingerprint` after server cert rotation
 *  without re-pair). The non-extractable AES-GCM key itself lives in
 *  the IndexedDB key-store (`apps/bridge/src/storage/token-store.ts`),
 *  not in chrome.storage.
 *
 *  The interface is storage-agnostic: chrome.storage.local is the
 *  production backend; in-memory is the test backend; an IndexedDB
 *  backend is the popup-inspector reference rendering source.
 *
 *  Reads + writes are typed against `BridgeLocalState` so consumers
 *  never coerce arbitrary keys in. The store rejects unknown keys at
 *  set-time (defense in depth — chrome.storage is global by design,
 *  so an injected attacker that gains `storage` write access still
 *  can't smuggle state through this interface).
 *
 *  ⚠️ The `pending_outbox` and `idempotency_cache` fields are large
 *  and should typically live in IndexedDB rather than chrome.storage
 *  (which has 10 MB total quota). The local store carries a pointer
 *  to the IndexedDB stores; the stores themselves live in
 *  `idempotency/cache.ts` + `queue/outbox-store.ts`.
 */

import {
  BRIDGE_LOCAL_STORAGE_FIELDS,
  type WebclientCertPinState,
  type WebclientPairMetadata,
  type WebclientTokenRecord,
} from '@recued/contracts';

/** Inspectable shape the popup renders. Exactly the closed-list 10
 *  fields per spec § A.3.4 + D-169 P0 Slice 2B + D-335 slice G + D-163
 *  O-2's approval notices — every other field is forbidden. */
export interface BridgeLocalState {
  /** WS endpoint URL set at pair time (e.g. `wss://alice.recued.net:8443/ws`). */
  server_url: string | null;
  /** D-169 P0 Slice 2B — AES-GCM-wrapped realm bearer record. Public
   *  projection (`token_id`) safe to render in the popup inspector;
   *  the runtime unwraps the ciphertext at WS connect time and discards
   *  plaintext after sending the bearer (mirrors `WebclientLocalStorage`
   *  field of the same name + type). */
  webclient_token: WebclientTokenRecord | null;
  /** Server's `server_identity_key` SPKI base64. Pinned at pair time;
   *  rotation triggers re-pair. */
  server_public_key: string | null;
  /** D-169 P0 Slice 2B — pair-time metadata. Non-secret; supports the
   *  popup inspector + audit row provenance. Mirrors `WebclientLocalStorage`. */
  pair_metadata: WebclientPairMetadata | null;
  /** D-169 P0 Slice 2B — § A.6.5 two-pin cert state. Carries the
   *  current fingerprint + optional staged-next so the bridge accepts
   *  either during the rotation overlap window without re-pair. */
  cert_pin_state: WebclientCertPinState | null;
  /** Snapshot of Chrome's per-origin permission inventory. Bridge
   *  reads but does not manage Chrome's grant table. Shape is `{ origins: string[] }`
   *  for current granted origins (subset of `optional_host_permissions`
   *  the user accepted). */
  chrome_permissions_state: { origins: string[] };
  /** Pointer to the IndexedDB store name + last-flush timestamp.
   *  Actual cache rows live in IndexedDB (24h TTL, large; chrome.storage
   *  quota would constrain). */
  idempotency_cache: { store_name: string; last_flush_at: number };
  /** Pointer to the queued-but-not-dispatched commands store. Same
   *  rationale as idempotency_cache. */
  pending_outbox: { store_name: string; depth: number };
  /** D-335 slice G — the owner's list of sites Recued must never use, as the
   *  side panel saves it (`permissions/site-grants.ts`). */
  blocked_sites: string[] | null;
  /** The approvals this Bridge has shown as OS notifications, so each shows once
   *  (`notifications/approval-notices.ts`): ids only, the newest 200. */
  approval_notices_shown: string[] | null;
}

export type BridgeLocalKey = keyof BridgeLocalState;

const ALLOWED_KEYS = new Set<string>(BRIDGE_LOCAL_STORAGE_FIELDS);

/** Storage-agnostic interface backed by chrome.storage.local in
 *  production + an in-memory map in tests. */
export interface BridgeLocalStore {
  get<K extends BridgeLocalKey>(key: K): Promise<BridgeLocalState[K] | null>;
  set<K extends BridgeLocalKey>(key: K, value: BridgeLocalState[K]): Promise<void>;
  remove(key: BridgeLocalKey): Promise<void>;
  /** Returns the inspectable projection — the popup renders this as
   *  the "What does the bridge store?" view. Always returns exactly
   *  the 10-field shape; missing values surface as `null`. */
  inspect(): Promise<BridgeLocalState>;
  /** Wipe the fields. Implements "Disconnect this bridge" + the
   *  Chrome `chrome.permissions.remove` follow-up. ⚠ Keeps `blocked_sites`:
   *  the owner's list of sites Recued must never use outlives a pairing, and
   *  dropping it would let the Bridge act on a site they listed. */
  clear(): Promise<void>;
}

/** Reject any key outside the closed-list. Both `set` and `remove`
 *  route through this guard so the storage substrate cannot drift
 *  from the spec's closed list. */
const assertAllowedKey = (key: string): void => {
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(`bridge.local-store: refusing to write field outside spec § A.3.4: ${key}`);
  }
};

interface InMemoryBackend {
  data: Partial<Record<BridgeLocalKey, BridgeLocalState[BridgeLocalKey]>>;
}

/** In-memory implementation. Used by tests + the SW boot-flow before
 *  the chrome.storage backend is initialized. */
export const createInMemoryBridgeLocalStore = (
  initial?: Partial<BridgeLocalState>,
): BridgeLocalStore => {
  const backend: InMemoryBackend = { data: {} };
  if (initial) {
    for (const [k, v] of Object.entries(initial)) {
      if (ALLOWED_KEYS.has(k)) {
        (backend.data as Record<string, unknown>)[k] = v as unknown;
      }
    }
  }

  const blank = (): BridgeLocalState => ({
    server_url: null,
    webclient_token: null,
    server_public_key: null,
    pair_metadata: null,
    cert_pin_state: null,
    chrome_permissions_state: { origins: [] },
    idempotency_cache: { store_name: 'recued.bridge.idempotency', last_flush_at: 0 },
    pending_outbox: { store_name: 'recued.bridge.outbox', depth: 0 },
    blocked_sites: null,
    approval_notices_shown: null,
  });

  return {
    async get(key) {
      assertAllowedKey(key);
      return (backend.data[key] as BridgeLocalState[typeof key] | undefined) ?? null;
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
      const fresh = blank();
      const out = { ...fresh } as BridgeLocalState;
      for (const k of BRIDGE_LOCAL_STORAGE_FIELDS as readonly BridgeLocalKey[]) {
        const v = backend.data[k];
        if (v !== undefined) {
          (out as unknown as Record<string, unknown>)[k] = v;
        }
      }
      return out;
    },
    async clear() {
      // As the chrome-backed store: the owner's list outlives a pairing.
      backend.data = backend.data.blocked_sites === undefined ? {} : { blocked_sites: backend.data.blocked_sites };
    },
  };
};

/** Chrome-storage backed implementation. The SW + offscreen doc
 *  share state through `chrome.storage.local`. The wrapping interface
 *  guarantees only the closed-list keys are ever written.
 *
 *  Pure adapter — keep it under thirty lines so the lint test that
 *  verifies "no engine code in apps/bridge" trivially passes. */
export interface ChromeStorageLocal {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

export const createChromeBridgeLocalStore = (
  storage: ChromeStorageLocal,
): BridgeLocalStore => {
  return {
    async get(key) {
      assertAllowedKey(key);
      const raw = await storage.get([key]);
      const v = raw[key];
      return (v ?? null) as BridgeLocalState[typeof key] | null;
    },
    async set(key, value) {
      assertAllowedKey(key);
      await storage.set({ [key]: value });
    },
    async remove(key) {
      assertAllowedKey(key);
      await storage.remove([key]);
    },
    async inspect() {
      const raw = await storage.get([...BRIDGE_LOCAL_STORAGE_FIELDS]);
      return {
        server_url: (raw.server_url as string | null | undefined) ?? null,
        webclient_token:
          (raw.webclient_token as BridgeLocalState['webclient_token'] | undefined) ?? null,
        server_public_key: (raw.server_public_key as string | null | undefined) ?? null,
        pair_metadata:
          (raw.pair_metadata as BridgeLocalState['pair_metadata'] | undefined) ?? null,
        cert_pin_state:
          (raw.cert_pin_state as BridgeLocalState['cert_pin_state'] | undefined) ?? null,
        chrome_permissions_state:
          (raw.chrome_permissions_state as BridgeLocalState['chrome_permissions_state'] | undefined) ??
          { origins: [] },
        idempotency_cache:
          (raw.idempotency_cache as BridgeLocalState['idempotency_cache'] | undefined) ??
          { store_name: 'recued.bridge.idempotency', last_flush_at: 0 },
        pending_outbox:
          (raw.pending_outbox as BridgeLocalState['pending_outbox'] | undefined) ??
          { store_name: 'recued.bridge.outbox', depth: 0 },
        blocked_sites: (raw.blocked_sites as BridgeLocalState['blocked_sites'] | undefined) ?? null,
        approval_notices_shown:
          (raw.approval_notices_shown as BridgeLocalState['approval_notices_shown'] | undefined) ?? null,
      };
    },
    async clear() {
      await storage.remove(BRIDGE_LOCAL_STORAGE_FIELDS.filter(field => field !== 'blocked_sites'));
    },
  };
};
