import { expect, it, vi } from 'vitest';
import type { WorkEntity, WorkEntityGetRpcResponse } from '@recued/contracts';
import { createRecentWorkRecords, recentWorkRecord, recentSourceRecord } from '../recent-work-records.js';
import { createRecentWorkPanel, type CheckedRecentSource } from '../recent-work-panel.js';
import { createPinnedRecords } from '../pinned-records.js';

const task: Extract<WorkEntity, { _kind: 'task' }> = { _kind: 'task', id: 'one', title: 'Saved <img src=x>', source_id: 'recued.task', created_at: 1,
  updated_at: 1, last_seen_at: 1, sync_state: 'live', conflict_policy: 'recued_wins', done: false, blocks_task_ids: [] };
const deferred = () => { let resolve!: (value: WorkEntityGetRpcResponse) => void; const promise = new Promise<WorkEntityGetRpcResponse>(done => { resolve = done; }); return { resolve, promise }; };
const setup = () => {
  const recent = createRecentWorkRecords({ scope: 'pair', storage: null }); recent.remember(recentWorkRecord(task, 'Recued <source>'));
  const state: { scope: string | null; blocked: boolean } = { scope: 'search:1', blocked: false };
  const read = vi.fn(async (_record: unknown): Promise<WorkEntityGetRpcResponse> => ({ entity: task })), open = vi.fn(async () => {}), changed = vi.fn(), focus = vi.fn();
  const panel = createRecentWorkPanel({ recent, scope: () => state.scope, blocked: () => state.blocked, read, open, changed, focus });
  return { recent, state, read, open, changed, focus, panel };
};

it('opens the freshly read exact record with its freshness and prevents duplicate activations', async () => {
  const f = setup(), held = deferred(); f.read.mockReturnValue(held.promise); const pending = f.panel.open('task', 'one');
  await f.panel.open('task', 'one'); expect(f.read).toHaveBeenCalledOnce();
  const fresh = { ...task, title: 'Fresh title', body: 'Fresh saved body' };
  held.resolve({ entity: fresh }); await pending; expect(f.open).toHaveBeenCalledWith(fresh, undefined, undefined);
});

it('retains missing and changed-identity records for removal or a fresh retry', async () => {
  const f = setup();
  for (const entity of [null, { ...task, id: 'wrong' }, { ...task, source_id: 'another' }, { ...task, created_at: 2 }]) {
    f.read.mockResolvedValue({ entity }); await f.panel.open('task', 'one'); expect(f.panel.render('data-action')).toContain('role="alert"');
  }
  expect(f.open).not.toHaveBeenCalled(); expect(f.recent.list()).toHaveLength(1);
  f.state.scope = 'search:2'; expect(f.panel.render('data-action')).not.toContain('role="alert"');
  f.read.mockResolvedValue({ entity: task }); await f.panel.open('task', 'one'); expect(f.open).toHaveBeenCalledOnce();
});

it('cancels held reads when the item is removed, history is cleared, or the search scope changes', async () => {
  for (const change of ['remove', 'clear', 'query', 'route', 'dispose'] as const) {
    const f = setup(), held = deferred(); f.read.mockReturnValue(held.promise); const pending = f.panel.open('task', 'one');
    if (change === 'remove' || change === 'clear') f.panel.handle(`recent-work-${change}`, 'task', 'one', 'all');
    if (change === 'query') f.state.scope = null;
    if (change === 'route') f.state.scope = 'search:2';
    if (change === 'dispose') f.panel.reset();
    held.resolve({ entity: task }); await pending; expect(f.open).not.toHaveBeenCalled();
  }
});

it('lets a newer open finish without an older failure overwriting its state or focus', async () => {
  const f = setup(), held = deferred(); f.read.mockReturnValueOnce(held.promise); const old = f.panel.open('task', 'one');
  f.panel.handle('recent-work-clear', null, null, 'all'); f.recent.remember(recentWorkRecord(task, 'Recued'));
  await f.panel.open('task', 'one'); const changes = f.changed.mock.calls.length, focuses = f.focus.mock.calls.length;
  held.resolve({ entity: null }); await old;
  expect(f.open).toHaveBeenCalledOnce(); expect(f.changed).toHaveBeenCalledTimes(changes); expect(f.focus).toHaveBeenCalledTimes(focuses);
  expect(f.panel.render('data-action')).not.toContain('no longer available');
});

it('blocks opening during mutations and rechecks before installing a held read', async () => {
  const f = setup(); f.state.blocked = true; await f.panel.open('task', 'one'); expect(f.read).not.toHaveBeenCalled();
  f.state.blocked = false; const held = deferred(); f.read.mockReturnValue(held.promise); const pending = f.panel.open('task', 'one');
  f.state.blocked = true; held.resolve({ entity: task }); await pending; expect(f.open).not.toHaveBeenCalled();
});

it('renders safe labels and filters by record kind while restoring a useful removal focus', () => {
  const f = setup(); f.recent.remember({ kind: 'note', id: 'same/id?二', source_id: 'recued.note', source_label: 'Recued', created_at: 1, title: 'Note' });
  const html = f.panel.render('data-action'); expect(html).toContain('Saved &lt;img src=x&gt;'); expect(html).toContain('Recued &lt;source&gt;'); expect(html).not.toContain('<img');
  expect(f.panel.render('data-action', 'task')).not.toContain('Open note'); expect(f.panel.render('data-action', 'contact')).toBe('');
  f.panel.handle('recent-work-remove', 'note', 'same/id?二', 'all'); expect(f.focus).toHaveBeenLastCalledWith({ action: 'remove', kind: 'task', id: 'one' });
  f.panel.handle('recent-work-clear', null, null, 'all'); expect(f.focus).toHaveBeenLastCalledWith(null); expect(f.panel.render('data-action')).toContain('Recently opened history cleared.');
});

