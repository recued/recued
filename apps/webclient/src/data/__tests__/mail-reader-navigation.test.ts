import { expect, it, vi } from 'vitest';
import type { CollectionListQuery, CollectionRecord } from '@recued/contracts';
import { createMailInbox } from '../mail-inbox.js';
import { createMailReaderNavigation } from '../mail-reader-navigation.js';

const records = Array.from({ length: 65 }, (_, index): CollectionRecord => ({
  record_id: `mail-${65 - index}`, source_id: `provider-${65 - index}`, received_at: 1_700_000_000_000 + 65 - index,
  modified_at: 1, size_bytes: 1, hot_fields: { is_read: false, is_flagged: true, direction: 'inbound', has_attachments: true },
}));
const setup = async () => {
  const requests: CollectionListQuery[] = [];
  let fail = false, hold = false, release!: () => void, allowed = true, reading = false, scope = 'all';
  const inbox = createMailInbox(async query => {
    requests.push(structuredClone(query));
    if (hold) { hold = false; await new Promise<void>(done => { release = done; }); }
    if (fail) { fail = false; throw new Error('Mail is unavailable.'); }
    return { records: records.filter(row => Object.entries(query.filters ?? {}).every(([key, value]) => row.hot_fields[key] === value))
      .filter(row => !query.before || row.received_at < query.before.received_at).slice(0, query.limit) };
  }, () => {});
  await inbox.select('work');
  const open = vi.fn(async (_id: string) => {});
  const navigation = createMailReaderNavigation({ inbox, open, changed: vi.fn(), beforeLeave: () => allowed,
    isReading: () => reading, scope: () => scope, canPage: () => scope === 'all',
    records: () => inbox.snapshot()!.records.filter(row => scope === 'all' || Number(row.source_id.slice(9)) % 2 === 1) });
  return { inbox, navigation, requests, open,
    fail: () => { fail = true; }, hold: () => { hold = true; }, release: () => release(),
    allow: (value: boolean) => { allowed = value; }, reading: (value: boolean) => { reading = value; }, scope: (value: string) => { scope = value; } };
};
const move = async (state: Awaited<ReturnType<typeof setup>>, direction = 'next') => {
  state.navigation.handle(`mail-reader-${direction}`);
  await vi.waitFor(() => expect(state.navigation.busy()).toBe(false));
};

it('walks the saved filtered order after the current email is marked read and removed from Unread', async () => {
  const state = await setup();
  await state.inbox.filter({ status: 'unread', direction: 'received', attachments: true });
  state.navigation.start('work', 'mail-64');
  const current = state.inbox.snapshot()!.records.find(row => row.record_id === 'mail-64')!;
  state.inbox.reconcile({ ...current, hot_fields: { ...current.hot_fields, is_read: true } });
  expect(state.inbox.snapshot()!.records.some(row => row.record_id === 'mail-64')).toBe(false);
  await move(state); await move(state, 'previous');
  expect(state.open.mock.calls.map(([id]) => id)).toEqual(['mail-63', 'mail-64']);
  expect(state.requests.at(-1)).toMatchObject({ slug: 'work', filters: { is_read: false, direction: 'inbound', has_attachments: true } });
});

it('loads only the next needed page, retries its exact cursor, and retains the current email on failure', async () => {
  const state = await setup(); state.navigation.start('work', 'mail-36');
  state.fail(); await move(state); expect(state.open).not.toHaveBeenCalled();
  expect(state.navigation.render('data-action')).toContain('unavailable');
  expect(state.requests[1]?.before).toEqual({ record_id: 'mail-36', received_at: records[29]!.received_at });
  await move(state);
  expect(state.requests[2]).toEqual(state.requests[1]); expect(state.open).toHaveBeenLastCalledWith('mail-35');
  await move(state, 'previous'); expect(state.open).toHaveBeenLastCalledWith('mail-36');
  expect(state.requests).toHaveLength(3);
});

it('blocks duplicate page reads and fences a late page after the reader is closed or another mailbox is selected', async () => {
  const state = await setup(); state.navigation.start('work', 'mail-36'); state.hold();
  state.navigation.handle('mail-reader-next'); state.navigation.handle('mail-reader-next');
  expect(state.requests).toHaveLength(2); expect(state.navigation.busy()).toBe(true);
  state.navigation.reset(); state.inbox.cancel();
  await state.inbox.select('other'); state.release(); await new Promise(resolve => setImmediate(resolve));
  expect(state.open).not.toHaveBeenCalled(); expect(state.navigation.render('data-action')).toBe('');
  expect(state.inbox.snapshot()?.slug).toBe('other');
});

it('checks the reply guard before paging and again before leaving after a delayed page', async () => {
  const state = await setup(); state.navigation.start('work', 'mail-36');
  state.allow(false); await move(state); expect(state.requests).toHaveLength(1);
  state.allow(true); state.reading(true); await move(state); expect(state.open).not.toHaveBeenCalled();
  state.reading(false); state.hold(); state.navigation.handle('mail-reader-next');
  state.allow(false); state.release();
  await vi.waitFor(() => expect(state.navigation.busy()).toBe(false)); expect(state.open).not.toHaveBeenCalled();
  state.allow(true); await move(state); expect(state.open).toHaveBeenLastCalledWith('mail-35');
});

it('keeps source, filter and loaded-record sphere scopes distinct and stops at the actual end', async () => {
  const state = await setup(); state.navigation.start('other', 'mail-65'); expect(state.navigation.render('data-action')).toBe('');
  state.navigation.start('work', 'missing'); expect(state.navigation.render('data-action')).toBe('');
  state.scope('professional'); state.navigation.start('work', 'mail-65');
  await move(state); expect(state.open).toHaveBeenLastCalledWith('mail-63');
  state.navigation.select('mail-37'); await move(state); expect(state.open).toHaveBeenCalledTimes(1);
  state.scope('all'); expect(state.navigation.render('data-action')).toBe('');
  await state.inbox.more(); await state.inbox.more(); state.navigation.start('work', 'mail-1');
  await move(state); expect(state.open).toHaveBeenCalledTimes(1);
  await move(state, 'previous'); expect(state.open).toHaveBeenLastCalledWith('mail-2');
  await state.inbox.filter({ status: 'all', direction: 'sent', attachments: false });
  expect(state.navigation.render('data-action')).toBe('');
});
