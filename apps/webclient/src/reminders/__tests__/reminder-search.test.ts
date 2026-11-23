import { describe, expect, it, vi } from 'vitest';
import { RpcError, type ReminderListResult, type ReminderSearchStatus, type ReminderView } from '@recued/contracts';
import { createReminderSearch, validateReminderSearchPage, type ReminderSearchCaller } from '../reminder-search.js';
import { renderReminderSearch } from '../reminder-search-view.js';
import { renderUniversalSearch } from '../../data/universal-search.js';

const AT = Date.parse('2026-11-01T15:00:00Z');
const row = (id: string, state: ReminderView['state'] = 'delivered'): ReminderView => ({ reminder_id: id,
  text: 'Clinic ' + id, at: AT, state, when: 'Sunday 1 November at 10:00 AM', time_zone: 'America/New_York', delivered_at: state === 'delivered' ? AT : null });
const page = (rows: ReminderView[], total = rows.length, more = false, state: ReminderSearchStatus = 'all'): ReminderListResult =>
  ({ reminders: rows, count: 1, page: { state, matched_count: total,
    next_cursor: more ? { at: rows.at(-1)!.at, reminder_id: rows.at(-1)!.reminder_id } : null } });
const input = { query: 'clinic', state: 'all' as const };
const deferred = () => { let resolve!: (out: ReminderListResult) => void; const promise = new Promise<ReminderListResult>(done => { resolve = done; }); return { promise, resolve }; };

