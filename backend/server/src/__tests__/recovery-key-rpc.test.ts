/** End-to-end ws → rpc test for `pair.registerRecoveryKey`.
 *
 *  Spins up a real server with the recovery-key store wired, opens
 *  a WS, fires the rpc, and asserts:
 *    - First call enrolls (returns `{outcome: 'enrolled'}`).
 *    - Second call with the SAME key verifies.
 *    - Second call with a DIFFERENT key is rejected with `mismatch`.
 *    - Bad mnemonic is rejected with `invalid` (400) before storage
 *      is touched.
 *    - When the store isn't wired, the rpc returns `not_configured`. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { generateRecoveryKey } from '@recued/crypto';
import {
  startServer,
  type RunningServer,
  createRecoveryKeyCheckStore,
} from '../index.js';

const KEY_A = generateRecoveryKey().mnemonic;
let KEY_B = generateRecoveryKey().mnemonic;
while (KEY_B === KEY_A) KEY_B = generateRecoveryKey().mnemonic;

const connectWs = (port: number, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

/** Send an rpc envelope and await the matching rpc_result. Resolves
 *  with the raw response so tests can assert ok / error fields. */
const callRpc = (
  ws: WebSocket,
  method: string,
  args: unknown,
): Promise<{
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}> =>
  new Promise((resolve) => {
    const request_id = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

describe('pair.registerRecoveryKey rpc — wired', () => {
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

  it('first call enrolls; second call with same key verifies', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      const first = await callRpc(ws, 'pair.registerRecoveryKey', { recoveryKey: KEY_A });
      expect(first.ok).toBe(true);
      expect((first.result as { outcome: string }).outcome).toBe('enrolled');

      const second = await callRpc(ws, 'pair.registerRecoveryKey', { recoveryKey: KEY_A });
      expect(second.ok).toBe(true);
      expect((second.result as { outcome: string }).outcome).toBe('verified');
    } finally {
      ws.close();
    }
  });

  it('different valid key after enrollment → mismatch (401)', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      const result = await callRpc(ws, 'pair.registerRecoveryKey', { recoveryKey: KEY_B });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('mismatch');
    } finally {
      ws.close();
    }
  });

  it('invalid mnemonic → invalid (400) before storage is touched', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      const result = await callRpc(ws, 'pair.registerRecoveryKey', { recoveryKey: 'abandon abandon abandon' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('invalid');
    } finally {
      ws.close();
    }
  });

  it('missing recoveryKey arg → bad_request (400)', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      const result = await callRpc(ws, 'pair.registerRecoveryKey', {});
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('bad_request');
    } finally {
      ws.close();
    }
  });
});

describe('pair.registerRecoveryKey rpc — store NOT wired', () => {
  let server: RunningServer;

  beforeAll(async () => {
    // No `recoveryKeyCheck` option → handler is omitted.
    server = await startServer(0, {});
  });

  afterAll(async () => {
    await server.close();
  });

  it('returns not_configured when the server has no recovery-key store', async () => {
    const ws = await connectWs(server.port, 'test-realm');
    try {
      const result = await callRpc(ws, 'pair.registerRecoveryKey', { recoveryKey: KEY_A });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('not_configured');
    } finally {
      ws.close();
    }
  });
});
