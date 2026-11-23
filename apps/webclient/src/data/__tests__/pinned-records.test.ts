import { expect, it, vi } from 'vitest';
import { createPinnedRecords, PINNED_RECORD_LIMIT } from '../pinned-records.js';
import { recentSourceRecord, type RecentWorkEntityRecord } from '../recent-work-records.js';

const task = (id = 'one'): RecentWorkEntityRecord => ({ kind: 'task', id, title: 'Saved task', source_id: 'recued.task', source_record_id: null, source_label: 'Recued', created_at: 1 });
const storage = () => {
  const values = new Map<string, string>(); let blocked = false;
  return { values, block: (value: boolean) => { blocked = value; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (blocked) throw Error('blocked'); values.set(key, value); },
    removeItem: (key: string) => { if (blocked) throw Error('blocked'); values.delete(key); } };
};

it('persists detached references for all five kinds, isolates pairings and matching account ids, and drops body fields', () => {
  const disk = storage(), pins = createPinnedRecords({ scope: 'pair-a', storage: disk });
  const rows = [task(), { ...task(), kind: 'note' as const },
    recentSourceRecord({ kind: 'contact', id: 'person', createdAt: 1, label: 'Riley' }, 'riley@example.test')!,
    ...['work', 'home'].flatMap(slug => [
      recentSourceRecord({ kind: 'mail', slug, recordId: 'shared/id', receivedAt: 1, identity: null, label: 'Email' }, slug)!,
      recentSourceRecord({ kind: 'calendar', slug, recordId: 'shared/id', sourceId: 'event', receivedAt: 1, incarnation: 'v1', label: 'Event' }, slug)!,
    ])];
  for (const row of rows) { const extra = { ...row, body: 'PRIVATE BODY', token: 'SECRET' }; expect(pins.pin(extra)).toBe(true); }
  expect(pins.list()).toHaveLength(7);
  expect(createPinnedRecords({ scope: 'pair-a', storage: disk }).list()).toEqual(pins.list());
  expect(createPinnedRecords({ scope: 'pair-b', storage: disk }).list()).toEqual([]);
  const clone = pins.list()[0]!; clone.title = 'mutated'; if ('origin' in clone) clone.origin.label = 'mutated';
  expect(pins.list()[0]!.title).not.toBe('mutated');
  expect([...disk.values.values()].join('')).not.toMatch(/PRIVATE BODY|SECRET/u);
});

it('retains pinned order while refreshing labels only for the same verified incarnation', () => {
  const disk = storage(), pins = createPinnedRecords({ scope: 'pair', storage: disk });
  pins.pin(task('one')); pins.pin(task('two'));
  pins.remember({ ...task('one'), title: 'Fresh title' });
  expect(pins.list().map(row => row.id)).toEqual(['two', 'one']); expect(pins.list()[1]!.title).toBe('Fresh title');
  pins.remember({ ...task('one'), title: 'Reused identity', created_at: 2 });
  pins.remember({ ...task('one'), title: 'Different provider record', source_record_id: 'replacement' });
  pins.remember(task('not-pinned')); expect(pins.list()).toHaveLength(2); expect(pins.list()[1]!.title).toBe('Fresh title');
  expect(pins.remove('task', 'two')).toBe(true);
  expect(createPinnedRecords({ scope: 'pair', storage: disk }).list().map(row => row.id)).toEqual(['one']);
});

it('never evicts a chosen pin for a new one and rejects malformed or oversized persisted references', () => {
  const disk = storage(), pins = createPinnedRecords({ scope: 'pair', storage: disk });
  for (let index = 0; index < PINNED_RECORD_LIMIT; index++) expect(pins.pin(task(String(index)))).toBe(true);
  const before = pins.list(); expect(pins.pin(task('overflow'))).toBe(false); expect(pins.list()).toEqual(before);
  for (const row of [{ ...task(), created_at: -1 }, { ...task(), created_at: Infinity }, { ...task(), source_record_id: 7 }, { ...task(), source_record_id: 'x'.repeat(2049) }])
    expect(pins.pin(row as RecentWorkEntityRecord)).toBe(false);
  const key = [...disk.values.keys()][0]!;
  disk.values.set(key, JSON.stringify([null, { kind: 'mail', id: 'forged', origin: { kind: 'contact' } }, { ...task(), source_record_id: 7 }, task('good'), task('good')]));
  expect(createPinnedRecords({ scope: 'pair', storage: disk }).list().map(row => row.id)).toEqual(['good']);
  disk.values.set(key, ' '.repeat(131_073)); expect(createPinnedRecords({ scope: 'pair', storage: disk }).list()).toEqual([]);
  disk.values.set(key, '{'); expect(createPinnedRecords({ scope: 'pair', storage: disk }).list()).toEqual([]);
});

it('does not claim persistence or lose existing pins when storage fails, and supports explicit memory-only use', () => {
  const disk = storage(), pins = createPinnedRecords({ scope: 'pair', storage: disk }); pins.pin(task()); disk.block(true);
  expect(pins.pin(task('two'))).toBe(false); expect(pins.remove('task', 'one')).toBe(false); expect(pins.clear()).toBe(false);
  expect(pins.list().map(row => row.id)).toEqual(['one']); disk.block(false); expect(pins.pin(task('two'))).toBe(true);
  const memory = createPinnedRecords({ scope: 'pair', storage: null }); expect(memory.pin(task())).toBe(true); expect(memory.remove('task', 'one')).toBe(true);
  vi.stubGlobal('localStorage', undefined);
  try { expect(createPinnedRecords({ scope: 'no-storage' }).pin(task())).toBe(false); } finally { vi.unstubAllGlobals(); }
});

it('merges another tab\'s saved pins before changing one shortcut', () => {
  const disk = storage(), first = createPinnedRecords({ scope: 'pair', storage: disk }), second = createPinnedRecords({ scope: 'pair', storage: disk });
  first.pin(task('one')); second.pin(task('two'));
  first.remember({ ...task('one'), title: 'Fresh title' }); expect(first.list().map(row => row.id)).toEqual(['two', 'one']);
  second.remove('task', 'two'); expect(first.list()).toEqual([{ ...task('one'), title: 'Fresh title' }]);
  first.pin(task('three')); second.pin(task('four')); expect(first.list().map(row => row.id)).toEqual(['four', 'three', 'one']);
});
