import { expect, it, vi } from 'vitest';
import { createPastedRecordLinks, draftRecordLinks, mergePastedRecord, type RecordLinkDraftOwner } from '../pasted-record-links.js';
import type { PreparedRecordLink } from '../../data/record-link-insert.js';
import type { ExactRecordLinkState } from '../../data/exact-record-link.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../../shell/route.js';

const href = 'https://app.test/client/?pair=secret#chat/new';
const record = (id = 'one'): PreparedRecordLink => ({ reference: {
  key: id, target: { tab: 'note', id, hash: serializeShellRoute('data', 'note', id) },
  href: 'https://app.test/client/#data/note/' + encodeURIComponent(id), title: id, details: [],
  identity: JSON.stringify(['note', id, 'recued.note', null, 1]),
} });
const ready = (row = record()): Extract<ExactRecordLinkState, { state: 'ready' }> => ({ state: 'ready', match: row.reference });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fixture = () => {
  let owner: RecordLinkDraftOwner | null = { key: 'a:1', scope: {} }, text = '#data/note/one', records: readonly PreparedRecordLink[] = [], blocked = false;
  const read = vi.fn(async (): Promise<Exclude<ExactRecordLinkState, { state: 'loading' | 'error' | 'invalid' }>> => ready()), changed = vi.fn();
  const commit = vi.fn((next: readonly PreparedRecordLink[]) => { records = next; return null as string | null; });
  const model = createPastedRecordLinks({ owner: () => owner, text: () => text, records: () => records, blocked: () => blocked,
    href: () => href, read, commit, changed });
  return { model, read, commit, changed, setText: (value: string) => { text = value; }, setOwner: (value: typeof owner) => { owner = value; },
    owner: () => owner!, setRecords: (value: typeof records) => { records = value; }, records: () => records, block: (value: boolean) => { blocked = value; } };
};

it('recognizes bounded complete links for all five record kinds and keeps accounts distinct without reading anything', () => {
  const hashes = ['#data/contact/person', '#data/task/task', '#data/note/note%2F二',
    ...['work', 'home'].map(collectionSlug => serializeSourceRecordAddress({ tab: 'mail', collectionSlug, recordId: 'same/id?二' })),
    serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: 'work', recordId: 'same/id?二' })];
  const text = 'Compare these:\n' + hashes.map(hash => 'https://app.test/client/' + hash).join('\n') + '\n#data/task/task';
  const links = draftRecordLinks(text, href);
  expect(links.map(link => link.target.tab)).toEqual(['contact', 'task', 'note', 'mail', 'mail', 'calendar']);
  expect(links[2]!.target).toMatchObject({ id: 'note/二' });
  expect(new Set(links.map(link => link.key)).size).toBe(6);
  expect(draftRecordLinks('hello https://elsewhere.test/client/#data/task/a https://app.test/other/#data/task/a javascript:alert(1) #data/file/x #data/task/%ZZ #data/note/' + 'x'.repeat(65_537), href)).toEqual([]);
  const f = fixture(); expect(f.model.state()?.candidate.key).toBe('#data/note/one'); expect(f.read).not.toHaveBeenCalled();
});

it('retains a stronger existing pin, refuses replaced lifetimes, and enforces capacity without dropping selections', () => {
  const selected = record(); selected.shortcut = { kind: 'note', id: 'one', title: 'Pinned', source_id: 'recued.note', source_label: 'Recued', created_at: 1, source_record_id: null };
  const rows = [selected];
  expect(mergePastedRecord(rows, record().reference).records).toBe(rows);
  expect(mergePastedRecord(rows, { ...record().reference, identity: 'replacement' })).toMatchObject({ records: rows, error: expect.stringContaining('different record') });
  const full = Array.from({ length: 20 }, (_, i) => record(String(i)));
  expect(mergePastedRecord(full, record().reference)).toMatchObject({ records: full, error: expect.stringContaining('20 records') });
});

it('requires an explicit current suggestion and commits against the latest selection while typing continues', async () => {
  const f = fixture(), pending = deferred<ReturnType<typeof ready>>(); f.read.mockReturnValue(pending.promise);
  await f.model.attach('unregistered'); expect(f.read).not.toHaveBeenCalled();
  const attaching = f.model.attach('#data/note/one'); expect(f.model.hasPending()).toBe(true);
  await f.model.attach('#data/note/one'); expect(f.read).toHaveBeenCalledTimes(1);
  f.setText('A longer question #data/note/one\nwith more text'); f.setRecords([record('two')]);
  expect(f.model.hasPending()).toBe(true); pending.resolve(ready()); await attaching;
  expect(f.records().map(row => row.reference.target.hash)).toEqual(['#data/note/two', '#data/note/one']);
  expect(f.model.state()).toBeNull(); expect(f.model.hasPending()).toBe(false);
});

