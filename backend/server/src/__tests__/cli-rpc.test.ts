/** CLI rpc-client integration tests.
 *
 *  Spins up a real ws-server with auth rpc dependencies, then uses the
 *  CLI rpc client to call auth.* methods against it. Verifies the full
 *  round-trip: realm-token read from DB, WS handshake, register, rpc,
 *  response, close.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createPairingManager } from '../pairing.js';
import { createKeyManager } from '../key-manager.js';
import { createBundleStore } from '../bundle-store.js';
import { startServer, type RunningServer } from '../server.js';
import { callLocalRpc, RpcError } from '../cli/rpc-client.js';

const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

let workDir: string;
let dbPath: string;
let db: Database.Database;
let server: RunningServer | undefined;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'recued-cli-'));
  dbPath = join(workDir, 'test.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  // Seed realm_token so the CLI can find it
  const pairing = createPairingManager({});
  db.prepare(`INSERT INTO server_config (key, value) VALUES ('realm_token', ?)`)
    .run(pairing.getRealmToken());

  // Build the auth deps the server will use
  const bundleStore = createBundleStore(db);
  const keys = createKeyManager({
    loadBundle: () => bundleStore.load(),
    saveBundle: (b) => bundleStore.save(b),
    argon2Params: FAST_ARGON2,
  });

  server = await startServer(0, {
    pairing,
    authDeps: { keys },
  });
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────────

describe('callLocalRpc — happy path', () => {
  it('round-trips auth.state', async () => {
    const res = await callLocalRpc<{ state: string }>({
      dbPath, port: server!.port, method: 'auth.state',
    });
    expect(res.state).toBe('uninitialized');
  });
});

// ────────────────────────────────────────────────────────────────
// Failure modes
// ────────────────────────────────────────────────────────────────

describe('callLocalRpc — failure modes', () => {
  it('unknown method returns RpcError', async () => {
    await expect(
      callLocalRpc({ dbPath, port: server!.port, method: 'bogus.method' }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('wrong port → connection error', async () => {
    await expect(
      callLocalRpc({ dbPath, port: 1, method: 'auth.state', timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('missing realm_token → RpcError no_realm_token', async () => {
    // Build a DB with no realm_token row
    const bareDir = mkdtempSync(join(tmpdir(), 'recued-bare-'));
    const bareDb = new Database(join(bareDir, 'bare.db'));
    bareDb.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    bareDb.close();

    try {
      await expect(
        callLocalRpc({
          dbPath: join(bareDir, 'bare.db'),
          port: server!.port,
          method: 'auth.state',
        }),
      ).rejects.toMatchObject({ code: 'no_realm_token' });
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it('bad args return RpcError with correct code', async () => {
    // auth.unlock requires password or recoveryKey — missing both → 400
    await expect(
      callLocalRpc({ dbPath, port: server!.port, method: 'auth.unlock', args: {} }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

// ────────────────────────────────────────────────────────────────
// End-to-end: init + lock + unlock via CLI
// ────────────────────────────────────────────────────────────────

describe('callLocalRpc — e2e auth lifecycle', () => {
  it('init → lock → unlock round-trips', async () => {
    // Init via rpc
    const init = await callLocalRpc<{ state: string; recoveryKey: string }>({
      dbPath, port: server!.port, method: 'auth.init', args: { password: 'pw' },
    });
    expect(init.state).toBe('unlocked');
    expect(init.recoveryKey.split(/\s+/).length).toBe(24);

    // Lock
    const locked = await callLocalRpc<{ state: string }>({
      dbPath, port: server!.port, method: 'auth.lock',
    });
    expect(locked.state).toBe('locked');

    // Unlock with correct password
    const unlocked = await callLocalRpc<{ state: string }>({
      dbPath, port: server!.port, method: 'auth.unlock', args: { password: 'pw' },
    });
    expect(unlocked.state).toBe('unlocked');

    // Unlock via recovery key after another lock
    await callLocalRpc({ dbPath, port: server!.port, method: 'auth.lock' });
    const byRecovery = await callLocalRpc<{ state: string }>({
      dbPath, port: server!.port, method: 'auth.unlock', args: { recoveryKey: init.recoveryKey },
    });
    expect(byRecovery.state).toBe('unlocked');
  });

  it('wrong password fails with unauthorized', async () => {
    await callLocalRpc({ dbPath, port: server!.port, method: 'auth.init', args: { password: 'right' } });
    await callLocalRpc({ dbPath, port: server!.port, method: 'auth.lock' });
    await expect(
      callLocalRpc({ dbPath, port: server!.port, method: 'auth.unlock', args: { password: 'WRONG' } }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
