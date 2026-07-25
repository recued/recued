/** Pre-enrollment gate tests.
 *
 *  When `recoveryKeyCheck` is wired but no realm-binding exists yet:
 *    - `register` messages are rejected with `server_not_enrolled`.
 *    - All rpc methods EXCEPT `pair.registerRecoveryKey` return
 *      `server_not_enrolled`.
 *    - After successful enrollment via `pair.registerRecoveryKey`,
 *      the gate lifts: subsequent register + rpc calls succeed.
 *
 *  When the store is NOT wired, the gate is bypassed entirely
 *  (legacy mode — register and rpc work as before).  */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { generateRecoveryKey } from '@recued/crypto';
import {
  startServer,
  type RunningServer,
  createRecoveryKeyCheckStore,
} from '../index.js';

const KEY = generateRecoveryKey().mnemonic;

const connectWs = (port: number, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

const callRpc = (
  ws: WebSocket,
  method: string,
  args: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> =>
  new Promise((resolve) => {
    const request_id = `req-${Date.now().toString(36)}`;
    const onMessage = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'rpc_result' && msg.request_id === request_id) {
        ws.off('message', onMessage);
        resolve({ ok: !msg.error, result: msg.result, error: msg.error });
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
  });

const sendRegister = (ws: WebSocket, instance_id: string): Promise<{ type: string; code?: string; message?: string }> =>
  new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.send(JSON.stringify({ type: 'register', instance_id }));
  });

describe('server NOT enrolled — gates active', () => {
  let server: RunningServer;
  let db: Database.Database;

  beforeAll(async () => {
    db = new Database(':memory:');
    server = await startServer(0, {
      recoveryKeyCheck: createRecoveryKeyCheckStore(db),
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('register is rejected with server_not_enrolled', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    const reply = await sendRegister(ws, 'ext-1');
    expect(reply.type).toBe('register_error');
    expect(reply.code).toBe('server_not_enrolled');
    expect(reply.message).toMatch(/not encrypted/i);
    ws.close();
  });

  it('rpc methods other than pair.registerRecoveryKey are rejected', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      const r = await callRpc(ws, 'cache.get', { key: 'whatever' });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('server_not_enrolled');
    } finally {
      ws.close();
    }
  });

  // M5 S3 — the pre-pair restore onboarding set is allowed pre-enrollment so a
  // code-paired-but-not-yet-enrolled server can stage + validate + restore a
  // backup. These run BEFORE the enrollment test below (which mutates the shared
  // server). The methods aren't fully wired in this minimal harness, so they
  // fail for OTHER reasons — the point is they are NOT `server_not_enrolled`.
  it('M5 S3 — archive upload + import rpcs ARE allowed pre-enrollment (gate lifted)', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      for (const method of [
        'server.archive.upload.create',
        'server.archive.upload.probe',
        'server.archive.upload.finalize',
        'server.archive.upload.delete',
        'server.archive.import',
      ]) {
        const r = await callRpc(ws, method, {});
        expect(r.ok).toBe(false);
        expect(r.error?.code).not.toBe('server_not_enrolled');
      }
    } finally {
      ws.close();
    }
  });

  it('pair.registerRecoveryKey IS allowed pre-enrollment (and enrolls)', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      const r = await callRpc(ws, 'pair.registerRecoveryKey', { recoveryKey: KEY });
      expect(r.ok).toBe(true);
      expect((r.result as { outcome: string }).outcome).toBe('enrolled');
    } finally {
      ws.close();
    }
  });

  it('after enrollment, register succeeds normally', async () => {
    // The previous test already enrolled. New WS, register should
    // sail through.
    const ws = await connectWs(server.port, 'test-realm');
    const reply = await sendRegister(ws, 'ext-2');
    expect(reply.type).toBe('registered');
    ws.close();
  });

  it('after enrollment, other rpc methods are reachable', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      // pair.list isn't wired in this test setup; we expect
      // not_configured (not server_not_enrolled) — proves the gate
      // lifted, even though the method itself isn't dispatched.
      const r = await callRpc(ws, 'pair.list', {});
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('not_configured');
    } finally {
      ws.close();
    }
  });
});

describe('server WITHOUT recovery-key store — gate bypassed (legacy)', () => {
  let server: RunningServer;

  beforeAll(async () => {
    // No recoveryKeyCheck wired → gate logic doesn't activate.
    server = await startServer(0, {});
    server.wsServer.maxInstances = 0; // allow many for this test
  });

  afterAll(async () => {
    await server.close();
  });

  it('register works without enrollment (legacy compatibility)', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    const reply = await sendRegister(ws, 'ext-legacy');
    expect(reply.type).toBe('registered');
    ws.close();
  });

  it('rpc methods are reachable without enrollment', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      const r = await callRpc(ws, 'cache.get', { key: 'whatever' });
      // cache.get not wired here either → not_configured. Different from
      // server_not_enrolled — proves the gate doesn't fire.
      expect(r.error?.code).toBe('not_configured');
    } finally {
      ws.close();
    }
  });
});
