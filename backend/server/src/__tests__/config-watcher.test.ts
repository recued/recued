import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createConfigWatcher,
  type ConfigWatcher,
  type ConfigWatcherDeps,
  type ReloadInfo,
} from '../lifecycle/config-watcher.js';
import {
  createLifecycleStateStore,
  type LifecycleStateStore,
} from '../lifecycle/lifecycle-state.js';
import {
  createRuntimeConfigStore,
  type BootstrapConfig,
  type LoadedConfig,
  type RuntimeConfig,
  type RuntimeConfigStore,
} from '@recued/config';

const BASELINE_BOOTSTRAP: BootstrapConfig = {
  data_path: '/var/lib/recued',
  bind_host: '127.0.0.1',
  bind_port: 7717,
  mcp_port: 7718,
  webhook_port: 0,
  log_path: '/var/log/recued',
};

const BASELINE_RUNTIME: RuntimeConfig = {
  'llm.free_pool_strategy': 'round_robin',
  'cache.max_bytes': 209_715_200,
  'lifecycle.drain_timeout_s': 30,
};

interface Harness {
  db: Database.Database;
  lifecycleStore: LifecycleStateStore;
  runtimeStore: RuntimeConfigStore;
  setMockLoad: (loaded: LoadedConfig) => void;
  createWatcher: (overrides?: Partial<ConfigWatcherDeps>) => ConfigWatcher;
  reloadInfos: ReloadInfo[];
}

const newHarness = (): Harness => {
  const db = new Database(':memory:');
  const lifecycleStore = createLifecycleStateStore(db);
  const runtimeStore = createRuntimeConfigStore({ ...BASELINE_RUNTIME });
  let mockLoaded: LoadedConfig = {
    bootstrap: { ...BASELINE_BOOTSTRAP },
    runtime: { ...BASELINE_RUNTIME },
    source: '/etc/recued/config.toml',
    distribution: 'server',
  };
  const reloadInfos: ReloadInfo[] = [];
  return {
    db,
    lifecycleStore,
    runtimeStore,
    setMockLoad(loaded) {
      mockLoaded = loaded;
    },
    reloadInfos,
    createWatcher(overrides = {}) {
      return createConfigWatcher({
        configPath: '/etc/recued/config.toml',
        distribution: 'server',
        initialBootstrap: { ...BASELINE_BOOTSTRAP },
        initialRuntime: { ...BASELINE_RUNTIME },
        runtimeStore,
        lifecycleStore,
        log: () => { /* silent */ },
        load: async () => mockLoaded,
        onReloaded: (info) => { reloadInfos.push(info); },
        ...overrides,
      });
    },
  };
};

