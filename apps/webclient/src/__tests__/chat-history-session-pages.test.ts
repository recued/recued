import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionListResult } from '@recued/contracts';
import { createHistorySessionPages } from '../chat/history-session-pages.js';

const batch = (start: number, more = true): ChatSessionListResult => {
  const sessions = Array.from({ length: 50 }, (_, i) => ({ id: `s${start + i}`, created_at: 1, last_active_at: 1000 - start - i,
    message_count: 0, archived: false, picker_state: { current: 'self' as const }, model_routing: { current: 'byok' as const } }));
  const last = sessions.at(-1)!;
  return { sessions, history_paging_available: true, ...(more ? { next_cursor: { id: last.id, last_active_at: last.last_active_at } } : {}) };
};
describe('Chat history batch ownership', () => {
  it('refreshes a loaded filtered window in one advertised request while Load more remains one batch', async () => {
    const filters = { source: 'messenger' as const, vendor: 'telegram' as const, needs_attention: false };
    const first = { ...batch(0), history_refresh_available: true, filter_membership: 'same' };
    const refreshed = { ...batch(100), sessions: [...batch(0).sessions, ...batch(50).sessions, ...batch(100).sessions], history_refresh_available: true, filter_membership: 'same' };
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed).mockResolvedValueOnce({ ...batch(150, false), filter_membership: 'same' });
    const pages = createHistorySessionPages(read); await pages.reload({ filters });
    expect((await pages.reload({ filters }, 150))?.sessions).toHaveLength(150);
    expect(read.mock.calls[1]?.[0]).toEqual({ limit: 50, filters, refresh_count: 150 });
    await pages.more(); expect(read.mock.calls[2]?.[0]).toEqual({ limit: 50, filters, before: refreshed.next_cursor });
  });

  it('caps refresh windows and falls back to ordinary batches when an older server stops advertising support', async () => {
    const filters = { source: 'messenger' as const, vendor: 'all' as const, needs_attention: false };
    let older = false;
    const read = vi.fn(async (request: { before?: { id: string }; refresh_count?: number }) => {
      const start = request.before ? Number(request.before.id.slice(1)) + 1 : 0;
      const count = older ? 50 : request.refresh_count ?? 50;
      const sessions = Array.from({ length: count / 50 }, (_, i) => batch(start + i * 50).sessions).flat();
      const last = sessions.at(-1)!;
      return { ...batch(start), sessions, next_cursor: { id: last.id, last_active_at: last.last_active_at },
        ...(!older ? { history_refresh_available: true } : {}) };
    });
    const pages = createHistorySessionPages(read); await pages.reload({ filters });
    expect((await pages.reload({ filters }, 1050))?.sessions).toHaveLength(1050);
    expect(read.mock.calls.slice(1).map(([request]) => request.refresh_count)).toEqual([1000, undefined]);
    older = true; read.mockClear();
    expect((await pages.reload({ filters }, 150))?.sessions).toHaveLength(150);
    expect(read.mock.calls.map(([request]) => request.refresh_count)).toEqual([150, undefined, undefined]);
  });

  it('bounds requests and joins a pending Load more, retaining its cursor after failure', async () => {
    let fail!: (error: Error) => void;
    const read = vi.fn().mockResolvedValueOnce(batch(0)).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockResolvedValueOnce(batch(50, false));
    const pages = createHistorySessionPages(read); await pages.reload({});
    const pending = pages.more(); expect(pages.state().loading).toBe(true); await pages.more(); expect(read).toHaveBeenCalledTimes(2);
    fail(Object.assign(new Error('offline'), { code: 'server_offline' })); await expect(pending).rejects.toMatchObject({ code: 'server_offline' });
    expect(pages.state().reply?.next_cursor?.id).toBe('s49'); expect(pages.state().error).toBeTruthy();
    expect((await pages.more())?.sessions[0]?.id).toBe('s50'); expect(pages.state().reply?.next_cursor).toBeUndefined();
    expect(read.mock.calls.map(([args]) => args.limit)).toEqual([50, 50, 50]);
    expect(read.mock.calls[2]?.[0].before.id).toBe('s49');
  });
  it('discards an old appended reply after the owner changes the query', async () => {
    let finish!: (reply: ChatSessionListResult) => void;
    const read = vi.fn().mockResolvedValueOnce(batch(0)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(batch(100, false));
    const pages = createHistorySessionPages(read); await pages.reload({}); const old = pages.more();
    const current = await pages.reload({ query: 'old' }); finish(batch(50)); expect(await old).toBeUndefined();
    expect(pages.state().reply).toEqual(current); expect(read.mock.calls[2]?.[0]).toEqual({ query: 'old', limit: 50 });
  });
  it('refreshes the already loaded window through bounded reads and accepts old servers as complete lists', async () => {
    const read = vi.fn().mockResolvedValueOnce(batch(0)).mockResolvedValueOnce(batch(50)).mockResolvedValueOnce({ sessions: [...batch(0).sessions, ...batch(50).sessions] });
    const pages = createHistorySessionPages(read); expect((await pages.reload({}, 100))?.sessions).toHaveLength(100);
    expect(read.mock.calls[1]?.[0].before.id).toBe('s49');
    expect((await pages.reload({}))?.sessions).toHaveLength(100); expect(pages.state().available).toBe(false);
    await pages.more(); expect(read).toHaveBeenCalledTimes(3);
  });
  it('rejects non-advancing cursors and reloads when global filter membership changes between batches', async () => {
    const first = { ...batch(0), filter_membership: 'one' };
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce({ ...batch(50), filter_membership: 'two' }).mockResolvedValueOnce(first);
    const pages = createHistorySessionPages(read); await pages.reload({});
    await expect(pages.more()).rejects.toThrow(); expect(pages.state().operation).toBe('reload'); expect(pages.state().reply).toEqual(first);
    await expect(pages.more()).rejects.toThrow(); expect(pages.state().reply).toEqual(first);
  });
  it('does not publish a late result after disposal', async () => {
    let finish!: (reply: ChatSessionListResult) => void;
    const pages = createHistorySessionPages(() => new Promise(resolve => { finish = resolve; }));
    const read = pages.reload({}); pages.dispose(); finish(batch(0)); expect(await read).toBeUndefined(); expect(pages.state().reply).toBeUndefined();
  });
  it('keeps the cursor with its successful scope when a new search fails', async () => {
    const read = vi.fn().mockResolvedValueOnce(batch(0)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(batch(50, false));
    const pages = createHistorySessionPages(read); await pages.reload({});
    await expect(pages.reload({ query: 'different' })).rejects.toThrow('offline');
    await pages.more();
    expect(read.mock.calls[2]?.[0]).toEqual({ limit: 50, before: batch(0).next_cursor });
  });
});