it('rechecks the limit after lookup and allows retry without changing the question or current selections', async () => {
  const f = fixture(), pending = deferred<ReturnType<typeof ready>>(); f.read.mockReturnValueOnce(pending.promise);
  const attaching = f.model.attach('#data/note/one'), full = Array.from({ length: 20 }, (_, i) => record(String(i)));
  f.setRecords(full); pending.resolve(ready()); await attaching;
  expect(f.model.state()).toMatchObject({ checking: false, error: expect.stringContaining('20 records') });
  expect(f.records()).toBe(full); expect(f.commit).not.toHaveBeenCalled();
  f.setRecords(full.slice(1)); await f.model.attach('#data/note/one');
  expect(f.records()).toHaveLength(20); expect(f.model.state()).toBeNull();
});

it('reports missing and failed reads, then retries the same link explicitly', async () => {
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error('private reader error'));
  await f.model.attach('#data/note/one'); expect(f.model.state()).toMatchObject({ checking: false, error: 'This record could not be attached. Try again.' });
  f.read.mockResolvedValueOnce({ state: 'missing', message: 'This note is unavailable.' });
  await f.model.attach('#data/note/one'); expect(f.model.state()?.error).toBe('This note is unavailable.');
  expect(f.commit).not.toHaveBeenCalled(); await f.model.attach('#data/note/one'); expect(f.records()).toHaveLength(1);
});

it('deduplicates contact aliases by canonical identity and retains the existing reference', async () => {
  const f = fixture(), existing = record('person');
  existing.reference = { ...existing.reference, target: { tab: 'contact', id: 'person', hash: '#data/contact/person' }, identity: 'contact-lifetime' };
  f.setRecords([existing]); f.setText('#data/contact/old%40example.test #data/contact/person');
  f.read.mockResolvedValue(ready(existing));
  await f.model.attach('#data/contact/old%40example.test');
  expect(f.records()[0]).toBe(existing); expect(f.model.state()).toBeNull();
  f.setRecords([]); expect(f.model.state()?.candidate.target).toMatchObject({ id: 'old@example.test' });
});

it('retires a removed or dismissed pending link and leaves a newer lookup untouched by its late result', async () => {
  const f = fixture(), old = deferred<ReturnType<typeof ready>>(), next = deferred<ReturnType<typeof ready>>();
  f.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const first = f.model.attach('#data/note/one');
  f.setText('#data/note/two'); expect(f.model.state()?.candidate.key).toBe('#data/note/two');
  const second = f.model.attach('#data/note/two'); old.resolve(ready()); await first;
  expect(f.model.hasPending()).toBe(true); expect(f.commit).not.toHaveBeenCalled();
  f.model.dismiss('#data/note/two'); next.resolve(ready(record('two'))); await second;
  expect(f.model.state()).toBeNull(); expect(f.commit).not.toHaveBeenCalled();
  f.setText('Question only'); f.model.state(); f.setText('#data/note/two');
  expect(f.model.state()?.candidate.key).toBe('#data/note/two');
});

it('keeps dismissals per draft and cancels lookup across a conversation round trip', async () => {
  const f = fixture(), a = f.owner(), pending = deferred<ReturnType<typeof ready>>();
  f.model.dismiss('#data/note/one'); f.setOwner({ key: 'b:1', scope: {} });
  expect(f.model.state()).not.toBeNull(); f.setOwner(a); expect(f.model.state()).toBeNull();
  f.setText(''); f.model.state(); f.setText('#data/note/one'); f.read.mockReturnValueOnce(pending.promise);
  const attaching = f.model.attach('#data/note/one'); f.model.reset();
  f.setOwner({ ...a, key: 'a:3' }); expect(f.model.hasPending()).toBe(false);
  pending.resolve(ready()); await attaching; expect(f.commit).not.toHaveBeenCalled();
});

it('prevents writes while blocked and discards results and repaint callbacks after disposal', async () => {
  const f = fixture(), pending = deferred<ReturnType<typeof ready>>();
  f.block(true); await f.model.attach('#data/note/one'); expect(f.read).not.toHaveBeenCalled();
  f.block(false); f.read.mockReturnValueOnce(pending.promise);
  const attaching = f.model.attach('#data/note/one'); f.model.dispose(); f.changed.mockClear();
  pending.resolve(ready()); await attaching;
  expect(f.commit).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled(); expect(f.model.state()).toBeNull();
});
