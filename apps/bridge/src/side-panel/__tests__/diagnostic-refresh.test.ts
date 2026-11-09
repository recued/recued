import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createDiagnosticRefresh, createPairStateRefresh } from '../diagnostic-refresh.js';
import { createSidePanelStore, DEFAULT_DIAGNOSTIC_FRAME } from '../store/local-store.js';
import { createIndexedDbIdempotencyCache } from '../../idempotency/indexed-db-cache.js';
import { buildBridgeStateInspection } from '../../pairing/inspector.js';
import { createInMemoryBridgeLocalStore } from '../../storage/local-store.js';
import { createFifoQueue } from '../../queue/fifo-queue.js';
import { createInMemoryBridgeGrantStore } from '../../permissions/grants.js';

const scope = { server_public_key: 'server', token_id: 'owner-bridge' };
const pair = { paired: true, server_url: 'wss://fixture.invalid/ws', server_display_name: null };
const local = { server_url: pair.server_url, server_public_key: scope.server_public_key,
  webclient_token: { token_id: scope.token_id, ciphertext_b64: 'fixture', iv_b64: 'fixture', issued_at: 1 } };
const confirmed = { count: 1, entries: [{ command_id: 'finished', status: 'ok' as const, stored_at: 400 }] };
const reply = (in_flight: unknown = { count: 0, entries: [] }, recent_confirmed: unknown = confirmed) => ({ local,
  idempotency: { entry_count: 2, in_flight, recent_confirmed },
  queue: { pending_depth: 0, current_command_id: null as string | null, paused: false }, grants: { count: 1 } });
const pending = { count: 1, entries: [{ command_id: 'pending', started_at: 500 }] };

