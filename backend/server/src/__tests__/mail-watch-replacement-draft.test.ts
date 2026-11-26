import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SEND_COMPOSED_MAIL_RECIPE_ID, type MailFollowUp, type MailDraftContent } from '@recued/contracts';
import { canonicalizeGmail } from '../collections/mail/gmail-provider.js';
import { buildRecord } from '../collections/mail/mail-collection.js';
import { createMailFollowUpTaskFixture } from './fixtures/mail-follow-up-task-fixture.js';
import { createMailComposeFollowUpFixture } from './fixtures/mail-compose-follow-up-fixture.js';
import { deliveryReportMime } from './fixtures/mail-delivery-report-fixture.js';

const fixtures: Array<{ dispose(): void }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const boot = async (ready = false) => {
  const f = await createMailFollowUpTaskFixture(); fixtures.push(f);
  let watch = await f.service.start({ ...f.request(), waiting_for: { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] } }, 'paired-owner');
  watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id }, () => {});
  if (ready) { f.due(); watch = await f.service.check(watch.id); }
  const message = await canonicalizeGmail({ id: 'failure', threadId: 'report-thread', labelIds: ['INBOX'], raw: deliveryReportMime({ at: f.now() }).toString('base64url') });
  const { record } = buildRecord(message, f.now, 'owner@example.test'); f.tables.get('work')!.upsert(record);
  watch = await f.service.check(watch.id); expect(watch.state).toBe('delivery_failed');
  const replacementRequest = () => ({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID() });
  const prepare = async () => f.service.createReplacement(replacementRequest(), 'paired-owner', f.principal.validate);
  return { ...f, watch, report: record, replacementRequest, prepare };
};
type Fixture = Awaited<ReturnType<typeof boot>>;
const read = (f: Fixture, id: string) => f.drafts.get({ draft_id: id }, f.principal);
const part = (body = 'Original attachment') => ({ filename: 'terms.txt', mime_type: 'text/plain', size: Buffer.byteLength(body), source_part_id: '1', fetchBytes: async () => Buffer.from(body) });
const file = (body = 'Original attachment') => ({ file_id: 'file:' + 'a'.repeat(32), filename: 'terms.txt', mime_type: 'text/plain', size: Buffer.byteLength(body),
  content_hash: createHash('sha256').update(body).digest('hex'), selection_revision: 'selection-1' });

