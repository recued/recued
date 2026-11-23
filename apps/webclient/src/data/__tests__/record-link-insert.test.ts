import { parseRecordLinkQuery, type ExactRecordLinkMatch, type ExactRecordLinkState } from '../exact-record-link.js';
import { expect, it, vi } from 'vitest';
import type { ContactRecord, CollectionSearchGroup, WorkEntitySearchRpcResponse } from '@recued/contracts';
import { createRecordLinkInsert, insertRecordLinkText, searchRecordLinks, type LinkKind, type LinkOption, type LinkPage } from '../record-link-insert.js';
import { serializeSourceRecordAddress, serializeShellRoute } from '../../shell/route.js';

const row = (kind: LinkKind = 'task', id = 'one'): LinkOption => ({ key: JSON.stringify([kind, id]), title: kind + ' ' + id, detail: 'Recued',
  target: kind === 'mail' || kind === 'calendar' ? { tab: kind, collectionSlug: 'work', recordId: id, hash: serializeSourceRecordAddress({ tab: kind, collectionSlug: 'work', recordId: id }) }
    : { tab: kind, id, hash: serializeShellRoute('data', kind, id) } });
const page = (kind: LinkKind = 'task', id = 'one'): LinkPage => ({ options: [row(kind, id)], more: false });
const workPage = (kind: 'task' | 'note' | 'commitment', patch = {}): WorkEntitySearchRpcResponse => ({ groups: [{ kind, offset: 0, more: false,
  matches: [{ id: 'opaque/二?', title: 'Literal <img src=x>', excerpt: 'private excerpt', source_id: 'recued.' + kind, source_label: 'Recued',
    updated_at: 1, stale: false, pending_write: false, ...patch }] }] });
const contact: ContactRecord = { _id: 'riley@example.test', _collection: 'contact', email: 'riley@example.test', contact_id: 'contact-one', name: 'Riley',
  source: 'manual', first_seen: 1, last_interaction: 1, interaction_count: 0, created_at: 1, updated_at: 1 };
const held = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const setup = (kinds: LinkKind[] = ['contact', 'task', 'note']) => {
  const current = { owner: 'draft-one' as string | null }, search = vi.fn(async (kind: LinkKind, _query: string) => page(kind)), verify = vi.fn(async () => true);
  const insert = vi.fn((_target: LinkOption['target']): string | null => null), changed = vi.fn();
  const model = createRecordLinkInsert({ owner: () => current.owner, kinds, search, verify, insert, changed });
  return { current, search, verify, insert, changed, model };
};

it('uses universal-search services with bounded exact-kind queries and canonical contact identities', async () => {
  const contacts = vi.fn(async () => ({ contacts: [contact, { ...contact, email: 'merged@example.test', contact_id: 'merged', merged_into: contact.email }], total: 30 }));
  expect(await searchRecordLinks('contact', '  Riley  ', { contacts })).toEqual({ options: [{ ...row('contact', contact.contact_id), title: 'Riley', detail: contact.email }], more: true });
  expect(contacts).toHaveBeenCalledExactlyOnceWith({ query: 'Riley', limit: 20, offset: 0 });
  for (const kind of ['task', 'note', 'commitment'] as const) {
    const work = vi.fn(async () => workPage(kind, { stale: true, pending_write: true }));
    const result = await searchRecordLinks(kind, '  二  ', { work });
    expect(work).toHaveBeenCalledExactlyOnceWith({ query: '二', limit: 20, offset: 0, kind });
    expect(result.options).toEqual([{ ...row(kind, 'opaque/二?'), title: 'Literal <img src=x>', detail: 'Recued · Last synced copy · Changes pending' }]);
    expect(result.options[0]).not.toHaveProperty('excerpt');
  }
});