describe('pair-scoped diagnostic refresh', () => {
  it('carries a durable failure code through inspection and the store without its private error payload', async () => {
    const indexedDB = new IDBFactory();
    const cache = () => createIndexedDbIdempotencyCache({ indexedDB, scope, now: () => 500 });
    await cache().store('failed', 'private-key', { command_id: 'failed', status: 'error', duration_ms: 5,
      bridge_version: 'fixture', idempotency_key_seen: false, outputs: { secret: 'private-output' },
      error: { code: 'selector_not_found', message: 'private-message', detail: 'private-selector' } });
    const store = createSidePanelStore({ pair });
    await createDiagnosticRefresh({ store, getScope: () => scope,
      inspect: () => buildBridgeStateInspection({ local: createInMemoryBridgeLocalStore(local), queue: createFifoQueue(),
        idempotency: cache(), grants: createInMemoryBridgeGrantStore(), now: () => 1_000 }) }).refresh();
    expect(store.getState().diagnostic.recent_confirmed?.entries).toEqual([
      { command_id: 'failed', status: 'error', stored_at: 500, error_code: 'selector_not_found' },
    ]);
    expect(JSON.stringify(store.getState().diagnostic)).not.toContain('private');
  });

  it.each([undefined, 'private-unknown-code', { private: true }])('drops unsupported code metadata without discarding the outcome (%j)', error_code => {
    const store = createSidePanelStore({ pair });
    const response = reply(pending, { count: 1, entries: [{ command_id: 'failed', status: 'error', stored_at: 500,
      error_code, error: { message: 'private-message' } }] });
    return createDiagnosticRefresh({ store, getScope: () => scope, inspect: async () => response }).refresh().then(() => {
      expect(store.getState().diagnostic.recent_confirmed?.entries).toEqual([{ command_id: 'failed', status: 'error', stored_at: 500 }]);
      expect(store.getState().diagnostic.refresh_error).toBeNull();
      expect(JSON.stringify(store.getState().diagnostic)).not.toContain('private');
    });
  });

  it.each(['delivery_uncertain', 'mv3_lifecycle_killed'])('refuses to present %s as a confirmed failure', async error_code => {
    const store = createSidePanelStore({ pair });
    await createDiagnosticRefresh({ store, getScope: () => scope, inspect: async () => reply(pending,
      { count: 1, entries: [{ command_id: 'pending', status: 'error', stored_at: 500, error_code }] }) }).refresh();
    expect(store.getState().diagnostic.recent_confirmed).toBeNull();
    expect(store.getState().diagnostic.unresolved).toEqual(pending);
    expect(store.getState().diagnostic.last_successful_refresh_at).toBeNull();
  });

  it('marks a read in progress and records its completion time with the live queue state', async () => {
    const store = createSidePanelStore({ pair });
    let clock = 1_000, release!: (value: unknown) => void;
    const inspect = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(reply())
      .mockImplementationOnce(() => new Promise(done => { release = done; }));
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect, now: () => clock });
    await refresh.refresh();
    expect(store.getState().diagnostic.last_successful_refresh_at).toBe(1_000);
    clock = 2_000;
    const reading = refresh.refresh();
    expect(store.getState().diagnostic.refreshing).toBe(true);
    expect(store.getState().diagnostic.last_successful_refresh_at).toBe(1_000);
    clock = 3_000;
    release({ ...reply(), queue: { current_command_id: 'running-command', pending_depth: 2, paused: true,
      args: { private: true } } });
    await reading;
    expect(store.getState().diagnostic).toMatchObject({ current_command_id: 'running-command',
      pending_command_count: 2, queue_paused: true, last_successful_refresh_at: 3_000,
      refreshing: false, refresh_error: null });
    expect(JSON.stringify(store.getState().diagnostic)).not.toContain('private');
  });

  it('preserves the last successful time across partial and failed reads, then recovers', async () => {
    const store = createSidePanelStore({ pair }); let clock = 1_000;
    const inspect = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply(null))
      .mockRejectedValueOnce(new Error('private worker details')).mockResolvedValueOnce(reply());
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect, now: () => clock });
    await refresh.refresh(); clock = 2_000;
    await refresh.refresh();
    expect(store.getState().diagnostic).toMatchObject({ last_successful_refresh_at: 1_000, refreshing: false,
      unresolved: null, pending_command_count: 0 });
    expect(store.getState().diagnostic.refresh_error).toContain('Some diagnostics');
    await refresh.refresh();
    expect(store.getState().diagnostic).toMatchObject({ last_successful_refresh_at: 1_000, refreshing: false,
      pending_command_count: null, current_command_id: null, queue_paused: null });
    expect(store.getState().diagnostic.refresh_error).toContain('Could not refresh');
    expect(JSON.stringify(store.getState().diagnostic)).not.toContain('private');
    clock = 3_000; await refresh.refresh();
    expect(store.getState().diagnostic).toMatchObject({ last_successful_refresh_at: 3_000,
      refreshing: false, refresh_error: null, pending_command_count: 0, queue_paused: false });
  });

  it.each([undefined, null, {}, { pending_depth: 0 },
    { pending_depth: 0, current_command_id: '', paused: false },
    { pending_depth: 0, current_command_id: 12, paused: false },
    { pending_depth: 0, current_command_id: null, paused: 'false' },
    { pending_depth: -1, current_command_id: null, paused: false },
  ])('marks a malformed queue unavailable without claiming a successful refresh (%j)', async queue => {
    const store = createSidePanelStore({ pair });
    await createDiagnosticRefresh({ store, getScope: () => scope,
      inspect: async () => ({ ...reply(), queue }) }).refresh();
    expect(store.getState().diagnostic).toMatchObject({ pending_command_count: null,
      current_command_id: null, queue_paused: null, last_successful_refresh_at: null, refreshing: false });
    expect(store.getState().diagnostic.refresh_error).toContain('Some diagnostics');
  });

  it('explains an unreadable pair without inspecting another namespace', async () => {
    const store = createSidePanelStore({ pair }), inspect = vi.fn(async () => reply());
    await createDiagnosticRefresh({ store, getScope: () => null, inspect }).refresh();
    expect(inspect).not.toHaveBeenCalled();
    expect(store.getState().diagnostic.refresh_error).toContain('Pairing information');
    expect(store.getState().diagnostic.refreshing).toBe(false);
  });

  it('replaces an unresolved timeout with a saved confirmation using a fresh durable cache', async () => {
    const indexedDB = new IDBFactory(); let clock = 500;
    const cache = () => createIndexedDbIdempotencyCache({ indexedDB, scope, now: () => clock });
    const result = { command_id: 'late', status: 'timeout' as const, duration_ms: 5,
      bridge_version: 'fixture', idempotency_key_seen: false };
    await cache().claim('late', 'private-key'); await cache().store('late', 'private-key', result);
    const store = createSidePanelStore({ pair });
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope,
      inspect: () => buildBridgeStateInspection({ local: createInMemoryBridgeLocalStore(local), queue: createFifoQueue(),
        idempotency: cache(), grants: createInMemoryBridgeGrantStore(), now: () => clock }) });
    await refresh.refresh();
    expect(store.getState().diagnostic.unresolved?.count).toBe(1);
    expect(store.getState().diagnostic.recent_confirmed).toEqual({ count: 0, entries: [] });
    clock = 600;
    await cache().store('late', 'private-key', { ...result, status: 'ok', outputs: { secret: 'private-output' } });
    await refresh.refresh();
    expect(store.getState().diagnostic.unresolved?.count).toBe(0);
    expect(store.getState().diagnostic.recent_confirmed).toEqual({ count: 1,
      entries: [{ command_id: 'late', status: 'ok', stored_at: 600 }] });
    expect(JSON.stringify(store.getState().diagnostic)).not.toContain('private');
  });

  it('clears a confirmed list immediately on pair invalidation and ignores the outstanding reply', async () => {
    const store = createSidePanelStore({ pair }); let resolve!: (value: unknown) => void;
    const inspect = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(reply())
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect });
    await refresh.refresh(); expect(store.getState().diagnostic.recent_confirmed).toEqual(confirmed);
    const old = refresh.refresh(); refresh.invalidate();
    expect(store.getState().diagnostic.recent_confirmed).toBeNull();
    expect(store.getState().diagnostic.last_successful_refresh_at).toBeNull();
    expect(store.getState().diagnostic.refreshing).toBe(false);
    resolve(reply()); await old;
    expect(store.getState().diagnostic.recent_confirmed).toBeNull();
    expect(store.getState().diagnostic.last_successful_refresh_at).toBeNull();
  });

  it('projects only confirmed metadata and bounds a valid large response', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ command_id: `finished-${i}`, status: 'ok', stored_at: 1_000 - i,
      outputs: { private: true }, idempotency_key: 'private-key', error: { message: 'private-error' } }));
    const response = reply(pending, { count: 55, entries }); response.idempotency.entry_count = 56;
    const store = createSidePanelStore({ pair });
    await createDiagnosticRefresh({ store, getScope: () => scope, inspect: async () => response }).refresh();
    expect(store.getState().diagnostic.recent_confirmed).toEqual({ count: 55,
      entries: entries.map(({ command_id, status, stored_at }) => ({ command_id, status, stored_at })) });
    expect(JSON.stringify(store.getState().diagnostic)).not.toContain('private');
  });

  it.each([undefined, null, { count: -1, entries: [] }, { count: 1, entries: [] },
    { count: 3, entries: [] }, { count: 1, entries: [{ command_id: '', status: 'ok', stored_at: 1 }] },
    ...['timeout', 'cancelled', 'invented', null].map(status => ({ count: 1, entries: [{ command_id: 'bad', status, stored_at: 1 }] })),
    ...[Infinity, NaN, 1e30].map(stored_at => ({ count: 1, entries: [{ command_id: 'bad', status: 'ok', stored_at }] })),
    { count: 2, entries: [{ command_id: 'same', status: 'ok', stored_at: 2 }, { command_id: 'same', status: 'ok', stored_at: 1 }] },
    { count: 2, entries: [{ command_id: 'older', status: 'ok', stored_at: 1 }, { command_id: 'newer', status: 'ok', stored_at: 2 }] },
    { count: 2, entries: [{ command_id: 'a', status: 'ok', stored_at: 1 }, { command_id: 'z', status: 'ok', stored_at: 1 }] },
    { count: 51, entries: Array.from({ length: 51 }, (_, i) => ({ command_id: String(i), status: 'ok', stored_at: 51 - i })) },
  ])('treats missing, uncertain or malformed confirmed outcomes as unavailable (%j)', async raw => {
    const store = createSidePanelStore({ pair });
    const response = reply(pending); response.idempotency.recent_confirmed = raw;
    await createDiagnosticRefresh({ store, getScope: () => scope, inspect: async () => response }).refresh();
    expect(store.getState().diagnostic.recent_confirmed).toBeNull();
    expect(store.getState().diagnostic.unresolved).toEqual(pending);
    expect(store.getState().diagnostic.idempotency_entry_count).toBe(2);
  });

  it('bounds outstanding reads after timeouts and recovers once an old port settles', async () => {
    vi.useFakeTimers();
    const releases: Array<(value: unknown) => void> = [];
    const store = createSidePanelStore({ pair }); let hanging = true;
    const inspect = vi.fn(async () => hanging ? new Promise(done => { releases.push(done); }) : reply(pending));
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect });
    try {
      for (let i = 0; i < 2; i++) {
        const reading = refresh.refresh(); await vi.advanceTimersByTimeAsync(5_000); await reading;
      }
      await refresh.refresh();
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(store.getState().diagnostic.unresolved).toBeNull();
      hanging = false;
      releases[0]!(reply()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await refresh.refresh();
      expect(inspect).toHaveBeenCalledTimes(3);
      expect(store.getState().diagnostic.unresolved).toEqual(pending);
      expect(vi.getTimerCount()).toBe(0);
    } finally { for (const release of releases) release(reply()); vi.useRealTimers(); }
  });

  it('expires a hung inspection instead of retaining an old empty view, and ignores its late reply', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const store = createSidePanelStore({ pair });
    const inspect = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(reply())
      .mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(reply(pending));
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect });
    let read: Promise<void> | undefined;
    try {
      await refresh.refresh();
      expect(store.getState().diagnostic.unresolved?.count).toBe(0);
      read = refresh.refresh();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.getState().diagnostic.unresolved).toBeNull();
      expect(store.getState().diagnostic.refresh_error).toContain('timed out');
      expect(store.getState().diagnostic.refreshing).toBe(false);
      await read;
      resolve(reply()); await Promise.resolve(); await Promise.resolve();
      expect(store.getState().diagnostic.unresolved).toBeNull();
      await refresh.refresh();
      expect(store.getState().diagnostic.unresolved).toEqual(pending);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resolve?.(reply()); await read; vi.useRealTimers();
    }
  });

  it('carries a fresh durable cache inspection into the panel without releasing the original admission', async () => {
    const indexedDB = new IDBFactory();
    const cache = () => createIndexedDbIdempotencyCache({ indexedDB, scope, now: () => 500 });
    await cache().claim('pending', 'private-key');
    const store = createSidePanelStore({ pair });
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope,
      inspect: () => buildBridgeStateInspection({ local: createInMemoryBridgeLocalStore(local), queue: createFifoQueue(),
        idempotency: cache(), grants: createInMemoryBridgeGrantStore(), now: () => 1_000 }) });
    await refresh.refresh();
    expect(store.getState().diagnostic).toEqual({ ...DEFAULT_DIAGNOSTIC_FRAME, idempotency_entry_count: 0,
      unresolved: pending, recent_confirmed: { count: 0, entries: [] }, pending_command_count: 0,
      queue_paused: false, grant_count: 0, last_successful_refresh_at: expect.any(Number) });
    expect((await cache().claim('retry', 'private-key')).kind).toBe('in_flight');
  });

  it('discards a late response after a token change on the same server URL', async () => {
    const store = createSidePanelStore({ pair }); let currentScope = scope;
    let resolve!: (result: unknown) => void;
    const refresh = createDiagnosticRefresh({ store, getScope: () => currentScope,
      inspect: () => new Promise(done => { resolve = done; }) });
    const old = refresh.refresh();
    currentScope = { ...scope, token_id: 'new-token' };
    refresh.invalidate(); store.reset(pair);
    resolve(reply(pending)); await old;
    expect(store.getState().diagnostic.unresolved).toBeNull();
  });

  it('rejects a late reply even after the pairing changes away and back', async () => {
    const store = createSidePanelStore({ pair }); let resolve!: (result: unknown) => void;
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope,
      inspect: () => new Promise(done => { resolve = done; }) });
    const old = refresh.refresh(); refresh.invalidate(); store.reset(pair);
    resolve(reply(pending)); await old;
    expect(store.getState().diagnostic.unresolved).toBeNull();
  });

  it('applies only the newest overlapping refresh', async () => {
    const store = createSidePanelStore({ pair }); let resolveOld!: (result: unknown) => void;
    let clock = 1_000;
    const inspect = vi.fn<() => Promise<unknown>>().mockImplementationOnce(() => new Promise(done => { resolveOld = done; }))
      .mockResolvedValueOnce(reply());
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect, now: () => clock });
    const old = refresh.refresh(); clock = 2_000; await refresh.refresh();
    clock = 3_000; resolveOld(reply(pending)); await old;
    expect(store.getState().diagnostic.unresolved).toEqual({ count: 0, entries: [] });
    expect(store.getState().diagnostic.last_successful_refresh_at).toBe(2_000);
    expect(store.getState().diagnostic.refreshing).toBe(false);
  });

  it('replaces an old empty result with unavailable when the worker cannot be reached', async () => {
    const store = createSidePanelStore({ pair });
    const inspect = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(reply()).mockRejectedValueOnce(new Error('worker unavailable'));
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect });
    await refresh.refresh(); expect(store.getState().diagnostic.unresolved?.count).toBe(0);
    await refresh.refresh(); expect(store.getState().diagnostic.unresolved).toBeNull();
  });

  it('refuses a snapshot from the prior worker pairing', async () => {
    const store = createSidePanelStore({ pair });
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope,
      inspect: async () => ({ ...reply(pending), local: { ...local, server_public_key: 'other-server' } }) });
    await refresh.refresh();
    expect(store.getState().diagnostic.idempotency_entry_count).toBeNull();
    expect(store.getState().diagnostic.unresolved).toBeNull();
  });

  it.each([undefined, null, { count: -1, entries: [] }, { count: 1, entries: [] },
    { count: 0, entries: [{}] }, { count: 1, entries: [{ command_id: '', started_at: 1 }] },
    { count: 1, entries: [{ command_id: 'bad', started_at: Infinity }] },
    { count: 1, entries: [{ command_id: 'bad', started_at: 1e30 }] },
    { count: 51, entries: Array.from({ length: 51 }, (_, i) => ({ command_id: String(i), started_at: 1 })) },
  ])('treats absent or malformed marker data as unavailable (%j)', async raw => {
    const store = createSidePanelStore({ pair });
    const response = reply(); response.idempotency.in_flight = raw;
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect: async () => response });
    await refresh.refresh();
    expect(store.getState().diagnostic.idempotency_entry_count).toBe(2);
    expect(store.getState().diagnostic.unresolved).toBeNull();
  });

  it('keeps only public command identity and start time from a valid marker row', async () => {
    const store = createSidePanelStore({ pair });
    const refresh = createDiagnosticRefresh({ store, getScope: () => scope, inspect: async () => reply({
      count: 1, entries: [{ ...pending.entries[0], idempotency_key: 'private', args: { secret: 'private' } }],
    }) });
    await refresh.refresh();
    expect(store.getState().diagnostic.unresolved).toEqual(pending);
  });

  it('does not inspect while unpaired', async () => {
    const store = createSidePanelStore(), inspect = vi.fn(async () => reply(pending));
    await createDiagnosticRefresh({ store, getScope: () => scope, inspect }).refresh();
    expect(inspect).not.toHaveBeenCalled();
    expect(store.getState().diagnostic.unresolved).toBeNull();
  });
});

