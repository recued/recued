import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDeliverySnapshot, ChatMessengerSessionStatus, ChatMessengerStatusResult, ChatSessionSummary } from '@recued/contracts';
import { createMessengerSessionList, messengerSessionLabels, type MessengerSessionListReply } from '../chat/messenger-session-list.js';
import { createChatDeliveryView } from '../chat/delivery-view.js';

const status = (delivery: Partial<NonNullable<ChatMessengerSessionStatus['delivery']>> = {}): ChatMessengerSessionStatus => ({
  vendor: 'telegram', recipient: '42', linked: true, receive: 'retrying',
  delivery: { pending_count: 0, sending_count: 0, unknown_count: 0, failed_count: 0, skipped_count: 0, ...delivery },
});
const session = (messenger?: ChatMessengerSessionStatus): ChatSessionSummary => ({
  id: 's', title: 'Renamed', created_at: 1, last_active_at: 1, message_count: 0,
  archived: false, picker_state: { current: 'self' }, model_routing: { current: 'byok' },
  ...(messenger ? { messenger } : {}),
});
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.useRealTimers(); });
const fixture = (read = vi.fn<() => Promise<MessengerSessionListReply>>().mockResolvedValue({ sessions: [session(status())], messenger_status_available: true }),
  readStatus?: (ids: string[]) => Promise<ChatMessengerStatusResult>,
  refresh: Pick<Parameters<typeof createMessengerSessionList>[0], 'needsListRefresh' | 'refreshList'> = {}) => {
  vi.useFakeTimers();
  const document = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    createElement: () => { throw new Error('These scheduling tests do not mount DOM'); } };
  const list = createMessengerSessionList({ document, read, readStatus, ...refresh, openDelivery: vi.fn(), actionsLocked: () => false });
  cleanups.push(list.dispose); return { list, read, document };
};

describe('Messenger list labels', () => {
  it('keeps a receive outage visible beside an empty outgoing journal', () => {
    expect(messengerSessionLabels(status())).toMatchObject({ vendor: 'Telegram', receive: 'Reconnecting', send: 'All sent' });
    expect(messengerSessionLabels({ ...status(), receive: 'webhook' }).receive).toBe('Set up to be told directly');
  });
  it.each([
    [{ pending_count: 3 }, '3 messages waiting to send'],
    [{ pending_count: 3, sending_count: 1 }, 'Sending · 3 pending'],
    [{ pending_count: 3, unknown_count: 1 }, '1 that Recued cannot account for unknown · 3 pending'],
    [{ pending_count: 3, failed_count: 1 }, '1 delivery failed · 3 pending'],
    [{ skipped_count: 1 }, '1 skipped message'],
  ])('describes unresolved and skipped messages: %j', (counts, label) => {
    expect(messengerSessionLabels(status(counts)).send).toBe(label);
  });
  it('never presents stale success or untracked history as caught up', () => {
    expect(messengerSessionLabels(status(), true)).toMatchObject({ receiveState: 'unavailable', sendState: 'unavailable', send: 'Recued cannot tell what was sent' });
    expect(messengerSessionLabels({ ...status(), linked: false, receive: 'unlinked', delivery: null }).send).toBe('Recued cannot follow what was sent');
  });
});

