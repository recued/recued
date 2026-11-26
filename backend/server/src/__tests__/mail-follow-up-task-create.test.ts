import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { calendarDayMs, type MailFollowUpTaskCreate } from '@recued/contracts';
import { createMailFollowUpTaskFixture } from './fixtures/mail-follow-up-task-fixture.js';
import { makeMailFollowUpHandlers } from '../mail-follow-up-rpc-handler.js';

const fixtures: Awaited<ReturnType<typeof createMailFollowUpTaskFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = async () => { const f = await createMailFollowUpTaskFixture(); fixtures.push(f); return f; };
const request = async (f: Awaited<ReturnType<typeof fixture>>): Promise<MailFollowUpTaskCreate> => {
  const watch = await f.service.start(f.request(), 'paired-owner');
  return { id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), title: 'Get the revised estimate', due_on: '2026-11-24', client_url: 'https://recued.example.test/webclient/' };
};
const observe = (f: Awaited<ReturnType<typeof fixture>>) => {
  const events: string[] = [];
  f.bus.subscribe('**', event => { if (event.slug === 'task' && event.event_kind === 'created') events.push(event.record_id); });
  return events;
};

describe('create a local task together with a reply-watch link', () => {
  it('saves the reviewed title, date-only due and exact email link, publishing only after both rows commit', async () => {
    const f = await fixture(), input = await request(f), events = observe(f);
    expect((await f.service.getTask({ id: input.id })).can_create).toBe(true);
    let linkedAtPublish: unknown;
    f.bus.subscribe('**', event => {
      if (event.slug === 'task' && event.event_kind === 'created') linkedAtPublish = f.db.prepare('SELECT task_key FROM mail_follow_ups WHERE id=?').get(input.id);
    });
    const watch = await f.service.createTask(input, () => f.principal.validate()), task = f.currentTask(watch.task_ref!.id)!;
    expect(task).toMatchObject({ title: input.title, done: false, due_at: calendarDayMs(input.due_on!), source_id: 'recued.task' });
    expect(task.body).toContain('https://recued.example.test/webclient/#data/mail/record/work/sent-1');
    expect(f.taskStore.countTasks()).toBe(2); expect(events).toEqual([task.id]);
    expect(linkedAtPublish).toMatchObject({ task_key: expect.any(String) });
    const restarted = f.makeService(); expect((await restarted.createTask(input, () => {})).task_ref).toEqual(watch.task_ref);
    expect((await restarted.getTask({ id: input.id })).can_create).toBe(false); expect(f.taskStore.countTasks()).toBe(2); expect(events).toEqual([task.id]);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').all())).not.toContain(input.title);
  });

  it('rolls the task back if the watch update fails and can retry the same request without a stray task or event', async () => {
    const f = await fixture(), input = await request(f), events = observe(f);
    f.db.exec("CREATE TRIGGER reject_task_watch BEFORE UPDATE ON mail_follow_ups WHEN new.task_key IS NOT NULL BEGIN SELECT RAISE(ABORT,'reject linked task'); END");
    await expect(f.service.createTask(input, () => {})).rejects.toThrow('reject linked task');
    expect(f.taskStore.countTasks()).toBe(1); expect(events).toEqual([]); expect((await f.service.getTask({ id: input.id })).watch.task_ref).toBeUndefined();
    f.db.exec('DROP TRIGGER reject_task_watch'); await f.service.createTask(input, () => {});
    expect(f.taskStore.countTasks()).toBe(2); expect(events).toHaveLength(1);
  });

  it('deduplicates the same save racing through two service instances while encryption yields', async () => {
    const f = await fixture(), input = await request(f), events = observe(f), other = f.makeService();
    let entered = 0, release!: () => void; const held = new Promise<void>(done => { release = done; });
    f.beforeWatch(async () => { if (++entered === 2) release(); await held; });
    const [a, b] = await Promise.all([f.service.createTask(input, () => {}), other.createTask(input, () => {})]);
    expect(a.task_ref).toEqual(b.task_ref); expect(f.taskStore.countTasks()).toBe(2); expect(events).toEqual([a.task_ref!.id]);
  });

  it('retains the creation receipt after unlinking, task deletion and a later create, so an old retry cannot recreate or relink the first task', async () => {
    const f = await fixture(), input = await request(f), first = await f.service.createTask(input, () => {});
    const unlinked = await f.service.setTask({ id: first.id, expected_revision: first.revision, request_id: randomUUID(), task_id: null }, () => {});
    f.taskStore.deleteTask(first.task_ref!.id);
    const second = await f.service.createTask({ ...input, expected_revision: unlinked.revision, request_id: randomUUID(), title: 'Check delivery date', due_on: undefined }, () => {});
    expect((await f.makeService().createTask(input, () => {})).task_ref).toEqual(second.task_ref);
    await expect(f.service.createTask({ ...input, title: 'Changed retry' }, () => {})).rejects.toMatchObject({ code: 'conflict' });
    expect(f.taskStore.countTasks()).toBe(2); expect(f.currentTask(first.task_ref!.id)).toBeNull();
  });

  it('rechecks owner authority after encryption, leaving no task when the owner is revoked', async () => {
    const f = await fixture(), input = await request(f), events = observe(f);
    const handlers = makeMailFollowUpHandlers({ service: f.service, authorize: () => { f.principal.validate(); return 'paired-owner'; } })!.handlers;
    f.beforeWatch(async () => { f.allow(false); });
    await expect(handlers['mail.follow_up.task.create'](input, {} as never)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.taskStore.countTasks()).toBe(1); expect(events).toEqual([]);
  });

  it('rechecks the exact watched email and local source at commit rather than creating from an obsolete selection', async () => {
    const f = await fixture(), input = await request(f), events = observe(f), source = f.taskStore.getSource('recued.task')!;
    f.beforeWatch(async () => { f.taskStore.registerSource({ ...source, write_capable: false }); });
    await expect(f.service.createTask(input, () => {})).rejects.toMatchObject({ code: 'unavailable' }); expect(f.taskStore.countTasks()).toBe(1);
    f.taskStore.registerSource(source);
    f.beforeWatch(async () => { f.tables.get('work')!.upsert({ ...f.seed, hot_fields: { ...f.seed.hot_fields, subject: 'Replaced email' } }); });
    await expect(f.service.createTask(input, () => {})).rejects.toMatchObject({ code: 'conflict' });
    expect(f.taskStore.countTasks()).toBe(1); expect(events).toEqual([]);
  });

  it('rejects invalid dates, titles, client URLs, stale revisions and an already linked watch without creating a task', async () => {
    const f = await fixture(), input = await request(f);
    for (const patch of [{ title: ' ' }, { title: 'x'.repeat(201) }, { due_on: '2026-02-30' }, { client_url: 'javascript:alert(1)' }, { client_url: input.client_url + '?secret=value' }])
      await expect(f.service.createTask({ ...input, ...patch }, () => {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.service.createTask({ ...input, expected_revision: 99 }, () => {})).rejects.toMatchObject({ code: 'conflict' });
    f.run(false); await expect(f.service.createTask(input, () => {})).rejects.toMatchObject({ code: 'unavailable' }); f.run(true);
    await f.service.setTask({ id: input.id, expected_revision: input.expected_revision, request_id: randomUUID(), task_id: f.task.id }, () => {});
    await expect(f.service.createTask(input, () => {})).rejects.toMatchObject({ code: 'conflict' }); expect(f.taskStore.countTasks()).toBe(1);
  });
});
