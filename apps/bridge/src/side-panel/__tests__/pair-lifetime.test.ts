import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MountSidePanelOptions } from '../mount.js';
import type { SidePanelStore, SidePanelStoreState } from '../store/local-store.js';
import type { StorageChanges } from '../storage-changes.js';

const { mount } = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock('../mount.js', () => ({ mountSidePanel: mount }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const firstPair = { server_url: 'https://first.example', server_public_key: 'first-key',
  webclient_token: { token_id: 'first-token' } };
const secondPair = { server_url: 'https://second.example', server_public_key: 'second-key',
  webclient_token: { token_id: 'second-token' } };
const lists = (id: string) => ({
  ok: true,
  recipe_results: [
    { run_id: id, recipe_id: 'recipe', status: 'ok', started_at: 1, duration_ms: null },
  ] satisfies SidePanelStoreState['recipe_results']['items'],
  notifications: [
    { id, title: id, text: 'Notice', fired_at: 1 },
  ] satisfies SidePanelStoreState['notifications']['items'],
  approvals: [
    { ask_id: id, title: id, text: 'Choose', options: [{ id: 'yes', label: 'Yes' }], created_at: 1 },
  ] satisfies SidePanelStoreState['approvals']['items'],
});
const status = (name: string) => ({ ok: true, status: {
  name, version: '1.0.0', uptime_seconds: 1, paired_client_count: 1, paired_client_connected: 1,
  ws_state: 'serving', last_sync_at: null, executions_last_hour: 0, executions_last_24h: 0,
  pending_asks: 0, ask_load: null, schedule_queue_depth: 0, recent_error_count: 0,
  keyfile_sealing: null, snapshot_at: 1,
} satisfies NonNullable<SidePanelStoreState['status']['status']> });
const active = (id: string) => ({ ok: true,
  entries: [{ entry_kind: 'run', run_id: id, recipe_id: 'recipe', step_id: 'step', lane: 'local-heavy',
    state: 'running', origin: 'attended',
    source: { channel: 'user', actor: 'user_self', user_id: 'user', client_token_id: 'client' },
    started_at: 1, slot_acquired_at: 1, progress: { contract: 'silent', stalled: false },
    kill: { mechanism: 'sigkill', pid: 42 } }] satisfies SidePanelStoreState['active']['entries'],
  lanes: [],
});

/** Real entry/store with captured Chrome requests. DOM mounting is the only
 * application module replaced, so these tests cover pairing-event wiring. */
const openPanel = async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mount.mockClear();
  const requests: Array<{ message: Record<string, unknown>; reply: ReturnType<typeof deferred<unknown>> }> = [];
  const messages: Array<(message: unknown) => void> = [];
  const changes: Array<(changes: StorageChanges) => void> = [];
  let local: Record<string, unknown> = { ...firstPair };
  let nextStorageRead: Promise<Record<string, unknown>> | undefined;
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: (fn: (message: unknown) => void) => { messages.push(fn); } },
      sendMessage: async (message: Record<string, unknown>) => {
        if (message.type === 'recued.bridge.side-panel.fetch-bridge-mode') {
          return { ok: true, modes: { notification: true, approval: true } };
        }
        if (typeof message.type === 'string' && message.type.startsWith('recued.bridge.side-panel.')) {
          const reply = deferred<unknown>();
          requests.push({ message, reply });
          return reply.promise;
        }
        return { ok: false, error: 'unavailable-in-fixture' };
      },
    },
    storage: { local: {
      async get() { const pending = nextStorageRead; nextStorageRead = undefined; return pending ?? local; },
      async set() {},
      onChanged: { addListener: (fn: (event: StorageChanges) => void) => { changes.push(fn); } },
    } },
  });
  await import('../side-panel-entry.js');
  await flush();
  const options = mount.mock.calls[0]?.[0] as MountSidePanelOptions;
  expect(options?.store).toBeDefined();
  return {
    options,
    store: options.store,
    requests(type: string) { return requests.filter(r => r.message.type === 'recued.bridge.side-panel.' + type); },
    reply(type: string, value: unknown, index = 0) {
      const request = this.requests(type)[index];
      expect(request, `${type} request ${index}`).toBeDefined();
      request!.reply.resolve(value);
    },
    changePair(next: Record<string, unknown>, event: StorageChanges = { webclient_token: { newValue: next.webclient_token } }) {
      local = next;
      for (const fn of changes) fn(event);
    },
    holdStorageRead(promise: Promise<Record<string, unknown>>) { nextStorageRead = promise; },
    connected() { for (const fn of messages) fn({ type: 'recued.bridge.side-panel.server-connected' }); },
    pushPicker(result: Record<string, unknown>) {
      for (const fn of messages) fn({ type: 'recued.bridge.side-panel.picker-result', ...result });
    },
  };
};
const expectEmpty = (store: SidePanelStore): void => {
  const state = store.getState();
  expect(state.status).toEqual({ status: null, fetched_at: null, error: null });
  for (const list of [state.recipe_results, state.notifications, state.approvals]) {
    expect(list).toEqual({ items: [], fetched_at: null, error: null });
  }
  expect(state.active).toEqual({ entries: [], lanes: [], fetched_at: null, error: null, notice: '' });
};

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('side-panel server data belongs to its pairing lifetime', () => {
  it('matches picker feedback to the launch, including a result arriving before the launch reply', async () => {
    const h = await openPanel();
    h.pushPicker({ launch_id: 'unsolicited', ok: true });
    expect(h.store.getState().element_watch.webclient_link).toBe(false);
    const first = h.options.onLaunchPicker!();
    h.reply('launch-picker', { ok: true, launch_id: 'first' });
    await first;
    h.changePair(secondPair);
    await flush();
    const second = h.options.onLaunchPicker!();
    h.pushPicker({ launch_id: 'first', ok: true });
    h.pushPicker({ launch_id: 'second', ok: true });
    h.reply('launch-picker', { ok: true, launch_id: 'second' }, 1);
    await second;
    expect(h.store.getState().element_watch.webclient_link).toBe(true);
    h.pushPicker({ launch_id: 'first', ok: false, error: 'retired' });
    h.pushPicker({ launch_id: 'second', ok: false, error: 'duplicate' });
    expect(h.store.getState().element_watch.webclient_link).toBe(true);
  });

  it('does not let an old launch release a new duplicate guard, and keeps metadata-only feedback valid', async () => {
    const h = await openPanel();
    const first = h.options.onLaunchPicker!();
    h.changePair(secondPair);
    await flush();
    const second = h.options.onLaunchPicker!();
    h.reply('launch-picker', { ok: true, launch_id: 'first' });
    await first;
    await h.options.onLaunchPicker!();
    expect(h.requests('launch-picker')).toHaveLength(2);
    h.reply('launch-picker', { ok: true, launch_id: 'second' }, 1);
    await second;
    h.changePair({ ...secondPair, pair_metadata: { server_display_name: 'Renamed' } },
      { pair_metadata: { newValue: { server_display_name: 'Renamed' } } });
    await flush();
    h.pushPicker({ launch_id: 'first', ok: true });
    expect(h.store.getState().element_watch.webclient_link).toBe(false);
    h.pushPicker({ launch_id: 'second', ok: false, error: 'picker_session_expired' });
    expect(h.store.getState().element_watch.message).toContain('expired');
    expect(h.store.getState().element_watch.tone).toBe('danger');
  });

  it('discards old status, history, live-list and active snapshots after replacement', async () => {
    const h = await openPanel();
    await vi.advanceTimersByTimeAsync(5_000);
    h.changePair(secondPair);
    await flush();
    expect(h.store.getState().pair.server_url).toBe(secondPair.server_url);
    expectEmpty(h.store);
    h.reply('fetch-status', status('First server'));
    h.reply('fetch-history', lists('old-history'));
    h.reply('fetch-frames', lists('old-live'));
    h.reply('fetch-active', active('old-run'), 1);
    await flush();
    expectEmpty(h.store);
  });

  it.each(['reply', 'throw'] as const)('discards an old status failure (%s)', async kind => {
    const h = await openPanel();
    h.changePair(secondPair);
    await flush();
    if (kind === 'reply') h.reply('fetch-status', { ok: false, error: 'first-server-only error' });
    else h.requests('fetch-status')[0]!.reply.reject(new Error('first-server-only error'));
    await flush();
    expectEmpty(h.store);
  });

  it('retires reads and blocks new server work while replacement storage is unresolved', async () => {
    const h = await openPanel();
    await vi.advanceTimersByTimeAsync(1_000);
    const reading = deferred<Record<string, unknown>>();
    h.holdStorageRead(reading.promise);
    h.changePair(secondPair);
    h.reply('fetch-history', lists('old-history'));
    await flush();
    expect(h.store.getState().approvals.items).toEqual([]);
    const answering = Promise.resolve(h.options.onAnswer!('ask', 'yes')).then(() => 'ok', () => 'rejected');
    const controlling = Promise.resolve(h.options.onControl!('kill', 'run'));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.requests('submit-answer')).toHaveLength(0);
    expect(h.requests('execution-kill')).toHaveLength(0);
    expect(h.requests('fetch-frames')).toHaveLength(0);
    expect(h.requests('fetch-active')).toHaveLength(1);
    expect(await answering).toBe('rejected');
    await controlling;
    reading.resolve(secondPair);
    await flush();
    expect(h.store.getState().pair.server_url).toBe(secondPair.server_url);
    expectEmpty(h.store);
  });

  it('does not revive a history reply when the same identity is paired again', async () => {
    const h = await openPanel();
    h.changePair({});
    await flush();
    h.changePair(firstPair);
    await flush();
    h.reply('fetch-history', lists('current-history'), 1);
    await flush();
    h.reply('fetch-history', lists('retired-history'));
    await flush();
    expect(h.store.getState().approvals.items[0]?.ask_id).toBe('current-history');
  });

  it('accepts pending reads and preserves data across metadata-only updates', async () => {
    const h = await openPanel();
    h.changePair({ ...firstPair, pair_metadata: { server_display_name: 'Renamed' } },
      { pair_metadata: { newValue: { server_display_name: 'Renamed' } } });
    await flush();
    h.reply('fetch-status', status('First server'));
    h.reply('fetch-history', lists('current-history'));
    h.reply('fetch-active', active('current-run'));
    await flush();
    expect(h.store.getState().pair.server_display_name).toBe('Renamed');
    expect(h.store.getState().status.status?.name).toBe('First server');
    expect(h.store.getState().approvals.items[0]?.ask_id).toBe('current-history');
    expect(h.store.getState().active.entries[0]?.run_id).toBe('current-run');
    const approvals = h.store.getState().approvals;
    h.changePair({ ...firstPair, pair_metadata: { server_display_name: 'Renamed again' } },
      { pair_metadata: { newValue: { server_display_name: 'Renamed again' } } });
    await flush();
    expect(h.store.getState().approvals).toBe(approvals);
  });

  it('drops an old answer snapshot and still applies a current answer with its note', async () => {
    const h = await openPanel();
    const old = h.options.onAnswer!('old-ask', 'yes');
    h.changePair(secondPair);
    await flush();
    h.reply('submit-answer', lists('old-answer'));
    await old;
    expectEmpty(h.store);
    const current = h.options.onAnswer!('new-ask', 'yes', 'Owner reason');
    expect(h.requests('submit-answer')[1]!.message).toMatchObject({ ask_id: 'new-ask', option_id: 'yes', note: 'Owner reason' });
    h.reply('submit-answer', lists('current-answer'), 1);
    await current;
    expect(h.store.getState().approvals.items[0]?.ask_id).toBe('current-answer');
  });

  it('keeps control deduplication local to the pairing and suppresses old follow-up reads', async () => {
    const h = await openPanel();
    const old = h.options.onControl!('kill', 'shared-run-id');
    h.changePair(secondPair);
    await flush();
    const current = h.options.onControl!('kill', 'shared-run-id');
    expect(h.requests('execution-kill')).toHaveLength(2);
    h.requests('execution-kill')[0]!.reply.reject(new Error('old-pair failure'));
    await old;
    await h.options.onControl!('kill', 'shared-run-id');
    expect(h.requests('execution-kill')).toHaveLength(2);
    expect(h.requests('fetch-active')).toHaveLength(1);
    expect(h.store.getState().active.notice).toBe('');
    h.reply('execution-kill', { ok: true, status: 'not_found' }, 1);
    await flush();
    h.reply('fetch-active', active('current-run'), 1);
    await current;
    expect(h.store.getState().active.entries[0]?.run_id).toBe('current-run');
    expect(h.store.getState().active.notice).toBe('That run is no longer active.');
  });

  it('discards an old active-read failure carrying a control notice', async () => {
    const h = await openPanel();
    const controlling = h.options.onControl!('kill', 'old-run');
    h.reply('execution-kill', { ok: true, status: 'not_found' });
    await flush();
    expect(h.requests('fetch-active')).toHaveLength(2);
    h.changePair(secondPair);
    await flush();
    h.requests('fetch-active')[1]!.reply.reject(new Error('old socket closed'));
    await controlling;
    expectEmpty(h.store);
  });

  it('still keeps the newest status and active response within the same pairing', async () => {
    const h = await openPanel();
    h.connected();
    await vi.advanceTimersByTimeAsync(5_000);
    h.reply('fetch-status', status('Newest'), 1);
    h.reply('fetch-active', active('newest-run'), 1);
    await flush();
    h.reply('fetch-status', status('Older'));
    h.reply('fetch-active', active('older-run'));
    await flush();
    expect(h.store.getState().status.status?.name).toBe('Newest');
    expect(h.store.getState().active.entries[0]?.run_id).toBe('newest-run');
  });
});