it('rejects mismatched, duplicated, failed or incomplete pages without claiming no matches', async () => {
  const original = workPage('task');
  for (const reply of [{ groups: [] }, workPage('note'), { groups: [{ ...original.groups[0]!, offset: 20 }] },
    { groups: [{ ...original.groups[0]!, error: 'index failed' }] }, { groups: [{ ...original.groups[0]!, matches: [...original.groups[0]!.matches, ...original.groups[0]!.matches] }] }]) {
    await expect(searchRecordLinks('task', 'name', { work: async () => reply })).rejects.toThrow();
  }
  await expect(searchRecordLinks('contact', 'name', { contacts: async () => ({ contacts: [], total: 1 }) })).rejects.toThrow();
  await expect(searchRecordLinks('contact', 'name', { contacts: async () => ({ contacts: [contact, contact], total: 2 }) })).rejects.toThrow();
});

it('inserts an exact deployment link at UTF-16 selection offsets, separates URL tokens, and refuses overflow or mismatched addresses', () => {
  const text = '二🙂 beforeSELECTafter\nKeep <img src=x>  ', start = text.indexOf('SELECT'), end = start + 6;
  const target = row('note', 'opaque/二?').target, url = 'https://app.test/client/#data/note/opaque%2F%E4%BA%8C%3F';
  const result = insertRecordLinkText(text, start, end, 'https://user:secret@app.test/client/?pairing=secret#data/task/current', target)!;
  expect(result.value).toBe(text.slice(0, start) + ' ' + url + ' ' + text.slice(end));
  expect(result.cursor).toBe(start + result.text.length); expect(result.value).not.toContain('secret');
  expect(insertRecordLinkText('before\n\nafter', 7, 7, 'https://app.test/client/', target)?.text).toBe(url);
  expect(insertRecordLinkText(text, start, end, 'https://app.test/client/', target, result.value.length - 1)).toBeNull();
  expect(insertRecordLinkText(text, end, start, 'https://app.test/client/', target)).toBeNull();
  expect(insertRecordLinkText(text, 0, 0, 'file:///app/', target)).toBeNull();
  expect(insertRecordLinkText(text, 0, 0, 'https://app.test/', { ...target, hash: '#data/task/another' })).toBeNull();
});

it('searches only on request and inserts only a registered result after confirmation', async () => {
  const f = setup(), check = held<boolean>();
  f.model.open(); expect(f.search).not.toHaveBeenCalled(); await f.model.search(); expect(f.search).not.toHaveBeenCalled();
  f.model.change('needle'); expect(f.search).not.toHaveBeenCalled(); await f.model.search();
  expect(f.search.mock.calls).toEqual([['contact', 'needle'], ['task', 'needle'], ['note', 'needle']]);
  await f.model.choose('forged'); expect(f.verify).not.toHaveBeenCalled();
  f.verify.mockReturnValueOnce(check.promise); const selected = f.model.choose(row().key);
  await f.model.choose(row().key); expect(f.verify).toHaveBeenCalledExactlyOnceWith(row().target); expect(f.insert).not.toHaveBeenCalled();
  check.resolve(true); await selected; expect(f.insert).toHaveBeenCalledExactlyOnceWith(row().target); expect(f.model.state()).toBeNull();
});

it('keeps independent successful groups usable and retries only the failed search', async () => {
  const f = setup(); f.search.mockImplementation(async kind => { if (kind === 'task') throw Error('private diagnostic'); return page(kind); });
  f.model.open(); f.model.change('name'); await f.model.search();
  expect(f.model.state()?.groups.filter(group => group.state === 'ready')).toHaveLength(2);
  expect(f.model.state()?.groups.find(group => group.kind === 'task')).toMatchObject({ state: 'error', message: 'Tasks could not be searched. Try again.' });
  f.search.mockResolvedValueOnce(page('task')); await f.model.retry('task');
  expect(f.search.mock.calls).toEqual([['contact', 'name'], ['task', 'name'], ['note', 'name'], ['task', 'name']]);
  expect(f.model.state()?.groups.every(group => group.state === 'ready')).toBe(true);
});

