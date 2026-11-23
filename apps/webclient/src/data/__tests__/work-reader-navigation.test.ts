import { expect, it, vi } from 'vitest';
import { createWorkReaderNavigation, type WorkReaderKind, type WorkReaderScope } from '../work-reader-navigation.js';

const setup = () => {
  const state: { scope: WorkReaderScope; record: { kind: WorkReaderKind; id: string } | null; allowed: boolean } = {
    scope: { kind: 'task', key: 'tasks:open:recued', generation: 1, label: 'Tasks', ids: ['a', 'b', 'c'], more: false, progress: 3 },
    record: { kind: 'task', id: 'a' }, allowed: true,
  };
  const more = vi.fn(async (_kind: WorkReaderKind) => {});
  const open = vi.fn(async (kind: WorkReaderKind, id: string) => { state.record = { kind, id }; return true; });
  const focus = vi.fn(), changed = vi.fn();
  const navigation = createWorkReaderNavigation({ scope: () => state.scope, reading: () => state.record, canLeave: () => state.allowed,
    more, open, focus, changed });
  navigation.start('task', 'a', 220);
  return { state, navigation, more, open, focus };
};
const move = async (f: ReturnType<typeof setup>, direction = 'next') => {
  f.navigation.handle(`work-reader-${direction}`);
  await vi.waitFor(() => expect(f.navigation.busy()).toBe(false));
};

it('retains the opening order and return anchor when a completion removes the current row from a filter', async () => {
  const f = setup(); f.state.scope.ids = ['c', 'b'];
  await move(f); await move(f, 'previous');
  expect(f.open.mock.calls).toEqual([['task', 'b'], ['task', 'a']]);
  expect(f.navigation.returnPosition()).toEqual({ kind: 'task', id: 'a', scrollTop: 220 });
  expect(f.more).not.toHaveBeenCalled();
});

it('does not attach an old roster while a new filter is still loading', async () => {
  const f = setup(); f.state.scope.ready = false; f.navigation.start('task', 'a', 10);
  f.state.scope.ready = true; await move(f);
  expect(f.open).not.toHaveBeenCalled(); expect(f.navigation.render()).toBe('');
});

it('loads the next page once, appends unique ids without changing the old order, and reuses it when going back', async () => {
  const f = setup(); f.state.record!.id = 'c'; f.state.scope.more = true; f.navigation.resume('task', 'c');
  f.more.mockImplementation(async () => { Object.assign(f.state.scope, { ids: ['c', 'b', 'd', 'd', 'e'], progress: 5, more: false }); });
  await move(f); await move(f, 'previous'); await move(f);
  expect(f.more.mock.calls).toEqual([['task']]);
  expect(f.open.mock.calls.map(([, id]) => id)).toEqual(['d', 'c', 'd']);
  expect(f.navigation.render()).toContain('4 of 5 loaded');
});

it('keeps the current cursor on a failed page and retries it without exposing error markup', async () => {
  const f = setup(); f.state.record!.id = 'c'; f.state.scope.more = true; f.navigation.resume('task', 'c');
  f.more.mockRejectedValueOnce(new Error('Source <img src=x> unavailable.'));
  await move(f); expect(f.open).not.toHaveBeenCalled(); expect(f.navigation.returnPosition()?.id).toBe('c');
  expect(f.navigation.render()).toContain('&lt;img src=x&gt;'); expect(f.navigation.render()).not.toContain('<img');
  f.more.mockImplementation(async () => { Object.assign(f.state.scope, { ids: ['a', 'b', 'c', 'd'], progress: 4, more: false }); });
  await move(f); expect(f.open).toHaveBeenLastCalledWith('task', 'd');
});

it('does not advance past an unavailable record and retries that exact next id', async () => {
  const f = setup(); f.open.mockResolvedValueOnce(false);
  await move(f); expect(f.navigation.returnPosition()?.id).toBe('a'); expect(f.navigation.render()).toContain('could not be opened');
  await move(f); expect(f.open.mock.calls).toEqual([['task', 'b'], ['task', 'b']]); expect(f.navigation.returnPosition()?.id).toBe('b');
});

it('blocks navigation during a write and checks again after a held page, without queuing duplicate activations', async () => {
  const f = setup(); f.state.allowed = false;
  await move(f); expect(f.open).not.toHaveBeenCalled();
  f.state.allowed = true; f.state.record!.id = 'c'; f.state.scope.more = true; f.navigation.resume('task', 'c');
  let release!: () => void;
  f.more.mockImplementation(async () => { await new Promise<void>(done => { release = done; }); Object.assign(f.state.scope, { ids: ['a', 'b', 'c', 'd'], progress: 4, more: false }); });
  f.navigation.handle('work-reader-next'); f.navigation.handle('work-reader-next'); expect(f.more).toHaveBeenCalledTimes(1);
  f.state.allowed = false; release(); await vi.waitFor(() => expect(f.navigation.busy()).toBe(false)); expect(f.open).not.toHaveBeenCalled();
  expect(f.focus).not.toHaveBeenCalled();
});

it('fences a page that completes after closing the reader', async () => {
  const f = setup(); f.state.record!.id = 'c'; f.state.scope.more = true; f.navigation.resume('task', 'c');
  let release!: () => void;
  f.more.mockImplementation(async () => { await new Promise<void>(done => { release = done; }); Object.assign(f.state.scope, { ids: ['a', 'b', 'c', 'd'], progress: 4, more: false }); });
  f.navigation.handle('work-reader-next'); f.navigation.reset(); release();
  await new Promise(resolve => setImmediate(resolve)); expect(f.open).not.toHaveBeenCalled(); expect(f.navigation.render()).toBe('');
});

it('resumes a parent reader after a related visit but rejects another source, filter, or kind', async () => {
  const f = setup(); f.navigation.suspend(); f.state.record = null; f.state.scope.generation++;
  f.state.record = { kind: 'task', id: 'a' }; f.navigation.resume('task', 'a'); await move(f);
  expect(f.open).toHaveBeenLastCalledWith('task', 'b'); expect(f.navigation.returnPosition()?.scrollTop).toBe(220);
  f.state.scope.key = 'tasks:done:another-source'; f.navigation.resume('task', 'b'); await move(f);
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.navigation.render()).toBe('');
  Object.assign(f.state.scope, { key: 'tasks:open:recued', kind: 'note' }); f.navigation.resume('note', 'b'); await move(f);
  expect(f.open).toHaveBeenCalledTimes(1);
});

it('retains progress through filtered-out pages and stops a page that does not advance', async () => {
  const f = setup(); f.state.record!.id = 'c'; f.state.scope.more = true; f.navigation.resume('task', 'c');
  f.more.mockImplementationOnce(async () => { f.state.scope.progress++; })
    .mockImplementationOnce(async () => { Object.assign(f.state.scope, { ids: ['a', 'b', 'c', 'd'], progress: 5, more: false }); });
  await move(f); expect(f.more).toHaveBeenCalledTimes(2); expect(f.open).toHaveBeenLastCalledWith('task', 'd');
  f.state.scope.more = true; f.more.mockImplementation(async () => {}); await move(f);
  expect(f.navigation.render()).toContain('did not advance'); expect(f.open).toHaveBeenCalledTimes(1);
});
