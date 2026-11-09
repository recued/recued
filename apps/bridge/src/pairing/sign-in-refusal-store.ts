/** Which server stopped accepting this bridge's sign-in, so the pair form can say why it is back
 *  and offer that server's address (2026-11-03).
 *
 *  When the server refuses the sign-in for good (close 4003 or 4401, `transport/ws-client.ts`),
 *  the worker stops the paired runtime and clears the pairing, and the side panel mounts the pair
 *  form. Without this note the form would appear with no reason given.
 *
 *  ⛔ `chrome.storage.session`, as `pending-pair-store.ts` explains: Chrome stops an idle worker
 *  after about 30 seconds, and an owner who opens the panel later would find a note kept in its
 *  memory gone. Session storage is held in memory, never written to disk, readable only by this
 *  extension's own pages and worker, and emptied by a browser restart. The note is the server's
 *  address and the time, nothing else; the next pairing to finish clears it. */

import type { ChromeStorageSessionArea } from './pending-pair-store.js';

/** The one `chrome.storage.session` key this module owns. */
export const BRIDGE_SIGN_IN_REFUSED_SESSION_KEY = 'bridge_sign_in_refused';

export interface BridgeSignInRefusal {
  /** The server's address as the pair form takes it (`https://host`), not its socket URL. */
  serverUrl: string;
  at: number;
  /** `disconnected`: the owner disconnected this bridge from its side panel and the server could
   *  not be told, so it still lists the bridge under Devices. Absent: the server refused it. */
  kind?: 'disconnected';
}

export interface BridgeSignInRefusalStore {
  load(): Promise<BridgeSignInRefusal | null>;
  save(note: BridgeSignInRefusal): Promise<void>;
  clear(): Promise<void>;
}

/** The address a pairing to `wsUrl` was made with: `wss://host/ws` → `https://host`, the reverse
 *  of `normaliseServerUrlToWs` (`pair-completion.ts`). Empty when it is not a socket URL. */
export const pairFormServerUrl = (wsUrl: string): string => {
  let u: URL;
  try { u = new URL(wsUrl); } catch { return ''; }
  const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : null;
  if (protocol === null) return '';
  const path = u.pathname.replace(/\/ws\/?$/u, '').replace(/\/+$/u, '');
  return `${protocol}//${u.host}${path}`;
};

const parse = (raw: unknown): BridgeSignInRefusal | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return typeof r.serverUrl === 'string' && r.serverUrl.length > 0 && typeof r.at === 'number'
    ? { serverUrl: r.serverUrl, at: r.at, ...(r.kind === 'disconnected' ? { kind: 'disconnected' as const } : {}) }
    : null;
};

export const createSessionSignInRefusalStore = (area: ChromeStorageSessionArea): BridgeSignInRefusalStore => ({
  async load() {
    return parse((await area.get([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]))[BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]);
  },
  async save(note) {
    await area.set({ [BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]: {
      serverUrl: note.serverUrl, at: note.at, ...(note.kind !== undefined ? { kind: note.kind } : {}),
    } });
  },
  async clear() {
    await area.remove([BRIDGE_SIGN_IN_REFUSED_SESSION_KEY]);
  },
});

/** Where `chrome.storage.session` is missing: the note lasts while the worker does. */
export const createInMemorySignInRefusalStore = (): BridgeSignInRefusalStore => {
  let note: BridgeSignInRefusal | null = null;
  return {
    async load() { return note; },
    async save(next) { note = { ...next }; },
    async clear() { note = null; },
  };
};