describe('reminder search ownership and paging', () => {
  it('fences older date windows and carries exact bounds through paging and return refreshes', async () => {
    const held = deferred(), from = AT - 3600000, before = AT + 3600000;
    const caller = vi.fn<ReminderSearchCaller>().mockImplementationOnce(() => held.promise)
      .mockImplementation(async args => args.page?.cursor ? page([row('rem_b')], 2) : page([row('rem_a')], 2, true));
    const search = createReminderSearch(caller, vi.fn()), old = search.load({ ...input, from: 0, before: AT + 86400000 });
    await search.load({ ...input, from, before });held.resolve(page([row('rem_old')]));await old;
    await search.load({ ...input, from, before }, true);const snapshot = search.snapshot();search.reset();search.restore(snapshot);await search.load({ ...input, from, before });
    expect(search.state().matches.map(row => row.reminder_id)).toEqual(['rem_a', 'rem_b']);
    for (const [args] of caller.mock.calls.slice(1))expect(args.page).toMatchObject({ from, before });
    search.dispose();
  });
  it('requires an exact email scope acknowledgement and refuses another mailbox or enrollment', () => {
    const mail_ref = { slug: 'work', record_id: 'email', source_id: 'uid-1', received_at: AT, incarnation: 'work-v1' };
    const linked = { ...row('rem_a', 'pending'), mail_ref }, input = { mail_ref, state: 'pending' as const };
    const out = { ...page([linked], 1, false, 'pending'), page: { ...page([linked], 1, false, 'pending').page!, mail_ref } };
    expect(() => validateReminderSearchPage(out, input)).not.toThrow();
    expect(() => validateReminderSearchPage(page([linked], 1, false, 'pending'), input)).toThrow('Update your Recued server');
    for (const ref of [{ ...mail_ref, slug: 'personal' }, { ...mail_ref, incarnation: 'work-v2' }, { ...mail_ref, received_at: AT + 1 }])
      expect(() => validateReminderSearchPage({ ...out, reminders: [{ ...linked, mail_ref: ref }] }, input)).toThrow('could not be confirmed');
  });
  it('requires the exact record acknowledgement and validates linked rows and terminal-only history', () => {
    const record_ref = { kind: 'task' as const, id: 'task-one', source_id: 'recued.task', source_record_id: null, created_at: AT };
    const linked = { ...row('rem_a'), record_ref }, scope = { state: 'all' as const, record_ref, history_only: true as const };
    const out = { ...page([linked]), page: { ...page([linked]).page!, record_ref, history_only: true as const } };
    expect(() => validateReminderSearchPage(out, scope)).not.toThrow();
    expect(() => validateReminderSearchPage(page([linked]), scope)).toThrow('Update your Recued server');
    for (const broken of [{ ...out, reminders: [row('rem_a')] },
      { ...out, reminders: [{ ...linked, record_ref: { ...record_ref, created_at: AT + 1 } }] },
      { ...out, reminders: [{ ...linked, state: 'pending' as const }] },
      { ...out, page: { ...out.page, history_only: undefined } }])
      expect(() => validateReminderSearchPage(broken, scope)).toThrow('could not be confirmed');
  });

  it('does not retain another record lifetime or accept its late results', async () => {
    const record_ref = { kind: 'task' as const, id: 'task-one', source_id: 'recued.task', source_record_id: null, created_at: AT };
    const later = { ...record_ref, created_at: AT + 1 }, held = deferred();
    const scoped = (ref: typeof record_ref) => {
      const out = page([{ ...row('rem_a'), record_ref: ref }]);
      return { ...out, page: { ...out.page!, record_ref: ref } };
    };
    const caller = vi.fn<ReminderSearchCaller>().mockImplementationOnce(() => held.promise).mockResolvedValueOnce(scoped(later));
    const search = createReminderSearch(caller, vi.fn());
    const old = search.load({ state: 'all', record_ref });
    await search.load({ state: 'all', record_ref: later }); held.resolve(scoped(record_ref)); await old;
    expect(search.state().matches[0]?.record_ref).toEqual(later); search.dispose();
  });
  it('restarts rather than endlessly retrying an old cursor when result membership changed between pages', async () => {
    const caller = vi.fn<ReminderSearchCaller>().mockResolvedValueOnce(page([row('rem_a'), row('rem_b')], 3, true))
      .mockResolvedValueOnce(page([row('rem_c')], 2)).mockResolvedValueOnce(page([row('rem_b'), row('rem_c')], 2));
    const search = createReminderSearch(caller, vi.fn()); await search.load(input); await search.load(input, true);
    expect(search.state()).toMatchObject({ retry_append: false, error: expect.stringContaining('changed while searching') });
    await search.load(input, search.state().retry_append === true);
    expect(caller.mock.calls[2]![0].page?.cursor).toBeUndefined();
    expect(search.state().matches.map(row => row.reminder_id)).toEqual(['rem_b', 'rem_c']); expect(search.state().error).toBeUndefined(); search.dispose();
  });
  it('pages confirmed matches and refreshes the loaded pages on the same scope', async () => {
    const caller = vi.fn<ReminderSearchCaller>(async args => args.page?.cursor ? page([row('rem_c')], 3) : page([row('rem_a'), row('rem_b')], 3, true));
    const search = createReminderSearch(caller, vi.fn());
    await search.load(input); await search.load(input, true);
    expect(search.state().matches.map(row => row.reminder_id)).toEqual(['rem_a', 'rem_b', 'rem_c']);
    expect(search.state()).toMatchObject({ pages: 2, total: 3, next_cursor: null });
    expect(caller.mock.calls[1]![0].page).toMatchObject({ query: 'clinic', state: 'all', cursor: { at: AT, reminder_id: 'rem_b' } });
    await search.load(input); expect(caller).toHaveBeenCalledTimes(4); expect(search.state().matches).toHaveLength(3);
    search.dispose();
  });

  it('preserves loaded results on a failed append and admits one retry for its cursor', async () => {
    const held = deferred(), caller = vi.fn<ReminderSearchCaller>().mockResolvedValueOnce(page([row('rem_a')], 2, true))
      .mockRejectedValueOnce(new Error('Next page interrupted')).mockImplementation(() => held.promise);
    const search = createReminderSearch(caller, vi.fn()); await search.load(input); await search.load(input, true);
    expect(search.state()).toMatchObject({ error: 'Next page interrupted', retry_append: true, total: 2 });
    expect(search.state().matches).toHaveLength(1);
    const first = search.load(input, true), second = search.load(input, true);
    expect(first).toBe(second); expect(caller).toHaveBeenCalledTimes(3);
    expect(caller.mock.calls[2]![0]).toEqual(caller.mock.calls[1]![0]);
    held.resolve(page([row('rem_b')], 2)); await first;
    expect(search.state().matches).toHaveLength(2); expect(search.state().error).toBeUndefined(); search.dispose();
  });

  it('drops old replies after status or wording changes, including a return to the same words', async () => {
    const all = deferred(), cancelled = deferred();
    const caller = vi.fn<ReminderSearchCaller>().mockImplementationOnce(() => all.promise).mockImplementationOnce(() => cancelled.promise)
      .mockResolvedValue(page([{ ...row('rem_d'), text: 'Dentist' }]));
    const search = createReminderSearch(caller, vi.fn());
    const older = search.load(input), newer = search.load({ ...input, state: 'cancelled' });
    cancelled.resolve(page([row('rem_c', 'cancelled')], 1, false, 'cancelled')); await newer;
    all.resolve(page([row('rem_a')])); await older;
    expect(search.state().input.state).toBe('cancelled'); expect(search.state().matches[0]?.reminder_id).toBe('rem_c');
    const pending = deferred(); caller.mockImplementationOnce(() => pending.promise);
    const stale = search.load(input); await search.load({ query: 'dentist', state: 'all' });
    expect(search.state().matches[0]?.text).toBe('Dentist');
    caller.mockResolvedValueOnce(page([row('rem_new')]));
    await search.load(input);
    pending.resolve(page([row('rem_old')])); await stale;
    expect(search.state().matches[0]?.reminder_id).toBe('rem_new'); search.dispose();
  });

  it('does not claim an empty search or offer cloud search when an old server ignores history scope', async () => {
    const caller = vi.fn<ReminderSearchCaller>(async () => ({ reminders: [], count: 0, page: { matched_count: 0, next_cursor: null } }));
    const search = createReminderSearch(caller, vi.fn()); await search.load(input);
    expect(search.state().unsupported).toBe(true);
    const html = renderUniversalSearch({ query: 'clinic', actionAttr: 'data-act', groups: [], workGroups: [], recipes: [], packs: [],
      reminderSearch: search.state(), marketplaceOffered: true });
    expect(html).toContain('Update your Recued server'); expect(html).not.toContain('No matches in the searched sources');
    expect(html).not.toContain('universal-search-marketplace'); search.dispose();
  });

  it('refuses wrong scopes, wrong-status rows and invalid or repeated cursors', async () => {
    for (const out of [page([row('rem_a')], 1, false, 'pending'), page([row('rem_a', 'pending')], 1, false, 'delivered'),
      { ...page([row('rem_a')], 1, true, 'delivered'), page: { state: 'delivered' as const, matched_count: 1, next_cursor: { at: AT, reminder_id: 'rem_wrong' } } }]) {
      const search = createReminderSearch(async () => out, vi.fn()); await search.load({ ...input, state: 'delivered' });
      expect(search.state().error).toContain('could not be confirmed'); expect(search.state().matches).toEqual([]); search.dispose();
    }
    const search = createReminderSearch(async () => page([row('rem_a')], 2, true), vi.fn());
    await search.load(input); await search.load(input, true);
    expect(search.state().error).toContain('could not be confirmed'); expect(search.state().matches).toHaveLength(1); search.dispose();
  });

  it('restores an independent snapshot and retires pending reads on restoration or disposal', async () => {
    const held = deferred(), changed = vi.fn(), caller = vi.fn<ReminderSearchCaller>().mockResolvedValueOnce(page([row('rem_a')])).mockImplementation(() => held.promise);
    const search = createReminderSearch(caller, changed); await search.load(input); const snapshot = search.snapshot();
    const pending = search.load({ query: 'other', state: 'cancelled' }); search.restore(snapshot);
    snapshot.matches[0]!.text = 'Changed outside the controller';
    held.resolve(page([row('rem_z', 'cancelled')], 1, false, 'cancelled')); await pending;
    expect(search.state().matches[0]?.text).toBe('Clinic rem_a');
    const pendingDisposed = search.load(input); search.dispose(); const paints = changed.mock.calls.length; await pendingDisposed;
    expect(changed).toHaveBeenCalledTimes(paints);
  });

  it('bounds queries and keeps pending, unsupported and real failures distinct', async () => {
    const caller = vi.fn<ReminderSearchCaller>(); const search = createReminderSearch(caller, vi.fn());
    await search.load({ ...input, query: 'x'.repeat(201) }); expect(caller).not.toHaveBeenCalled(); expect(search.state().error).toContain('200 characters');
    caller.mockRejectedValueOnce(new RpcError('unknown_method', 'Old server')); await search.load(input);
    expect(search.state().unsupported).toBe(true);
    expect(renderReminderSearch(search.state(), 'data-act')).not.toContain('No reminders match');
    search.dispose();
  });
});
