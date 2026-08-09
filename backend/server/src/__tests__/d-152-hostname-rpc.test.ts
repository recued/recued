/** D-152 — collection.hostname.* rpc surface. */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { createServerHandlerSet, type ServerConfig } from '../index.js';
import { createHostnameSniBindingLookup } from '../hostname/sni-dispatch.js';
import {
  handleHostnameAdd,
  handleHostnameGet,
  handleHostnameList,
  handleHostnameRemove,
  handleHostnameUpdate,
  handleHostnameVerifyOwnership,
  type HostnameRpcDeps,
} from '../hostname-handler.js';
import { createHostnameRegistryStore } from '../storage/hostname-registry.js';

const NOW = 1_700_000_000_000;
const CALLER = { instance_id: 'client-1' };

class MemorySocket extends Duplex {
  peer: MemorySocket | undefined;
  remoteAddress = '127.0.0.1';
  remotePort = 12345;
  localAddress = '127.0.0.1';
  localPort = 80;

  _read(): void {
    // Peer writes push directly into this readable side.
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.peer && !this.peer.destroyed) {
      this.peer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) {
      this.peer.push(null);
    }
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
}

const createSocketPair = (): { client: MemorySocket; server: MemorySocket } => {
  const client = new MemorySocket();
  const server = new MemorySocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
};

