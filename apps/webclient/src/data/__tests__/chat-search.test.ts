import { describe, expect, it, vi } from 'vitest';
import type { ChatMessageSearchMatch, ChatMessageSearchResult } from '@recued/contracts';
import { createChatSearch, type ChatSearchCaller } from '../chat-search.js';

const row = (ts: number, message_id = `m${ts}`): ChatMessageSearchMatch => ({ session_id: 'conversation', message_id,
  ts, role: 'assistant', title: 'Planning', snippet: `Needle ${ts}` });
const page = (matches: ChatMessageSearchMatch[], next?: ChatMessageSearchMatch): ChatMessageSearchResult => ({ matches,
  incomplete: false, ...(next ? { next_cursor: { ts: next.ts, message_id: next.message_id } } : {}) });
const deferred = () => { let resolve!: (value: ChatMessageSearchResult) => void;
  const promise = new Promise<ChatMessageSearchResult>(done => { resolve = done; }); return { promise, resolve }; };

describe('chat messages in universal search', () => {
  it('retains an empty scan cursor and unreadable-row status until older messages are searched', async () => {
    const caller = vi.fn<ChatSearchCaller>().mockResolvedValueOnce({ ...page([], row(3)), incomplete: true })
      .mockResolvedValueOnce(page([row(2)]));
    const search = createChatSearch(caller, () => {});
    await search.load(' needle ');
    expect(search.state()).toMatchObject({ query: 'needle', matches: [], next_cursor: { ts: 3, message_id: 'm3' }, incomplete: true });
    await search.load('needle', true);
    expect(caller.mock.calls[1]).toEqual([{ query: 'needle', before: { ts: 3, message_id: 'm3' } }]);
    expect(search.state()).toMatchObject({ matches: [row(2)], incomplete: true, next_cursor: undefined });
  });
  it('keeps confirmed matches when More fails and retries the same cursor without duplicate reads', async () => {
    const pending = deferred();
    const caller = vi.fn<ChatSearchCaller>().mockResolvedValueOnce(page([row(3)], row(3)))
      .mockRejectedValueOnce(new Error('Chat search offline')).mockReturnValueOnce(pending.promise);
    const search = createChatSearch(caller, () => {});
    await search.load('needle'); await search.load('needle', true);
    expect(search.state()).toMatchObject({ matches: [row(3)], error: 'Chat search offline', retry_append: true });
    const retry = search.load('needle', true), duplicate = search.load('needle', true);
    expect(caller.mock.calls[2]).toEqual(caller.mock.calls[1]); expect(caller).toHaveBeenCalledTimes(3);
    pending.resolve(page([row(2)])); await Promise.all([retry, duplicate]);
    expect(search.state().matches).toEqual([row(3), row(2)]);
  });
  it('ignores replies from an edit away and back, or after disposal', async () => {
    const old = deferred(), disposed = deferred();
    const caller = vi.fn<ChatSearchCaller>().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page([row(2)])).mockReturnValueOnce(disposed.promise);
    const search = createChatSearch(caller, () => {});
    const first = search.load('needle'); search.reset(); await search.load('needle');
    old.resolve(page([row(3)])); await first;
    expect(search.state().matches).toEqual([row(2)]);
    const last = search.load('another'); search.dispose(); disposed.resolve(page([row(1)])); await last;
    expect(search.state().matches).not.toEqual([row(1)]);
  });
  it('uses the store’s UTF-8 ordering at timestamp ties and rejects a cursor that does not advance', async () => {
    const high = row(3, '🧭'), middle = row(3, '\uE000'), low = row(3, 'a');
    const caller = vi.fn<ChatSearchCaller>().mockResolvedValueOnce(page([high, middle], middle))
      .mockResolvedValueOnce(page([low], middle));
    const search = createChatSearch(caller, () => {});
    await search.load('needle'); expect(search.state().matches).toEqual([high, middle]);
    await search.load('needle', true);
    expect(search.state()).toMatchObject({ matches: [high, middle], error: 'The chat search page could not be confirmed. Try again.' });
  });
  it('refreshes the loaded prefix on return, removing a deleted hit without reducing the requested page depth', async () => {
    const caller = vi.fn<ChatSearchCaller>().mockResolvedValueOnce(page([row(4), row(3)], row(3)))
      .mockResolvedValueOnce(page([row(2), row(1)]));
    const search = createChatSearch(caller, () => {});
    await search.load('needle'); await search.load('needle', true);
    const refreshed = vi.fn<ChatSearchCaller>().mockResolvedValueOnce(page([row(4), row(3)], row(3)))
      .mockResolvedValueOnce(page([row(1)]));
    const resumed = createChatSearch(refreshed, () => {}); resumed.restore(search.snapshot());
    await resumed.load('needle');
    expect(resumed.state().matches).toEqual([row(4), row(3), row(1)]);
    expect(resumed.state().pages).toBe(2);
    expect(refreshed.mock.calls[1]).toEqual([{ query: 'needle', before: { ts: 3, message_id: 'm3' } }]);
  });
  it('distinguishes an unavailable server capability from a successful search with no hits', async () => {
    for (const code of ['unknown_method', 'not_configured']) {
      const search = createChatSearch(async () => { throw { code, message: 'Unavailable' }; }, () => {});
      await search.load('needle'); expect(search.state()).toMatchObject({ unsupported: true, loading: false, matches: [] });
    }
  });
});
