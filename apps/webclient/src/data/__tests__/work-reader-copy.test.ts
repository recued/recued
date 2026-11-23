import { expect, it, vi } from 'vitest';
import type { WorkEntity } from '@recued/contracts';
import { createWorkReaderCopy, taskCopyText, workRecordLink, type WorkCopyOwner } from '../work-reader-copy.js';
import { parseShellRoute } from '../../shell/route.js';

const task: Extract<WorkEntity, { _kind: 'task' }> = { _kind: 'task', id: 'one', title: 'Launch <img src=x>', body: '  Notes 二\n<script>raw</script>\n',
  source_id: 'recued.task', sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1, last_seen_at: 1,
  done: false, priority: 'high', blocks_task_ids: [] };
const deferred = () => { let resolve!: (value: boolean) => void; const promise = new Promise<boolean>(done => { resolve = done; }); return { promise, resolve }; };
const setup = () => {
  const state: { owner: WorkCopyOwner | null; blocked: boolean; focused: boolean } = { owner: { entity: task, version: 1, href: 'https://app.test/recued/?pair=secret#data/search' }, blocked: false, focused: true };
  const write = vi.fn(async (_value: string) => true), render = vi.fn(), focusAction = vi.fn(), selectFallback = vi.fn();
  const copy = createWorkReaderCopy({ current: () => state.owner, blocked: () => state.blocked, write, render,
    beforeStart: vi.fn(), focusAction, actionFocused: () => state.focused, selectFallback });
  return { state, write, render, focusAction, selectFallback, copy };
};

it('copies saved task fields as plain text without changing their raw contents', () => {
  const before = structuredClone(task);
  expect(taskCopyText(task)).toBe('Launch <img src=x>\nStatus: Open\nDue date: No due date\nPriority: High\n\n  Notes 二\n<script>raw</script>\n');
  expect(taskCopyText({ ...task, title: ' ', done: true, priority: undefined, body: '' })).toBe('Task\nStatus: Completed\nDue date: No due date\nPriority: Not set');
  expect(task).toEqual(before);
});

it('retains source uncertainty in a copied task snapshot', () => {
  expect(taskCopyText({ ...task, sync_state: 'stale_unreachable' })).toContain('Source status: This source cannot be reached. The task may be out of date.');
  expect(taskCopyText({ ...task, deleted_at: 2 })).toContain('Source status: This task was deleted at its source.');
  expect(taskCopyText({ ...task, pending_write: { staged_at: 2, operation: 'update', dirty_fields: ['title'], state: 'awaiting_verify' } })).toContain('Source status: A change is waiting for source confirmation.');
});

it('builds exact record links under the deployment path without search or pairing context', () => {
  for (const kind of ['task', 'note', 'commitment'] as const) {
    const id = "shared/id?二.)!'*", value = workRecordLink('https://app.test/tools/index.html?pair=secret&query=private#views/a', kind, id)!;
    const url = new URL(value);
    expect(url.origin + url.pathname).toBe('https://app.test/tools/index.html'); expect(url.search).toBe('');
    expect(parseShellRoute(url.hash).segments).toEqual([kind, id]);
  }
  expect(workRecordLink('file:///tools/app.html', 'task', 'one')).toBeNull();
  expect(workRecordLink('not a URL', 'note', 'one')).toBeNull();
  expect(workRecordLink('https://app.test/', 'task', '')).toBeNull();
  expect(workRecordLink('https://user:secret@app.test/tools/index.html?code=pair#private', 'note', 'one'))
    .toBe('https://app.test/tools/index.html#data/note/one');
});

it('blocks overlapping copies and offers exactly the attempted value after rejection', async () => {
  const f = setup(), held = deferred(); f.write.mockReturnValue(held.promise);
  const pending = f.copy.copy('details');
  expect(f.copy.state()?.busy).toBe('details'); expect(await f.copy.copy('link')).toBe(false);
  held.resolve(false); expect(await pending).toBe(false);
  expect(f.write.mock.calls).toEqual([[taskCopyText(task)]]);
  expect(f.copy.state()?.fallback?.value).toBe(taskCopyText(task)); expect(f.selectFallback).toHaveBeenCalledOnce();
});

it('respects mutations and does not copy an unsaved editor', async () => {
  const f = setup(); f.state.blocked = true; await f.copy.copy('details');
  f.state.blocked = false; f.state.owner = null; await f.copy.copy('link'); expect(f.write).not.toHaveBeenCalled();
});

it('cannot transfer a pending result into a refreshed entity or a new read session', async () => {
  for (const change of ['entity', 'session', 'closed'] as const) {
    const f = setup(), held = deferred(); f.write.mockReturnValue(held.promise); const pending = f.copy.copy('details');
    if (change === 'closed') f.state.owner = null;
    else if (change === 'session') f.state.owner!.version++;
    else f.state.owner!.entity = { ...task, title: 'Refreshed' };
    held.resolve(false); await pending;
    expect(f.copy.state()?.notice).toBeUndefined(); expect(f.copy.state()?.fallback).toBeUndefined(); expect(f.render).toHaveBeenCalledOnce();
  }
});

it('lets a new reader copy finish while an older result is still pending', async () => {
  const f = setup(), held = deferred(); f.write.mockReturnValueOnce(held.promise); const old = f.copy.copy('details');
  f.state.owner = { ...f.state.owner!, entity: { ...task, id: 'two' }, version: 2 };
  await f.copy.copy('link'); const calls = f.render.mock.calls.length;
  held.resolve(false); await old;
  expect(f.copy.state()?.notice).toEqual({ kind: 'ok', text: 'Link copied.' }); expect(f.copy.state()?.fallback).toBeUndefined();
  expect(f.write.mock.calls[1]![0]).toBe('https://app.test/recued/#data/task/two'); expect(f.render).toHaveBeenCalledTimes(calls);
});

it('never takes focus back after the user moves away, and reset fences late work', async () => {
  const f = setup(), held = deferred(); f.write.mockReturnValue(held.promise); const pending = f.copy.copy('link');
  f.state.focused = false; held.resolve(false); await pending; expect(f.selectFallback).not.toHaveBeenCalled(); expect(f.focusAction).toHaveBeenCalledOnce();
  const next = deferred(); f.write.mockReturnValue(next.promise); const pendingNext = f.copy.copy('link'); f.copy.reset(); next.resolve(true); await pendingNext;
  expect(f.copy.state()?.notice).toBeUndefined();
});
