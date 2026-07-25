import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CacheEntry,
  CacheStore,
  PeerCacheTransport,
} from '@recued/cache';
import type { ServerExecutorConfig } from '../server-executor.js';
import type { WsServerHandle } from '../ws-server.js';

const cacheMocks = vi.hoisted(() => ({
  wrapStoreWithPeer: vi.fn(),
}));

vi.mock('@recued/cache', () => ({
  wrapStoreWithPeer: cacheMocks.wrapStoreWithPeer,
}));

import { wrapServePeerCache } from '../serve/wrap-peer-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const wrapPeerCachePath = join(repoRoot, 'backend/server/src/serve/wrap-peer-cache.ts');
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const makeCacheStore = (): CacheStore =>
  ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    deleteByRecipe: vi.fn(),
    size: vi.fn(async () => 0),
    evictLRU: vi.fn(),
    clear: vi.fn(),
  }) as unknown as CacheStore;

const makeEntry = (key = 'cache-key'): CacheEntry =>
  ({
    key,
    recipe_id: 'recipe',
    ingredient_slug: 'ingredient',
    input_hash: 'input',
    value: { ok: true },
    created_at: 1,
    last_accessed_at: 1,
    expires_at: 2,
    size_bytes: 10,
  }) as unknown as CacheEntry;

const makeWsServer = (
  overrides: Partial<WsServerHandle> = {},
): WsServerHandle =>
  ({
    clientCount: vi.fn(() => 1),
    peerCacheGet: vi.fn(async () => null),
    peerCachePut: vi.fn(),
    ...overrides,
  }) as unknown as WsServerHandle;

const makeExecutorConfig = (
  cacheStore: CacheStore | undefined = undefined,
): Pick<ServerExecutorConfig, 'cacheStore'> =>
  ({ cacheStore }) as Pick<ServerExecutorConfig, 'cacheStore'>;

const capturedTransport = (): PeerCacheTransport => {
  const call = cacheMocks.wrapStoreWithPeer.mock.calls[0];
  if (!call) throw new Error('wrapStoreWithPeer was not called');
  return call[1].transport as PeerCacheTransport;
};

beforeEach(() => {
  cacheMocks.wrapStoreWithPeer.mockReset();
});

describe('wrapServePeerCache', () => {
  it('does not wrap when the cache store is absent', () => {
    const existingStore = makeCacheStore();
    const executorConfig = makeExecutorConfig(existingStore);

    wrapServePeerCache({
      cacheStore: undefined,
      wsServer: makeWsServer(),
      executorConfig,
    });

    expect(cacheMocks.wrapStoreWithPeer).not.toHaveBeenCalled();
    expect(executorConfig.cacheStore).toBe(existingStore);
  });

  it('does not wrap when the WebSocket handle is absent', () => {
    const cacheStore = makeCacheStore();
    const executorConfig = makeExecutorConfig(cacheStore);

    wrapServePeerCache({
      cacheStore,
      wsServer: undefined,
      executorConfig,
    });

    expect(cacheMocks.wrapStoreWithPeer).not.toHaveBeenCalled();
    expect(executorConfig.cacheStore).toBe(cacheStore);
  });

  it('wraps the cache store and publishes it onto executor config', () => {
    const cacheStore = makeCacheStore();
    const wrappedStore = makeCacheStore();
    const wsServer = makeWsServer();
    const executorConfig = makeExecutorConfig(cacheStore);
    cacheMocks.wrapStoreWithPeer.mockReturnValue(wrappedStore);

    wrapServePeerCache({ cacheStore, wsServer, executorConfig });

    expect(cacheMocks.wrapStoreWithPeer).toHaveBeenCalledTimes(1);
    expect(cacheMocks.wrapStoreWithPeer).toHaveBeenCalledWith(cacheStore, {
      transport: expect.any(Object),
    });
    expect(executorConfig.cacheStore).toBe(wrappedStore);
  });

  it('wires connected, getEntry, and putEntries through the WebSocket handle', async () => {
    const cacheStore = makeCacheStore();
    const wrappedStore = makeCacheStore();
    const entry = makeEntry();
    const wsServer = makeWsServer({
      clientCount: vi.fn(() => 2),
      peerCacheGet: vi.fn(async () => entry),
      peerCachePut: vi.fn(),
    });
    cacheMocks.wrapStoreWithPeer.mockReturnValue(wrappedStore);

    wrapServePeerCache({
      cacheStore,
      wsServer,
      executorConfig: makeExecutorConfig(cacheStore),
    });
    const transport = capturedTransport();

    expect(transport.connected()).toBe(true);
    await expect(transport.getEntry('cache-key', 50)).resolves.toBe(entry);
    await transport.putEntries([entry]);
    expect(wsServer.clientCount).toHaveBeenCalledTimes(1);
    // The wrapper's peerQueryBudgetMs must reach the wire call — dropping it
    // left peerCacheGet on its 8s default and stalled every cold cache miss
    // 8s-per-step whenever a registered client was connected.
    expect(wsServer.peerCacheGet).toHaveBeenCalledWith('cache-key', 50);
    expect(wsServer.peerCachePut).toHaveBeenCalledWith([entry]);
  });

  it('returns an empty getSince page because server-originated peer sync is push-on-write', async () => {
    const cacheStore = makeCacheStore();
    cacheMocks.wrapStoreWithPeer.mockReturnValue(makeCacheStore());

    wrapServePeerCache({
      cacheStore,
      wsServer: makeWsServer(),
      executorConfig: makeExecutorConfig(cacheStore),
    });

    await expect(capturedTransport().getSince(10, 100)).resolves.toEqual({
      entries: [],
      next_cursor: null,
    });
  });
});

describe('wrap-peer-cache source boundary', () => {
  it('keeps peer-cache wrapping behind post-listener runtime', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/wrap-peer-cache\.js/);
    expect(runtimeSource).toMatch(/wrapServePeerCache\(\{/);
  });

  it('preserves WebSocket publication, peer-cache wrap, and scheduler order', () => {
    const source = readFileSync(startPostListenerRuntimePath, 'utf8');
    const wsPublishIndex = source.indexOf('options.executorConfig.wsServer = options.server.wsServer;');
    const peerCacheIndex = source.indexOf('wrapServePeerCache({');
    const schedulerIndex = source.indexOf('const schedulersBundle = startSchedulers({');

    expect(wsPublishIndex).toBeGreaterThanOrEqual(0);
    expect(peerCacheIndex).toBeGreaterThan(wsPublishIndex);
    expect(schedulerIndex).toBeGreaterThan(peerCacheIndex);
  });

  it('keeps the helper focused on peer-cache wrapping only', () => {
    const source = readFileSync(wrapPeerCachePath, 'utf8');

    expect(source).toMatch(/wrapStoreWithPeer/);
    expect(source).toMatch(/PeerCacheTransport/);
    expect(source).toMatch(/peerCacheGet/);
    expect(source).toMatch(/peerCachePut/);
    expect(source).toMatch(/getSince/);
    expect(source).not.toMatch(/composeCertStackLate|composeSchedulers/);
    expect(source).not.toMatch(/composeHousekeepingScheduler|startServeHousekeepingScheduler/);
    expect(source).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(source).not.toMatch(/logBootBanner|installShutdown/);
    expect(source).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
  });
});
