/** R27 delta-B (server) — DDNS pause/resume: the flag store + the
 *  `ddns.*` handler (cloud-first ordering, owner-gate). */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  createInMemoryDdnsEnabledStore,
  createSqliteDdnsEnabledStore,
} from '../ddns/ddns-enabled-store.js';
import { makeDdnsHandlers } from '../ddns-handler.js';
import {
  createInMemoryHandleStateStore,
  type HandleState,
} from '../handle/index.js';
import type { DdnsPauseResult } from '../ddns/update-client.js';
import type { WsClient } from '../ws-server.js';
import type { DdnsSetEnabledRequest } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// ddns-enabled-store
// ────────────────────────────────────────────────────────────────

describe('ddns-enabled-store (R27 delta-B)', () => {
  it('in-memory: defaults to enabled and setEnabled toggles', () => {
    const store = createInMemoryDdnsEnabledStore();
    expect(store.isEnabled()).toBe(true);
    store.setEnabled(false);
    expect(store.isEnabled()).toBe(false);
    store.setEnabled(true);
    expect(store.isEnabled()).toBe(true);
  });

  it('sqlite: an absent row defaults to enabled; setEnabled persists across instances', () => {
    const db = new Database(':memory:');
    try {
      // A fresh server (no row) publishes — default-enabled.
      expect(createSqliteDdnsEnabledStore(db).isEnabled()).toBe(true);
      createSqliteDdnsEnabledStore(db).setEnabled(false);
      // A new instance over the same db sees the persisted pause.
      expect(createSqliteDdnsEnabledStore(db).isEnabled()).toBe(false);
      createSqliteDdnsEnabledStore(db).setEnabled(true);
      expect(createSqliteDdnsEnabledStore(db).isEnabled()).toBe(true);
    } finally {
      db.close();
    }
  });

  it('sqlite: fails OPEN (enabled) on a corrupt stored value', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`).run(
        'ddns_enabled',
        'not-json',
      );
      // A server should keep publishing rather than silently go dark on corruption.
      expect(createSqliteDdnsEnabledStore(db).isEnabled()).toBe(true);
    } finally {
      db.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// ddns-handler
// ────────────────────────────────────────────────────────────────

const registered = { instance_id: 'inst-1' } as unknown as WsClient;
const unregistered = { instance_id: null } as unknown as WsClient;

const handleState = (
  subscription_state: HandleState['subscription_state'] = 'active',
): HandleState => ({
  publisher_id: 'pub-1',
  current_handle: 'alice',
  handle_history: [],
  subscription_state,
  last_synced_at: 1,
});

const makeDeps = (
  opts: {
    initialEnabled?: boolean;
    handleState?: HandleState;
    pauseResult?: DdnsPauseResult;
  } = {},
) => {
  const enabledStore = createInMemoryDdnsEnabledStore(opts.initialEnabled ?? true);
  const handleStateStore = createInMemoryHandleStateStore(
    opts.handleState ?? handleState(),
  );
  const pause = vi.fn(
    async (): Promise<DdnsPauseResult> =>
      opts.pauseResult ?? { ok: true, data: { handle: 'alice', paused: true, at: 1 } },
  );
  return {
    deps: { enabledStore, handleStateStore, pauseClient: { pause } },
    enabledStore,
    pause,
  };
};

describe('makeDdnsHandlers (R27 delta-B)', () => {
  it('returns undefined when deps are absent (→ not_configured)', () => {
    expect(makeDdnsHandlers(undefined)).toBeUndefined();
  });

  it('ddns.status returns the local enabled flag', async () => {
    const { deps } = makeDeps({ initialEnabled: false });
    const slice = makeDdnsHandlers(deps)!;
    await expect(slice.handlers['ddns.status'](undefined, registered)).resolves.toEqual({
      enabled: false,
    });
  });

  it('ddns.status rejects an unregistered client', async () => {
    const { deps } = makeDeps();
    const slice = makeDdnsHandlers(deps)!;
    await expect(slice.handlers['ddns.status'](undefined, unregistered)).rejects.toThrow(
      /registered/,
    );
  });

  it('setEnabled(false) calls cloud pause (paused:true) THEN flips the flag', async () => {
    const { deps, enabledStore, pause } = makeDeps({ initialEnabled: true });
    const slice = makeDdnsHandlers(deps)!;

    const res = await slice.handlers['ddns.setEnabled']({ enabled: false }, registered);

    expect(res).toEqual({ enabled: false });
    expect(pause).toHaveBeenCalledWith({ publisher_id: 'pub-1', handle: 'alice', paused: true });
    expect(enabledStore.isEnabled()).toBe(false);
  });

  it('setEnabled(true) calls cloud resume (paused:false) THEN flips the flag', async () => {
    const { deps, enabledStore, pause } = makeDeps({ initialEnabled: false });
    const slice = makeDdnsHandlers(deps)!;

    await slice.handlers['ddns.setEnabled']({ enabled: true }, registered);

    expect(pause).toHaveBeenCalledWith({ publisher_id: 'pub-1', handle: 'alice', paused: false });
    expect(enabledStore.isEnabled()).toBe(true);
  });

  it('cloud-first: a cloud failure throws and leaves the local flag UNCHANGED', async () => {
    const { deps, enabledStore } = makeDeps({
      initialEnabled: true,
      pauseResult: { ok: false, error: 'ddns_pause_subscription_lapsed', message: 'nope' },
    });
    const slice = makeDdnsHandlers(deps)!;

    await expect(
      slice.handlers['ddns.setEnabled']({ enabled: false }, registered),
    ).rejects.toThrow(/cloud pause failed/);
    // The flag did NOT flip — local + cloud stay consistent (still publishing).
    expect(enabledStore.isEnabled()).toBe(true);
  });

  it('no live handle (released) → skips the cloud call but still flips the local flag', async () => {
    const { deps, enabledStore, pause } = makeDeps({
      initialEnabled: true,
      handleState: handleState('released'),
    });
    const slice = makeDdnsHandlers(deps)!;

    const res = await slice.handlers['ddns.setEnabled']({ enabled: false }, registered);

    expect(res).toEqual({ enabled: false });
    expect(pause).not.toHaveBeenCalled();
    expect(enabledStore.isEnabled()).toBe(false);
  });

  it('setEnabled rejects a non-boolean `enabled` with NO cloud call + NO local write (split-brain guard)', async () => {
    for (const bad of [{}, { enabled: 0 }, { enabled: 'true' }, null]) {
      const { deps, enabledStore, pause } = makeDeps({ initialEnabled: true });
      const slice = makeDdnsHandlers(deps)!;
      await expect(
        slice.handlers['ddns.setEnabled'](bad as unknown as DdnsSetEnabledRequest, registered),
      ).rejects.toThrow(/boolean/);
      expect(pause).not.toHaveBeenCalled();
      expect(enabledStore.isEnabled()).toBe(true); // never split — flag untouched
    }
  });

  it('setEnabled rejects an unregistered client before any side effect', async () => {
    const { deps, enabledStore, pause } = makeDeps({ initialEnabled: true });
    const slice = makeDdnsHandlers(deps)!;

    await expect(
      slice.handlers['ddns.setEnabled']({ enabled: false }, unregistered),
    ).rejects.toThrow(/registered/);
    expect(pause).not.toHaveBeenCalled();
    expect(enabledStore.isEnabled()).toBe(true);
  });
});
