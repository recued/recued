import { expect, it, vi } from 'vitest';
import { createRecordChecks, recordCheckKey, type RecordCheckOwner } from '../record-checks.js';
import type { PreparedRecordLink } from '../../data/record-link-insert.js';

const record = (id: string): PreparedRecordLink => ({ reference: {
  key: id, target: { tab: 'note', id, hash: '#data/note/' + id }, href: '#data/note/' + id, title: 'Note ' + id, details: [],
  identity: JSON.stringify(['note', id, 'recued.note', null, 1]),
} });
const deferred = () => {
  let resolve!: (value: boolean) => void, reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
};
const fixture = () => {
  let owner: RecordCheckOwner | null = { key: 'a:1', scope: {} }, records = [record('one'), record('two')], blocked = false;
  const verify = vi.fn(async (_row: PreparedRecordLink) => true), changed = vi.fn();
  const model = createRecordChecks({ owner: () => owner, records: () => records, blocked: () => blocked, verify, changed });
  return { model, verify, changed, records: () => records, owner: () => owner!,
    setOwner: (value: typeof owner) => { owner = value; }, setRecords: (value: typeof records) => { records = value; }, block: (value: boolean) => { blocked = value; } };
};

it('checks the entire selection despite independent missing and failed records, without altering references', async () => {
  const f = fixture(); f.setRecords([...f.records(), record('three')]); const selected = f.records(), keys = selected.map(recordCheckKey);
  expect(f.model.rows().map(row => row.state)).toEqual([undefined, undefined, undefined]); expect(f.verify).not.toHaveBeenCalled();
  f.verify.mockImplementation(async row => { if (row.reference.title === 'Note one') return false; if (row.reference.title === 'Note two') throw new Error('private error'); return true; });
  const result = await f.model.checkAll(selected);
  expect(result.current).toBe(true); expect(result.issues.map(row => [row.key, row.state])).toEqual([[keys[0], 'missing'], [keys[1], 'error']]);
  expect(f.verify.mock.calls.map(([row]) => row)).toEqual(selected); expect(f.records()).toBe(selected); expect(f.model.hasPending()).toBe(false);
  expect(f.model.rows().map(row => row.state)).toEqual(['missing', 'error', 'ready']);
});

it('rechecks only an explicitly selected record, never changes a frozen lifetime, and keeps other failures', async () => {
  const f = fixture(); f.verify.mockResolvedValue(false); await f.model.checkAll(f.records()); f.verify.mockClear();
  expect(await f.model.recheck('a DOM supplied address')).toBe(false); expect(f.verify).not.toHaveBeenCalled();
  f.verify.mockResolvedValue(true); await f.model.recheck(recordCheckKey(f.records()[0]!));
  expect(f.verify).toHaveBeenCalledExactlyOnceWith(f.records()[0]); expect(f.model.rows().map(row => row.state)).toEqual(['ready', 'missing']);
  expect(f.records()[0]!.reference.identity).toBe(record('one').reference.identity);
});

it('keeps Send pending until every read settles and coalesces a duplicate check', async () => {
  const f = fixture(), first = deferred(), second = deferred();
  f.verify.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const batch = f.model.checkAll(f.records()), duplicate = f.model.recheck(recordCheckKey(f.records()[0]!));
  await Promise.resolve();
  expect(f.model.hasPending()).toBe(true); expect(f.verify).toHaveBeenCalledTimes(2);
  first.resolve(true); await duplicate; expect(f.model.hasPending()).toBe(true);
  second.resolve(false); expect((await batch).issues).toHaveLength(1); expect(f.model.hasPending()).toBe(false);
});

it('keeps draft errors independent, restores them on a round trip, and retires pending reads', async () => {
  const f = fixture(), a = f.owner(), held = deferred(); f.verify.mockResolvedValue(false); await f.model.checkAll(f.records());
  f.verify.mockReturnValueOnce(held.promise); const checking = f.model.recheck(recordCheckKey(f.records()[0]!)); await Promise.resolve(); expect(f.model.hasPending()).toBe(true);
  f.model.cancel(); f.setOwner({ key: 'b:1', scope: {} }); expect(f.model.rows().map(row => row.state)).toEqual([undefined, undefined]);
  f.setOwner({ ...a, key: 'a:3' }); expect(f.model.rows().map(row => row.state)).toEqual(['missing', 'missing']);
  expect(await checking).toBe(false); held.resolve(true); expect(f.model.rows().map(row => row.state)).toEqual(['missing', 'missing']);
});