const connectWs = (httpServer: HttpServer, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1/ws?token=${encodeURIComponent(token)}`,
      {
        createConnection: () => {
          const pair = createSocketPair();
          process.nextTick(() => {
            httpServer.emit('connection', pair.server as unknown as Socket);
          });
          return pair.client as unknown as Socket;
        },
      },
    );
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      resolve(ws);
    });
    ws.once('error', fail);
    ws.once('unexpected-response', (_req, res) => {
      fail(new Error(`unexpected response ${res.statusCode}`));
    });
  });

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForClose = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
  });

const closeWs = async (ws: WebSocket): Promise<void> => {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = waitForClose(ws);
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
  await Promise.race([
    closed,
    wait(250).then(() => {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    }),
  ]);
};

interface RpcReply {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

const waitForMessage = (
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('waitForMessage timeout'));
    }, 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(msg)) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });

const registerWs = async (ws: WebSocket): Promise<void> => {
  const registered = waitForMessage(
    ws,
    (msg) => msg.type === 'registered' && msg.instance_id === CALLER.instance_id,
  );
  ws.send(JSON.stringify({
    type: 'register',
    instance_id: CALLER.instance_id,
    display_name: 'D-152 test client',
  }));
  await registered;
};

const callRpc = async (
  ws: WebSocket,
  method: string,
  args: unknown = {},
): Promise<RpcReply> => {
  const requestId = `req-${randomUUID()}`;
  const reply = waitForMessage(
    ws,
    (msg) => msg.type === 'rpc_result' && msg.request_id === requestId,
  );
  ws.send(JSON.stringify({
    type: 'rpc',
    request_id: requestId,
    method,
    args,
  }));
  const msg = await reply;
  const error = msg.error as RpcReply['error'] | undefined;
  return {
    ok: error === undefined,
    ...(msg.result !== undefined ? { result: msg.result } : {}),
    ...(error !== undefined ? { error } : {}),
  };
};

interface RpcHarness {
  connect(): Promise<WebSocket>;
  close(): Promise<void>;
}

const createRpcHarness = (config: ServerConfig): RpcHarness => {
  const handlerSet = createServerHandlerSet(config);
  const httpServer = createHttpServer();
  const wsUpgrade = handlerSet.upgradeHandlers.ws;
  if (!wsUpgrade) {
    handlerSet.close();
    throw new Error('ws upgrade handler not composed');
  }
  httpServer.on('upgrade', wsUpgrade);
  handlerSet.wsHandle.maxInstances = 0;

  const openSockets = new Set<WebSocket>();

  return {
    async connect() {
      const ws = await connectWs(httpServer, 'test-realm');
      openSockets.add(ws);
      ws.once('close', () => openSockets.delete(ws));
      return ws;
    },
    async close() {
      for (const ws of [...openSockets]) {
        await closeWs(ws);
      }
      openSockets.clear();
      handlerSet.close();
      httpServer.removeAllListeners();
    },
  };
};

const openDbs: Database.Database[] = [];
const openHarnesses: RpcHarness[] = [];

afterEach(async () => {
  for (const harness of openHarnesses.splice(0)) {
    await harness.close();
  }
  for (const db of openDbs.splice(0).reverse()) {
    db.close();
  }
});

const makeDeps = (overrides: Partial<HostnameRpcDeps> = {}): HostnameRpcDeps => {
  const db = new Database(':memory:');
  openDbs.push(db);
  let nextId = 0;
  return {
    store: createHostnameRegistryStore(db, {
      now: () => NOW + nextId,
      newId: () => `host-${++nextId}`,
    }),
    serverIdentityId: 'server-1',
    ...overrides,
  };
};

describe('D-152 collection.hostname.* handlers', () => {
  it('performs CRUD over safe projections and drives ownership proof into SNI binding', async () => {
    const deps = makeDeps();

    const added = await handleHostnameAdd(
      deps,
      {
        hostname: 'App.Example',
        cert_source: 'byo_uploaded',
        cert_blob_id: 'blob-secret',
        cert_fingerprint: 'fp-app',
        verification_method: 'cert_proof',
        verification_token_hash: 'sha256:not-returned',
        listener_ports: [443, 8448],
      },
      CALLER,
    );
    expect(added.hostname).toMatchObject({
      hostname: 'app.example',
      cert_source: 'byo_uploaded',
      cert_fingerprint: 'fp-app',
      ownership_status: 'pending',
      enabled: false,
      listener_ports: [443, 8448],
    });
    expect(added.hostname).not.toHaveProperty('cert_blob_id');
    expect(added.hostname).not.toHaveProperty('verification_token_hash');
    expect(added.hostname).not.toHaveProperty('private_key_pem');

    await handleHostnameUpdate(
      deps,
      { hostname: 'app.example', enabled: true },
      CALLER,
    );
    expect(createHostnameSniBindingLookup(deps.store)('app.example')).toBeNull();

    const proof = await handleHostnameVerifyOwnership(
      deps,
      {
        hostname: 'app.example',
        method: 'cert_proof',
        cert_matches_hostname: true,
      },
      CALLER,
    );
    expect(proof).toMatchObject({
      ok: true,
      hostname: 'app.example',
      status: 'verified',
    });
    expect(createHostnameSniBindingLookup(deps.store)('APP.EXAMPLE')).toEqual({
      hostname: 'app.example',
      cert_source: 'byo_uploaded',
      tls_topology: 'server_terminated',
    });

    await handleHostnameAdd(
      deps,
      { hostname: 'proxy.example', cert_source: 'byo_external' },
      CALLER,
    );
    expect(await handleHostnameList(deps, undefined, CALLER)).toMatchObject({
      hostnames: [
        { hostname: 'app.example' },
        { hostname: 'proxy.example' },
      ],
    });
    expect(await handleHostnameGet(deps, { hostname: 'app.example' }, CALLER))
      .toMatchObject({ hostname: { hostname: 'app.example' } });

    expect(await handleHostnameRemove(deps, { hostname: 'proxy.example' }, CALLER))
      .toEqual({ removed: true });
    expect(await handleHostnameRemove(deps, { hostname: 'proxy.example' }, CALLER))
      .toEqual({ removed: false });
  });

  it('resets BYO ownership when proof configuration changes through update', async () => {
    const deps = makeDeps();
    await handleHostnameAdd(
      deps,
      {
        hostname: 'ready.example',
        cert_source: 'byo_uploaded',
        ownership_status: 'verified',
        verification_method: 'cert_proof',
        enabled: true,
      },
      CALLER,
    );
    expect(createHostnameSniBindingLookup(deps.store)('ready.example')).toMatchObject({
      hostname: 'ready.example',
    });

    const updated = await handleHostnameUpdate(
      deps,
      {
        hostname: 'ready.example',
        verification_method: 'dns_txt',
        verification_token_hash: 'sha256:new-proof',
      },
      CALLER,
    );

    expect(updated.hostname).toMatchObject({
      hostname: 'ready.example',
      ownership_status: 'pending',
      verification_method: 'dns_txt',
      enabled: true,
    });
    expect(createHostnameSniBindingLookup(deps.store)('ready.example')).toBeNull();
  });

  /** ⛔ A row that ALREADY EXISTS was registered by the `pro-cert-enrollment`
   *  background service, which orders its certificate on its own cadence and
   *  retries on its own backoff. Issuing here as well means two racing attempts
   *  for one hostname — and CAs rate-limit FAILED validations (LE: 5 per
   *  account per hostname per hour), so a racing pair can exhaust the limit and
   *  block both. Observed live in a single run. */
  it('DEFERS issuance when the row already exists — the enrollment service owns it', async () => {
    const issueInitialDomain = vi.fn(async () => ({
      ok: true as const,
      new_fingerprint: 'should-not-be-used',
      cert_expires_at: NOW + 1,
    }));
    const deps = makeDeps({ initialAcmeIssuer: () => ({ issueInitialDomain }) });

    // Stand in for the background service having registered it already.
    deps.store.upsert({
      server_identity_id: 'srv-1',
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      ownership_status: 'verified',
      ddns_managed: true,
      enabled: true,
    });

    const added = await handleHostnameAdd(
      deps,
      { hostname: 'Alice.Recued.Net', cert_source: 'recued_acme', enabled: true },
      CALLER,
    );

    expect(issueInitialDomain).not.toHaveBeenCalled();
    // Returning the row is the honest answer, not a silent no-op: no
    // `cert_fingerprint` IS the pending state the UI renders.
    expect(added.hostname).toMatchObject({ hostname: 'alice.recued.net' });
    expect(added.hostname.cert_fingerprint).toBeUndefined();
  });

  it('issues the first cert for a verified recued_acme hostname and mirrors cert metadata', async () => {
    const issueInitialDomain = vi.fn(async () => ({
      ok: true as const,
      new_fingerprint: 'fresh-fp',
      cert_expires_at: NOW + 90 * 24 * 60 * 60 * 1000,
    }));
    const deps = makeDeps({
      initialAcmeIssuer: () => ({ issueInitialDomain }),
    });

    const added = await handleHostnameAdd(
      deps,
      {
        hostname: 'Alice.Recued.Net',
        cert_source: 'recued_acme',
        enabled: true,
      },
      CALLER,
    );

    expect(issueInitialDomain).toHaveBeenCalledTimes(1);
    expect(issueInitialDomain).toHaveBeenCalledWith({
      domain: 'alice.recued.net',
    });
    expect(added.hostname).toMatchObject({
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      ownership_status: 'verified',
      cert_fingerprint: 'fresh-fp',
      cert_expires_at: NOW + 90 * 24 * 60 * 60 * 1000,
    });
    expect(deps.store.get('alice.recued.net')).toMatchObject({
      cert_fingerprint: 'fresh-fp',
      cert_expires_at: NOW + 90 * 24 * 60 * 60 * 1000,
    });
  });
});

describe('D-152 collection.hostname.* WS wiring', () => {
  it('reaches the hostname store through createServerHandlerSet and ws-server dispatch', async () => {
    const deps = makeDeps();
    const harness = createRpcHarness({
      hostnameDeps: deps,
    });
    openHarnesses.push(harness);
    const ws = await harness.connect();
    await registerWs(ws);

    expect(await callRpc(ws, 'collection.hostname.add', {
      hostname: 'token.example',
      cert_source: 'byo_external',
      verification_method: 'http_token',
      verification_token_hash: 'sha256:expected',
      enabled: true,
    })).toMatchObject({
      ok: true,
      result: {
        hostname: {
          hostname: 'token.example',
          ownership_status: 'pending',
          tls_topology: 'upstream_terminated',
        },
      },
    });

    expect(await callRpc(ws, 'collection.hostname.verifyOwnership', {
      hostname: 'token.example',
      method: 'http_token',
      observed_token_hash: 'sha256:expected',
    })).toMatchObject({
      ok: true,
      result: {
        ok: true,
        hostname: 'token.example',
        status: 'verified',
      },
    });
    expect(deps.store.get('token.example')).toMatchObject({
      ownership_status: 'verified',
      verification_token_hash: 'sha256:expected',
    });
  });

  it('returns not_configured when the hostname deps are not wired', async () => {
    const harness = createRpcHarness({});
    openHarnesses.push(harness);
    const ws = await harness.connect();
    await registerWs(ws);

    expect(await callRpc(ws, 'collection.hostname.list', {})).toMatchObject({
      ok: false,
      error: { code: 'not_configured' },
    });
  });
});