it('fences old search failures after a new query and type filter, including newer results already painted', async () => {
  const f = setup(['task', 'note']), old = held<LinkPage>(); f.search.mockReturnValueOnce(old.promise);
  f.model.open(); f.model.change('old', 'task'); const pending = f.model.search();
  f.model.change('new', 'note'); await f.model.search(); const paints = f.changed.mock.calls.length;
  old.reject(Error('late failure')); await pending;
  expect(f.model.state()).toMatchObject({ query: 'new', filter: 'note', groups: [{ kind: 'note', state: 'ready' }] });
  expect(f.changed).toHaveBeenCalledTimes(paints);
});

it('ignores pending search and selected-record replies after close, source or editor replacement, or disposal', async () => {
  for (const change of ['close', 'owner', 'dispose'] as const) for (const phase of ['search', 'verify'] as const) {
    const f = setup(['task']), read = held<LinkPage>(), check = held<boolean>();
    f.model.open(); f.model.change('name');
    if (phase === 'search') f.search.mockReturnValueOnce(read.promise);
    const search = f.model.search(); if (phase === 'verify') await search;
    f.verify.mockReturnValueOnce(check.promise); const verify = phase === 'verify' ? f.model.choose(row().key) : Promise.resolve();
    if (change === 'close') f.model.close(); if (change === 'owner') f.current.owner = 'another-source-or-editor'; if (change === 'dispose') f.model.dispose();
    const paints = f.changed.mock.calls.length; read.resolve(page()); check.resolve(true); await Promise.all([search, verify]);
    expect(f.insert).not.toHaveBeenCalled(); expect(f.model.state()).toBeNull(); expect(f.changed).toHaveBeenCalledTimes(paints);
  }
});

it('lets a newer query cancel a pending insertion and retains a draft on unavailable, failed or locally refused insertion', async () => {
  const f = setup(['task']), check = held<boolean>(); f.model.open(); f.model.change('one'); await f.model.search();
  f.verify.mockReturnValueOnce(check.promise); const old = f.model.choose(row().key);
  f.model.change('two'); await f.model.search(); check.resolve(true); await old; expect(f.insert).not.toHaveBeenCalled();
  f.verify.mockResolvedValueOnce(false); await f.model.choose(row().key); expect(f.model.state()?.error).toContain('no longer available'); expect(f.insert).not.toHaveBeenCalled();
  f.verify.mockRejectedValueOnce(Error('private read diagnostic')); await f.model.choose(row().key); expect(f.model.state()?.error).toBe('The selected record could not be checked. Try selecting it again.');
  f.insert.mockReturnValueOnce('The draft changed.'); await f.model.choose(row().key); expect(f.model.state()).toMatchObject({ error: 'The draft changed.' });
  await f.model.choose(row().key); expect(f.model.state()).toBeNull();
});

const sourceGroup = (platform: 'mail' | 'calendar', slug = 'work'): CollectionSearchGroup => ({ platform, slug, more: false,
  source_freshness: { stale: true, pending: 0, age_ms: 0, last_success_at: 1, degraded: false },
  matches: [{ record_id: 'shared/id?二', received_at: 1000, rank: -1, hot_fields: { subject: 'Exact email', from: 'Riley <riley@example.test>', summary: 'Exact event', start_at: 2000 } }] });