describe('pair-state read recovery', () => {
  it.each([false, true])('retries a failed pair read and preserves the identity reset (initial: %s)', initiallyInvalidated => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValueOnce('new-pair');
    const apply = vi.fn(), invalidate = vi.fn();
    const refresh = createPairStateRefresh({ read, apply, invalidate, initiallyInvalidated });
    return (async () => {
      if (!initiallyInvalidated) refresh.invalidateIdentity();
      expect(await refresh.refresh()).toBe(false);
      expect(refresh.needsRefresh()).toBe(true);
      expect(apply).not.toHaveBeenCalled();
      expect(await refresh.refresh()).toBe(true);
      expect(apply).toHaveBeenCalledWith('new-pair', true);
      expect(refresh.needsRefresh()).toBe(false);
    })();
  });

  it.each(['resolve', 'reject'])('ignores a stale pair read that later completes by %s', async result => {
    let resolve!: (value: string) => void, reject!: (error: Error) => void;
    const read = vi.fn<() => Promise<string>>().mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }))
      .mockResolvedValueOnce('current-pair');
    const apply = vi.fn();
    const refresh = createPairStateRefresh({ read, apply, invalidate: () => {} });
    refresh.invalidateIdentity(); const old = refresh.refresh();
    // A metadata change triggers a newer read while the identity read is pending.
    await refresh.refresh();
    if (result === 'resolve') resolve('old-pair'); else reject(new Error('old read failed'));
    expect(await old).toBe(false);
    expect(apply).toHaveBeenCalledExactlyOnceWith('current-pair', true);
    expect(refresh.needsRefresh()).toBe(false);
  });

  it('keeps presentation-only updates from resetting a healthy pairing', async () => {
    const apply = vi.fn();
    const refresh = createPairStateRefresh({ read: async () => 'new-display-name', apply, invalidate: () => {} });
    await refresh.refresh();
    expect(apply).toHaveBeenCalledWith('new-display-name', false);
  });

  it('expires hung pair reads, bounds their outstanding ports and ignores their late results', async () => {
    vi.useFakeTimers();
    const releases: Array<(value: string) => void> = [], apply = vi.fn(); let hanging = true;
    const read = vi.fn(async () => hanging ? new Promise<string>(done => { releases.push(done); }) : 'current-pair');
    const refresh = createPairStateRefresh({ read, apply, invalidate: () => {} });
    const pending: Array<Promise<boolean>> = [];
    try {
      refresh.invalidateIdentity();
      for (let i = 0; i < 2; i++) {
        const reading = refresh.refresh(); pending.push(reading);
        let settled = false; void reading.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(settled).toBe(true);
        expect(await reading).toBe(false);
      }
      for (let i = 0; i < 20; i++) expect(await refresh.refresh()).toBe(false);
      expect(read).toHaveBeenCalledTimes(2);
      expect(refresh.needsRefresh()).toBe(true); expect(apply).not.toHaveBeenCalled();
      hanging = false; releases[0]!('expired-pair'); await vi.advanceTimersByTimeAsync(0);
      expect(apply).not.toHaveBeenCalled();
      expect(await refresh.refresh()).toBe(true);
      expect(read).toHaveBeenCalledTimes(3);
      expect(apply).toHaveBeenCalledExactlyOnceWith('current-pair', true);
      expect(refresh.needsRefresh()).toBe(false);
      releases[1]!('expired-pair'); await vi.advanceTimersByTimeAsync(0);
      expect(apply).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    } finally {
      for (const release of releases) release('expired-pair');
      await Promise.all(pending); vi.useRealTimers();
    }
  });
});