it('drops a removed reference and cannot mark its replacement through an old request', async () => {
  const f = fixture(), held = deferred(); f.verify.mockReturnValueOnce(held.promise);
  const checking = f.model.recheck(recordCheckKey(f.records()[0]!)), replacement = record('one');
  await Promise.resolve();
  replacement.reference.identity = JSON.stringify(['note', 'one', 'recued.note', null, 2]); f.setRecords([replacement]);
  expect(f.model.hasPending()).toBe(false); held.resolve(false); expect(await checking).toBe(false); expect(f.model.rows()[0]!.state).toBeUndefined();
  expect(f.records()).toEqual([replacement]);
});

it('treats stronger pinned identity changes as a new selection even at the same address', async () => {
  const f = fixture(), selected = record('one'), held = deferred();
  selected.shortcut = { kind: 'note', id: 'one', title: 'Pinned', source_id: 'recued.note', source_label: 'Recued', source_record_id: null, created_at: 1 };
  f.setRecords([selected]); f.verify.mockReturnValueOnce(held.promise);
  const checking = f.model.recheck(recordCheckKey(selected)), replacement = { ...selected, shortcut: { ...selected.shortcut, created_at: 2 } };
  await Promise.resolve();
  f.setRecords([replacement]); expect(f.model.rows()[0]!.state).toBeUndefined(); held.resolve(true);
  expect(await checking).toBe(false); expect(f.model.rows()[0]!.state).toBeUndefined(); expect(recordCheckKey(selected)).not.toBe(recordCheckKey(replacement));
});

it('cancels batch admission if the selection changes, even when the already checked rows are still present', async () => {
  const f = fixture(), held = deferred(); f.verify.mockReturnValueOnce(held.promise);
  const batch = f.model.checkAll(f.records()); f.setRecords([...f.records(), record('three')]);
  held.resolve(true); expect((await batch).current).toBe(false);
  f.verify.mockClear(); const previous = f.records().slice(0, 2);
  expect((await f.model.checkAll(previous)).current).toBe(false); expect(f.verify).not.toHaveBeenCalled();
});

it('an old reply cannot finish a newer check after cancellation or overwrite its failure', async () => {
  const f = fixture(), old = deferred(), fresh = deferred(), key = recordCheckKey(f.records()[0]!);
  f.verify.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first = f.model.recheck(key); await Promise.resolve(); f.model.cancel(); const second = f.model.recheck(key); await Promise.resolve();
  old.resolve(true); expect(await first).toBe(false); expect(f.model.hasPending()).toBe(true);
  fresh.reject(new Error('interrupted')); expect(await second).toBe(true); expect(f.model.rows()[0]!.state).toBe('error');
});

it('ignores blocked controls and cannot repaint after disposal or a lost draft owner', async () => {
  const f = fixture(), held = deferred(), key = recordCheckKey(f.records()[0]!);
  f.block(true); expect(await f.model.recheck(key)).toBe(false); expect(f.verify).not.toHaveBeenCalled();
  f.block(false); f.verify.mockReturnValueOnce(held.promise); const checking = f.model.recheck(key);
  await Promise.resolve();
  f.model.dispose(); f.changed.mockClear(); held.resolve(true);
  expect(await checking).toBe(false); expect(f.changed).not.toHaveBeenCalled(); expect(f.model.rows()).toEqual([]);
  f.setOwner(null); expect(f.model.hasPending()).toBe(false);
});

