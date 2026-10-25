/** A rotated sign-in token reaches only the device it belongs to.
 *
 *  ⛔ `token.rotated` carries the new bearer in clear so the rotated device
 *  can reconnect, and it went to EVERY subscribed client. In a run against
 *  the real server, device A rotated the Bridge's token, read the Bridge's
 *  new bearer off its own event stream, was then revoked — and signed back
 *  in as the Bridge, while the real Bridge was locked out. Driven over real
 *  sockets against `startServer`.
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
import { createTokenRotationEmitter } from '../pairing/token-rotation-emitter.js';
import { createEventBus } from '../events/bus.js';
import { SELF_HOST_OWNER_ID } from '../ws-server.js';

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RotatedEvent { kind: string; target_token_id: string; new_token_id: string; bearer: string }
interface Conn { ws: WebSocket; opened: boolean; rotated: RotatedEvent[] }

let server: RunningServer;
let db: Database.Database;
let clientTokens: ClientTokenStore;
const tokens: Record<string, { token_id: string; bearer: string }> = {};
const open: Conn[] = [];

const connect = (bearer: string): Promise<Conn> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, [
      WS_VERSION_SUBPROTOCOL,
      encodeBearerSubprotocol(bearer),
    ]);
    const conn: Conn = { ws, opened: false, rotated: [] };
    open.push(conn);
    let settled = false;
    const done = (): void => { if (!settled) { settled = true; resolve(conn); } };
    ws.on('open', () => { conn.opened = true; done(); });
    ws.on('unexpected-response', done);
    ws.on('error', done);
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; event?: RotatedEvent };
      if (msg.type === 'server_event' && msg.event?.kind === 'token.rotated') conn.rotated.push(msg.event);
    });
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
  const paired = createPairedInstancesStore(db);
  const bus = createEventBus();
  for (const [name, kind] of [['laptop', 'webclient'], ['bridge', 'bridge'], ['phone', 'webclient']] as const) {
    const issued = await clientTokens.issue({
      client_kind: kind, client_label: name, metadata: { issued_via: '/auth/pair', instance_id: `inst-${name}` },
    });
    tokens[name] = { token_id: issued.token_id, bearer: `${issued.token_id}.${issued.bearer}` };
    paired.addOrRefresh({ instance_id: `inst-${name}`, user_id: SELF_HOST_OWNER_ID, display_name: name, kind });
  }
  server = await startServer(0, {
    executeDeps: {
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
    },
    clientTokens,
    pairedInstances: paired,
    eventsDeps: { bus },
    tokenRotationDeps: { emitter: createTokenRotationEmitter({ clientTokens, bus }) },
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

describe('token.rotated reaches only the device whose token was rotated', () => {
  it('the rotated device gets its new bearer; every other client gets the event without it', async () => {
    const laptop = await connect(tokens.laptop!.bearer);
    const bridge = await connect(tokens.bridge!.bearer);
    const phone = await connect(tokens.phone!.bearer);
    for (const conn of [laptop, bridge, phone]) {
      expect(conn.opened).toBe(true);
      expect((await rpc(conn, 'events.subscribe', { kinds: ['token.rotated'] })).error).toBeUndefined();
    }

    // The laptop rotates the Bridge's token.
    const rotated = await rpc(laptop, 'token.rotate', { token_id: tokens.bridge!.token_id });
    expect(rotated.error).toBeUndefined();
    await wait(100);

    // The Bridge receives a bearer that works.
    expect(bridge.rotated).toHaveLength(1);
    const delivered = bridge.rotated[0]!;
    expect(delivered.target_token_id).toBe(tokens.bridge!.token_id);
    expect(delivered.bearer.length).toBeGreaterThan(0);
    expect((await clientTokens.verify(delivered.new_token_id, delivered.bearer)).ok).toBe(true);

    // The caller and a bystander see the rotation, not the credential.
    for (const other of [laptop, phone]) {
      expect(other.rotated).toHaveLength(1);
      expect(other.rotated[0]!.new_token_id).toBe(delivered.new_token_id);
      expect(other.rotated[0]!.bearer).toBe('');
    }
  });
});