it('searches source records by platform, retains account identity, and labels partial source failures', async () => {
  for (const kind of ['mail', 'calendar'] as const) {
    const collections = vi.fn(async () => ({ groups: [sourceGroup(kind), sourceGroup(kind, 'home')], unavailable_sources: [{ platform: kind, slug: 'offline' }] }));
    const result = await searchRecordLinks(kind, '  Exact  ', { collections });
    expect(collections).toHaveBeenCalledExactlyOnceWith({ query: 'Exact', per_group: 20, platforms: [kind] });
    expect(result.options.map(row => row.target)).toEqual(['work', 'home'].map(collectionSlug => ({ tab: kind, collectionSlug, recordId: 'shared/id?二', hash: serializeSourceRecordAddress({ tab: kind, collectionSlug, recordId: 'shared/id?二' }) })));
    expect(new Set(result.options.map(row => row.key)).size).toBe(2); expect(result.options[0]!.detail).toContain('Last synced copy');
    expect(result.warnings).toEqual(['Could not search account offline. Try again.']);
  }
});
it('rejects malformed or duplicate source identities and bounds results without mixing account rankings', async () => {
  const group = sourceGroup('mail');
  for (const groups of [[sourceGroup('calendar')], [group, group], [{ ...group, matches: [...group.matches, ...group.matches] }],
    [{ ...group, matches: [{ ...group.matches[0]!, received_at: undefined }] }]]) {
    await expect(searchRecordLinks('mail', 'Exact', { collections: async () => ({ groups }) })).rejects.toThrow();
  }
  const groups = Array.from({ length: 6 }, (_, index) => ({ ...sourceGroup('mail', 'account-' + index), more: true,
    matches: Array.from({ length: 20 }, (_, row) => ({ ...group.matches[0]!, record_id: String(row) })) }));
  const result = await searchRecordLinks('mail', 'Exact', { collections: async () => ({ groups }) });
  expect(result.options).toHaveLength(100); expect(result.more).toBe(true); expect(result.options[0]!.account).toBe('account-0'); expect(result.options[99]!.account).toBe('account-4');
});
it('inserts source URLs with exact account/occurrence encoding and refuses an unqualified source address', () => {
  for (const tab of ['mail', 'calendar'] as const) {
    const target = { tab, collectionSlug: 'Work/二', recordId: 'same/id?', hash: serializeSourceRecordAddress({ tab, collectionSlug: 'Work/二', recordId: 'same/id?' }) };
    const result = insertRecordLinkText('Before SELECT after', 7, 13, 'https://app.test/client/?pair=secret', target)!;
    expect(result.value).toBe('Before https://app.test/client/' + target.hash + ' after');
    expect(insertRecordLinkText('', 0, 0, 'https://app.test/client/', { ...target, hash: '#data/mail/same' })).toBeNull();
  }
});


it('offers local shortcuts without searching, restores them on clear, and verifies only registered choices', async () => {
  const record = { kind: 'task' as const, id: 'one', title: 'Pinned task', source_id: 'recued.task', source_label: 'Recued', created_at: 1 };
  const option = { ...row(), shortcut: record };
  const shortcuts = vi.fn((filter: LinkKind | 'all') => filter === 'all' || filter === 'task' ? [{ label: 'Pinned' as const, options: [option] }] : []);
  const search = vi.fn(async () => page()), verify = vi.fn(async () => true), verifyShortcut = vi.fn(async () => true), insert = vi.fn(() => null);
  const model = createRecordLinkInsert({ owner: () => 'draft', kinds: ['task', 'note'], shortcuts, search, verify, verifyShortcut, insert, changed: () => {} });
  model.open(); await model.search(); expect(search).not.toHaveBeenCalled(); expect(model.state()?.shortcuts?.[0]?.options).toEqual([option]);
  model.change('', 'note'); expect(model.state()?.shortcuts).toEqual([]);
  model.change('needle', 'task'); expect(model.state()?.shortcuts).toEqual([]); await model.search(); expect(search).toHaveBeenCalledExactlyOnceWith('task', 'needle');
  model.change(''); await model.choose('forged'); expect(verifyShortcut).not.toHaveBeenCalled();
  verifyShortcut.mockResolvedValueOnce(false); await model.choose(option.key); expect(model.state()?.error).toContain('no longer available'); expect(insert).not.toHaveBeenCalled();
  await model.choose(option.key); expect(verifyShortcut).toHaveBeenCalledWith(record); expect(verify).not.toHaveBeenCalled(); expect(insert).toHaveBeenCalledExactlyOnceWith(option.target);
});