it('opens a checked source through its own reader and retires late source reads after removal or a changed search', async () => {
  for (const steering of ['open', 'remove', 'query'] as const) {
    const recent = createRecentWorkRecords({ scope: 'pair', storage: null });
    const record = recentSourceRecord({ kind: 'mail', slug: 'work', recordId: 'same/id', receivedAt: 1, identity: null, label: '<img src=x>' }, 'Work <mailbox>')!;
    recent.remember(record); let scope: string | null = 'search'; let resolve!: (value: CheckedRecentSource) => void;
    const readSource = vi.fn(() => new Promise<CheckedRecentSource>(done => { resolve = done; })), openSource = vi.fn(async () => {}), read = vi.fn(), open = vi.fn(async () => {});
    const panel = createRecentWorkPanel({ recent, scope: () => scope, blocked: () => false, read, open, readSource, openSource, changed: vi.fn(), focus: vi.fn() });
    const pending = panel.open('mail', record.id); await panel.open('mail', record.id); expect(readSource).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
    if (steering === 'remove') panel.handle('recent-work-remove', 'mail', record.id, 'all');
    if (steering === 'query') scope = null;
    const checked = { kind: 'mail' } as CheckedRecentSource; resolve(checked); await pending;
    expect(openSource).toHaveBeenCalledTimes(steering === 'open' ? 1 : 0); expect(open).not.toHaveBeenCalled();
  }
});

it('keeps failed source reads retryable, reports history-specific copy, and filters safe context labels', async () => {
  const recent = createRecentWorkRecords({ scope: 'pair', storage: null });
  const record = recentSourceRecord({ kind: 'contact', id: 'person', createdAt: 1, label: 'Riley <img src=x>' }, 'riley@example.test')!; recent.remember(record);
  const readSource = vi.fn(async (): Promise<CheckedRecentSource> => { throw Error('The original contact is unavailable or has a different identity. Your draft is still here.'); });
  const openSource = vi.fn(async () => {});
  const panel = createRecentWorkPanel({ recent, scope: () => 'search', blocked: () => false, readSource, openSource, open: vi.fn(async () => {}), changed: vi.fn(), focus: vi.fn() });
  await panel.open('contact', record.id); expect(panel.render('data-action', 'contact')).toContain('Try again or remove it from Recently opened.');
  expect(panel.render('data-action')).not.toContain('Your draft'); expect(panel.render('data-action')).toContain('Riley &lt;img src=x&gt;'); expect(panel.render('data-action')).toContain('riley@example.test');
  readSource.mockResolvedValue({ kind: 'contact' } as CheckedRecentSource); await panel.open('contact', record.id); expect(openSource).toHaveBeenCalledOnce();
});

it('rechecks pinned provider identity and deletions while keeping an unavailable shortcut removable', async () => {
  const pins = createPinnedRecords({ scope: 'pair', storage: null }); pins.pin({ ...recentWorkRecord(task, 'Recued'), source_record_id: 'provider-one' });
  const read = vi.fn(async (): Promise<WorkEntityGetRpcResponse> => ({ entity: task })), open = vi.fn(async () => {}), focus = vi.fn();
  const panel = createRecentWorkPanel({ variant: 'pinned', recent: pins, scope: () => 'search', blocked: () => false, read, open, focus, changed: vi.fn() });
  for (const entity of [{ ...task, source_record_id: 'replacement' }, { ...task, source_record_id: 'provider-one', deleted_at: 2 },
    { ...task, source_record_id: 'provider-one', sync_state: 'orphaned' as const }]) {
    read.mockResolvedValue({ entity }); await panel.open('task', 'one'); expect(open).not.toHaveBeenCalled();
  }
  const html = panel.render('data-action'); expect(html).toContain('Unpin task Saved &lt;img src=x&gt;'); expect(html).not.toContain('Clear recently opened');
  read.mockResolvedValue({ entity: { ...task, source_record_id: 'provider-one', title: 'Fresh title' } }); await panel.open('task', 'one'); expect(open).toHaveBeenCalledOnce();
  panel.handle('pinned-work-remove', 'task', 'one', 'all'); expect(pins.list()).toEqual([]); expect(focus).toHaveBeenLastCalledWith(null);
});

it('removing a pinned record cancels its held read without clearing Recently opened', async () => {
  const pins = createPinnedRecords({ scope: 'pair', storage: null }); pins.pin({ ...recentWorkRecord(task, 'Recued'), source_record_id: null });
  const recent = createRecentWorkRecords({ scope: 'pair', storage: null }); recent.remember(recentWorkRecord(task, 'Recued'));
  const held = deferred(), open = vi.fn(async () => {});
  const panel = createRecentWorkPanel({ variant: 'pinned', recent: pins, scope: () => 'search', blocked: () => false,
    read: () => held.promise, open, focus: vi.fn(), changed: vi.fn() });
  const pending = panel.open('task', 'one'); panel.handle('pinned-work-remove', 'task', 'one', 'all'); held.resolve({ entity: task }); await pending;
  expect(open).not.toHaveBeenCalled(); expect(pins.list()).toEqual([]); expect(recent.list()).toHaveLength(1);
});
