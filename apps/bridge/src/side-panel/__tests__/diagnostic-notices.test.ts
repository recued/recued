import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticRefresh, createDiagnosticRefreshQueue, createPairStateRefresh } from '../diagnostic-refresh.js';
import { createSidePanelStore } from '../store/local-store.js';

const scope = { server_public_key: 'server', token_id: 'owner' };
const pair = { paired: true, server_url: 'wss://fixture.invalid/ws', server_display_name: null };
const reply = (id: string, token_id = scope.token_id) => ({
  local: { server_public_key: scope.server_public_key, webclient_token: { token_id } },
  idempotency: { entry_count: 1, in_flight: { count: 0, entries: [] },
    recent_confirmed: { count: 1, entries: [{ command_id: id, status: 'ok', stored_at: 500 }] } },
  queue: { pending_depth: 0, current_command_id: null, paused: false }, grants: { count: 1 },
});
afterEach(() => vi.useRealTimers());

describe('coalesced diagnostic notices', () => {
  it('reads once per burst and follows a slow snapshot with the latest committed state', async () => {
    vi.useFakeTimers(); const store = createSidePanelStore({ pair });
    let release!: (value: unknown) => void;
    const inspect = vi.fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => new Promise(done => { release = done; })).mockResolvedValue(reply('latest'));
    const diagnostics = createDiagnosticRefresh({ store, getScope: () => scope, inspect });
    const reads = createDiagnosticRefreshQueue({ store, refresh: () => diagnostics.refresh() });
    for (let i = 0; i < 100; i++) reads.request();
    await vi.advanceTimersByTimeAsync(50);
    expect(inspect).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) reads.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inspect).toHaveBeenCalledTimes(1);
    release(reply('earlier')); await vi.advanceTimersByTimeAsync(50);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(store.getState().diagnostic.recent_confirmed?.entries[0]?.command_id).toBe('latest');
    reads.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an old pair snapshot and applies the queued read to the current pair', async () => {
    vi.useFakeTimers(); const store = createSidePanelStore({ pair }); let currentScope = scope;
    let release!: (value: unknown) => void;
    const inspect = vi.fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => new Promise(done => { release = done; })).mockResolvedValue(reply('new-pair', 'new-owner'));
    const diagnostics = createDiagnosticRefresh({ store, getScope: () => currentScope, inspect });
    const reads = createDiagnosticRefreshQueue({ store, refresh: () => diagnostics.refresh() });
    reads.request(); await vi.advanceTimersByTimeAsync(50);
    diagnostics.invalidate(); currentScope = { ...scope, token_id: 'new-owner' }; store.reset(pair);
    reads.request(); release(reply('old-pair')); await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().diagnostic.recent_confirmed).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(store.getState().diagnostic.recent_confirmed?.entries[0]?.command_id).toBe('new-pair');
    reads.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps hung ports bounded under repeated notices and recovers when a port settles', async () => {
    vi.useFakeTimers(); const store = createSidePanelStore({ pair });
    const releases: Array<(value: unknown) => void> = []; let hanging = true;
    const inspect = vi.fn(async () => hanging ? new Promise(done => { releases.push(done); }) : reply('recovered'));
    const diagnostics = createDiagnosticRefresh({ store, getScope: () => scope, inspect });
    const reads = createDiagnosticRefreshQueue({ store, refresh: () => diagnostics.refresh() });
    for (let i = 0; i < 5; i++) { reads.request(); await vi.advanceTimersByTimeAsync(5_050); }
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(store.getState().diagnostic.recent_confirmed).toBeNull();
    hanging = false; releases[0]!(reply('expired')); await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().diagnostic.recent_confirmed).toBeNull();
    reads.request(); await vi.advanceTimersByTimeAsync(50);
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(store.getState().diagnostic.recent_confirmed?.entries[0]?.command_id).toBe('recovered');
    reads.stop(); releases[1]!(reply('expired')); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the coalesced polling fallback usable after a pairing read hangs', async () => {
    vi.useFakeTimers(); const store = createSidePanelStore({ pair });
    let currentScope: typeof scope | null = scope, release!: (value: typeof scope) => void;
    const inspect = vi.fn(async () => reply('recovered'));
    const diagnostics = createDiagnosticRefresh({ store, getScope: () => currentScope, inspect });
    const read = vi.fn<() => Promise<typeof scope>>()
      .mockImplementationOnce(() => new Promise(done => { release = done; })).mockResolvedValue(scope);
    const pairState = createPairStateRefresh({ read,
      invalidate: () => { currentScope = null; diagnostics.invalidate(); },
      apply: next => { currentScope = next; store.reset(pair); } });
    const reads = createDiagnosticRefreshQueue({ store,
      prepare: async () => { if (pairState.needsRefresh()) await pairState.refresh(); },
      refresh: () => diagnostics.refresh(),
    });
    try {
      pairState.invalidateIdentity(); reads.request();
      expect(store.getState().diagnostic.refreshing).toBe(true);
      await vi.advanceTimersByTimeAsync(2_050);
      expect(store.getState().diagnostic.refreshing).toBe(true);
      expect(inspect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(pairState.needsRefresh()).toBe(true);
      expect(store.getState().diagnostic.refreshing).toBe(false);
      expect(store.getState().diagnostic.refresh_error).toContain('Pairing information');
      reads.request(); await vi.advanceTimersByTimeAsync(50);
      expect(read).toHaveBeenCalledTimes(2);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(store.getState().diagnostic.recent_confirmed?.entries[0]?.command_id).toBe('recovered');
      release({ ...scope, token_id: 'expired-pair' }); await vi.advanceTimersByTimeAsync(0);
      expect(currentScope).toEqual(scope);
      expect(store.getState().diagnostic.recent_confirmed?.entries[0]?.command_id).toBe('recovered');
    } finally {
      reads.stop(); release(scope); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers();
    }
  });

  it('keeps the polling recovery path usable before a pairing has been read', async () => {
    vi.useFakeTimers(); const store = createSidePanelStore();
    const inspect = vi.fn(async () => reply('first-paired-inspection'));
    const diagnostics = createDiagnosticRefresh({ store, getScope: () => scope, inspect });
    const reads = createDiagnosticRefreshQueue({ store,
      prepare: async () => { store.reset(pair); }, refresh: () => diagnostics.refresh() });
    reads.request();
    expect(store.getState().diagnostic.refreshing).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(store.getState().diagnostic.recent_confirmed?.entries[0]?.command_id).toBe('first-paired-inspection');
    expect(store.getState().diagnostic.refreshing).toBe(false);
    expect(store.getState().diagnostic.refresh_error).toBeNull();
    reads.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
