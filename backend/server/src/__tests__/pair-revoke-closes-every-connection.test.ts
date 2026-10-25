/** Revoke takes a device off the server: EVERY connection it holds closes.
 *
 *  ⛔ It used to close the first matching socket and return. A browser opens
 *  one socket per tab, each admitted under the same bearer and never
 *  re-checked after the upgrade, so the revoked laptop's second tab stayed
 *  fully signed in — it listed devices and revoked the phone that had just
 *  revoked it. Its open download kept streaming too: binary data sockets
 *  never join the client map. Driven over real sockets against `startServer`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { WS_VERSION_SUBPROTOCOL, encodeBearerSubprotocol } from '@recued/contracts';

import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createClientTokenStore, type ClientTokenStore } from '../pairing/client-tokens.js';
import { createPairedInstancesStore } from '../paired-instances-store.js';
import { SELF_HOST_OWNER_ID } from '../ws-server.js';

// Fast Argon2id params — the shape the other client-token tests use.
const FAST_ARGON2 = { t: 1, m: 8, p: 1 };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Conn {
  ws: WebSocket;
  opened: boolean;
  closes: number[];
}

let server: RunningServer;
let db: Database.Database;
let clientTokens: ClientTokenStore;
let bearerA: string;
let bearerB: string;
let tokenIdA: string;
let paired: ReturnType<typeof createPairedInstancesStore>;
const open: Conn[] = [];

const connect = (path: string, bearer: string): Promise<Conn> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, [
      WS_VERSION_SUBPROTOCOL,
      encodeBearerSubprotocol(bearer),
    ]);
    const conn: Conn = { ws, opened: false, closes: [] };
    open.push(conn);
    let settled = false;
    const done = (): void => { if (!settled) { settled = true; resolve(conn); } };
    ws.on('open', () => { conn.opened = true; done(); });
    ws.on('unexpected-response', done);
    ws.on('error', done);
    ws.on('close', (code: number) => { conn.closes.push(code); });
  });

let requestSeq = 0;
const rpc = (conn: Conn, method: string, args: unknown): Promise<{ result?: unknown; error?: unknown }> =>
  new Promise((resolve, reject) => {
    const request_id = `r${++requestSeq}`;
    const onMessage = (raw: Buffer): void => {
      const msg = JSON.parse(raw.toString()) as { type?: string; request_id?: string };
      if (msg.type !== 'rpc_result' || msg.request_id !== request_id) return;
      conn.ws.off('message', onMessage);
      resolve(msg as { result?: unknown; error?: unknown });
    };
    conn.ws.on('message', onMessage);
    conn.ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
    setTimeout(() => reject(new Error(`${method} timed out`)), 3000);
  });

beforeEach(async () => {
  db = new Database(':memory:');
  clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
  paired = createPairedInstancesStore(db);
  for (const [instance_id, label] of [['inst-A', 'Laptop'], ['inst-B', 'Phone']] as const) {
    paired.addOrRefresh({ instance_id, user_id: SELF_HOST_OWNER_ID, display_name: label, kind: 'webclient' });
  }
  const a = await clientTokens.issue({
    client_kind: 'webclient', client_label: 'Laptop', metadata: { issued_via: '/auth/pair', instance_id: 'inst-A' },
  });
  const b = await clientTokens.issue({
    client_kind: 'webclient', client_label: 'Phone', metadata: { issued_via: '/auth/pair', instance_id: 'inst-B' },
  });
  tokenIdA = a.token_id;
  bearerA = `${a.token_id}.${a.bearer}`;
  bearerB = `${b.token_id}.${b.bearer}`;

  const recipeStore = createRecipeStore('/nonexistent');
  server = await startServer(0, {
    executeDeps: { recipeStore, executorConfig: { manifests: createManifestRegistry('/nonexistent') }, baseVault: {} },
    clientTokens,
    pairedInstances: paired,
    // Only the data socket matters here: it is admitted, then held open.
    downloadDeps: { service: { handleStart: async () => {} } } as never,
  });
  server.wsServer.maxInstances = 0;
});

afterEach(async () => {
  for (const conn of open.splice(0)) {
    try { conn.ws.close(); } catch { /* closed */ }
  }
  await server.close();
  db.close();
});

describe('pair.revoke closes every connection of the revoked device', () => {
  it('closes both tabs and the open download, not just the first socket', async () => {
    const tab1 = await connect('/ws', bearerA);
    const tab2 = await connect('/ws', bearerA);
    const download = await connect('/ws/download', bearerA);
    const phone = await connect('/ws', bearerB);
    expect([tab1.opened, tab2.opened, download.opened, phone.opened]).toEqual([true, true, true, true]);

    const revoked = await rpc(phone, 'pair.revoke', { instance_id: 'inst-A' });
    expect(revoked.result).toEqual({ ok: true });
    await wait(100);

    expect(tab1.closes).toEqual([4003]);
    expect(tab2.closes).toEqual([4003]);
    expect(download.closes).toEqual([4003]);
    // The device that revoked it keeps its connection.
    expect(phone.closes).toEqual([]);
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);

    // And the revoked bearer is refused when it comes back — with the 4401 a
    // browser can read, so a closed laptop learns it was removed when it
    // next connects.
    const again = await connect('/ws', bearerA);
    await wait(100);
    expect(again.closes).toEqual([4401]);
  });

  it('revokes every bearer its live connections used', async () => {
    // A second, separately issued token bound to the same device.
    const second = await clientTokens.issue({
      client_kind: 'webclient', client_label: 'Laptop', metadata: { issued_via: '/auth/pair', instance_id: 'inst-A' },
    });
    const viaFirst = await connect('/ws', bearerA);
    const viaSecond = await connect('/ws', `${second.token_id}.${second.bearer}`);
    expect([viaFirst.opened, viaSecond.opened]).toEqual([true, true]);

    const result = server.wsServer.revokeConnectedInstance('inst-A');
    expect(result.revoked).toBe(true);
    expect([...(result.client_token_ids ?? [])].sort()).toEqual([tokenIdA, second.token_id].sort());
    expect(result.client_token_id).toBe(result.client_token_ids?.[0]);
    await wait(50);
    expect(viaFirst.closes).toEqual([4003]);
    expect(viaSecond.closes).toEqual([4003]);
  });

  it('reports nothing revoked for a device with no open connection', () => {
    expect(server.wsServer.revokeConnectedInstance('inst-A')).toEqual({ revoked: false, client_token_ids: [] });
  });
});

// ⛔ Devices could not tell a quiet device from a dead one: a browser that
// cleared its storage never comes back, and its entry looked like any other.
describe('Devices learns when each device was last here', () => {
  it('stamps its connect and its leave, and pair.list carries it', async () => {
    expect(paired.get('inst-A')?.last_seen_at).toBeNull();
    const tab = await connect('/ws', bearerA);
    expect(tab.opened).toBe(true);
    const atConnect = paired.get('inst-A')?.last_seen_at;
    expect(atConnect).toEqual(expect.any(Number));

    const listed = await rpc(tab, 'pair.list', undefined) as {
      result?: { devices: Array<{ instance_id: string; last_seen_at?: number }> };
    };
    expect(listed.result?.devices.find((d) => d.instance_id === 'inst-A')?.last_seen_at)
      .toBe(atConnect);

    // The leave stamps it again (an older mark shows the write happened).
    paired.noteSeen('inst-A', 1);
    tab.ws.close();
    await wait(100);
    expect(paired.get('inst-A')?.last_seen_at).toBeGreaterThan(1);
    // A device that never connected stays unseen.
    expect(paired.get('inst-B')?.last_seen_at).toBeNull();
  });
});
