import { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createWebSocketUpgrade } from '../ws-server.js';
import type { WebSocketUpgradeBinding } from '../ws-server.js';

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };

class FakeUpgradeSocket extends Duplex {
  readonly writes: string[] = [];
  wasDestroyed = false;

  _read(): void {}

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    callback();
  }

  setTimeout(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  destroy(error?: Error): this {
    this.wasDestroyed = true;
    return super.destroy(error) as this;
  }
}

const makeUpgradeReq = (token: string): IncomingMessage => ({
  method: 'GET',
  url: `/ws?token=${encodeURIComponent(token)}`,
  headers: {
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version': '13',
  },
}) as IncomingMessage;

const waitForWrite = async (
  socket: FakeUpgradeSocket,
  prefix: string,
): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    if (socket.writes.some((write) => write.startsWith(prefix))) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for socket write ${prefix}`);
};

describe('ws-server canonical client_tokens auth without a listener', () => {
  let binding: WebSocketUpgradeBinding | undefined;

  afterEach(() => {
    binding?.handle.close();
    binding = undefined;
  });

  it('accepts a structured token_id.bearer verified against an active client_tokens row', async () => {
    let now = 1_700_000_000_000;
    const db = new Database(':memory:');
    const clientTokens = createClientTokenStore(db, {
      argon2_params: FAST_ARGON2,
      now: () => now,
    });
    const issued = await clientTokens.issue({
      client_kind: 'webclient',
      client_label: 'Listenerless webclient',
    });
    now += 1;
    binding = createWebSocketUpgrade({ clientTokens });
    const socket = new FakeUpgradeSocket();

    binding.upgrade(
      makeUpgradeReq(`${issued.token_id}.${issued.bearer}`),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );

    await waitForWrite(socket, 'HTTP/1.1 101 Switching Protocols');
    expect(socket.wasDestroyed).toBe(false);
    expect(clientTokens.get(issued.token_id)?.last_used_at).toBe(now);
    db.close();
  });

  it('rejects a legacy opaque bearer when clientTokens is wired', async () => {
    const db = new Database(':memory:');
    const clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    binding = createWebSocketUpgrade({ clientTokens });
    const socket = new FakeUpgradeSocket();

    binding.upgrade(
      makeUpgradeReq('legacy-opaque-realm-bearer'),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );

    expect(socket.writes.join('')).toContain('HTTP/1.1 401 Unauthorized');
    expect(socket.wasDestroyed).toBe(true);
    db.close();
  });

  it('rejects an env-var MCP bearer string instead of treating it as a realm bearer', async () => {
    const db = new Database(':memory:');
    const clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    binding = createWebSocketUpgrade({ clientTokens });
    const socket = new FakeUpgradeSocket();

    binding.upgrade(
      makeUpgradeReq('env-configured-mcp-http-bearer'),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );

    expect(socket.writes.join('')).toContain('HTTP/1.1 401 Unauthorized');
    expect(socket.wasDestroyed).toBe(true);
    db.close();
  });
});
