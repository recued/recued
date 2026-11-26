import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mailFollowUpAutomaticReplyNotice, type MailFollowUp, type CollectionRecord } from '@recued/contracts';
import { createMailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';
import { createMailFollowUpTaskFixture } from './fixtures/mail-follow-up-task-fixture.js';

const fixtures: Array<{ dispose(): void }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = () => { const f = createMailFollowUpFixture(); fixtures.push(f); return f; };
const waiting_for = { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] };
const automatic = { reply_automation: 'v1:automatic' };

describe('keep waiting after an automatic reply', () => {
  it('retains the chosen person and task, allows Snooze and resolves only after an ordinary reply', async () => {
    const f = await createMailFollowUpTaskFixture(); fixtures.push(f);
    let watch = await f.service.start({ ...f.request(), waiting_for, notify_on_reply: true }, 'paired-owner');
    watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id }, () => {});
    const task = f.currentTask(), originalRef = watch.task_ref; f.add({ hot_fields: automatic });
    watch = await f.service.check(watch.id);
    expect(watch).toMatchObject({ state: 'waiting', waiting_for, task_ref: originalRef, automatic_reply_count: 1 });
    expect(mailFollowUpAutomaticReplyNotice(watch)).toContain('Still waiting for alex@example.test');
    expect(f.draftCount()).toBe(0); expect(f.currentTask()).toEqual(task);
    watch = await f.service.reschedule({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), check_at: f.now() + 7200000 }, () => {});
    expect(watch).toMatchObject({ state: 'waiting', automatic_reply_count: 1, waiting_for });
    f.add({ record_id: 'ordinary', source_id: 'ordinary-source', received_at: f.now() + 1 });
    const replied = await f.makeService().check(watch.id);
    expect(replied).toMatchObject({ state: 'replied', reply_record_id: 'ordinary', task_ref: watch.task_ref });
    expect(mailFollowUpAutomaticReplyNotice(replied)).toBeNull(); expect(f.currentTask()).toEqual(task);
  });

  it('applies to Anyone watches and keeps a due draft available for explicit review without accepting the automatic message', async () => {
    const f = fixture(), watch = await f.service.start(f.request(), 'paired-owner'); f.add({ hot_fields: automatic }); f.due();
    const due = await f.service.check(watch.id); expect(due).toMatchObject({ state: 'draft_ready', automatic_reply_count: 1 });
    expect(mailFollowUpAutomaticReplyNotice(due)).toContain('Still waiting'); expect(f.draftCount()).toBe(1);
    await expect(f.service.getReply({ id: watch.id })).rejects.toMatchObject({ code: 'unavailable' });
    const snoozed = await f.service.reschedule({ id: due.id, expected_revision: due.revision, request_id: randomUUID(), check_at: f.now() + 7200000 });
    expect(snoozed).toMatchObject({ state: 'waiting', draft_id: due.draft_id, automatic_reply_count: 1 });
  });

  it('requires review for legacy or ambiguous participant messages and can recover after a verified rescan', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner');
    const row: CollectionRecord = f.add(); delete row.hot_fields.reply_automation; f.tables.get('work')!.upsert(row); f.due();
    expect(await f.service.check(watch.id)).toMatchObject({ state: 'needs_attention', detail: expect.stringContaining('could not be verified') });
    expect(f.draftCount()).toBe(0);
    f.tables.get('work')!.upsert({ ...row, hot_fields: { ...row.hot_fields, ...automatic } });
    const rescanned = await f.service.check(watch.id); expect(rescanned).toMatchObject({ state: 'draft_ready', automatic_reply_count: 1 });
    expect(rescanned.reply_ref).toBeUndefined();
  });

  it('keeps unknown senders requiring review even when they claim to be automatic', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner');
    f.add({ hot_fields: { ...automatic, from: 'stranger@example.test' } }); f.due();
    expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
  });

  it('retains harmless automatic activity arriving during draft encryption but refuses a newly ordinary reply', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner'); f.due();
    f.beforeDraft(async () => { f.beforeDraft(); f.add({ hot_fields: automatic }); });
    expect(await f.service.check(watch.id)).toMatchObject({ state: 'draft_ready', automatic_reply_count: 1 });
    const other = await f.service.start({ ...f.request(f.now() + 3600000, 'personal'), waiting_for }, 'paired-owner'); f.due();
    f.beforeDraft(async () => { f.beforeDraft(); f.add({}, 'personal'); });
    expect((await f.service.check(other.id)).state).not.toBe('draft_ready');
    expect((await f.service.check(other.id)).state).toBe('replied');
  });

  it('rechecks classification after encrypted reply writes and through a previously captured reply guard', async () => {
    const f = fixture(), watch = await f.service.start(f.request(), 'paired-owner'); const row = f.add();
    f.beforeWatch(async value => { if ((value as { watch: MailFollowUp }).watch.state === 'replied') {
      f.beforeWatch(); f.tables.get('work')!.upsert({ ...row, hot_fields: { ...row.hot_fields, ...automatic } });
    } });
    expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect((await f.store.get(watch.id))!.watch.reply_ref).toBeUndefined();
    f.add({ record_id: 'real', source_id: 'real-source', received_at: f.now() + 1 });
    const replied = await f.service.check(watch.id), guard = await f.service.replyGuard(watch.id), real = f.tables.get('work')!.get('real')!;
    f.tables.get('work')!.upsert({ ...real, hot_fields: { ...real.hot_fields, ...automatic } });
    expect(() => guard()).toThrow(); await expect(f.service.getReply({ id: watch.id })).rejects.toMatchObject({ code: 'resource_changed' });
    expect((await f.service.check(replied.id)).state).toBe('waiting');
  });

  it('still supersedes the watch after a new owner send and refuses Snooze if the source changes during encryption', async () => {
    const f = fixture(); let watch = await f.service.start(f.request(), 'paired-owner'); f.add({ hot_fields: automatic }); watch = await f.service.check(watch.id);
    f.beforeWatch(async () => { f.beforeWatch(); f.add({ record_id: 'new-send', source_id: 'new-send-source', hot_fields: { from: 'owner@example.test', direction: 'outbound', folder: 'Sent' }, received_at: f.now() + 1 }); });
    await expect(f.service.reschedule({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), check_at: f.now() + 7200000 })).rejects.toMatchObject({ code: 'resource_changed' });
    expect((await f.service.check(watch.id)).state).toBe('superseded');
  });
});
