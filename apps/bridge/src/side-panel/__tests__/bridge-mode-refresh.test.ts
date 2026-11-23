import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SidePanelStore } from '../store/local-store.js';
import type { StorageChanges } from '../storage-changes.js';

const { mount } = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock('../mount.js', () => ({ mountSidePanel: mount }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const paired = {
  server_url: 'https://first.example',
  server_public_key: 'first-key',
  webclient_token: { token_id: 'first-token' },
};
const modes = (approval: boolean) => ({ ok: true, modes: { notification: false, approval } });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/** Drive the production entry and real store. Only DOM mounting and Chrome
 * messaging/storage are replaced; the refresh and pairing wiring are real. */
const openPanel = async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mount.mockClear();
  const reads: ReturnType<typeof deferred<unknown>>[] = [];
  const messages: Array<(message: unknown) => void> = [];
  const changes: Array<(changes: StorageChanges) => void> = [];
  let local: Record<string, unknown> = { ...paired };
  let nextStorageRead: Promise<Record<string, unknown>> | undefined;
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: (fn: (message: unknown) => void) => { messages.push(fn); } },
      sendMessage: async (message: { type: string }) => {
        if (message.type === 'recued.bridge.side-panel.fetch-bridge-mode') {
          const read = deferred<unknown>();
          reads.push(read);
          return read.promise;
        }
        return { ok: false, error: 'unavailable-in-fixture' };
      },
    },
    storage: { local: {
      async get() {
        const pending = nextStorageRead;
        nextStorageRead = undefined;
        return pending ?? local;
      },
      async set() {},
      onChanged: { addListener: (fn: (event: StorageChanges) => void) => { changes.push(fn); } },
    } },
  });
  await import('../side-panel-entry.js');
  await flush();
  const store = mount.mock.calls[0]?.[0]?.store as SidePanelStore;
  expect(store).toBeDefined();
  expect(reads).toHaveLength(1);
  return {
    store,
    reads,
    invalidate() {
      for (const fn of messages) fn({ type: 'recued.bridge.side-panel.bridge-mode-invalidated' });
    },
    changePair(next: Record<string, unknown>, event: StorageChanges) {
      local = next;
      for (const fn of changes) fn(event);
    },
    holdStorageRead(promise: Promise<Record<string, unknown>>) { nextStorageRead = promise; },
  };
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('side-panel approval-mode refresh ownership', () => {
  it('keeps the newer OFF reply when an older ON reply arrives', async () => {
    const h = await openPanel();
    h.invalidate();
    h.reads[1]!.resolve(modes(false));
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(false);
    h.reads[0]!.resolve(modes(true));
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(false);
  });

  it('retires the old mode immediately while changed pairing storage is still being read', async () => {
    const h = await openPanel();
    h.reads[0]!.resolve(modes(true));
    await flush();
    h.invalidate();
    const storage = deferred<Record<string, unknown>>();
    h.holdStorageRead(storage.promise);
    const next = { server_url: 'https://second.example', server_public_key: 'second-key',
      webclient_token: { token_id: 'second-token' } };
    h.changePair(next, { server_public_key: { newValue: next.server_public_key } });
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(false);
    h.reads[1]!.resolve(modes(true));
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(false);
    storage.resolve(next);
    await flush();
    expect(h.store.getState().pair.server_url).toBe(next.server_url);
    expect(h.store.getState().bridge_mode.approval).toBe(false);
  });

  it('does not revive a retired reply when the same identity is paired again', async () => {
    const h = await openPanel();
    h.changePair({}, { webclient_token: { newValue: null } });
    await flush();
    expect(h.store.getState().pair.paired).toBe(false);
    h.changePair(paired, { webclient_token: { newValue: paired.webclient_token } });
    await flush();
    h.reads[1]!.resolve(modes(false));
    await flush();
    h.reads[0]!.resolve(modes(true));
    await flush();
    expect(h.store.getState().pair.paired).toBe(true);
    expect(h.store.getState().bridge_mode.approval).toBe(false);
  });

  it('does not fail closed or retry for a superseded request failure', async () => {
    const h = await openPanel();
    h.reads[0]!.resolve(modes(false));
    await flush();
    h.invalidate();
    h.invalidate();
    h.reads[2]!.resolve(modes(true));
    await flush();
    h.reads[1]!.reject(new Error('old connection lost'));
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.reads).toHaveLength(3);
    expect(h.store.getState().bridge_mode.approval).toBe(true);
  });

  it('retires a scheduled retry after a newer invalidation succeeds', async () => {
    const h = await openPanel();
    h.reads[0]!.resolve(modes(true));
    await flush();
    h.invalidate();
    h.reads[1]!.resolve({ ok: false, error: 'disconnected' });
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(false);
    h.invalidate();
    h.reads[2]!.resolve(modes(true));
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.reads).toHaveLength(3);
    expect(h.store.getState().bridge_mode.approval).toBe(true);
  });

  it('still fails closed immediately and recovers on the current sequence retry', async () => {
    const h = await openPanel();
    h.reads[0]!.resolve(modes(true));
    await flush();
    h.invalidate();
    h.reads[1]!.reject(new Error('connection lost'));
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(false);
    expect(h.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    h.reads[2]!.resolve(modes(true));
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.reads).toHaveLength(3);
  });

  it('preserves the current mode and pending reply across metadata-only changes', async () => {
    const h = await openPanel();
    h.changePair({ ...paired, pair_metadata: { server_display_name: 'Renamed' } },
      { pair_metadata: { newValue: { server_display_name: 'Renamed' } } });
    await flush();
    h.reads[0]!.resolve(modes(true));
    await flush();
    expect(h.store.getState().pair.server_display_name).toBe('Renamed');
    expect(h.store.getState().bridge_mode.approval).toBe(true);
    h.changePair({ ...paired, pair_metadata: { server_display_name: 'Renamed again' } },
      { pair_metadata: { newValue: { server_display_name: 'Renamed again' } } });
    await flush();
    expect(h.store.getState().bridge_mode.approval).toBe(true);
    expect(h.reads).toHaveLength(1);
  });
});
