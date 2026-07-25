/** Phase G (D-109) — pill runtime integration tests.
 *  D-121 Phase 3 — refactored to drive the integration through mock
 *  `StorageAdapter` / `RpcAdapter` / `TabAdapter` instances rather
 *  than `globalThis.chrome`. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerHeartbeatSnapshot } from '@recued/contracts';
import {
  integrateServerPill,
  openOptionsAtServerHome,
  PILL_DEEP_LINK_HASH,
  readCachedServerSnapshot,
  SERVER_HEARTBEAT_BROADCAST_KIND,
} from '../integrate.js';
import type {
  RpcAdapter,
  StorageAdapter,
  TabAdapter,
} from '../../runtime/adapters.js';

const TEST_STORAGE_KEY = 'recued.server-heartbeat';

const makeFakeHost = () => {
  let html = '';
  let listener: ((evt: Event) => void) | null = null;
  const host = {
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      if (evt === 'click') listener = fn;
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      if (evt === 'click' && listener === fn) listener = null;
    },
  } as unknown as HTMLElement;
  return { host, getHtml: () => html };
};

const snap = (
  over: Partial<ServerHeartbeatSnapshot> = {},
): ServerHeartbeatSnapshot => ({
  server_id: 'srv-1',
  last_seen_at: Date.now(),
  lifecycle_state: 'running',
  uptime_s: 3600,
  supervisor_mode: 'systemd',
  pressure_details: { worst_state: 'running', per_surface: [] },
  collections: [],
  ...over,
});

interface MockAdapters {
  storage: StorageAdapter;
  rpc: RpcAdapter;
  tab: TabAdapter;
  /** Expose the rpc subscriber list so tests can fire broadcasts. */
  listeners: ((message: unknown) => void)[];
  /** Spy on tab adapter calls. */
  openOptionsPageMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  sendMock: ReturnType<typeof vi.fn<(message: unknown) => Promise<void>>>;
  openUrlMock: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
}

const makeMockAdapters = (
  initialSnapshot: ServerHeartbeatSnapshot | null = null,
  overrides: Partial<{ openOptionsPage: () => Promise<void> }> = {},
): MockAdapters => {
  const data: Record<string, unknown> = initialSnapshot
    ? { [TEST_STORAGE_KEY]: initialSnapshot }
    : {};
  const listeners: ((message: unknown) => void)[] = [];
  const openOptionsPageMock = vi.fn<() => Promise<void>>(
    overrides.openOptionsPage ?? (async () => {}),
  );
  const sendMock = vi.fn<(message: unknown) => Promise<void>>(
    async (_message: unknown) => {},
  );
  const openUrlMock = vi.fn<(url: string) => Promise<void>>(
    async (_url: string) => {},
  );

  const storage: StorageAdapter = {
    get: async <T>(key: string) =>
      (data[key] as T | undefined) ?? null,
    set: async (key, value) => {
      data[key] = value;
    },
    remove: async (key) => {
      delete data[key];
    },
  };
  const rpc: RpcAdapter = {
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    send: sendMock,
  };
  const tab: TabAdapter = {
    openOptionsPage: openOptionsPageMock,
    openUrl: openUrlMock,
  };
  return { storage, rpc, tab, listeners, openOptionsPageMock, sendMock, openUrlMock };
};

describe('readCachedServerSnapshot', () => {
  it('returns the stored snapshot when present', async () => {
    const s = snap();
    const adapters = makeMockAdapters(s);
    expect(
      await readCachedServerSnapshot(adapters.storage, TEST_STORAGE_KEY),
    ).toEqual(s);
  });

  it('returns null when the key is absent', async () => {
    const adapters = makeMockAdapters(null);
    expect(
      await readCachedServerSnapshot(adapters.storage, TEST_STORAGE_KEY),
    ).toBeNull();
  });

  it('returns null when the storage adapter resolves null', async () => {
    const storage: StorageAdapter = {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    };
    expect(
      await readCachedServerSnapshot(storage, TEST_STORAGE_KEY),
    ).toBeNull();
  });
});

