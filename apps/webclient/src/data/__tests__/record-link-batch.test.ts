import { expect, it, vi } from 'vitest';
import { createRecordLinkInsert, insertRecordLinksText, linkInsertPreviewOptions, RECORD_LINK_SELECTION_LIMIT, type LinkOption } from '../record-link-insert.js';
import { parseRecordLinkQuery, type ExactRecordLinkMatch, type ExactRecordLinkState } from '../exact-record-link.js';
import { serializeShellRoute } from '../../shell/route.js';
import type { RecentWorkRecord } from '../recent-work-records.js';

const href = 'https://app.test/client/?pair=private';
const row = (id: string): LinkOption => ({ key: id, title: 'Saved ' + id, detail: 'Recued', target: { tab: 'note', id, hash: serializeShellRoute('data', 'note', id) } });
const reference = (option: LinkOption): ExactRecordLinkMatch => ({ key: 'exact:' + option.target.hash, target: option.target, title: option.title, details: ['Note'], identity: 'life:' + option.target.hash, href: 'https://app.test/client/' + option.target.hash });
const held = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; };
const setup = (rows = [row('one'), row('two')]) => {
  const owner = { key: 'pair/editor' }, options = { rows };
  const prepare = vi.fn(async (option: LinkOption): Promise<ExactRecordLinkState> => ({ state: 'ready', match: reference(option) }));
  const verify = vi.fn(async (_match: ExactRecordLinkMatch) => true), shortcut = vi.fn(async (_record: RecentWorkRecord) => true);
  const insert = vi.fn((_records: readonly ExactRecordLinkMatch[]): string | null => null);
  const model = createRecordLinkInsert({ owner: () => owner.key, kinds: ['note', 'task'], search: async () => ({ options: options.rows, more: false }),
    shortcuts: () => [{ label: 'Pinned', options: options.rows.filter(option => option.shortcut) }],
    lookup: { parse: query => parseRecordLinkQuery(query, href), read: async target => ({ state: 'ready', match: reference({ ...row('exact'), target }) }), verify },
    verify: async () => true, verifyShortcut: shortcut, prepareSelection: prepare, insertBatch: insert, insert: () => null, changed: () => {} });
  model.open(); model.setMultiple(true);
  const search = async (query = 'records', kind: 'note' | 'task' = 'note') => { model.change(query, kind); await model.search(); };
  return { model, prepare, verify, shortcut, insert, search, owner, options };
};

it('retains pending and ready selections across queries and filters, deduplicating canonical aliases', async () => {
  const f = setup(), pending = held<ExactRecordLinkState>(); await f.search(); f.prepare.mockReturnValueOnce(pending.promise);
  const choose = f.model.toggleSelection('one'); await f.search('another', 'task');
  pending.resolve({ state: 'ready', match: reference(row('one')) }); await choose;
  expect(f.model.state()).toMatchObject({ query: 'another', filter: 'task', selections: [{ state: 'ready', reference: reference(row('one')) }] });
  const alias = row('alias'); f.options.rows = [alias]; await f.search();
  f.prepare.mockResolvedValueOnce({ state: 'ready', match: reference(row('one')) }); await f.model.toggleSelection(alias.key);
  expect(f.model.state()?.selections).toHaveLength(1); expect(f.model.state()?.selections[0]?.hashes).toContain(alias.target.hash);
  f.model.change(''); expect(linkInsertPreviewOptions(f.model.state()!).some(option => option.exact?.identity === reference(row('one')).identity)).toBe(true);
  await f.model.insertSelected(); expect(f.insert).toHaveBeenCalledExactlyOnceWith([reference(row('one'))]);
});

