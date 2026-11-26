import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mailFollowUpTaskRef, RpcError } from '@recued/contracts';
import { createMailFollowUpTaskFixture } from './fixtures/mail-follow-up-task-fixture.js';
import { makeMailFollowUpHandlers } from '../mail-follow-up-rpc-handler.js';

const fixtures: Awaited<ReturnType<typeof createMailFollowUpTaskFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = async () => { const f = await createMailFollowUpTaskFixture(); fixtures.push(f); return f; };
const link = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const watch = await f.service.start(f.request(), 'paired-owner');
  const request = { id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id };
  return { watch: await f.service.setTask(request, () => f.principal.validate()), request };
};

describe('reply watches linked to existing tasks', () => {
  it('persists one exact encrypted task link, retries a lost save, and observes a reply without completing the task', async () => {
    const f = await fixture(), { watch, request } = await link(f), service = f.makeService();
    expect(await service.setTask(request, () => {})).toEqual(watch);
    const ref = mailFollowUpTaskRef({ ...f.task, _kind: 'task' })!;
    expect(await service.taskLinks({ tasks: [ref] })).toMatchObject({ available: true, links: [{ task_ref: ref, watch: { id: watch.id, state: 'waiting' } }] });
    f.add({ received_at: f.now() + 1 }); await service.check(watch.id);
    expect((await service.setTask(request, () => {})).state).toBe('replied');
    await expect(service.setTask({ ...request, task_id: null }, () => {})).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.getTask({ id: watch.id })).task).toMatchObject({ title: f.task.title, done: false });
    expect((await service.taskLinks({ tasks: [ref] })).links[0]!.watch.state).toBe('replied'); expect(f.currentTask()!.done).toBe(false);
    await f.complete(); expect(f.currentTask()!.done).toBe(true); expect((await service.getTask({ id: watch.id })).task!.done).toBe(true);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').all())).not.toContain(f.task.id);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').all())).not.toContain(f.task.title);
  });

  it('keeps source failures visible and lets the owner unlink an unavailable task without touching the task', async () => {
    const f = await fixture(), { watch } = await link(f); f.unavailable(true);
    expect(await f.service.getTask({ id: watch.id })).toMatchObject({ task: null, reason: expect.any(String) });
    const ref = watch.task_ref!; expect(await f.service.taskLinks({ tasks: [ref] })).toMatchObject({ links: [], unavailable: [ref] });
    const unlinked = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: null }, () => {});
    expect(unlinked.task_ref).toBeUndefined(); expect(f.currentTask()!.done).toBe(false);
  });

  it('refuses stale or already completed tasks and requires the current watch revision', async () => {
    const f = await fixture(), watch = await f.service.start(f.request(), 'paired-owner');
    const request = { id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id };
    f.stale(true); await expect(f.service.setTask(request, () => {})).rejects.toMatchObject({ code: 'resource_changed' }); f.stale(false);
    await f.complete(); await expect(f.service.setTask(request, () => {})).rejects.toMatchObject({ code: 'resource_changed' });
    await expect(f.service.setTask({ ...request, task_id: null, expected_revision: 99 }, () => {})).rejects.toMatchObject({ code: 'conflict' });
  });

  it('enforces one task per watch and one watch per task without redirecting another watch', async () => {
    const f = await fixture(), { watch } = await link(f), other = await f.service.start(f.request(f.now() + 3600000, 'personal'), 'paired-owner');
    await expect(f.service.setTask({ id: other.id, expected_revision: other.revision, request_id: randomUUID(), task_id: f.task.id }, () => {})).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.service.check(other.id)).task_ref).toBeUndefined();
    const second = await f.createTask('Get delivery date');
    const moved = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: second.id }, () => {});
    expect(moved.task_ref!.id).toBe(second.id); expect((await f.service.taskLinks({ tasks: [watch.task_ref!] })).links).toEqual([]);
  });

  it('rechecks task completion and owner authority after task reads and at encrypted commit', async () => {
    const f = await fixture(), watch = await f.service.start(f.request(), 'paired-owner');
    const request = { id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id };
    f.afterTaskRead(async () => { await f.complete(); });
    await expect(f.service.setTask(request, () => {})).rejects.toMatchObject({ code: 'resource_changed' });
    const next = await f.createTask('Another task');
    f.beforeWatch(async () => { f.allow(false); });
    await expect(f.service.setTask({ ...request, task_id: next.id }, () => f.principal.validate())).rejects.toMatchObject({ code: 'forbidden' });
    f.beforeWatch(); f.allow(true); expect((await f.service.check(watch.id)).task_ref).toBeUndefined();
  });

  it('does not accept replaced task identities or a forged list scope and enforces owner RPC authorization', async () => {
    const f = await fixture(), { watch } = await link(f), ref = watch.task_ref!;
    expect((await f.service.taskLinks({ tasks: [{ ...ref, created_at: ref.created_at + 1 }] })).links).toEqual([]);
    f.taskStore.deleteTask(f.task.id);
    f.taskStore.writeTask({ ...f.task, created_at: f.task.created_at + 1 }, f.now());
    expect(await f.service.getTask({ id: watch.id })).toMatchObject({ task: null, reason: expect.stringContaining('replaced') });
    expect(await f.service.taskLinks({ tasks: [ref] })).toMatchObject({ links: [], unavailable: [ref] });
    await expect(f.service.taskLinks({ tasks: [{ ...ref, source_id: '' }] })).rejects.toMatchObject({ code: 'bad_request' });
    const handlers = makeMailFollowUpHandlers({ service: f.service, authorize: () => { throw new RpcError('forbidden', 'Owner only', 403); } })!.handlers;
    await expect(handlers['mail.follow_up.task.get']({ id: watch.id }, {} as never)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: 'invalid', task_id: null }, () => {})).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses a task source that goes stale while the encrypted link is being saved', async () => {
    const f = await fixture(), watch = await f.service.start(f.request(), 'paired-owner');
    f.beforeWatch(async () => { f.stale(true); });
    await expect(f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id }, () => {}))
      .rejects.toMatchObject({ code: 'resource_changed' });
    f.beforeWatch(); f.stale(false);
    expect((await f.service.check(watch.id)).task_ref).toBeUndefined(); expect(f.currentTask()!.done).toBe(false);
  });
});