describe('ConfigWatcher.reload — runtime-only deltas', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('applies changed runtime keys to the runtime store', async () => {
    h.setMockLoad({
      bootstrap: { ...BASELINE_BOOTSTRAP },
      runtime: { ...BASELINE_RUNTIME, 'cache.max_bytes': 500_000_000 },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    const info = await watcher.reload('SIGHUP');
    expect(info.runtime_changed).toEqual(['cache.max_bytes']);
    expect(info.bootstrap_changed).toEqual([]);
    expect(info.restart_required).toBe(false);
    expect(h.runtimeStore.get('cache.max_bytes')).toBe(500_000_000);
  });

  it('applies public_port changes through the runtime store', async () => {
    h.setMockLoad({
      bootstrap: { ...BASELINE_BOOTSTRAP },
      runtime: { ...BASELINE_RUNTIME, public_port: 8443 },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    const info = await watcher.reload('SIGHUP');
    expect(info.runtime_changed).toEqual(['public_port']);
    expect(h.runtimeStore.get('public_port')).toBe(8443);
  });

  it('does not touch restart_pending on runtime-only changes', async () => {
    h.setMockLoad({
      bootstrap: { ...BASELINE_BOOTSTRAP },
      runtime: { ...BASELINE_RUNTIME, 'lifecycle.drain_timeout_s': 60 },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    await watcher.reload('SIGHUP');
    expect(h.lifecycleStore.getRestartPending()).toBe(false);
  });

  it('skips keys rejected by the runtime schema without failing the reload', async () => {
    h.setMockLoad({
      bootstrap: { ...BASELINE_BOOTSTRAP },
      runtime: {
        ...BASELINE_RUNTIME,
        // Known schema key with an invalid value (wrong type) — runtimeStore.set throws.
        'cache.max_bytes': 'not-a-number' as unknown as number,
      },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    const info = await watcher.reload('SIGHUP');
    expect(info.runtime_changed).not.toContain('cache.max_bytes');
  });
});

describe('ConfigWatcher.reload — bootstrap-only deltas', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('marks restart_pending=true when bootstrap changes', async () => {
    h.setMockLoad({
      bootstrap: { ...BASELINE_BOOTSTRAP, bind_port: 8080 },
      runtime: { ...BASELINE_RUNTIME },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    const info = await watcher.reload('SIGHUP');
    expect(info.bootstrap_changed).toEqual(['bind_port']);
    expect(info.restart_required).toBe(true);
    expect(h.lifecycleStore.getRestartPending()).toBe(true);
  });

  it('lists every bootstrap key that changed', async () => {
    h.setMockLoad({
      bootstrap: {
        ...BASELINE_BOOTSTRAP,
        bind_port: 8080,
        bind_host: '0.0.0.0',
        mcp_port: 0,
      },
      runtime: { ...BASELINE_RUNTIME },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    const info = await watcher.reload('SIGHUP');
    expect(info.bootstrap_changed.sort()).toEqual(['bind_host', 'bind_port', 'mcp_port']);
  });

  it('does NOT apply bootstrap changes live — only runtime_changed is applied', async () => {
    h.setMockLoad({
      bootstrap: { ...BASELINE_BOOTSTRAP, bind_port: 8080 },
      runtime: { ...BASELINE_RUNTIME, 'cache.max_bytes': 500_000_000 },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    const info = await watcher.reload('SIGHUP');
    expect(info.runtime_changed).toEqual(['cache.max_bytes']);
    expect(info.bootstrap_changed).toEqual(['bind_port']);
    // Runtime store reflects the new value; bootstrap is queued for restart.
    expect(h.runtimeStore.get('cache.max_bytes')).toBe(500_000_000);
  });
});

describe('ConfigWatcher.reload — combined + edge cases', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('reports no changes on an identical reload (idempotent)', async () => {
    const watcher = h.createWatcher();
    const info = await watcher.reload('SIGHUP');
    expect(info.runtime_changed).toEqual([]);
    expect(info.bootstrap_changed).toEqual([]);
    expect(info.restart_required).toBe(false);
  });

  it('calls onReloaded with the info object', async () => {
    h.setMockLoad({
      bootstrap: { ...BASELINE_BOOTSTRAP },
      runtime: { ...BASELINE_RUNTIME, 'cache.max_bytes': 500_000_000 },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    await watcher.reload('SIGHUP');
    expect(h.reloadInfos).toHaveLength(1);
    expect(h.reloadInfos[0].runtime_changed).toEqual(['cache.max_bytes']);
  });

  it('no-ops when configPath is null', async () => {
    const watcher = h.createWatcher({ configPath: null });
    const info = await watcher.reload('SIGHUP');
    expect(info.runtime_changed).toEqual([]);
    expect(info.bootstrap_changed).toEqual([]);
  });

  it('reload returns safely when load throws', async () => {
    const watcher = h.createWatcher({
      load: async () => { throw new Error('disk gone'); },
    });
    const info = await watcher.reload('SIGHUP');
    expect(info.runtime_changed).toEqual([]);
    expect(info.bootstrap_changed).toEqual([]);
    expect(info.restart_required).toBe(false);
  });

  it('consecutive reloads only report new deltas', async () => {
    h.setMockLoad({
      bootstrap: { ...BASELINE_BOOTSTRAP },
      runtime: { ...BASELINE_RUNTIME, 'cache.max_bytes': 500_000_000 },
      source: '/etc/recued/config.toml',
      distribution: 'server',
    });
    const watcher = h.createWatcher();
    const first = await watcher.reload('SIGHUP');
    expect(first.runtime_changed).toEqual(['cache.max_bytes']);
    const second = await watcher.reload('SIGHUP');
    expect(second.runtime_changed).toEqual([]); // already applied
  });
});

describe('ConfigWatcher.start / stop (fs.watch)', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.db.close(); });

  it('does not start when watchFile is false', () => {
    const calls: string[] = [];
    const watcher = h.createWatcher({
      watchFile: false,
      watchImpl: () => {
        calls.push('start');
        return { close: () => {} };
      },
    });
    watcher.start();
    expect(calls).toEqual([]);
    expect(watcher.watching).toBe(false);
  });

  it('starts and debounces fs.watch triggers', async () => {
    let triggerCallback: () => void = () => {};
    const reloadCalls: string[] = [];
    const watcher = h.createWatcher({
      watchFile: true,
      fsWatchDebounceMs: 30,
      watchImpl: (_path, cb) => {
        triggerCallback = cb;
        return { close: () => {} };
      },
      onReloaded: (info) => { reloadCalls.push(info.reason); },
    });
    watcher.start();
    expect(watcher.watching).toBe(true);

    // Three rapid triggers should coalesce into one reload.
    triggerCallback();
    triggerCallback();
    triggerCallback();
    await new Promise((r) => setTimeout(r, 80));
    expect(reloadCalls).toEqual(['fs.watch']);
  });

  it('stop() releases the watcher handle + clears pending debounce', () => {
    let closed = false;
    const watcher = h.createWatcher({
      watchFile: true,
      watchImpl: () => ({ close: () => { closed = true; } }),
    });
    watcher.start();
    watcher.stop();
    expect(closed).toBe(true);
    expect(watcher.watching).toBe(false);
  });
});