describe('openOptionsAtServerHome', () => {
  it('calls openOptionsPage + sends navigate message', async () => {
    const adapters = makeMockAdapters();
    openOptionsAtServerHome(adapters.tab, adapters.rpc, 'https://fallback.example/');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(adapters.openOptionsPageMock).toHaveBeenCalled();
    expect(adapters.sendMock).toHaveBeenCalledWith({
      kind: 'options:navigate',
      hash: PILL_DEEP_LINK_HASH,
    });
  });

  it('falls back to openUrl when openOptionsPage is missing', async () => {
    const adapters = makeMockAdapters();
    const tabWithoutOptions: TabAdapter = {
      openUrl: (url) => adapters.openUrlMock(url),
    };
    openOptionsAtServerHome(tabWithoutOptions, adapters.rpc, 'https://deep.example/');
    expect(adapters.openUrlMock).toHaveBeenCalledWith('https://deep.example/');
  });

  it('falls back to openUrl when openOptionsPage rejects', async () => {
    const adapters = makeMockAdapters(null, {
      openOptionsPage: async () => {
        throw new Error('no options page');
      },
    });
    openOptionsAtServerHome(adapters.tab, adapters.rpc, 'https://fallback.example/');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(adapters.openUrlMock).toHaveBeenCalledWith('https://fallback.example/');
  });
});

describe('integrateServerPill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds snapshot from the storage adapter', async () => {
    const s = snap({ server_id: 'from-storage' });
    const adapters = makeMockAdapters(s);
    const { host, getHtml } = makeFakeHost();
    const handle = integrateServerPill({
      host,
      storage: adapters.storage,
      rpc: adapters.rpc,
      storageKey: TEST_STORAGE_KEY,
    });
    expect(getHtml()).toBe('');
    await new Promise((r) => setImmediate(r));
    expect(getHtml()).toContain('server-pill');
    expect(handle.snapshot()?.server_id).toBe('from-storage');
    handle.dispose();
  });

  it('re-renders on matching broadcasts via the rpc adapter', async () => {
    const adapters = makeMockAdapters();
    const { host, getHtml } = makeFakeHost();
    const handle = integrateServerPill({
      host,
      storage: adapters.storage,
      rpc: adapters.rpc,
      storageKey: TEST_STORAGE_KEY,
    });
    await new Promise((r) => setImmediate(r));
    adapters.listeners[0]!({
      kind: SERVER_HEARTBEAT_BROADCAST_KIND,
      snapshot: snap({ lifecycle_state: 'draining' }),
    });
    expect(getHtml()).toContain('server-pill--orange');
    expect(handle.snapshot()?.lifecycle_state).toBe('draining');
    handle.dispose();
  });

  it('ignores non-matching broadcasts', async () => {
    const adapters = makeMockAdapters();
    const { host, getHtml } = makeFakeHost();
    const handle = integrateServerPill({
      host,
      storage: adapters.storage,
      rpc: adapters.rpc,
      storageKey: TEST_STORAGE_KEY,
    });
    await new Promise((r) => setImmediate(r));
    adapters.listeners[0]!({ kind: 'something-else' });
    expect(getHtml()).toBe('');
    handle.dispose();
  });

  it('dispose removes the rpc subscription', async () => {
    const adapters = makeMockAdapters();
    const { host } = makeFakeHost();
    const handle = integrateServerPill({
      host,
      storage: adapters.storage,
      rpc: adapters.rpc,
      storageKey: TEST_STORAGE_KEY,
    });
    expect(adapters.listeners).toHaveLength(1);
    handle.dispose();
    expect(adapters.listeners).toHaveLength(0);
  });

  it('supports dependency-injected getSnapshot', () => {
    const adapters = makeMockAdapters();
    const { host, getHtml } = makeFakeHost();
    const handle = integrateServerPill({
      host,
      storage: adapters.storage,
      rpc: adapters.rpc,
      storageKey: TEST_STORAGE_KEY,
      getSnapshot: () => snap({ server_name: 'Injected' }),
    });
    expect(getHtml()).toContain('server-pill');
    handle.dispose();
  });
});
