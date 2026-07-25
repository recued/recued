/** D-167 P5 Slice 2b - server RPC deps forwarding regression.
 *
 * Covers the dep families that composeListeners could pass but
 * createServerHandlerSet previously dropped before createWebSocketUpgrade:
 * notificationsDeps, engagementHealthDeps, packInstallDeps,
 * packListDeps, and packUninstallDeps.
 *
 * Also covers the later D-170 ingredient.* dep seam: install authoring deps
 * plus draft/preview deps must survive createServerHandlerSet and reach the
 * WS attach options.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  BULK_INSTALL_PACK_VERSION,
  BULK_PACK_INSTALL_PERMISSION,
  type BulkPackManifest,
  type RecipeDefinition,
} from '@recued/contracts';
import type { NotificationBlock } from '@recued/notification';

import {
  createServerHandlerSet,
  type ServerConfig,
} from '../index.js';
import { composeEngagementHealthRpcDeps } from '../composition/bin/wire-engagement-health-rpc-deps.js';
import { composeNotificationsRpcDeps } from '../composition/bin/wire-notifications-rpc-deps.js';
import { composePackInstallRpcDeps } from '../composition/bin/wire-pack-install-rpc-deps.js';
import { composePackListRpcDeps } from '../composition/bin/wire-pack-list-rpc-deps.js';
import { composePackUninstallRpcDeps } from '../composition/bin/wire-pack-uninstall-rpc-deps.js';
import { createHousekeepingStateStore } from '../housekeeping/state-store.js';
import type { IngredientDraftRpcDeps } from '../ingredient-authoring/draft-preview-rpc.js';
import type { IngredientAuthoringRpcDeps } from '../ingredient-authoring/install-rpc.js';
import { createRecipeStore } from '../recipe-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createEngagementCapabilityStore } from '../storage/engagement-capability-store.js';
import { createEngagementRateControlStore } from '../storage/engagement-rate-control-store.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';

const NOW = 1_714_867_200_000;
const PACK_SLUG = 'd-167-forward-pack';
const RECIPE_ID = 'd-167-forward-recipe';

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

const must = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) {
    throw new Error(`${label} was not composed`);
  }
  return value;
};

const recipeDef = (recipeId: string): RecipeDefinition => ({
  recipe_id: recipeId,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipeId,
    description: 'D-167 RPC deps forward fixture',
    author: 'recued-core',
    supported_platforms: [],
    tags: [],
  },
  steps: [],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const baseManifest = (): BulkPackManifest => ({
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: PACK_SLUG,
  publisher: 'recued-core',
  name: 'D-167 forward pack',
  description: 'D-167 RPC deps forward fixture',
  version: 1,
  recipes: [{ slug: RECIPE_ID, version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: [],
});

const emptyDraftStore = (): IngredientDraftRpcDeps['draftStore'] => ({
  save: () => ({ error: 'limit_reached' }),
  get: () => null,
  list: () => [],
  delete: () => false,
  count: () => 0,
});

describe('createServerHandlerSet rpc-deps forwarding', () => {
  let db: Database.Database | undefined;
  let enrichmentStore: EnrichmentStore | undefined;
  let recipeDir: string | undefined;
  let packDir: string | undefined;
  let harness: RpcHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    enrichmentStore?.close();
    enrichmentStore = undefined;
    db?.close();
    db = undefined;
    if (recipeDir) {
      rmSync(recipeDir, { recursive: true, force: true });
      recipeDir = undefined;
    }
    if (packDir) {
      rmSync(packDir, { recursive: true, force: true });
      packDir = undefined;
    }
  });

  it('dispatches all remaining formerly dropped families when deps are wired', async () => {
    db = new Database(':memory:');
    recipeDir = mkdtempSync(join(tmpdir(), 'recued-d167-forward-recipes-'));
    packDir = mkdtempSync(join(tmpdir(), 'recued-d167-forward-packs-'));
    writeFileSync(join(recipeDir, `${RECIPE_ID}.json`), JSON.stringify(recipeDef(RECIPE_ID)));
    const manifest = baseManifest();
    writeFileSync(join(packDir, `${PACK_SLUG}.json`), JSON.stringify(manifest));

    const recipeStore = createRecipeStore(recipeDir, db);

    // Both block calls `handleNotificationsDescribe` makes. The settings
    // read arrived with D-163 R31 slice 2 (75856813b) — `describe` is the
    // only read path for the anti-phishing verification phrase, so it now
    // reads the settings record alongside the channel matrix. A stub with
    // only the matrix method throws, and this suite's subject (do the
    // deps SURVIVE createServerHandlerSet?) is masked by the TypeError.
    const notificationBlock = {
      describeNotificationChannels: async () => [],
      getNotificationSettings: async () => ({ ui: true, bridge: false }),
    } as unknown as NotificationBlock;

    const engagementBundle = composeEngagementHealthRpcDeps({
      connectionStore: createConnectionStore(db),
      housekeepingState: createHousekeepingStateStore(db),
      rateControlStore: createEngagementRateControlStore(db),
      capabilityStore: createEngagementCapabilityStore(db),
      getApiConnectionLookup: () => async () => null,
      getRefreshAuth: () => async (connection) => connection.auth,
      getRegisterSalesforceCallEntity: () => undefined,
    });

    const config: ServerConfig = {
      notificationsDeps: must(
        composeNotificationsRpcDeps({ block: notificationBlock }).notificationsDeps,
        'notificationsDeps',
      ),
      engagementHealthDeps: must(
        engagementBundle.engagementHealthDeps,
        'engagementHealthDeps',
      ),
      packInstallDeps: must(
        composePackInstallRpcDeps({
          recipeStore,
          now: () => NOW,
        }).packInstallDeps,
        'packInstallDeps',
      ),
      packListDeps: must(
        composePackListRpcDeps({ recipeStore, packDir }).packListDeps,
        'packListDeps',
      ),
      packUninstallDeps: must(
        composePackUninstallRpcDeps({
          recipeStore,
          packDir,
        }).packUninstallDeps,
        'packUninstallDeps',
      ),
    };
    harness = createRpcHarness(config);
    const ws = await harness.connect();

    expect(await callRpc(ws, 'notifications.describe', {})).toMatchObject({
      ok: true,
      result: { rows: [] },
    });

    expect(await callRpc(ws, 'collection.connection.engagementHealth', {
      name: 'missing-connection',
    })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });

    expect(await callRpc(ws, 'packs.list', {})).toMatchObject({
      ok: true,
      result: {
        packs: [
          expect.objectContaining({
            slug: PACK_SLUG,
            installed: false,
            recipe_count: 1,
          }),
        ],
      },
    });

    expect(await callRpc(ws, 'packs.install', {
      manifest,
      granted_permissions: [BULK_PACK_INSTALL_PERMISSION],
    })).toMatchObject({
      ok: true,
      result: {
        result: {
          ok: true,
          installed: [
            expect.objectContaining({
              slug: RECIPE_ID,
            }),
          ],
        },
      },
    });

    expect(await callRpc(ws, 'packs.uninstall', {
      pack_slug: PACK_SLUG,
    })).toMatchObject({
      ok: true,
      result: {
        result: {
          ok: true,
          removed: {
            recipes: [RECIPE_ID],
            body_grants: [],
          },
        },
      },
    });
  });

  it('dispatches ingredient install, draft, decompose, and preview when deps are wired', async () => {
    const config: ServerConfig = {
      ingredientAuthoringDeps: {} as IngredientAuthoringRpcDeps,
      ingredientDraftDeps: {
        draftStore: emptyDraftStore(),
      },
    };
    harness = createRpcHarness(config);
    const ws = await harness.connect();

    expect(await callRpc(ws, 'ingredient.install', {})).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });

    expect(await callRpc(ws, 'ingredient.draft.list', {})).toMatchObject({
      ok: true,
      result: { ok: true, drafts: [] },
    });

    expect(await callRpc(ws, 'ingredient.compose.decompose', {})).toMatchObject({
      ok: true,
      result: { ok: false, code: 'bad_request' },
    });

    expect(await callRpc(ws, 'ingredient.preview', {})).toMatchObject({
      ok: true,
      result: { ok: false, code: 'bad_request' },
    });
  });
});
