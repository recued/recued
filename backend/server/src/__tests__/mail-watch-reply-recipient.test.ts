import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mailDraftRecipeConfig, parseMailDraftContent, parseMailFollowUpPreference, readMailFollowUpWaitingFor, type MailFollowUpWaitingFor } from '@recued/contracts';
import { createMailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';
import { createMailFollowUpTaskFixture } from './fixtures/mail-follow-up-task-fixture.js';
import { createMailComposeFollowUpFixture } from './fixtures/mail-compose-follow-up-fixture.js';

const owned: Array<{ dispose(): void }> = [];
afterEach(() => { for (const f of owned.splice(0)) f.dispose(); });
const fixture = () => { const f = createMailFollowUpFixture(); owned.push(f); return f; };
const selected: MailFollowUpWaitingFor = { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] };
const copyReply = { from: 'copy@example.test' };

describe('reply watches waiting for a chosen participant', () => {
  it('keeps a Cc reply visible without satisfying the watch, prepares a due draft, and resolves only for the chosen person', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for: selected }, 'paired-owner');
    f.add({ hot_fields: copyReply });
    expect(await f.service.check(watch.id)).toMatchObject({ state: 'waiting', waiting_for: selected, other_reply_count: 1 });
    expect(f.draftCount()).toBe(0); f.due();
    const due = await f.makeService().check(watch.id); expect(due).toMatchObject({ state: 'draft_ready', other_reply_count: 1 });
    const draft = await f.drafts.get({ draft_id: due.draft_id }, f.principal);
    expect(parseMailFollowUpPreference(draft.content.follow_up).waiting_for).toEqual(selected);
    expect(mailDraftRecipeConfig(draft.content)).not.toHaveProperty('follow_up');
    f.add({ record_id: 'chosen-reply', source_id: 'chosen-reply-source', received_at: f.now() + 1 });
    const replied = await f.service.check(watch.id); expect(replied).toMatchObject({ state: 'replied', reply_record_id: 'chosen-reply' });
    expect((await f.service.getReply({ id: watch.id })).mail_ref.record_id).toBe('chosen-reply');
    f.tables.get('work')!.upsert({ ...f.tables.get('work')!.get('chosen-reply')!, hot_fields: { ...f.tables.get('work')!.get('chosen-reply')!.hot_fields, from: 'copy@example.test' } });
    await expect(f.service.getReply({ id: watch.id })).rejects.toMatchObject({ code: 'resource_changed' });
  });

  it('can wait for a Cc recipient while a To recipient has already replied', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for: { ...selected, address: 'copy@example.test' } }, 'paired-owner');
    f.add(); expect((await f.service.check(watch.id)).state).toBe('waiting');
    f.add({ record_id: 'copy-reply', source_id: 'copy-reply-source', hot_fields: copyReply, received_at: f.now() + 1 });
    expect((await f.service.check(watch.id)).reply_record_id).toBe('copy-reply');
  });

  it('keeps the legacy Anyone behavior and treats an unknown sender as activity requiring review', async () => {
    const f = fixture(), any = await f.service.start(f.request(), 'paired-owner'); f.add({ hot_fields: copyReply });
    expect((await f.service.check(any.id)).state).toBe('replied');
    const other = await f.service.start({ ...f.request(f.now() + 3600000, 'personal'), waiting_for: selected }, 'paired-owner');
    f.add({ hot_fields: { from: 'unknown@example.test' } }, 'personal'); f.due();
    expect((await f.service.check(other.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
  });

  it('accepts another listed participant arriving while a draft is encrypted, and revalidates a chosen reply arriving then', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for: selected }, 'paired-owner'); f.due();
    f.beforeDraft(async () => { f.beforeDraft(); f.add({ hot_fields: copyReply }); });
    expect(await f.service.check(watch.id)).toMatchObject({ state: 'draft_ready', other_reply_count: 1 });
    const other = await f.service.start({ ...f.request(f.now() + 3600000, 'personal'), waiting_for: selected }, 'paired-owner'); f.due();
    f.beforeDraft(async () => { f.beforeDraft(); f.add({}, 'personal'); });
    const checked = await f.service.check(other.id); expect(checked.state).not.toBe('draft_ready');
    expect((await f.service.check(other.id)).state).toBe('replied');
  });

  it('does not hide a newer owner-sent message behind another participant reply', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for: selected }, 'paired-owner');
    f.add({ hot_fields: copyReply });
    f.add({ record_id: 'new-owner-send', source_id: 'owner-next', hot_fields: { from: 'owner@example.test', direction: 'outbound', folder: 'Sent' }, received_at: f.now() + 1 });
    expect((await f.service.check(watch.id)).state).toBe('superseded'); expect(f.draftCount()).toBe(0);
  });

  it('binds retries to the chosen participant and rejects outsiders, self and changed participant lists', async () => {
    const f = fixture(), request = { ...f.request(), waiting_for: selected }, watch = await f.service.start(request, 'paired-owner');
    expect(await f.makeService().start(request, 'paired-owner')).toEqual(watch);
    await expect(f.service.start({ ...request, waiting_for: { ...selected, address: 'copy@example.test' } }, 'paired-owner')).rejects.toMatchObject({ code: 'conflict' });
    for (const waiting_for of [{ address: 'outsider@example.test', recipients: [...selected.recipients, 'outsider@example.test'] },
      { address: 'owner@example.test', recipients: [...selected.recipients, 'owner@example.test'] },
      { address: selected.address, recipients: [selected.address] }]) {
      await expect(f.service.start({ ...f.request(), waiting_for }, 'paired-owner')).rejects.toMatchObject({ code: 'resource_changed' });
    }
    expect((await f.service.list()).watches).toHaveLength(1);
  });

  it('checks source identity and owner permission again after encrypting the watch', async () => {
    const f = fixture();
    f.beforeWatch(async () => { f.tables.get('work')!.upsert({ ...f.seed, hot_fields: { ...f.seed.hot_fields, cc: ['new-copy@example.test'] } }); });
    await expect(f.service.start({ ...f.request(), waiting_for: selected }, 'paired-owner')).rejects.toMatchObject({ code: 'conflict' });
    f.beforeWatch(); f.tables.get('work')!.upsert(f.seed);
    f.beforeWatch(async () => { f.allow(false); });
    await expect(f.service.start({ ...f.request(), waiting_for: selected }, 'paired-owner', () => f.principal.validate())).rejects.toMatchObject({ code: 'forbidden' });
    f.beforeWatch(); f.allow(true); expect((await f.service.list()).watches).toEqual([]);
  });

  it('preserves the participant through approval, Sent verification, restart and atomic task continuation', async () => {
    const base = await createMailFollowUpTaskFixture(); owned.push(base);
    let source = await base.service.start({ ...base.request(), waiting_for: selected }, 'paired-owner');
    source = await base.service.setTask({ id: source.id, expected_revision: source.revision, request_id: randomUUID(), task_id: base.task.id }, () => {});
    base.due(); source = await base.service.check(source.id);
    const draft = await base.drafts.get({ draft_id: source.draft_id }, base.principal), f = createMailComposeFollowUpFixture(base);
    const task = (await base.service.taskContext({ watch_id: source.id, draft_id: draft.draft_id })).selection!;
    const response = await f.execute({ recipe_id: 'send-composed-mail', config: mailDraftRecipeConfig(draft.content),
      mail_follow_up: { request_id: randomUUID(), ...parseMailFollowUpPreference(draft.content.follow_up), continue_task: task } });
    expect(response.awaiting_approval).toBe(true); expect(response.mail_follow_up!.waiting_for).toEqual(selected);
    await f.answer('approve'); expect((await f.send().get(response.mail_follow_up!.id))!.state).toBe('awaiting_sync');
    expect((await base.service.getTask({ id: source.id })).watch.task_ref).toEqual(source.task_ref);
    const sent = f.syncSent(); f.restartSend(); expect((await f.send().get(response.mail_follow_up!.id))!.state).toBe('armed');
    const next = (await base.service.getTask({ id: response.mail_follow_up!.id })).watch;
    expect(next).toMatchObject({ waiting_for: selected, task_ref: source.task_ref });
    f.add({ record_id: 'next-copy', source_id: 'next-copy-source', hot_fields: { ...copyReply, thread_id: sent.hot_fields.thread_id }, received_at: f.now() + 1 });
    expect((await base.service.check(next.id)).state).toBe('waiting'); expect(base.currentTask()!.done).toBe(false);
    f.add({ record_id: 'next-chosen', source_id: 'next-chosen-source', hot_fields: { thread_id: sent.hot_fields.thread_id }, received_at: f.now() + 2 });
    expect((await base.service.check(next.id)).state).toBe('replied'); expect(base.currentTask()!.done).toBe(false); expect(f.delivered).toHaveLength(1);
  });

  it('rejects recipient changes before dispatch and excludes the selection from recipe arguments and scheduled sends', async () => {
    const base = fixture(), f = createMailComposeFollowUpFixture(base);
    const content = parseMailDraftContent({ sender_mail_instance: 'work', to: ['alex@example.test'], cc: ['copy@example.test'], subject: 'Chosen recipient', body: 'Please reply', follow_up: { after_ms: 3600000, waiting_for: selected } });
    const changed = { ...mailDraftRecipeConfig(content), cc: ['another@example.test'] };
    await expect(f.execute({ recipe_id: 'send-composed-mail', config: changed, mail_follow_up: { request_id: randomUUID(), after_ms: 3600000, waiting_for: selected } })).rejects.toMatchObject({ code: 'resource_changed' });
    expect(f.delivered).toHaveLength(0); expect(f.sendStore.activeIds()).toEqual([]);
    expect(() => f.send().validateScheduled(content, 'paired-owner')).toThrow('Anyone on To/Cc before scheduling');
    expect(mailDraftRecipeConfig(content)).not.toHaveProperty('follow_up');
    expect(readMailFollowUpWaitingFor({ address: 'Alex <ALEX@example.test>', recipients: ['COPY@example.test', 'alex@example.test', 'alex@example.test'] })).toEqual(selected);
    expect(readMailFollowUpWaitingFor({ ...selected, arbitrary: true })).toBeNull();
    expect(readMailFollowUpWaitingFor({ ...selected, address: 'alex@example.test, other@example.test' })).toBeNull();
  });
});
