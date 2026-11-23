import { expect, it } from 'vitest';
import { createReaderStateStore, readingRecord, type ReadingEntity, type SavedReaderState } from '../reader-state.js';
import type { RecentSearchStorage } from '../recent-searches.js';

const entity = (id = 'one', kind: 'note' | 'task' = 'note'): ReadingEntity => ({ _kind: kind, id, source_id: `recued.${kind}`,
  source_record_id: undefined, created_at: 1, title: 'Private heading', body: 'Private body https://secret.test/?token=private' } as ReadingEntity);
const state = (): SavedReaderState => ({ format: 'formatted', positions: { formatted: { top: 420, outlineTop: 12, sections: [['activity', true]], anchor: { index: 2, offset: -8 } } },
  find: { open: true, query: 'match', active: 3 } });
const memory = () => {
  const data = new Map<string, string>();
  const storage: RecentSearchStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  return { data, storage };
};

it('stores only bounded reading metadata, restores across boots, and copies nested state', () => {
  const { data, storage } = memory(), store = createReaderStateStore({ scope: 'pair', storage }), ref = readingRecord(entity());
  store.set(ref, { ...state(), focus: 'https://private.test/?token=secret' } as SavedReaderState);
  const restored = createReaderStateStore({ scope: 'pair', storage }); expect(restored.get(ref)).toEqual(state());
  const exposed = restored.get(ref)!; exposed.positions.formatted!.anchor!.index = 50; exposed.positions.formatted!.sections[0]![1] = false;
  expect(restored.get(ref)).toEqual(state());
  const raw = [...data.values()].join(''); expect(raw).not.toContain('Private heading'); expect(raw).not.toContain('Private body'); expect(raw).not.toContain('private.test'); expect(raw).not.toContain('token=');
});

it('separates tasks, notes, sources, provider identities, incarnations and paired servers', () => {
  const { storage } = memory(), store = createReaderStateStore({ scope: 'pair', storage }), ref = readingRecord(entity()); store.set(ref, state());
  expect(store.get(readingRecord(entity('one', 'task')))).toBeUndefined();
  for (const patch of [{ sourceId: 'other.note' }, { sourceRecordId: 'different-provider-record' }, { createdAt: 2 }]) expect(store.get({ ...ref, ...patch })).toBeUndefined();
  expect(createReaderStateStore({ scope: 'other-pair', storage }).get(ref)).toBeUndefined(); expect(store.get(ref)).toEqual(state());
});

it('keeps display preference when text changes while retiring stale positions and Find matches', () => {
  const { storage } = memory(), store = createReaderStateStore({ scope: 'pair', storage }), original = entity(), ref = readingRecord(original); store.set(ref, state());
  for (const changed of [{ ...original, body: 'Changed body' }, { ...original, title: 'Renamed title' }]) {
    const next = readingRecord(changed); expect(next.contentKey).not.toBe(ref.contentKey);
    expect(store.get(next)).toEqual({ format: 'formatted', positions: {}, find: { open: false, query: '', active: 0 } });
  }
  expect(store.get(ref)).toEqual(state());
});

it('rejects malformed storage, forged state and invalid coordinates without affecting the reader', () => {
  const { storage, data } = memory(), store = createReaderStateStore({ scope: 'pair', storage }), ref = readingRecord(entity()); store.set(ref, state()); const key = [...data.keys()][0]!;
  for (const raw of ['{broken', '{}', 'x'.repeat(262_145), JSON.stringify([{ record: ref, state: { ...state(), find: { open: true, query: 'x'.repeat(513), active: 0 } } }]),
    JSON.stringify([{ record: ref, state: { ...state(), positions: { plain: { top: -1, sections: [], outlineTop: 0 } } } }]),
    JSON.stringify([{ record: { ...ref, createdAt: -1 }, state: state() }]),
    JSON.stringify([{ record: ref, state: { ...state(), positions: { formatted: { top: 1, outlineTop: 0, sections: [['<img>', true]] } } } }])]) {
    data.set(key, raw); expect(createReaderStateStore({ scope: 'pair', storage }).get(ref)).toBeUndefined();
  }
  store.set(ref, { ...state(), find: { open: true, query: 'match', active: 1000 } }); expect(store.get(ref)).toEqual(state());
});

it('bounds record count and serialized size while retaining the most recently read records', () => {
  const { storage, data } = memory(), store = createReaderStateStore({ scope: 'pair', storage });
  for (let index = 0; index < 40; index++) store.set(readingRecord(entity(`${index}`)), state());
  expect(store.get(readingRecord(entity('0')))).toBeUndefined(); expect(createReaderStateStore({ scope: 'pair', storage }).get(readingRecord(entity('39')))).toEqual(state());
  expect(JSON.parse([...data.values()][0]!)).toHaveLength(24);
  for (let index = 0; index < 24; index++) store.set({ ...readingRecord(entity(`large-${index}`)), id: `${index}` + '"'.repeat(2046), sourceId: '\\'.repeat(2048), sourceRecordId: '"'.repeat(2048) }, state());
  expect([...data.values()][0]!.length).toBeLessThanOrEqual(262_144);
});

it('continues in memory when storage is blocked or disabled', () => {
  const ref = readingRecord(entity()), store = createReaderStateStore({ scope: 'pair', storage: { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); }, removeItem: () => {} } });
  store.set(ref, state()); expect(store.get(ref)).toEqual(state());
  const transient = createReaderStateStore({ scope: 'pair', storage: null }); transient.set(ref, state()); expect(transient.get(ref)).toEqual(state());
});
