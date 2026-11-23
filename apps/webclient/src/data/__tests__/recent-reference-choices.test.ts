import { expect, it } from 'vitest';
import { createRecentReferenceChoices, sameReferenceChoice, type RecentReferenceChoice } from '../recent-reference-choices.js';
import { recentReferencePage } from '../recent-reference-picker.js';
import type { RecentSearchStorage } from '../recent-searches.js';

const choice = (id: string, kind: RecentReferenceChoice['kind'] = 'task'): RecentReferenceChoice => ({ kind, id, createdAt: 1,
  ...(kind === 'contact' ? {} : { sourceId: 'recued.' + kind, sourceRecordId: null }) });
const memory = () => {
  const data = new Map<string, string>();
  const storage: RecentSearchStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  return { data, storage };
};

it('keeps eight choices per kind, promotes a repeated choice, copies outputs and persists identities without record contents', () => {
  const { storage, data } = memory(), recent = createRecentReferenceChoices({ scope: 'pair', storage });
  for (const kind of ['contact', 'project', 'task'] as const) for (let i = 0; i < 10; i++) recent.remember(choice(String(i), kind));
  recent.remember({ ...choice('5'), title: 'Private title', body: 'Private body', email: 'Private email' } as RecentReferenceChoice);
  expect(recent.list('task').map(row => row.id)).toEqual(['5', '9', '8', '7', '6', '4', '3', '2']);
  expect(recent.list('contact')).toHaveLength(8); expect(recent.list('project')).toHaveLength(8);
  recent.list('task')[0]!.id = 'External mutation';
  expect(createRecentReferenceChoices({ scope: 'pair', storage }).list('task')).toEqual(recent.list('task'));
  expect([...data.values()].join('')).not.toContain('Private');
  expect(sameReferenceChoice(choice('5'), { ...choice('5'), createdAt: 2 })).toBe(false);
  expect(sameReferenceChoice(choice('5'), { ...choice('5'), sourceId: 'replacement' })).toBe(false);
});

it('isolates servers and pairings, clears only the chosen kind and retires its old read epoch', () => {
  const { storage } = memory(), first = createRecentReferenceChoices({ scope: 'server/pair1', storage }), other = createRecentReferenceChoices({ scope: 'other/pair1', storage });
  first.remember(choice('same')); first.remember(choice('same', 'contact')); other.remember(choice('same'));
  const epoch = first.clearEpoch('task'); expect(first.clear('task')).toBe(true); expect(first.clearEpoch('task')).toBeGreaterThan(epoch);
  expect(createRecentReferenceChoices({ scope: 'server/pair1', storage }).list('task')).toEqual([]);
  expect(first.list('contact')).toEqual([choice('same', 'contact')]); expect(other.list('task')).toEqual([choice('same')]);
  expect(createRecentReferenceChoices({ scope: 'server/pair2', storage }).list('contact')).toEqual([]);
});

it('rejects corrupt or oversized stored data and incomplete identities, preserving opaque valid ids', () => {
  const { data, storage } = memory(), recent = createRecentReferenceChoices({ scope: 'pair', storage }); recent.remember(choice('initial'));
  const key = [...data.keys()][0]!;
  data.set(key, JSON.stringify([null, { ...choice('bad'), kind: 'note' }, { ...choice('bad'), createdAt: '1' }, { ...choice('bad'), sourceId: undefined },
    choice('bad\u0000id'), choice("opaque/id?二!'*"), choice('same'), choice('same')]));
  expect(createRecentReferenceChoices({ scope: 'pair', storage }).list('task')).toEqual([choice("opaque/id?二!'*"), choice('same')]);
  for (const raw of ['{broken', '{}', 'x'.repeat(65537)]) { data.set(key, raw); expect(createRecentReferenceChoices({ scope: 'pair', storage }).list('task')).toEqual([]); }
});

it('keeps failed clearing retryable and provides an in-memory history when storage is unavailable', () => {
  const { storage } = memory(); let fail = false;
  const recent = createRecentReferenceChoices({ scope: 'pair', storage: { ...storage,
    setItem(key, value) { if (fail) throw Error('Blocked'); storage.setItem(key, value); }, removeItem(key) { if (fail) throw Error('Blocked'); storage.removeItem(key); } } });
  recent.remember(choice('one')); fail = true; const epoch = recent.clearEpoch('task');
  expect(recent.clear('task')).toBe(false); expect(recent.clearEpoch('task')).toBe(epoch); expect(recent.list('task')).toEqual([choice('one')]);
  recent.remember(choice('two')); expect(recent.list('task').map(row => row.id)).toEqual(['two', 'one']); fail = false; expect(recent.clear('task')).toBe(true);
  const transient = createRecentReferenceChoices({ scope: 'pair', storage: null }); transient.remember(choice('one')); expect(transient.clear('task')).toBe(true);
});

it('keeps fresh usable choices in order, reports partial read failures and distinguishes an empty recent list from an empty search', async () => {
  const recent = createRecentReferenceChoices({ scope: 'pair', storage: null });
  expect(await recentReferencePage(recent, 'task', async () => null, () => true)).toMatchObject({ options: [], emptyText: 'No recent tasks yet. Type to search.' });
  for (const id of ['missing', 'failed', 'second', 'first']) recent.remember(choice(id));
  const page = await recentReferencePage(recent, 'task', async row => {
    if (row.id === 'failed') throw Error('Interrupted'); return row.id === 'missing' ? null : { id: row.id, label: 'Fresh ' + row.id };
  }, () => true);
  expect(page.options.map(option => option.id)).toEqual(['first', 'second']); expect(page.options[0]?.sublabel).toBe('Recent choice');
  expect(page.retryableError).toContain('could not be checked');
});

it('does not return a recent page after history was cleared or its editor retired', async () => {
  const recent = createRecentReferenceChoices({ scope: 'pair', storage: null }); recent.remember(choice('one'));
  let release!: () => void; const pending = new Promise<void>(done => { release = done; });
  const result = recentReferencePage(recent, 'task', async row => { await pending; return { id: row.id, label: 'Late title' }; }, () => true);
  expect(recent.clear('task')).toBe(true); release(); expect((await result).options).toEqual([]);
  recent.remember(choice('one')); let current = true;
  const retired = recentReferencePage(recent, 'task', async row => { current = false; return { id: row.id, label: 'Retired title' }; }, () => current);
  expect((await retired).options).toEqual([]);
});
