import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mailDraftRecipeConfig, parseMailDraftContent, parseMailFollowUpPreference, type MailFollowUpTaskContinuation } from '@recued/contracts';
import { createMailFollowUpTaskFixture } from './fixtures/mail-follow-up-task-fixture.js';
import { createMailComposeFollowUpFixture } from './fixtures/mail-compose-follow-up-fixture.js';
import { createMailFollowUpSendService } from '../mail-follow-up-send-service.js';

const fixtures: Awaited<ReturnType<typeof createMailFollowUpTaskFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = async () => {
  const base = await createMailFollowUpTaskFixture(); fixtures.push(base);
  let source = await base.service.start(base.request(), 'paired-owner');
  source = await base.service.setTask({ id: source.id, expected_revision: source.revision, request_id: randomUUID(), task_id: base.task.id }, () => {});
  base.due(); source = await base.service.check(source.id);
  const draft = await base.drafts.get({ draft_id: source.draft_id! }, base.principal);
  const context = await base.service.taskContext({ watch_id: source.id, draft_id: draft.draft_id });
  const selected = context.selection!, f = createMailComposeFollowUpFixture(base);
  const request = () => ({ recipe_id: 'send-composed-mail', trigger_source: 'manual', config: mailDraftRecipeConfig(draft.content),
    mail_follow_up: { request_id: randomUUID(), after_ms: 3600000, continue_task: selected } });
  const otherSend = () => createMailFollowUpSendService({ store: f.sendStore, watches: base.makeService(), mailbox: f.mailbox,
    incarnation: slug => f.instances.getIncarnation!('mail', slug), validateOwner: () => f.principal.validate(), now: f.now });
  return { ...base, ...f, source, draft, selected, request, otherSend };
};