it('fences a pending shortcut when the scoped lists change and fails closed without a shortcut reader', async () => {
  const record = { kind: 'task' as const, id: 'one', title: 'Recent task', source_id: 'recued.task', source_label: 'Recued', created_at: 1 };
  let options = [{ ...row(), shortcut: record }]; const check = held<boolean>(), insert = vi.fn(() => null);
  const deps = { owner: () => 'draft', kinds: ['task'] as const, shortcuts: () => [{ label: 'Recently opened' as const, options }],
    search: async () => page(), verify: vi.fn(async () => true), insert, changed: () => {} };
  const model = createRecordLinkInsert({ ...deps, verifyShortcut: () => check.promise }); model.open(); const pending = model.choose(options[0]!.key);
  options = []; check.resolve(true); await pending; expect(insert).not.toHaveBeenCalled(); expect(model.state()?.selecting).toBeUndefined();
  options = [{ ...row(), shortcut: record }]; const noReader = createRecordLinkInsert(deps); noReader.open(); await noReader.choose(options[0]!.key);
  expect(noReader.state()?.error).toContain('no longer available'); expect(deps.verify).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
});


it('refreshes removed shortcuts before activation even without a screen repaint', async () => {
  const record = { kind: 'task' as const, id: 'one', title: 'Recent task', source_id: 'recued.task', source_label: 'Recued', created_at: 1 };
  let present = true; const verifyShortcut = vi.fn(async () => true), insert = vi.fn(() => null);
  const model = createRecordLinkInsert({ owner: () => 'draft', kinds: ['task'],
    shortcuts: () => present ? [{ label: 'Pinned', options: [{ ...row(), shortcut: record }] }] : [],
    search: async () => page(), verify: async () => true, verifyShortcut, insert, changed: () => {} });
  model.open(); present = false; await model.choose(row().key);
  expect(verifyShortcut).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled(); expect(model.state()?.shortcuts).toEqual([]);
});


it('looks up a pasted URL without text search and verifies that exact result before insertion', async () => {
  const match: ExactRecordLinkMatch = { key: 'exact-note', target: row('note').target, title: 'Current note', details: ['Note'], identity: 'lifetime-one', href: 'https://app.test/#data/note/one' };
  const search = vi.fn(async () => page()), read = vi.fn(async (): Promise<ExactRecordLinkState> => ({ state: 'ready', match })), verify = vi.fn(async () => true), insert = vi.fn(() => null);
  const lookup = { parse: (q: string) => parseRecordLinkQuery(q, 'https://app.test/'), read, verify };
  const model = createRecordLinkInsert({ owner: () => 'draft', kinds: ['task', 'note'], lookup, search, verify: async () => true, insert, changed: () => {} });
  model.open(); model.change(match.href); await model.search(); expect(search).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledExactlyOnceWith(match.target);
  await model.choose('forged'); expect(verify).not.toHaveBeenCalled(); verify.mockResolvedValueOnce(false); await model.choose(match.key); expect(insert).not.toHaveBeenCalled(); expect(model.state()?.error).toContain('no longer available');
  await model.choose(match.key); expect(verify).toHaveBeenCalledWith(match); expect(insert).toHaveBeenCalledExactlyOnceWith(match.target);
  model.open(); model.change('https://foreign.test/#data/note/one'); await model.search(); expect(model.state()?.exact?.state).toBe('invalid'); expect(read).toHaveBeenCalledTimes(1); expect(search).not.toHaveBeenCalled();
  model.change('regular words'); await model.search(); expect(search).toHaveBeenCalled();
});

it('retires exact lookup replies when the query changes, the picker closes, or its editor changes', async () => {
  for (const change of ['query', 'close', 'owner'] as const) {
    const result = held<ExactRecordLinkState>(); let owner = 'draft'; const insert = vi.fn(() => null);
    const model = createRecordLinkInsert({ owner: () => owner, kinds: ['note'], search: async () => page('note'), verify: async () => true, insert, changed: () => {},
      lookup: { parse: q => parseRecordLinkQuery(q, 'https://app.test/'), read: () => result.promise, verify: async () => true } });
    model.open(); model.change('#data/note/old'); const pending = model.search();
    if (change === 'query') { model.change('new'); await model.search(); } else if (change === 'close') model.close(); else owner = 'another-editor';
    result.resolve({ state: 'missing', message: 'Old record missing' }); await pending; expect(insert).not.toHaveBeenCalled();
    if (change === 'query') { expect(model.state()?.query).toBe('new'); expect(model.state()?.exact).toBeUndefined(); } else expect(model.state()).toBeNull();
  }
});