describe('replacement drafts from verified delivery failures', () => {
  it('copies the verified original and all retained attachment bytes as a new email, leaving the old follow-up edits and task unchanged', async () => {
    const f = await boot(true), task = f.currentTask(), old = await read(f, f.watch.draft_id!);
    await f.drafts.update({ draft_id: old.draft_id, expected_revision: old.revision, content: { ...old.content, body: 'Keep the owner’s previous follow-up edits.' } }, f.principal);
    const original = f.tables.get('work')!.get('sent-1')!;
    f.tables.get('work')!.upsert({ ...original, hot_fields: { ...original.hot_fields, has_attachments: true } });
    f.replacementAttachments([{ ...part(), size: 0 }], [file()]);
    const prepared = await f.prepare(), draft = await read(f, prepared.replacement_draft_id!);
    expect(draft).toMatchObject({ reply_watch_id: f.watch.id, delivery_replacement: true, content: {
      sender_mail_instance: 'work', to: ['alex@example.test'], subject: 'Renewal', body: 'Can you confirm the renewal?',
      body_format: 'text', attachments: [file().file_id] } });
    for (const key of ['in_reply_to', 'references', 'reconciliation_id', 'cc', 'bcc', 'follow_up']) expect(draft.content).not.toHaveProperty(key);
    expect((await read(f, old.draft_id)).content.body).toBe('Keep the owner’s previous follow-up edits.');
    expect(prepared).toMatchObject({ state: 'delivery_failed', task_ref: f.watch.task_ref, draft_id: old.draft_id }); expect(f.currentTask()).toEqual(task);
    expect((await f.service.getDeliveryReport({ id: f.watch.id })).mail_ref.record_id).toBe(f.report.record_id);
  });

  it('reuses one saved copy across retries and a lost final watch write, retaining edits made before recovery', async () => {
    const f = await boot(), request = f.replacementRequest(); let once = true;
    f.beforeWatch(async raw => { if ((raw as { watch: MailFollowUp }).watch.replacement_draft_id && once) { once = false; throw Error('Lost watch write'); } });
    await expect(f.service.createReplacement(request, 'paired-owner', f.principal.validate)).rejects.toThrow('Lost watch write');
    const saved = (await f.drafts.list({}, f.principal)).drafts[0]!, draft = await read(f, saved.draft_id);
    await f.drafts.update({ draft_id: draft.draft_id, expected_revision: draft.revision, content: { ...draft.content, body: 'Recovered owner edits.', to: ['new-alex@example.test'] } }, f.principal);
    const retried = await f.service.createReplacement(request, 'paired-owner', f.principal.validate);
    const again = await f.service.createReplacement(f.replacementRequest(), 'paired-owner', f.principal.validate);
    expect(again.replacement_draft_id).toBe(retried.replacement_draft_id); expect(f.draftCount()).toBe(1);
    expect((await read(f, retried.replacement_draft_id!)).content).toMatchObject({ body: 'Recovered owner edits.', to: ['new-alex@example.test'] });
  });

  it('converges simultaneous service instances on one saved replacement without overwriting either response', async () => {
    const f = await boot(), a = f.replacementRequest(), b = f.replacementRequest();
    const result = await Promise.allSettled([f.service.createReplacement(a, 'paired-owner', f.principal.validate),
      f.makeService().createReplacement(b, 'paired-owner', f.principal.validate)]);
    expect(result.filter(value => value.status === 'fulfilled').length).toBeGreaterThan(0);
    const one = await f.service.createReplacement(a, 'paired-owner', f.principal.validate);
    const two = await f.makeService().createReplacement(b, 'paired-owner', f.principal.validate);
    expect(one.replacement_draft_id).toBe(two.replacement_draft_id); expect(f.draftCount()).toBe(1); expect(f.currentTask()!.done).toBe(false);
  });

  it('offers explicit task consent for the new copy, while keeping ordinary failed-watch continuations blocked', async () => {
    const f = await boot(true), prepared = await f.prepare(), draft = await read(f, prepared.replacement_draft_id!);
    const context = await f.service.taskContext({ watch_id: f.watch.id, draft_id: draft.draft_id });
    expect(context.selection).toMatchObject({ draft_id: draft.draft_id, task_ref: f.watch.task_ref, replacement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(f.service.taskContext({ watch_id: f.watch.id, draft_id: f.watch.draft_id! })).rejects.toMatchObject({ code: 'resource_changed' });
    const corrected: MailDraftContent = { ...draft.content, to: ['new-alex@example.test'] };
    const guard = await f.service.validateContinuation(context.selection!, corrected); guard();
    for (const content of [draft.content, { ...corrected, cc: ['copy@example.test'] }, { ...corrected, in_reply_to: '<sent-1@example.test>' }, { ...corrected, sender_mail_instance: 'personal' }])
      await expect(f.service.validateContinuation(context.selection!, content)).rejects.toMatchObject({ code: 'resource_changed' });
    await expect(f.service.validateContinuation({ ...context.selection!, replacement_hash: '0'.repeat(64) }, corrected)).rejects.toMatchObject({ code: 'resource_changed' });
    await f.service.cancel({ id: prepared.id, expected_revision: prepared.revision }); expect(() => guard()).toThrow();
  });

  it('moves the task only after the approved replacement send and exact Sent sync, retaining original failure history through restart and replay', async () => {
    const f = await boot(true), prepared = await f.prepare(), draft = await read(f, prepared.replacement_draft_id!), task = f.currentTask();
    const context = await f.service.taskContext({ watch_id: f.watch.id, draft_id: draft.draft_id }), compose = createMailComposeFollowUpFixture(f);
    const args = { recipe_id: SEND_COMPOSED_MAIL_RECIPE_ID, config: { ...draft.content, to: ['new-alex@example.test'] },
      mail_follow_up: { request_id: randomUUID(), after_ms: 3600000, continue_task: context.selection! } };
    const response = await compose.execute(args); expect(compose.delivered).toHaveLength(0);
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    await compose.answer('approve'); expect(compose.delivered).toHaveLength(1);
    expect((await compose.send().get(response.mail_follow_up!.id))!.state).toBe('awaiting_sync');
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    compose.syncSent(); compose.restartSend(); expect((await compose.send().get(response.mail_follow_up!.id))!.state).toBe('armed');
    const next = (await f.service.getTask({ id: response.mail_follow_up!.id })).watch, source = (await f.service.getTask({ id: f.watch.id })).watch;
    expect(next).toMatchObject({ task_ref: f.watch.task_ref, state: 'waiting' }); expect(source).toMatchObject({ state: 'delivery_failed', replacement_draft_id: draft.draft_id });
    expect(source.task_ref).toBeUndefined(); expect(f.currentTask()).toEqual(task); expect((await f.service.getDeliveryReport({ id: f.watch.id })).mail_ref.record_id).toBe(f.report.record_id);
    await compose.execute(args); expect(compose.delivered).toHaveLength(1); expect(f.currentTask()).toEqual(task);
  });

  it('keeps task tracking on the source when the report changes during approval, or when approval is denied', async () => {
    for (const deny of [true, false]) {
      const f = await boot(), prepared = await f.prepare(), draft = await read(f, prepared.replacement_draft_id!);
      const context = await f.service.taskContext({ watch_id: f.watch.id, draft_id: draft.draft_id }), compose = createMailComposeFollowUpFixture(f);
      const response = await compose.execute({ recipe_id: SEND_COMPOSED_MAIL_RECIPE_ID, config: { ...draft.content, to: ['new-alex@example.test'] },
        mail_follow_up: { request_id: randomUUID(), after_ms: 3600000, continue_task: context.selection! } });
      if (deny) { await compose.answer('deny'); expect(compose.delivered).toHaveLength(0); }
      else { f.tables.get('work')!.delete(f.report.record_id); await compose.answer('approve'); compose.syncSent(); }
      expect((await compose.send().get(response.mail_follow_up!.id))!.state).toBe(deny ? 'not_sent' : 'needs_attention');
      expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref); expect(f.currentTask()!.done).toBe(false);
      expect((await f.service.list()).watches).toHaveLength(1);
    }
  });

  it('refuses incomplete or mismatched original attachments, including changes while bytes are read or the draft is sealed', async () => {
    for (const change of ['missing', 'wrong-bytes', 'during-read', 'during-seal'] as const) {
      const f = await boot(), original = f.tables.get('work')!.get('sent-1')!;
      f.tables.get('work')!.upsert({ ...original, hot_fields: { ...original.hot_fields, has_attachments: true } });
      let attachment = part();
      if (change === 'during-read') attachment = { ...attachment, fetchBytes: async () => { f.replacementAttachments([part()], [{ ...file(), selection_revision: 'changed' }]); return Buffer.from('Original attachment'); } };
      f.replacementAttachments(change === 'missing' ? [] : [attachment], change === 'wrong-bytes' ? [file('Different bytes')] : [file()]);
      if (change === 'during-seal') f.beforeDraft(async () => { f.beforeDraft(); f.replacementAttachments([part()], [{ ...file(), selection_revision: 'changed' }]); });
      await expect(f.prepare(), change).rejects.toThrow(); expect(f.draftCount()).toBe(0); expect(f.currentTask()!.done).toBe(false);
    }
  });

  it('rechecks owner access, pause, source identity and failure classification across awaited reads and encrypted writes', async () => {
    for (const change of ['pause', 'owner', 'source', 'report'] as const) {
      const f = await boot();
      if (change === 'pause') f.run(false);
      else if (change === 'owner') f.beforeReplacement(async () => { f.allow(false); });
      else if (change === 'source') f.beforeReplacement(async () => { f.tables.get('work')!.upsert({ ...f.seed, source_id: 'replacement-source' }); });
      else f.beforeDraft(async () => { f.beforeDraft(); f.tables.get('work')!.delete(f.report.record_id); });
      await expect(f.prepare(), change).rejects.toThrow(); expect(f.draftCount()).toBe(0); expect(f.currentTask()!.done).toBe(false);
    }
  });
});