it('checks every frozen identity and shortcut before one ordered insertion, preserving failures for review', async () => {
  const pin: RecentWorkRecord = { kind: 'note', id: 'one', title: 'Pinned', source_id: 'recued.note', source_label: 'Recued', created_at: 1 };
  const f = setup([{ ...row('one'), shortcut: pin }, row('two')]); await f.search(); await f.model.toggleSelection('one'); await f.model.toggleSelection('two');
  f.verify.mockResolvedValueOnce(false); await f.model.insertSelected();
  expect(f.verify.mock.calls.map(call => call[0].identity)).toEqual([reference(row('one')).identity, reference(row('two')).identity]);
  expect(f.shortcut).toHaveBeenCalledExactlyOnceWith(pin); expect(f.insert).not.toHaveBeenCalled(); expect(f.model.state()?.error).toContain('No links were inserted');
  expect(f.model.state()?.selections[0]?.error).toContain('removed or replaced');
  f.verify.mockRejectedValueOnce(Error('private failure')); await f.model.insertSelected(); expect(f.model.state()?.selections[0]?.error).toContain('could not be checked'); expect(f.insert).not.toHaveBeenCalled();
  f.insert.mockReturnValueOnce('The draft changed.'); await f.model.insertSelected(); expect(f.model.state()?.error).toBe('The draft changed.'); expect(f.model.state()?.selections).toHaveLength(2);
  f.insert.mockClear(); const pending = held<boolean>(); f.verify.mockReturnValueOnce(pending.promise); const save = f.model.insertSelected();
  await f.model.insertSelected(); expect(f.insert).not.toHaveBeenCalled(); pending.resolve(true); await save;
  expect(f.insert).toHaveBeenCalledExactlyOnceWith([reference(row('one')), reference(row('two'))]); expect(f.model.state()).toBeNull();
});

it('retires pending selection reads on removal, mode exit, close, owner change and disposal', async () => {
  for (const boundary of ['remove', 'mode', 'close', 'owner', 'dispose'] as const) {
    const f = setup(), read = held<ExactRecordLinkState>(); await f.search(); f.prepare.mockReturnValueOnce(read.promise); const pending = f.model.toggleSelection('one');
    const id = f.model.state()!.selections[0]!.id;
    if (boundary === 'remove') f.model.removeSelection(id);
    if (boundary === 'mode') f.model.setMultiple(false);
    if (boundary === 'close') { f.model.close(); f.model.open(); f.model.setMultiple(true); }
    if (boundary === 'owner') f.owner.key = 'other-pair/editor';
    if (boundary === 'dispose') f.model.dispose();
    read.resolve({ state: 'ready', match: reference(row('one')) }); await pending;
    expect(f.model.state()?.selections ?? []).toEqual([]); expect(f.insert).not.toHaveBeenCalled();
  }
});

it('retires a checked batch after query change, close, owner change or disposal', async () => {
  for (const boundary of ['query', 'close', 'owner', 'dispose'] as const) {
    const f = setup(); await f.search(); await f.model.toggleSelection('one'); await f.model.toggleSelection('two');
    const check = held<boolean>(); f.verify.mockReturnValueOnce(check.promise); const pending = f.model.insertSelected();
    if (boundary === 'query') f.model.change('new query');
    if (boundary === 'close') f.model.close();
    if (boundary === 'owner') f.owner.key = 'other';
    if (boundary === 'dispose') f.model.dispose();
    check.resolve(true); await pending; expect(f.insert).not.toHaveBeenCalled(); expect(f.verify).toHaveBeenCalledTimes(1);
    if (boundary === 'query') { expect(f.model.state()?.selections).toHaveLength(2); expect(f.model.state()?.inserting).toBe(false); }
  }
});

it('bounds selections, rejects unregistered choices and retries failed preparation without accepting a changed preview', async () => {
  const f = setup(Array.from({ length: RECORD_LINK_SELECTION_LIMIT + 1 }, (_, i) => row(String(i)))); await f.search();
  await f.model.toggleSelection('forged'); expect(f.prepare).not.toHaveBeenCalled();
  f.prepare.mockRejectedValueOnce(Error('private')); await f.model.toggleSelection('0'); expect(f.model.state()?.selections[0]?.state).toBe('error');
  await f.model.insertSelected(); expect(f.verify).not.toHaveBeenCalled();
  await f.model.retrySelection(f.model.state()!.selections[0]!.id); expect(f.model.state()?.selections[0]?.state).toBe('ready');
  for (let i = 1; i <= RECORD_LINK_SELECTION_LIMIT; i++) await f.model.toggleSelection(String(i));
  expect(f.model.state()?.selections).toHaveLength(RECORD_LINK_SELECTION_LIMIT); expect(f.model.state()?.error).toContain('Select up to'); expect(f.prepare).toHaveBeenCalledTimes(RECORD_LINK_SELECTION_LIMIT + 1);
  f.model.clearSelection(); expect(f.model.state()?.selections).toEqual([]);
  const expected = { ...reference(row('0')), identity: 'old-life' }; await f.model.toggleSelection('0', expected);
  expect(f.model.state()?.selections[0]?.state).toBe('error'); expect(f.insert).not.toHaveBeenCalled();
  await f.model.retrySelection(f.model.state()!.selections[0]!.id); expect(f.model.state()?.selections[0]?.state).toBe('error');
});

