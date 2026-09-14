import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDeliverySnapshot, ChatMessengerSessionStatus, ChatSessionSummary } from '@recued/contracts';
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
const fixture = (read = vi.fn<() => Promise<MessengerSessionListReply>>().mockResolvedValue({ sessions: [session(status())], messenger_status_available: true })) => {
  vi.useFakeTimers();
  const document = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    createElement: () => { throw new Error('These scheduling tests do not mount DOM'); } };
  const list = createMessengerSessionList({ document, read, openDelivery: vi.fn(), actionsLocked: () => false });
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
