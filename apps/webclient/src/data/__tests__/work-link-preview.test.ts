import { expect, it, vi } from 'vitest';
import type { ContactRecord, WorkEntity } from '@recued/contracts';
import { createWorkLinkPreview, readWorkLinkPreview, type WorkLinkPreviewResult } from '../work-link-preview.js';
import type { WorkReaderLink, WorkRecordLink } from '../task-note-source.js';

const base = { source_id: 'recued.task', sync_state: 'live' as const, conflict_policy: 'recued_wins' as const, created_at: 1, updated_at: 1, last_seen_at: 1 };
const task: Extract<WorkEntity, { _kind: 'task' }> = { ...base, _kind: 'task', id: 'task-one', title: 'Launch <img src=x>', done: false, blocks_task_ids: [] };
const note: Extract<WorkEntity, { _kind: 'note' }> = { ...base, _kind: 'note', source_id: 'recued.note', id: 'note-one', title: 'Saved note',
  body: 'Saved <script>literal</script> ' + '二🙂'.repeat(100), last_user_action_at: 1,
  related_contact_ids: [], related_project_ids: [], related_calendar_event_ids: [], related_mail_thread_ids: [] };
const contact: ContactRecord = { _id: 'riley@example.test', _collection: 'contact', contact_id: 'contact-one', email: 'riley@example.test', name: 'Riley',
  source: 'manual', created_at: 1, updated_at: 1, first_seen: 1, last_interaction: 1, interaction_count: 0 };
const target = (tab: WorkRecordLink['tab'], id = tab + '-one'): WorkRecordLink => ({ tab, id, hash: '#data/' + tab + '/' + id });
const ready = (title = 'Fresh record'): WorkLinkPreviewResult => ({ state: 'ready', title, details: [] });
const deferred = () => {
  let resolve!: (value: WorkLinkPreviewResult) => void, reject!: (error: Error) => void;
  const promise = new Promise<WorkLinkPreviewResult>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject };
};
const setup = () => {
  const current = { owner: 'note-one:revision-one' as string | null }, read = vi.fn(async (_ref: WorkReaderLink) => ready()), changed = vi.fn();
  const model = createWorkLinkPreview({ owner: () => current.owner, read, changed });
  const links = new Map([['one', target('task')], ['two', target('note')]]);
  model.bind(current.owner, links); return { current, read, changed, model, links };
};

it('projects only the exact saved contact, task fields and a bounded literal Note excerpt without changing the records', async () => {
  const original = structuredClone({ task, note, contact }), getContact = vi.fn(async () => ({ contact }));
  const getWork = vi.fn(async (kind: 'task' | 'note' | 'commitment' | 'booking' | 'project', _id: string) => ({ entity: kind === 'task' ? task : note }));
  const readers = { contact: getContact, work: getWork };
  expect(await readWorkLinkPreview(target('contact'), readers)).toMatchObject({ state: 'ready', title: 'Riley', details: ['riley@example.test'] });
  expect(await readWorkLinkPreview(target('task'), readers)).toMatchObject({ state: 'ready', title: task.title, details: ['Open', 'Due date: No due date'] });
  const result = await readWorkLinkPreview(target('note'), readers);
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw Error('Note preview is missing');
  expect(result.excerpt).toContain('<script>literal</script>'); expect(Array.from(result.excerpt!)).toHaveLength(181);
  expect(result.excerpt).toMatch(/…$/u); expect(result.excerpt).not.toMatch(/[\ud800-\udbff]$/u);
  expect(getContact).toHaveBeenCalledExactlyOnceWith('contact-one'); expect(getWork.mock.calls).toEqual([['task', 'task-one'], ['note', 'note-one']]);
  expect({ task, note, contact }).toEqual(original);
});

it('retains completion, pending changes, source uncertainty and merged-contact state', async () => {
  expect(await readWorkLinkPreview(target('task'), { work: async () => ({ entity: { ...task, done: true,
    pending_write: { staged_at: 2, operation: 'update', dirty_fields: ['done'], state: 'awaiting_verify' } } }) }))
    .toMatchObject({ state: 'ready', details: ['Completed', 'Due date: No due date'], warning: 'A change is waiting for source confirmation.' });
  expect(await readWorkLinkPreview(target('note'), { work: async () => ({ entity: note,
    source_freshness: { source_id: note.source_id, state: 'stale' } }) })).toMatchObject({ warning: 'The saved record may be out of date.' });
  expect(await readWorkLinkPreview(target('contact'), { contact: async () => ({ contact: { ...contact, merged_into: 'kept-contact' } }) }))
    .toMatchObject({ state: 'ready', title: 'Riley', warning: 'This contact was merged. Open it to review the saved link.' });
});