it('builds a bounded titled block without changing surrounding text, leaking pairing data or partially accepting invalid links', () => {
  const records = [reference({ ...row('one/二'), title: 'Café 🙂\n<script>literal</script>' }), reference(row('two'))];
  const result = insertRecordLinksText('Before SELECT after', 7, 13, href, records)!;
  expect(result.value).toBe('Before \n- Café 🙂 <script>literal</script>: https://app.test/client/' + records[0]!.target.hash + '\n- Saved two: https://app.test/client/' + records[1]!.target.hash + '\n after');
  expect(result.cursor).toBe(result.start + result.text.length); expect(result.value).not.toContain('pair=private');
  expect(insertRecordLinksText('Before SELECT after', 7, 13, href, records, result.value.length - 1)).toBeNull();
  expect(insertRecordLinksText('Before SELECT after', 7, 13, href, records, result.value.length)).toEqual(result);
  expect(insertRecordLinksText('', 0, 0, href, [{ ...records[0]!, target: { ...row('one').target, hash: '#data/note/someone-else' } }, records[1]!])).toBeNull();
});

it('keeps click order when two aliases finish preparing in reverse order', async () => {
  const f = setup([row('one'), row('two'), row('alias')]), slow = held<ExactRecordLinkState>(); await f.search();
  f.prepare.mockReturnValueOnce(slow.promise); const first = f.model.toggleSelection('one');
  await f.model.toggleSelection('two'); f.prepare.mockResolvedValueOnce({ state: 'ready', match: reference(row('one')) }); await f.model.toggleSelection('alias');
  slow.resolve({ state: 'ready', match: reference(row('one')) }); await first; await f.model.insertSelected();
  expect(f.insert).toHaveBeenCalledExactlyOnceWith([reference(row('one')), reference(row('two'))]);
});

it('refreshes shortcut registration before reading a stale visible selection trigger', async () => {
  const record: RecentWorkRecord = { kind: 'note', id: 'one', title: 'Pinned', source_id: 'recued.note', source_label: 'Recued', created_at: 1 };
  const f = setup([{ ...row('one'), shortcut: record }]); f.options.rows = []; await f.model.toggleSelection('one');
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.model.state()?.selections).toEqual([]);
});

it('reopens a context selection with its original identity and permits an explicit empty commit', async () => {
  const original = reference(row('one')), verify = vi.fn(async () => false), commit = vi.fn(() => null);
  const model = createRecordLinkInsert({ owner: () => 'chat/a', kinds: ['note'], search: async () => ({ options: [], more: false }),
    lookup: { parse: query => parseRecordLinkQuery(query, href), read: async () => ({ state: 'missing', message: 'Unavailable' }), verify },
    verify: async () => true, initialSelections: () => [{ reference: original }], allowEmptyBatch: true, insertBatch: commit,
    insert: () => null, changed: () => {} });
  model.open(); expect(model.state()?.multiple).toBe(true); expect(model.state()?.selections[0]?.reference).toEqual(original);
  await model.insertSelected(); expect(verify).toHaveBeenCalledExactlyOnceWith(original); expect(commit).not.toHaveBeenCalled();
  model.clearSelection(); await model.insertSelected(); expect(commit).toHaveBeenCalledExactlyOnceWith([]); expect(model.state()).toBeNull();
});
