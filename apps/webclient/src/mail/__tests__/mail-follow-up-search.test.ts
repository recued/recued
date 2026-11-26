import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mailFollowUpTimeHref, parseMailFollowUpAddress, parseSavedDataViewDefinition, type MailFollowUp, type MailFollowUpPage } from '@recued/contracts';
import { createMailFollowUpSearch, followUpResultHref, readFollowUpPage } from '../mail-follow-up-search.js';
import { createTodayFollowUps } from '../../today/follow-ups.js';
import { renderUniversalSearch, SEARCH_MARKETPLACE_ACTION } from '../../data/universal-search.js';
import { searchTypeCounts } from '../../data/universal-search-filter.js';

const now = Date.parse('2026-11-23T18:00Z');
const watch = (n = 1): MailFollowUp => ({ id: `mfw_00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, revision: 1, subject: 'Renewal',
  mail_ref: { slug: 'work', record_id: 'sent-1', source_id: 'provider-sent-1', received_at: now - 100, incarnation: 'box-1' },
  state: 'waiting', check_at: now, created_at: now, updated_at: now });
const page = (rows: MailFollowUp[] = []): MailFollowUpPage => ({ watches: rows, next_cursor: null });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('reply watch search and Today', () => {
  it('continues empty encrypted pages, includes history, and saves filters and cursor independently of live objects', async () => {
    const row = { ...watch(), state: 'replied' as const }, cursor = { updated_at: now - 1, id: watch(2).id };
    const call = vi.fn().mockResolvedValueOnce({ watches: [], next_cursor: cursor }).mockResolvedValueOnce(page([row]));
    const search = createMailFollowUpSearch(call, vi.fn(), { state: 'replied', mailbox: 'work' });
    await search.load('renewal');
    expect(call).toHaveBeenNthCalledWith(2, { query: 'renewal', state: 'replied', mailbox: 'work', limit: 5, cursor });
    const snapshot = search.snapshot(); search.state().matches[0]!.mail_ref.slug = 'changed';
    search.restore(snapshot); expect(search.state().matches[0]!.mail_ref.slug).toBe('work');
    expect(parseSavedDataViewDefinition({ tab: 'search', query: 'renewal', result_type: 'follow_up', follow_up_filters: snapshot.filters }))
      .toEqual({ tab: 'search', query: 'renewal', result_type: 'follow_up', follow_up_filters: { state: 'replied', mailbox: 'work' } });
    expect(parseSavedDataViewDefinition({ tab: 'search', query: '', follow_up_filters: { state: 'made-up' } })).toBeNull();
  });

  it('bounds a sparse encrypted history and exposes continuation without an empty claim or marketplace offer', async () => {
    let n = 0;
    const call = vi.fn(async (): Promise<MailFollowUpPage> => ++n <= 32 ? { watches: [], next_cursor: { updated_at: now - n, id: watch(n).id } } : page([watch()]));
    const search = createMailFollowUpSearch(call, vi.fn()); await search.load('renewal');
    expect(call).toHaveBeenCalledTimes(32); expect(search.state().next_cursor).not.toBeNull();
    const html = renderUniversalSearch({ query: 'renewal', actionAttr: 'data-action', groups: [], workGroups: [], followUpSearch: search.state(), marketplaceOffered: true });
    expect(html).not.toContain('No matches in the searched sources'); expect(html).not.toContain('No reply watches match'); expect(html).not.toContain('universal-search-marketplace');
    expect(searchTypeCounts({ query: 'renewal', actionAttr: 'data-action', followUpSearch: search.state() }).follow_up).toMatchObject({ loaded: 0, more: true });
    await search.load('renewal', true); expect(search.state().matches.map(row => row.id)).toEqual([watch().id]); expect(search.state().next_cursor).toBeNull();
  });

  it('retires pending query and filter results at the edit boundary', async () => {
    const held = deferred<MailFollowUpPage>();
    const call = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce(page([{ ...watch(2), subject: 'New renewal', state: 'replied' }]));
    const search = createMailFollowUpSearch(call, vi.fn()); const old = search.load('old');
    search.setFilters({ state: 'replied' }); await search.load('new'); held.resolve(page([watch()])); await old;
    expect(search.state()).toMatchObject({ query: 'new', filters: { state: 'replied' }, matches: [{ id: watch(2).id }] });
  });

  it('reports malformed, stalled and unavailable pages without claiming a successful empty search', async () => {
    const cursor = { updated_at: now, id: watch().id };
    await expect(readFollowUpPage(async () => ({ watches: [], next_cursor: cursor }), { cursor })).rejects.toThrow('did not advance');
    await expect(readFollowUpPage(async () => page([{ ...watch(), mail_ref: {} as never }]), {})).rejects.toThrow('could not be confirmed');
    await expect(readFollowUpPage(async () => page([watch()]), { state: 'replied' })).rejects.toThrow('could not confirm the reply watch filters');
    const search = createMailFollowUpSearch(async () => { throw { code: 'unknown_method' }; }, vi.fn()); await search.load('renewal');
    expect(search.state().unsupported).toBe(true);
    expect(renderUniversalSearch({ query: 'renewal', resultType: 'follow_up', actionAttr: 'data-action', followUpSearch: search.state() })).not.toContain('No Reply watches results loaded');
  });

  it('reads every Today page without checking a thread and retains confirmed work with a visible refresh failure', async () => {
    const rows = Array.from({ length: 51 }, (_, n) => watch(n + 1));
    const list = vi.fn().mockResolvedValueOnce({ watches: rows.slice(0, 50), next_cursor: { updated_at: now, id: watch(50).id } }).mockResolvedValueOnce(page(rows.slice(50)));
    const today = createTodayFollowUps({ list, now: () => now, changed: vi.fn() });
    expect(today.canClaimEmpty()).toBe(false); await today.load(); expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]![0]).toEqual({ attention_at: now }); expect(today.current()).toBe(true); expect(today.canClaimEmpty()).toBe(false);
    list.mockRejectedValueOnce(Error('Watch store unavailable')); await today.load();
    expect(today.render('data-action')).toContain('Watch store unavailable'); expect(today.render('data-action')).toContain(watch(51).id);
    expect(today.current()).toBe(false); expect(today.canClaimEmpty()).toBe(false); today.dispose();
  });

  it('⛔ a search on a server without reply watches still says "No matches" and offers the marketplace', async () => {
    // 26.11.26 cut: counted as uncertain, an absent source took "No matches", "Did you mean" and the marketplace
    // offer away from every search on a server not yet updated. A server without reply watches has none.
    for (const code of ['unknown_method', 'not_configured']) {
      const search = createMailFollowUpSearch(async () => { throw { code }; }, vi.fn()); await search.load('renewal');
      expect(search.state().unsupported, code).toBe(true);
      const html = renderUniversalSearch({ query: 'renewal', actionAttr: 'data-act', groups: [], marketplaceOffered: true,
        followUpSearch: search.state() });
      expect(html, code).toContain('No matches in the searched sources');
      expect(html, code).toContain(`data-act="${SEARCH_MARKETPLACE_ACTION}"`);
    }
  });

  it('⛔ opening a scheduled prompt from Search does not wait on reply watches', () => {
    // 26.11.26 cut: the marketplace guard's reply-watch clause sat in the prompt-open guard, so a plain click on a
    // Scheduled-prompt result did nothing whenever a reply watch matched, and always on a server without them.
    const route = readFileSync(fileURLToPath(new URL('../../data/bootstrap-data-route.ts', import.meta.url)), 'utf8');
    const start = route.indexOf('if (action === SEARCH_OPEN_PROMPT) {');
    const guard = route.slice(start, route.indexOf('const id = target.getAttribute(SEARCH_PROMPT_ID)', start));
    expect(start).toBeGreaterThan(0); expect(guard).toContain('promptOpening');
    expect(guard).not.toContain('followUpSearch');
  });

  it('⛔ a server without reply watches holds nothing on Today: no card, and its empty state and freshness stand', async () => {
    // 26.11.26 cut: an older server answers `unknown_method` (an unwired one, `not_configured`). Today kept a
    // "Reply watches are unavailable" alert, hid "Nothing is due" and failed every return-to-Today check.
    for (const code of ['unknown_method', 'not_configured']) {
      const list = vi.fn().mockRejectedValue({ code });
      const today = createTodayFollowUps({ list, now: () => now, changed: vi.fn() });
      await today.load();
      expect(today.render('data-action'), code).toBe('');
      expect(today.canClaimEmpty(), code).toBe(true); expect(today.current(), code).toBe(true);
      // Each load still asks, so a server that updates brings the card in without a reload.
      list.mockResolvedValueOnce(page([watch(1)])); await today.load();
      expect(today.render('data-action'), code).toContain(watch(1).id); expect(today.canClaimEmpty(), code).toBe(false);
      today.dispose();
    }
  });

  it('does not accept a future snooze as due work and keeps draft links tied to the alert cycle', async () => {
    const today = createTodayFollowUps({ list: async () => page([{ ...watch(), check_at: now + 1 }]), now: () => now, changed: vi.fn() });
    await today.load(); expect(today.current()).toBe(false); expect(today.render('data-action')).not.toContain('No reply watches need attention');
    const ready = { ...watch(), state: 'draft_ready' as const, draft_id: 'mad_00000000-0000-0000-0000-000000000001', schedule_version: 2 };
    expect(followUpResultHref(ready)).toBe(`#mail/reply-watch/${ready.id}/draft/${ready.draft_id}/cycle/2`);
    expect(parseMailFollowUpAddress(mailFollowUpTimeHref(ready.id).slice('#mail/'.length).split('/'))).toEqual({ id: ready.id, edit_time: true });
  });
});