it('distinguishes deleted or missing records from a response for a different identity or kind', async () => {
  expect(await readWorkLinkPreview(target('task'), { work: async () => ({ entity: null }) })).toEqual({ state: 'missing', message: 'This task is no longer available.' });
  expect(await readWorkLinkPreview(target('note'), { work: async () => ({ entity: { ...note, deleted_at: 2 } }) })).toMatchObject({ state: 'missing' });
  for (const entity of [{ ...task, id: 'another-task' }, note]) {
    await expect(readWorkLinkPreview(target('task'), { work: async () => ({ entity }) })).rejects.toThrow('could not be confirmed');
  }
  await expect(readWorkLinkPreview(target('contact'), { contact: async () => ({ contact: { ...contact, contact_id: 'another', email: 'another@example.test' } }) })).rejects.toThrow('could not be confirmed');
});

it('reads only an explicitly selected available link and coalesces repeated requests while it is loading', async () => {
  const f = setup(), held = deferred(); f.read.mockReturnValueOnce(held.promise);
  expect(f.read).not.toHaveBeenCalled(); await f.model.open('not-a-link'); expect(f.read).not.toHaveBeenCalled();
  const pending = f.model.open('one'); expect(f.model.state()).toMatchObject({ key: 'one', state: 'loading' });
  await f.model.open('one'); expect(f.read).toHaveBeenCalledExactlyOnceWith(target('task'));
  held.resolve(ready()); await pending; expect(f.model.state()).toMatchObject({ key: 'one', state: 'ready', title: 'Fresh record' });
});

it('ignores a late closed request even when a newly opened preview has finished', async () => {
  const f = setup(), held = deferred(); f.read.mockReturnValueOnce(held.promise);
  const old = f.model.open('one'); f.model.close(); await f.model.open('two');
  const paints = f.changed.mock.calls.length; held.reject(Error('Old failed read')); await old;
  expect(f.model.state()).toMatchObject({ key: 'two', state: 'ready', title: 'Fresh record' }); expect(f.changed).toHaveBeenCalledTimes(paints);
});

it('fences responses after owner revision or pairing changes, removed links, replaced targets and disposal', async () => {
  for (const change of ['owner', 'closed reader', 'removed', 'replaced', 'dispose'] as const) {
    const f = setup(), held = deferred(); f.read.mockReturnValueOnce(held.promise); const pending = f.model.open('one');
    if (change === 'owner') f.current.owner = 'different-reader-or-revision';
    if (change === 'closed reader') f.current.owner = null;
    if (change === 'removed') f.model.bind(f.current.owner, new Map());
    if (change === 'replaced') f.model.bind(f.current.owner, new Map([['one', target('task', 'replacement')]]));
    if (change === 'dispose') f.model.dispose();
    held.resolve(ready('Must not appear')); await pending; expect(f.model.state()).toBeNull(); expect(f.changed).toHaveBeenCalledOnce();
  }
});

it('offers retry after an unavailable or deleted record and never surfaces raw transport diagnostics', async () => {
  const f = setup(); f.read.mockRejectedValueOnce(Error('This linked task failed: private credential or SQL diagnostic'));
  await f.model.open('one'); expect(f.model.state()).toMatchObject({ state: 'error', message: 'This record could not be loaded. Try again.' });
  f.read.mockResolvedValueOnce({ state: 'missing', message: 'This task is no longer available.' }); await f.model.open('one');
  expect(f.model.state()).toMatchObject({ state: 'missing' }); await f.model.open('one');
  expect(f.model.state()).toMatchObject({ state: 'ready' }); expect(f.read).toHaveBeenCalledTimes(3);
});

it('previews and confirms only the selected account-qualified source record and its arrival identity', async () => {
  for (const tab of ['mail', 'calendar'] as const) {
    const target = { tab, collectionSlug: 'work', recordId: 'shared/id', hash: '#data/' + tab + '/record/work/shared%2Fid' };
    const record = { record_id: target.recordId, source_id: 'provider', received_at: 1000, modified_at: 1000, size_bytes: 1,
      hot_fields: { subject: 'Literal <img src=x>', from: 'Riley', summary: 'Event title', start_at: 2000 } };
    const source = vi.fn(async () => ({ record }));
    const result = await readWorkLinkPreview(target, { source }, 1000);
    expect(source).toHaveBeenCalledExactlyOnceWith({ platform: tab, slug: 'work', record_id: 'shared/id' });
    expect(result).toMatchObject({ state: 'ready', title: tab === 'mail' ? 'Literal <img src=x>' : 'Event title' });
    if (result.state === 'ready') expect(result.details).toContain('Account: work');
    await expect(readWorkLinkPreview(target, { source: async () => ({ record: { ...record, received_at: 2000 } }) }, 1000)).rejects.toThrow('could not be confirmed');
    await expect(readWorkLinkPreview(target, { source: async () => ({ record: { ...record, record_id: 'another' } }) })).rejects.toThrow('could not be confirmed');
    expect(await readWorkLinkPreview(target, { source: async () => ({ record: null }) })).toMatchObject({ state: 'missing' });
  }
});
