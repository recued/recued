/** The bearer check on a WebSocket upgrade is bounded.
 *
 *  ⛔ Each check is an Argon2id hash (32 MiB, ~0.4 s of the main thread),
 *  run even for an unknown token so timing never says which tokens exist.
 *  Unbounded, sixteen bogus upgrades at once held `/health` for 37 s. Now a
 *  full queue is turned away without a check, and an address that keeps
 *  failing is refused without one for a while. Driven over real sockets
 *  against `startServer`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { WS_VERSION_SUBPROTOCOL, encodeBearerSubprotocol } from '@recued/contracts';

import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createClientTokenStore, type ClientTokenStore } from '../pairing/client-tokens.js';
import {
  STRUCTURED_BEARER_LEN,
  STRUCTURED_BEARER_TOKEN_ID_LEN,
  UPGRADE_FAILURES_BEFORE_COOLDOWN,
  UPGRADE_VERIFY_MAX_IN_FLIGHT,
} from '../ws-server.js';

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };
const BOGUS = `${'U'.repeat(STRUCTURED_BEARER_TOKEN_ID_LEN)}.${'Z'.repeat(STRUCTURED_BEARER_LEN)}`;

interface Attempt { opened: boolean; status?: number; closed: Promise<number> }

let server: RunningServer;
let db: Database.Database;
let realTokens: ClientTokenStore;
let verifyCalls = 0;
let holdVerify: Promise<void> | null = null;
const sockets: WebSocket[] = [];

const attempt = (bearer: string): Promise<Attempt> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, [
      WS_VERSION_SUBPROTOCOL,
      encodeBearerSubprotocol(bearer),
    ]);
    sockets.push(ws);
    const closed = new Promise<number>((done) => { ws.once('close', (code: number) => done(code)); });
    let settled = false;
    const finish = (result: Omit<Attempt, 'closed'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...result, closed });
    };
    ws.on('open', () => finish({ opened: true }));
    ws.on('unexpected-response', (_req, res) => finish({ opened: false, status: res.statusCode }));
    ws.on('error', () => finish({ opened: false }));
  });

beforeEach(async () => {
  verifyCalls = 0;
  holdVerify = null;
  db = new Database(':memory:');
  realTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
  const counted: ClientTokenStore = {
    ...realTokens,
    verify: async (token_id, bearer) => {
      verifyCalls += 1;
      if (holdVerify !== null) await holdVerify;
      return realTokens.verify(token_id, bearer);
    },
  };
  server = await startServer(0, {
    executeDeps: {
      recipeStore: createRecipeStore('/nonexistent'),
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
    },
    clientTokens: counted,
  });
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try { ws.terminate(); } catch { /* closed */ }
  }
  await server.close();
  db.close();
});

describe('the bearer check on an upgrade is bounded', () => {
  it('an address whose checks keep failing is refused without another check', async () => {
    for (let i = 0; i < UPGRADE_FAILURES_BEFORE_COOLDOWN; i += 1) {
      const failed = await attempt(BOGUS);
      expect(await failed.closed).toBe(4401);
    }
    expect(verifyCalls).toBe(UPGRADE_FAILURES_BEFORE_COOLDOWN);

    const refused = await attempt(BOGUS);
    expect(refused).toMatchObject({ opened: false, status: 429 });
    expect(verifyCalls).toBe(UPGRADE_FAILURES_BEFORE_COOLDOWN);
  });

  it('a success clears the count, so a device that got it right is not cooled down', async () => {
    const issued = await realTokens.issue({ client_kind: 'webclient' });
    for (let i = 0; i < UPGRADE_FAILURES_BEFORE_COOLDOWN - 1; i += 1) {
      expect(await (await attempt(BOGUS)).closed).toBe(4401);
    }
    expect((await attempt(`${issued.token_id}.${issued.bearer}`)).opened).toBe(true);
    // The count started over: these fail as checks, not as refusals.
    for (let i = 0; i < UPGRADE_FAILURES_BEFORE_COOLDOWN - 1; i += 1) {
      expect(await (await attempt(BOGUS)).closed).toBe(4401);
    }
  });

  it('a full queue of checks turns the next upgrade away without starting one', async () => {
    let release!: () => void;
    holdVerify = new Promise<void>((done) => { release = done; });
    const pending = Array.from({ length: UPGRADE_VERIFY_MAX_IN_FLIGHT }, () => attempt(BOGUS));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(verifyCalls).toBe(UPGRADE_VERIFY_MAX_IN_FLIGHT);

    const turnedAway = await attempt(BOGUS);
    expect(turnedAway).toMatchObject({ opened: false, status: 503 });
    expect(verifyCalls).toBe(UPGRADE_VERIFY_MAX_IN_FLIGHT);

    release();
    await Promise.all(pending);
  });
});
