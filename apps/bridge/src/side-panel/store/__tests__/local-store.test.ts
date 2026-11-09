import { describe, expect, it, vi } from 'vitest';

import {
  createSidePanelStore,
  DEFAULT_DIAGNOSTIC_FRAME,
  type SidePanelStatusFrame,
} from '../local-store.js';

const statusFrame = (): SidePanelStatusFrame => ({
  fetched_at: 1_800_000_000_000,
  error: null,
  status: {
    name: 'Recued Local',
    version: '1.2.3',
    uptime_seconds: 60,
    paired_client_count: 2,
    paired_client_connected: 1,
    ws_state: 'serving',
    last_sync_at: 1_799_999_990_000,
    executions_last_hour: 3,
    executions_last_24h: 12,
    pending_asks: 1,
    ask_load: null,
    schedule_queue_depth: 4,
    recent_error_count: 0,
    keyfile_sealing: null,
    snapshot_at: 1_800_000_000_000,
  },
});

describe('D-169 P1 side-panel local store', () => {
  it.each([false, true])('copies clipboard feedback, preserves it through polling, and clears it on re-pair (initial: %s)', initial => {
    const diagnostic_copy = { phase: 'manual' as const, summary: 'Allowlisted summary' };
    const store = createSidePanelStore(initial ? { diagnostic_copy } : undefined);
    if (!initial) store.applyDiagnosticCopyState(diagnostic_copy);
    diagnostic_copy.summary = 'Changed by caller';
    store.applyDiagnosticFrame({ ...DEFAULT_DIAGNOSTIC_FRAME, refreshing: true });
    expect(store.getState().diagnostic_copy).toEqual({ phase: 'manual', summary: 'Allowlisted summary' });
    expect(Object.isFrozen(store.getState().diagnostic_copy)).toBe(true);
    store.reset({ paired: true, server_url: 'wss://other.invalid', server_display_name: null });
    expect(store.getState().diagnostic_copy).toEqual({ phase: 'idle', summary: '' });
  });

  it.each(['ok', 'error', 'rejected'] as const)('retains known error codes only for failed outcomes (%s)', status => {
    const store = createSidePanelStore();
    store.applyDiagnosticFrame({ ...DEFAULT_DIAGNOSTIC_FRAME, recent_confirmed: { count: 1, entries: [
      { command_id: 'result', status, stored_at: 500, error_code: 'selector_not_found',
        ...{ error: { message: 'private-message' }, outputs: { secret: 'private-output' } } },
    ] } });
    expect(store.getState().diagnostic.recent_confirmed?.entries).toEqual([
      { command_id: 'result', status, stored_at: 500, ...(status === 'ok' ? {} : { error_code: 'selector_not_found' }) },
    ]);
    expect(JSON.stringify(store.getState().diagnostic)).not.toContain('private');
  });

  it.each([false, true])('copies and freezes unresolved rows independently of their caller (initial: %s)', initial => {
    const unresolved = { count: 1, entries: [{ command_id: 'original', started_at: 500 }] };
    const diagnostic = { ...DEFAULT_DIAGNOSTIC_FRAME, idempotency_entry_count: 0, unresolved,
      recent_confirmed: null, pending_command_count: 0, grant_count: 0 };
    const store = createSidePanelStore(initial ? { diagnostic } : undefined);
    if (!initial) store.applyDiagnosticFrame(diagnostic);
    expect(Object.isFrozen(unresolved.entries)).toBe(false);
    unresolved.entries[0]!.command_id = 'changed-by-caller';
    unresolved.entries.push({ command_id: 'injected', started_at: 600 });
    expect(store.getState().diagnostic.unresolved).toEqual({ count: 1, entries: [{ command_id: 'original', started_at: 500 }] });
    expect(Object.isFrozen(store.getState().diagnostic.unresolved?.entries)).toBe(true);
    expect(Object.isFrozen(store.getState().diagnostic.unresolved?.entries[0])).toBe(true);
    store.reset();
    expect(store.getState().diagnostic.unresolved).toBeNull();
  });

  it.each([false, true])('copies and freezes confirmed metadata and clears it on reset (initial: %s)', initial => {
    const recent_confirmed = { count: 1, entries: [{ command_id: 'finished', status: 'ok' as const, stored_at: 500,
      outputs: { secret: 'private' }, idempotency_key: 'private' }] };
    const diagnostic = { ...DEFAULT_DIAGNOSTIC_FRAME, idempotency_entry_count: 1, unresolved: null,
      recent_confirmed, pending_command_count: 0, grant_count: 0 };
    const store = createSidePanelStore(initial ? { diagnostic } : undefined);
    if (!initial) store.applyDiagnosticFrame(diagnostic);
    recent_confirmed.entries[0]!.command_id = 'changed-by-caller';
    expect(Object.isFrozen(recent_confirmed.entries)).toBe(false);
    expect(store.getState().diagnostic.recent_confirmed).toEqual({ count: 1,
      entries: [{ command_id: 'finished', status: 'ok', stored_at: 500 }] });
    expect(Object.isFrozen(store.getState().diagnostic.recent_confirmed)).toBe(true);
    expect(Object.isFrozen(store.getState().diagnostic.recent_confirmed?.entries)).toBe(true);
    expect(Object.isFrozen(store.getState().diagnostic.recent_confirmed?.entries[0])).toBe(true);
    store.reset({ paired: true, server_url: 'wss://other.invalid', server_display_name: null });
    expect(store.getState().diagnostic.recent_confirmed).toBeNull();
  });

  it('starts with the default unpaired state and empty frames', () => {
    const state = createSidePanelStore().getState();

    expect(state.pair).toEqual({
      paired: false,
      server_url: null,
      server_display_name: null,
    });
    expect(state.status).toEqual({
      status: null,
      fetched_at: null,
      error: null,
    });
    expect(state.recipe_results.items).toEqual([]);
    expect(state.notifications.items).toEqual([]);
    expect(state.approvals.items).toEqual([]);
    expect(state.diagnostic).toEqual({
      idempotency_entry_count: null,
      unresolved: null,
      recent_confirmed: null,
      pending_command_count: null,
      current_command_id: null,
      queue_paused: null,
      grant_count: null,
      last_successful_refresh_at: null,
      refreshing: false,
      refresh_error: null,
    });
  });

  it('getState returns a structurally frozen state tree', () => {
    const state = createSidePanelStore().getState();

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.pair)).toBe(true);
    expect(Object.isFrozen(state.status)).toBe(true);
    expect(Object.isFrozen(state.recipe_results)).toBe(true);
    expect(Object.isFrozen(state.recipe_results.items)).toBe(true);

    try {
      (state.pair as { paired: boolean }).paired = true;
    } catch {
      // ES modules run in strict mode; non-strict runtimes silently drop.
    }
    expect(state.pair.paired).toBe(false);
  });

  it('applyPairState triggers one subscriber callback with the patched state', () => {
    const store = createSidePanelStore();
    const sub = vi.fn();
    store.subscribe(sub);

    store.applyPairState({
      paired: true,
      server_url: 'https://local.recued.test',
      server_display_name: 'Local Recued',
    });

    expect(sub).toHaveBeenCalledTimes(1);
    expect(sub.mock.calls[0][0].pair).toEqual({
      paired: true,
      server_url: 'https://local.recued.test',
      server_display_name: 'Local Recued',
    });
  });

  it('applyStatusFrame and applyDiagnosticFrame each trigger once and preserve other frames', () => {
    const store = createSidePanelStore();
    const sub = vi.fn();
    store.subscribe(sub);
    const beforeRecipes = store.getState().recipe_results;

    const status = statusFrame();
    store.applyStatusFrame(status);
    expect(sub).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toEqual(status);
    expect(store.getState().recipe_results).toBe(beforeRecipes);

    store.applyDiagnosticFrame({
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 2,
      unresolved: null,
      recent_confirmed: null,
      pending_command_count: 1,
      grant_count: 5,
    });
    expect(sub).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toEqual(status);
    expect(store.getState().diagnostic).toEqual({
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 2,
      unresolved: null,
      recent_confirmed: null,
      pending_command_count: 1,
      grant_count: 5,
    });
  });

  it('reset returns to defaults and triggers a callback', () => {
    const store = createSidePanelStore();
    const sub = vi.fn();
    store.subscribe(sub);
    store.applyPairState({
      paired: true,
      server_url: 'https://local.recued.test',
      server_display_name: 'Local Recued',
    });

    store.reset();

    expect(sub).toHaveBeenCalledTimes(2);
    expect(store.getState().pair.paired).toBe(false);
    expect(store.getState().status.status).toBeNull();
    expect(store.getState().diagnostic).toEqual({
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: null,
      unresolved: null,
      recent_confirmed: null,
      pending_command_count: null,
      grant_count: null,
    });
  });

  it('reset can atomically enter a new pair without retaining live frames', () => {
    const store = createSidePanelStore();
    store.applyStatusFrame(statusFrame());
    store.applyBridgeMode({ notification: true, approval: true });
    const sub = vi.fn();
    store.subscribe(sub);

    store.reset({
      paired: true,
      server_url: 'https://new.recued.test',
      server_display_name: 'New server',
    });

    expect(sub).toHaveBeenCalledTimes(1);
    expect(store.getState().pair).toEqual({
      paired: true,
      server_url: 'https://new.recued.test',
      server_display_name: 'New server',
    });
    expect(store.getState().status.status).toBeNull();
    expect(store.getState().bridge_mode).toEqual({
      notification: false,
      approval: false,
    });
  });

  it('a throwing subscriber does not break later subscribers', () => {
    const store = createSidePanelStore();
    const first = vi.fn(() => {
      throw new Error('subscriber failed');
    });
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);

    expect(() =>
      store.applyPairState({
        paired: true,
        server_url: 'https://local.recued.test',
        server_display_name: null,
      }),
    ).not.toThrow();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers each receive every patch', () => {
    const store = createSidePanelStore();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);

    store.applyStatusFrame(statusFrame());
    store.applyDiagnosticFrame({
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 1,
      unresolved: null,
      recent_confirmed: null,
      pending_command_count: 0,
      grant_count: 2,
    });

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('returned unsubscribe handle stops future callbacks', () => {
    const store = createSidePanelStore();
    const sub = vi.fn();
    const unsubscribe = store.subscribe(sub);

    store.applyStatusFrame(statusFrame());
    unsubscribe();
    store.applyDiagnosticFrame({
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 1,
      unresolved: null,
      recent_confirmed: null,
      pending_command_count: 0,
      grant_count: 2,
    });

    expect(sub).toHaveBeenCalledTimes(1);
  });

  it('freezes per-frame item arrays so recipe_results cannot be pushed', () => {
    const store = createSidePanelStore({
      recipe_results: {
        items: [
          {
            run_id: 'run-1',
            recipe_id: 'recipe-1',
            status: 'ok',
            started_at: 1,
            duration_ms: 25,
          },
        ],
        fetched_at: 1,
        error: null,
      },
    });
    const items = store.getState().recipe_results.items;

    expect(Object.isFrozen(items)).toBe(true);
    expect(() => {
      (items as Array<unknown>).push({ recipe_id: 'recipe-2' });
    }).toThrow();
  });

  it('applyBusFrames patches all live lists once, applies meta, and deeply freezes rows', () => {
    const store = createSidePanelStore();
    const sub = vi.fn();
    store.subscribe(sub);

    store.applyBusFrames(
      {
        recipe_results: [
          {
            run_id: 'run-1',
            recipe_id: 'recipe-1',
            status: 'ok',
            started_at: 1_800_000_000_000,
            duration_ms: null,
          },
        ],
        notifications: [
          {
            id: 'notify:1',
            title: 'Notice',
            text: 'Notify body',
            fired_at: 1_800_000_000_001,
          },
        ],
        approvals: [
          {
            ask_id: 'ask-1',
            title: 'Approve?',
            text: 'Choose one',
            options: [{ id: 'yes', label: 'Yes' }],
            created_at: 1_800_000_000_002,
          },
        ],
      },
      { fetched_at: 1_800_000_000_010, error: 'rpc stale' },
    );

    expect(sub).toHaveBeenCalledTimes(1);
    const state = store.getState();
    expect(state.recipe_results).toEqual({
      items: [
        {
          run_id: 'run-1',
          recipe_id: 'recipe-1',
          status: 'ok',
          started_at: 1_800_000_000_000,
          duration_ms: null,
        },
      ],
      fetched_at: 1_800_000_000_010,
      error: 'rpc stale',
    });
    expect(state.notifications).toEqual({
      items: [
        {
          id: 'notify:1',
          title: 'Notice',
          text: 'Notify body',
          fired_at: 1_800_000_000_001,
        },
      ],
      fetched_at: 1_800_000_000_010,
      error: 'rpc stale',
    });
    expect(state.approvals).toEqual({
      items: [
        {
          ask_id: 'ask-1',
          title: 'Approve?',
          text: 'Choose one',
          options: [{ id: 'yes', label: 'Yes' }],
          created_at: 1_800_000_000_002,
        },
      ],
      fetched_at: 1_800_000_000_010,
      error: 'rpc stale',
    });

    const notification = state.notifications.items[0]!;
    const approval = state.approvals.items[0]!;
    const option = approval.options[0]!;
    expect(Object.isFrozen(notification)).toBe(true);
    expect(Object.isFrozen(approval)).toBe(true);
    expect(Object.isFrozen(approval.options)).toBe(true);
    expect(Object.isFrozen(option)).toBe(true);

    expect(() => {
      (notification as { text: string }).text = 'mutated';
    }).toThrow();
    expect(() => {
      (approval.options as Array<unknown>).push({ id: 'no', label: 'No' });
    }).toThrow();
    expect(() => {
      (option as { label: string }).label = 'Mutated';
    }).toThrow();
    expect(store.getState().notifications.items[0]!.text).toBe('Notify body');
    expect(store.getState().approvals.items[0]!.options[0]!.label).toBe('Yes');
  });
});

describe('D-163 O-1 — whether Chrome shows this Bridge\'s notifications', () => {
  it('starts unread, notifies on a change only, and survives a re-pair, being this browser\'s', () => {
    const store = createSidePanelStore();
    expect(store.getState().desktop_notifications).toBeNull();
    const seen = vi.fn();
    store.subscribe(seen);
    store.applyDesktopNotifications('denied');
    store.applyDesktopNotifications('denied');
    expect(seen).toHaveBeenCalledTimes(1);
    store.reset({ paired: true, server_url: 'wss://other.invalid', server_display_name: null });
    expect(store.getState().desktop_notifications).toBe('denied');
    store.applyDesktopNotifications('granted');
    expect(store.getState().desktop_notifications).toBe('granted');
  });
});