it('reports completed/total progress and cancels a batch before its outstanding reader replies', async () => {
  const f = fixture(), first = deferred(), second = deferred(), selected = f.records();
  f.verify.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const batch = f.model.checkAll(selected); await Promise.resolve();
  expect(f.verify).toHaveBeenCalledTimes(2); expect(f.model.progress()).toMatchObject({ completed: 0, total: 2 });
  first.resolve(true); await vi.waitFor(() => expect(f.model.progress()).toMatchObject({ completed: 1, total: 2 }));
  const id = f.model.progress()!.id; expect(f.model.cancelPending(id)).toBe(true);
  expect((await batch).current).toBe(false); expect(f.model.hasPending()).toBe(false); expect(f.model.progress()).toBeNull();
  expect(f.records()).toBe(selected); expect(f.model.rows().map(row => row.state)).toEqual(['ready', undefined]);
  f.changed.mockClear(); second.resolve(false); await second.promise;
  expect(f.model.rows().map(row => row.state)).toEqual(['ready', undefined]); expect(f.changed).not.toHaveBeenCalled();
});

it('restores the previous problem and fences a fresh Recheck from both an old reply and its old Cancel token', async () => {
  const f = fixture(), key = recordCheckKey(f.records()[0]!), old = deferred(), fresh = deferred();
  f.verify.mockResolvedValue(false); await f.model.checkAll(f.records());
  f.verify.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const first = f.model.recheck(key); await Promise.resolve(); const oldId = f.model.progress()!.id;
  expect(f.model.cancelPending(oldId)).toBe(true); expect(await first).toBe(false); expect(f.model.rows()[0]!.state).toBe('missing');
  const retry = f.model.recheck(key); await Promise.resolve(); expect(f.model.progress()!.id).not.toBe(oldId);
  expect(f.model.cancelPending(oldId)).toBe(false); expect(f.model.hasPending()).toBe(true);
  old.resolve(true); await old.promise; expect(f.model.progress()).toMatchObject({ completed: 0, total: 1 });
  fresh.reject(new Error('interrupted')); expect(await retry).toBe(true); expect(f.model.rows()[0]!.state).toBe('error');
});

it('cancellation before dispatch avoids starting the saved-record readers', async () => {
  const f = fixture(), batch = f.model.checkAll(f.records()), id = f.model.progress()!.id;
  expect(f.model.cancelPending(id)).toBe(true); expect((await batch).current).toBe(false);
  expect(f.verify).not.toHaveBeenCalled(); expect(f.model.progress()).toBeNull();
  expect(f.model.cancelPending(id)).toBe(false);
});

it('coalesces progress for concurrent single-record checks and counts a renewed failed check once', async () => {
  const f = fixture(), first = deferred(), second = deferred(), retry = deferred(), keys = f.records().map(recordCheckKey);
  f.verify.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(retry.promise);
  const a = f.model.recheck(keys[0]!), b = f.model.recheck(keys[1]!), duplicate = f.model.recheck(keys[0]!); await Promise.resolve();
  expect(f.model.progress()).toMatchObject({ completed: 0, total: 2 }); expect(f.verify).toHaveBeenCalledTimes(2);
  first.resolve(false); await a; await duplicate; expect(f.model.progress()).toMatchObject({ completed: 1, total: 2 });
  const next = f.model.recheck(keys[0]!); await Promise.resolve(); expect(f.model.progress()).toMatchObject({ completed: 0, total: 2 });
  expect(f.model.cancelPending(f.model.progress()!.id)).toBe(true); expect(await b).toBe(false); expect(await next).toBe(false);
  expect(f.model.rows().map(row => row.state)).toEqual(['missing', undefined]); second.resolve(true); retry.resolve(true);
});

it('keeps the full denominator when a reader throws synchronously and another record remains pending', async () => {
  const f = fixture(), held = deferred();
  f.verify.mockImplementation(row => { if (row.reference.title === 'Note one') throw new Error('interrupted'); return held.promise; });
  const batch = f.model.checkAll(f.records());
  await vi.waitFor(() => expect(f.model.progress()).toMatchObject({ completed: 1, total: 2 }));
  f.model.cancelPending(f.model.progress()!.id); expect((await batch).current).toBe(false);
  expect(f.model.rows().map(row => row.state)).toEqual(['error', undefined]); held.resolve(true);
});