describe('continue a saved follow-up task through a verified one-off send', () => {
  it('keeps the original association through approval and Sent sync, then moves it atomically without completing or editing the task', async () => {
    const f = await fixture(), before = f.currentTask(), args = f.request();
    expect(f.draft.reply_watch_id).toBe(f.source.id);
    const response = await f.execute(args), id = response.mail_follow_up!.id;
    expect(response.awaiting_approval).toBe(true); expect(f.delivered).toHaveLength(0);
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    await f.answer('approve'); expect(f.delivered).toHaveLength(1);
    expect((await f.send().get(id))!.state).toBe('awaiting_sync');
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    f.syncSent(); f.restartSend();
    expect((await f.send().get(id))!.state).toBe('armed');
    const next = (await f.service.getTask({ id })).watch, old = (await f.service.getTask({ id: f.source.id })).watch;
    expect(next).toMatchObject({ task_ref: f.source.task_ref, state: 'waiting', check_at: f.now() + 3600000 });
    expect(old.state).toBe('superseded'); expect(old.task_ref).toBeUndefined(); expect(f.currentTask()).toEqual(before);
    expect((await f.service.taskLinks({ tasks: [f.source.task_ref!] })).links).toMatchObject([{ watch: { id } }]);
    await f.execute(args); f.restartSend(); expect((await f.send().get(id))!.state).toBe('armed'); expect(f.delivered).toHaveLength(1);
    const unlinked = await f.service.setTask({ id, expected_revision: next.revision, request_id: randomUUID(), task_id: null }, () => {});
    f.restartSend(); await f.send().get(id); expect((await f.service.getTask({ id })).watch).toEqual(unlinked);
    expect(f.currentTask()).toEqual(before);
    const rows = JSON.stringify(f.db.prepare('SELECT * FROM mail_follow_ups').all());
    expect(rows).not.toContain(f.task.id); expect(rows).not.toContain(f.task.title);
  });

  it('retires the old watch before inserting a continuation in the same provider thread', async () => {
    const f = await fixture(), response = await f.execute(f.request()); await f.answer('approve');
    f.delivered[0]!.result.thread_id = f.seed.hot_fields.thread_id as string; f.syncSent();
    expect((await f.send().get(response.mail_follow_up!.id))!.state).toBe('armed');
    expect((await f.service.taskLinks({ tasks: [f.source.task_ref!] })).links[0]!.watch.id).toBe(response.mail_follow_up!.id);
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toBeUndefined();
  });

  it('preserves the original task when approval is denied, invocation fails, or the pending watch is cancelled', async () => {
    const f = await fixture(), denied = await f.execute(f.request()); await f.answer('deny');
    expect((await f.send().get(denied.mail_follow_up!.id))!.state).toBe('not_sent'); expect(f.delivered).toHaveLength(0);
    const failed = f.request();
    await expect(f.send().execute(failed, 'paired-owner', () => {}, async () => { throw Error('Run failed'); })).rejects.toThrow('Run failed');
    expect((await f.send().get('mfw_' + failed.mail_follow_up.request_id))!.state).toBe('not_sent');
    const waiting = await f.execute(f.request()), id = waiting.mail_follow_up!.id;
    const pending = await f.send().get(id); await f.send().cancel({ id, expected_revision: pending!.revision }, () => {});
    await f.answer('approve'); f.syncSent(); f.restartSend(); expect((await f.send().get(id))!.state).toBe('cancelled');
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    expect((await f.service.list()).watches).toHaveLength(1); expect(f.currentTask()!.done).toBe(false);
  });

  it.each(['complete', 'edit', 'unlink-relink'] as const)('does not revive stale task consent after %s during approval', async change => {
    const f = await fixture(), response = await f.execute(f.request()), id = response.mail_follow_up!.id;
    if (change === 'complete') await f.complete();
    else if (change === 'edit') f.taskStore.writeTask({ ...f.currentTask()!, title: 'Changed task' }, f.now());
    else {
      let watch = (await f.service.getTask({ id: f.source.id })).watch;
      watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: null }, () => {});
      await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id }, () => {});
    }
    await f.answer('approve'); f.syncSent();
    expect(await f.send().get(id)).toMatchObject({ state: 'needs_attention', detail: expect.stringContaining('task tracking changed') });
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    expect((await f.service.list()).watches).toHaveLength(1);
    // Returning the task to its previous content cannot revive the rejected choice.
    f.taskStore.writeTask(f.task, f.now()); f.restartSend();
    expect((await f.send().get(id))!.state).toBe('needs_attention'); expect((await f.service.list()).watches).toHaveLength(1);
  });

  it('rechecks cancellation from another service after encryption and commits neither watch change', async () => {
    const f = await fixture(), response = await f.execute(f.request()), id = response.mail_follow_up!.id;
    await f.answer('approve'); f.syncSent();
    f.beforeWatch(async () => { f.beforeWatch(); const other = f.otherSend(), pending = await f.sendStore.get(id);
      await other.cancel({ id, expected_revision: pending!.intent.revision }, () => {}); });
    expect((await f.send().get(id))!.state).toBe('cancelled');
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    expect((await f.service.list()).watches).toHaveLength(1);
  });

  it('rechecks task changes at encrypted commit and rolls back the original link and new watch', async () => {
    const f = await fixture(), response = await f.execute(f.request()), id = response.mail_follow_up!.id;
    await f.answer('approve'); f.syncSent();
    f.beforeWatch(async () => { f.beforeWatch(); await f.complete(); });
    expect((await f.send().get(id))!.state).toBe('needs_attention');
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    expect((await f.service.list()).watches).toHaveLength(1);
  });

  it.each(['owner', 'sent-identity', 'task-unlinked'] as const)('rechecks %s after encryption before moving either association', async change => {
    const f = await fixture(), response = await f.execute(f.request()), id = response.mail_follow_up!.id;
    await f.answer('approve'); const sent = f.syncSent();
    f.beforeWatch(async () => {
      f.beforeWatch();
      if (change === 'owner') f.allow(false);
      else if (change === 'sent-identity') f.tables.get('work')!.upsert({ ...sent, hot_fields: { ...sent.hot_fields, rfc_message_id: '<replaced@example.test>' } });
      else {
        const other = f.makeService(), watch = (await other.getTask({ id: f.source.id })).watch;
        await other.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: null }, () => {});
      }
    });
    expect((await f.send().get(id))!.state).toBe('needs_attention'); f.allow(true);
    const old = (await f.service.getTask({ id: f.source.id })).watch;
    expect(old.task_ref).toEqual(change === 'task-unlinked' ? undefined : f.source.task_ref);
    expect((await f.service.list()).watches).toHaveLength(1); expect(f.currentTask()!.done).toBe(false);
  });

  it('accepts a legacy task association and ordinary watch revisions without silently replacing the selected task', async () => {
    const f = await fixture(), value = (await f.store.get(f.source.id))!;
    delete value.watch.task_link_version; value.watch.revision += 1;
    await f.store.put(value, value.watch.revision - 1);
    const selected = (await f.service.taskContext({ watch_id: f.source.id, draft_id: f.draft.draft_id })).selection!;
    expect(selected.link_version).toBe(0);
    // A background watch update changes its revision, not the task association.
    const changed = { ...value, watch: { ...value.watch, checked_at: f.now(), revision: value.watch.revision + 1 } };
    await f.store.put(changed, value.watch.revision);
    const args = f.request(); args.mail_follow_up.continue_task = selected;
    const response = await f.execute(args); await f.answer('approve'); f.syncSent();
    expect((await f.send().get(response.mail_follow_up!.id))!.state).toBe('armed');
    expect(f.currentTask()!.done).toBe(false);
  });

  it.each(['new-watch', 'send-receipt'] as const)('rolls back the whole transfer if the %s write fails, then retries once', async failure => {
    const f = await fixture(), response = await f.execute(f.request()), id = response.mail_follow_up!.id;
    await f.answer('approve'); f.syncSent();
    f.db.exec(failure === 'new-watch'
      ? "CREATE TRIGGER fail_transfer BEFORE INSERT ON mail_follow_ups BEGIN SELECT RAISE(ABORT, 'Watch write failed'); END"
      : "CREATE TRIGGER fail_transfer BEFORE UPDATE ON mail_follow_up_sends WHEN NEW.state='armed' BEGIN SELECT RAISE(ABORT, 'Receipt write failed'); END");
    expect((await f.send().get(id))!.state).toBe('needs_attention');
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    expect((await f.service.list()).watches).toHaveLength(1);
    f.db.exec('DROP TRIGGER fail_transfer'); f.restartSend(); expect((await f.send().get(id))!.state).toBe('armed');
    expect(f.delivered).toHaveLength(1); expect(f.currentTask()!.done).toBe(false);
  });

  it('binds the choice to the actual follow-up draft and sending mailbox', async () => {
    const f = await fixture();
    await expect(f.service.taskContext({ watch_id: f.source.id, draft_id: 'mad_' + randomUUID() })).rejects.toMatchObject({ code: 'resource_changed' });
    for (const patch of [{ draft_id: 'mad_' + randomUUID() }, { task_hash: '0'.repeat(64) }, { task_ref: { ...f.selected.task_ref, created_at: 1 } }]) {
      const args = f.request(); args.mail_follow_up.continue_task = { ...f.selected, ...patch };
      await expect(f.execute(args)).rejects.toMatchObject({ code: 'resource_changed' });
    }
    for (const [key, value] of [['sender_mail_instance', 'personal'], ['in_reply_to', '<other@example.test>']]) {
      const args = f.request(); args.config = { ...args.config, [key!]: value! };
      await expect(f.execute(args)).rejects.toMatchObject({ code: 'resource_changed' });
    }
    const content = parseMailDraftContent({ ...f.draft.content, follow_up: { after_ms: 3600000, continue_task: f.selected } });
    expect(parseMailFollowUpPreference(content.follow_up).continue_task).toEqual(f.selected);
    expect(mailDraftRecipeConfig(content)).not.toHaveProperty('follow_up');
    expect(f.delivered).toHaveLength(0);
    expect(() => parseMailFollowUpPreference({ after_ms: 3600000, continue_task: { ...f.selected, injected: true } })).toThrow();
    expect(() => parseMailFollowUpPreference({ after_ms: 3600000, continue_task: { ...f.selected, link_version: -1 } as MailFollowUpTaskContinuation })).toThrow();
  });

  it('does not offer a continuation for a task replaced before the composer context lookup', async () => {
    const f = await fixture();
    f.taskStore.deleteTask(f.task.id);
    f.taskStore.writeTask({ ...f.task, created_at: f.task.created_at + 1 }, f.now());
    await expect(f.service.taskContext({ watch_id: f.source.id, draft_id: f.draft.draft_id })).rejects.toMatchObject({ code: 'resource_changed' });
    await expect(f.execute(f.request())).rejects.toMatchObject({ code: 'resource_changed' });
    expect(f.delivered).toHaveLength(0); expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
  });
});