describe('Messenger list refresh lifecycle', () => {
  it('appends fresh status without clearing previous identities or reviving stale success', () => {
    const f = fixture(); f.list.adopt({ sessions: [session(status())], messenger_status_available: true }); f.list.failed();
    const next = { ...session(status()), id: 'next' };
    f.list.adopt({ sessions: [next], messenger_status_available: true }, { append: true });
    expect(f.list.project(session()).stale).toBe(true); expect(f.list.project(session()).messenger).toBeDefined();
    expect(f.list.project(next).stale).toBe(false); expect(f.list.statusUnavailable()).toBe(true);
    f.list.adopt({ sessions: [], messenger_status_available: true }, { retain: ['s'] });
    expect(f.list.project(session()).stale).toBe(true); expect(f.list.project(session()).messenger).toBeDefined();
    expect(f.list.project(next).messenger).toBeUndefined();
  });
  const narrowReply = (ids: string[]): ChatMessengerStatusResult => ({ sessions: ids.map(id => ({ id, messenger: status() })), messenger_status_available: true });
  const capable = (sessions = [session(status())]): MessengerSessionListReply => ({ sessions, messenger_status_available: true, messenger_status_refresh_available: true, history_filters_available: true });

  it('uses one global refresh for active filters, including empty results, and resumes normal status polling after filters clear', async () => {
    let filtered = true;
    const readStatus = vi.fn(async (ids: string[]) => narrowReply(ids));
    const refreshList = vi.fn(async () => { f.list.beginRead(); f.list.adopt(capable([])); });
    const f = fixture(undefined, readStatus, { needsListRefresh: () => filtered, refreshList });
    f.list.adopt(capable()); await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshList).toHaveBeenCalledTimes(1); expect(readStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000); expect(refreshList).toHaveBeenCalledTimes(2);
    f.document.visibilityState = 'hidden'; await vi.advanceTimersByTimeAsync(10_000); expect(refreshList).toHaveBeenCalledTimes(2);
    f.document.visibilityState = 'visible'; filtered = false; f.list.adopt(capable());
    await vi.advanceTimersByTimeAsync(5_000); expect(readStatus).toHaveBeenCalledTimes(1);
    expect(refreshList).toHaveBeenCalledTimes(2);
  });

  it('marks a stalled filtered refresh stale and keeps notifications single-flight until the owning read settles', async () => {
    let finish!: () => void;
    const readStatus = vi.fn(async (ids: string[]) => narrowReply(ids));
    const refreshList = vi.fn(() => { f.list.beginRead(); return new Promise<void>(resolve => { finish = resolve; }); });
    const f = fixture(undefined, readStatus, { needsListRefresh: () => true, refreshList });
    f.list.adopt(capable()); await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 0; i < 20; i++) f.list.invalidate('s');
    await vi.advanceTimersByTimeAsync(8_000); expect(f.list.project(session()).stale).toBe(true);
    expect(refreshList).toHaveBeenCalledTimes(1); expect(readStatus).not.toHaveBeenCalled();
    f.list.adopt(capable()); finish(); await vi.advanceTimersByTimeAsync(0);
    expect(f.list.project(session()).stale).toBe(false);
  });

  it('a newer metadata result resumes filtered polling before an obsolete refresh settles', async () => {
    let finish!: () => void;
    const refreshList = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => { f.list.beginRead(); return new Promise<void>(resolve => { finish = resolve; }); })
      .mockImplementation(async () => { f.list.beginRead(); f.list.adopt(capable([])); });
    const f = fixture(undefined, undefined, { needsListRefresh: () => true, refreshList });
    f.list.adopt(capable()); await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshList).toHaveBeenCalledTimes(1);
    // Changing filters has its own read and succeeds while the old RPC hangs.
    f.list.beginRead(); f.list.adopt(capable([]));
    await vi.advanceTimersByTimeAsync(5_000); expect(refreshList).toHaveBeenCalledTimes(2);
    finish(); await vi.advanceTimersByTimeAsync(5_000); expect(refreshList).toHaveBeenCalledTimes(3);
  });

  it('settling an obsolete filtered refresh cannot release a newer status read', async () => {
    let filtered = true; let finishOld!: () => void; let finishStatus!: (reply: ChatMessengerStatusResult) => void;
    const refreshList = vi.fn((): Promise<void> => { f.list.beginRead(); return new Promise(resolve => { finishOld = resolve; }); });
    const readStatus = vi.fn<(ids: string[]) => Promise<ChatMessengerStatusResult>>()
      .mockImplementationOnce(() => new Promise(resolve => { finishStatus = resolve; }))
      .mockImplementation(async ids => narrowReply(ids));
    const f = fixture(undefined, readStatus, { needsListRefresh: () => filtered, refreshList });
    f.list.adopt(capable()); await vi.advanceTimersByTimeAsync(5_000);
    filtered = false; f.list.beginRead(); f.list.adopt(capable());
    await vi.advanceTimersByTimeAsync(5_000); expect(readStatus).toHaveBeenCalledTimes(1);
    finishOld(); await vi.advanceTimersByTimeAsync(0);
    f.list.invalidate('s'); await vi.advanceTimersByTimeAsync(50); expect(readStatus).toHaveBeenCalledTimes(1);
    finishStatus(narrowReply(['s'])); await vi.advanceTimersByTimeAsync(50); expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it('polls known Messenger IDs only, and includes a newly invalidated web chat', async () => {
    const readStatus = vi.fn(async (ids: string[]) => narrowReply(ids)); const f = fixture(undefined, readStatus);
    const web = { ...session(), id: 'web' }; f.list.adopt(capable([session(status()), web]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readStatus).toHaveBeenLastCalledWith(['s']); expect(f.read).not.toHaveBeenCalled(); expect(f.list.filtersAvailable()).toBe(true);
    f.list.invalidate('web'); await vi.advanceTimersByTimeAsync(50);
    expect(readStatus).toHaveBeenLastCalledWith(['s', 'web']); expect(f.list.project(web).messenger).toBeDefined();
    f.list.adopt(capable([web])); f.list.invalidate('web'); await vi.advanceTimersByTimeAsync(50);
    expect(readStatus).toHaveBeenLastCalledWith(['web']);
  });

  it('batches large histories and preserves other batches when one becomes unavailable', async () => {
    const sessions = Array.from({ length: 1001 }, (_, i) => ({ ...session(status()), id: `s${i}` })); let fail = false;
    const readStatus = vi.fn(async (ids: string[]) => fail && ids.includes('s500') ? { sessions: [], messenger_status_available: false } : narrowReply(ids));
    const f = fixture(undefined, readStatus); f.list.adopt(capable(sessions)); await vi.advanceTimersByTimeAsync(5_000);
    expect(readStatus.mock.calls.map(([ids]) => ids.length)).toEqual([500, 500, 1]); expect(f.list.statusUnavailable()).toBe(false);
    fail = true; await vi.advanceTimersByTimeAsync(5_000);
    expect(f.list.statusUnavailable()).toBe(true); expect(f.list.project(sessions[500]!).stale).toBe(true);
    expect(f.list.project(sessions[0]!).stale).toBe(false); expect(f.list.project(sessions[1000]!).messenger).toBeDefined();
    fail = false; await vi.advanceTimersByTimeAsync(5_000); expect(f.list.statusUnavailable()).toBe(false);
    expect(f.list.project(sessions[500]!).stale).toBe(false); expect(f.read).not.toHaveBeenCalled();
  });

  it('retains status on malformed partial replies, and recovers binding changes after visibility resumes', async () => {
    let reply: ChatMessengerStatusResult = { sessions: [], messenger_status_available: true };
    const readStatus = vi.fn(async () => reply); const f = fixture(undefined, readStatus); const web = { ...session(), id: 'web' };
    f.list.adopt(capable([session(status()), web])); await vi.advanceTimersByTimeAsync(5_000);
    expect(f.list.project(session()).messenger).toBeDefined(); expect(f.list.project(session()).stale).toBe(true);
    f.document.visibilityState = 'hidden'; await vi.advanceTimersByTimeAsync(10_000); expect(readStatus).toHaveBeenCalledTimes(1);
    reply = { sessions: [{ id: 's' }, { id: 'web', messenger: status() }], messenger_status_available: true };
    f.document.visibilityState = 'visible'; const visibility = f.document.addEventListener.mock.calls[0]![1] as () => void; visibility();
    await vi.advanceTimersByTimeAsync(0); expect(readStatus).toHaveBeenLastCalledWith(['s', 'web']);
    expect(f.list.project(session()).messenger).toBeUndefined(); expect(f.list.project(web).messenger).toBeDefined();
  });

  it('falls back once for unsupported status RPCs and never probes servers without the capability', async () => {
    const readStatus = vi.fn().mockRejectedValue({ code: 'unknown_method' }); const f = fixture(undefined, readStatus);
    f.list.adopt({ sessions: [session(status())], messenger_status_available: true }); await vi.advanceTimersByTimeAsync(5_000);
    expect(readStatus).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledTimes(1);
    f.list.adopt(capable()); await vi.advanceTimersByTimeAsync(10_000);
    expect(readStatus).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(3);
  });

  it('rechecks an invalidation arriving during a read and ignores an obsolete unsupported reply', async () => {
    let finish!: (reply: ChatMessengerStatusResult) => void; let reject!: (error: unknown) => void;
    const readStatus = vi.fn<(ids: string[]) => Promise<ChatMessengerStatusResult>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockImplementation(async ids => narrowReply(ids));
    const f = fixture(undefined, readStatus); f.list.adopt(capable()); f.list.invalidate('s'); await vi.advanceTimersByTimeAsync(50);
    f.list.invalidate('s'); finish(narrowReply(['s'])); await vi.advanceTimersByTimeAsync(50); expect(readStatus).toHaveBeenCalledTimes(2);
    f.list.beginRead(); f.list.adopt(capable()); reject({ code: 'unknown_method' }); await vi.advanceTimersByTimeAsync(5_000);
    expect(readStatus).toHaveBeenCalledTimes(3); expect(f.read).not.toHaveBeenCalled(); expect(f.list.project(session()).stale).toBe(false);
    f.list.dispose(); await vi.advanceTimersByTimeAsync(20_000); expect(readStatus).toHaveBeenCalledTimes(3);
  });
  it('keeps filter identity through failed reads and rejects malformed status until recovery', () => {
    const f = fixture();
    f.list.adopt({ sessions: [session(status())], messenger_status_available: true, history_filters_available: true });
    expect(f.list.filtersAvailable()).toBe(true);
    expect(f.list.project(session()).messenger?.vendor).toBe('telegram');
    f.list.failed(); expect(f.list.statusUnavailable()).toBe(true); expect(f.list.project(session()).stale).toBe(true);
    f.list.adopt({ sessions: [session(status({ failed_count: -1 }))], messenger_status_available: true, history_filters_available: true });
    expect(f.list.statusUnavailable()).toBe(true);
    f.list.adopt({ sessions: [session(status())], messenger_status_available: true, history_filters_available: true });
    expect(f.list.statusUnavailable()).toBe(false); expect(f.list.project(session()).stale).toBe(false);
    f.list.adopt({ sessions: [session()], messenger_status_available: true });
    expect(f.list.filtersAvailable()).toBe(false); expect(f.list.project(session()).messenger).toBeUndefined();
  });
  it('coalesces delivery notifications, respects visibility, and stops on disposal', async () => {
    const f = fixture(); f.list.adopt({ sessions: [session(status())] });
    for (let i = 0; i < 20; i++) f.list.invalidate();
    await vi.advanceTimersByTimeAsync(50); expect(f.read).toHaveBeenCalledTimes(1);
    f.document.visibilityState = 'hidden'; await vi.advanceTimersByTimeAsync(10_000); expect(f.read).toHaveBeenCalledTimes(1);
    f.document.visibilityState = 'visible'; f.list.invalidate(); await vi.advanceTimersByTimeAsync(50); expect(f.read).toHaveBeenCalledTimes(2);
    f.list.dispose(); await vi.advanceTimersByTimeAsync(60_000); expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.document.removeEventListener).toHaveBeenCalled();
  });
  it('does not poll older servers or ordinary web-only histories, but retries a failed first status read', async () => {
    const f = fixture(); f.list.adopt({ sessions: [session()] });
    await vi.advanceTimersByTimeAsync(10_000); expect(f.read).not.toHaveBeenCalled();
    f.list.adopt({ sessions: [session()], messenger_status_available: false });
    await vi.advanceTimersByTimeAsync(5_000); expect(f.read).toHaveBeenCalledTimes(1);
    f.list.adopt({ sessions: [session()], messenger_status_available: true });
    await vi.advanceTimersByTimeAsync(10_000); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('keeps a stalled status read single-flight across notifications and defers to a newer full-list read', async () => {
    let finish!: (reply: MessengerSessionListReply) => void;
    const read = vi.fn(() => new Promise<MessengerSessionListReply>(resolve => { finish = resolve; }));
    const f = fixture(read); f.list.adopt({ sessions: [session(status())] });
    f.list.invalidate(); await vi.advanceTimersByTimeAsync(50);
    f.list.invalidate(); await vi.advanceTimersByTimeAsync(20_000); expect(read).toHaveBeenCalledTimes(1);
    f.list.beginRead(); f.list.adopt({ sessions: [], messenger_status_available: true });
    finish({ sessions: [session(status())], messenger_status_available: true }); await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('joins the initial delivery-panel read before focusing its recovery controls', async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const list = vi.fn(async () => { await held; return { generation: 'g', revision: 1, binding: null, deliveries: [], pending_count: 0, skipped_count: 0 }; });
    function conn(method: 'chat.deliveries.list'): Promise<ChatDeliverySnapshot>;
    function conn(method: 'chat.delivery.retry' | 'chat.delivery.skip'): Promise<{ ok: true }>;
    function conn(method: 'chat.messenger.connect'): Promise<{ session_id: string }>;
    async function conn(method: string): Promise<unknown> {
      if (method === 'chat.deliveries.list') return list();
      throw new Error(`Unexpected RPC: ${method}`);
    }
    const view = createChatDeliveryView(conn, vi.fn(), vi.fn()); cleanups.push(view.dispose);
    const read = view.refresh('s'); let ready = false;
    const focus = view.ready('s').then(() => { ready = true; });
    await Promise.resolve(); expect(ready).toBe(false); expect(list).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([read, focus]); expect(ready).toBe(true); expect(list).toHaveBeenCalledTimes(1);
  });
});
