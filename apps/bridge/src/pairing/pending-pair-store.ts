/** Where an ACCEPTED pairing waits until this bridge finishes setting up.
 *
 *  Backs the `pendingStore` of [[createBridgeWorkerPairing]]. `/auth/pair`
 *  spends the single-use code the moment it says yes, so the reply it sends
 *  back — bearer, token id, passport — is the only way left to finish.
 *  Losing it means asking the owner for another code, and a Chrome Web Store
 *  reviewer cannot ask (0.0.1 was rejected for exactly that, 2026-10-09).
 *
 *  ⛔ WHY `chrome.storage.session`, NOT THE SERVICE WORKER'S MEMORY ALONE.
 *  The worker keeps a copy in memory too, but Chrome stops an idle worker
 *  after about 30 seconds, and a user who reads the failure and comes back
 *  later would find it gone. Session storage outlives the worker's idle
 *  shutdown, is held in memory and never written to disk, is readable only
 *  by this extension's own pages and worker (content scripts are excluded by
 *  the default access level, which the bridge never widens), and is emptied
 *  by a browser restart and by an extension reload. The worker clears this
 *  key the moment a pair finalizes.
 *
 *  ⛔ NEVER THE RECOVERY KEY. A pair can carry the realm's 24-word root
 *  secret, and the pair form promises "this bridge never stores it". The
 *  record has no field for it, and `save` writes named fields only, so
 *  nothing passed in by mistake is kept. */

/** The server's reply to an accepted code, plus what this bridge sent with
 *  it. Everything finishing needs, and nothing else. */
export interface BridgeAcceptedPair {
  /** Server URL the user typed (HTTP shape; finalize normalises it). */
  serverUrl: string;
  /** The bearer `/auth/pair` returned. */
  token: string;
  /** Durable server-issued client token id. */
  token_id?: string;
  /** Passport projection `/auth/pair` returned inline. */
  passport?: unknown;
  /** Server id, when the server was configured with one. */
  serverId?: string;
  /** The instance id this bridge sent with the pair, so finalize records
   *  the same one the server stamped on the token. */
  instanceId?: string;
}

/** Persistence for an accepted pairing whose setup has not finished. The
 *  worker treats every call as best-effort and keeps its own copy. */
export interface BridgePendingPairStore {
  load(): Promise<BridgeAcceptedPair | null>;
  save(pending: BridgeAcceptedPair): Promise<void>;
  clear(): Promise<void>;
}

/** The one `chrome.storage.session` key this module owns. */
export const BRIDGE_PENDING_PAIR_SESSION_KEY = 'bridge_pending_pair';

/** The slice of `chrome.storage.session` this store needs. Same call shapes
 *  as the `chrome.storage.local` binding in `storage/local-store.ts`. */
export interface ChromeStorageSessionArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/** Read back a saved pairing, or null when the row is absent or not one this
 *  module wrote. A malformed row is dropped rather than half-used: finishing
 *  with a broken one fails, and fails the same way on every retry. */
const parsePendingPair = (raw: unknown): BridgeAcceptedPair | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!nonEmptyString(r.serverUrl) || !nonEmptyString(r.token)) return null;
  if (r.token_id !== undefined && !nonEmptyString(r.token_id)) return null;
  if (r.serverId !== undefined && !nonEmptyString(r.serverId)) return null;
  if (r.instanceId !== undefined && !nonEmptyString(r.instanceId)) return null;
  return {
    serverUrl: r.serverUrl,
    token: r.token,
    ...(r.token_id !== undefined ? { token_id: r.token_id } : {}),
    ...(r.passport !== undefined ? { passport: r.passport } : {}),
    ...(r.serverId !== undefined ? { serverId: r.serverId } : {}),
    ...(r.instanceId !== undefined ? { instanceId: r.instanceId } : {}),
  };
};

export const createSessionPendingPairStore = (
  area: ChromeStorageSessionArea,
): BridgePendingPairStore => ({
  async load() {
    const got = await area.get([BRIDGE_PENDING_PAIR_SESSION_KEY]);
    return parsePendingPair(got[BRIDGE_PENDING_PAIR_SESSION_KEY]);
  },
  async save(pending) {
    await area.set({
      [BRIDGE_PENDING_PAIR_SESSION_KEY]: {
        serverUrl: pending.serverUrl,
        token: pending.token,
        ...(pending.token_id !== undefined ? { token_id: pending.token_id } : {}),
        ...(pending.passport !== undefined ? { passport: pending.passport } : {}),
        ...(pending.serverId !== undefined ? { serverId: pending.serverId } : {}),
        ...(pending.instanceId !== undefined ? { instanceId: pending.instanceId } : {}),
      },
    });
  },
  async clear() {
    await area.remove([BRIDGE_PENDING_PAIR_SESSION_KEY]);
  },
});
