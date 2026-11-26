import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { mailFollowUpLabel, mailFollowUpReportHref, parseMailFollowUpAddress, type MailFollowUp } from '@recued/contracts';
import { canonicalizeGmail } from '../collections/mail/gmail-provider.js';
import { buildRecord } from '../collections/mail/mail-collection.js';
import { mailFollowUpAlertMessage } from '../mail-follow-up-alerts.js';
import { createMailFollowUpFixture, type MailFollowUpFixture } from './fixtures/mail-follow-up-fixture.js';
import { createMailFollowUpTaskFixture } from './fixtures/mail-follow-up-task-fixture.js';
import { deliveryReportMime } from './fixtures/mail-delivery-report-fixture.js';

const fixtures: Array<{ dispose(): void }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = () => { const f = createMailFollowUpFixture(); fixtures.push(f); return f; };
const waiting_for = { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] };
const receive = async (f: MailFollowUpFixture, options: Parameters<typeof deliveryReportMime>[0] = {}, slug = 'work') => {
  const msg = await canonicalizeGmail({ id: options.id ?? 'failure', threadId: 'separate-report-thread', labelIds: ['INBOX'],
    internalDate: String(f.now()), raw: deliveryReportMime({ at: f.now(), ...options }).toString('base64url') });
  const { record } = buildRecord(msg, f.now, 'owner@example.test'); f.tables.get(slug)!.upsert(record); return record;
};

describe('permanent delivery failures on reply watches', () => {
  it('correlates a report in another thread to the selected recipient, stops drafts and keeps the linked task open through restart', async () => {
    const f = await createMailFollowUpTaskFixture(); fixtures.push(f);
    let watch = await f.service.start({ ...f.request(), waiting_for, notify_on_reply: true }, 'paired-owner');
    watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id }, () => {});
    const task = f.currentTask(), report = await receive(f); f.due();
    const failed = await f.service.check(watch.id);
    expect(failed).toMatchObject({ state: 'delivery_failed', task_ref: watch.task_ref, waiting_for,
      delivery_failure: { recipient: 'alex@example.test', status: '5.1.1', reason: '550 5.1.1 No such user', report_ref: { record_id: report.record_id } } });
    expect(mailFollowUpLabel(failed)).toBe('Delivery failed for alex@example.test');
    expect((await f.service.getDeliveryReport({ id: watch.id })).mail_ref.record_id).toBe(report.record_id);
    expect(await f.makeService().check(watch.id)).toEqual(failed); expect(f.draftCount()).toBe(0); expect(f.currentTask()).toEqual(task);
    expect((await f.service.list({ attention_at: f.now() })).watches.map(item => item.id)).toContain(watch.id);
    expect((await f.service.list({ query: 'delivery failed alex' })).watches).toHaveLength(1);
    await expect(f.service.getReply({ id: watch.id })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(f.service.reschedule({ id: watch.id, expected_revision: failed.revision, request_id: randomUUID(), check_at: f.now() + 3600000 })).rejects.toMatchObject({ code: 'conflict' });
    expect(parseMailFollowUpAddress(mailFollowUpReportHref(watch.id).slice('#mail/'.length).split('/'))).toEqual({ id: watch.id, open_report: true });
    const dismissed = await f.service.cancel({ id: watch.id, expected_revision: failed.revision });
    expect(dismissed.state).toBe('cancelled'); expect((await f.service.list({ attention_at: f.now() })).watches).toEqual([]); expect(f.currentTask()).toEqual(task);
  });

  it('handles Anyone for a sole recipient but asks for review when Anyone includes several recipients', async () => {
    const f = fixture(); f.seed.hot_fields.cc = []; f.tables.get('work')!.upsert(f.seed);
    const single = await f.service.start(f.request(), 'paired-owner'); await receive(f, { originalCc: '' }); f.due();
    expect((await f.service.check(single.id)).state).toBe('delivery_failed');
    const multiple = await f.service.start(f.request(f.now() + 3600000, 'personal'), 'paired-owner'); await receive(f, {}, 'personal');
    expect(await f.service.check(multiple.id)).toMatchObject({ state: 'needs_attention', detail: expect.stringContaining('several recipients') }); expect(f.draftCount()).toBe(0);
  });

  it('ignores reports for another original email, mailbox or specifically unselected recipient', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner');
    await receive(f, { id: 'wrong-message', originalId: 'different@example.test' }); await receive(f, { id: 'other-mailbox' }, 'personal');
    await receive(f, { id: 'copy-failed', finalRecipient: 'copy@example.test' }); f.due();
    expect((await f.service.check(watch.id)).state).toBe('draft_ready'); expect(f.draftCount()).toBe(1);
  });

  it('requires review for temporary, conflicting, malformed or mismatched report evidence instead of resolving the watch', async () => {
    const cases: Parameters<typeof deliveryReportMime>[0][] = [
      { action: 'delayed', status: '4.2.2' }, { action: 'failed', status: '4.4.7' }, { action: 'delivered', status: '2.0.0' },
      { originalFrom: 'different@example.test' }, { originalTo: 'stranger@example.test' }, { to: 'another-owner@example.test' },
      { extraStatus: ['Action: delayed'] }, { originalId: '' }, { originalId: 'sent-1@example.test>\r\nMessage-ID: <other@example.test' }, { finalRecipient: 'not-an-original-recipient@example.test' },
    ];
    for (const options of cases) {
      const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner'); await receive(f, options); f.due();
      expect((await f.service.check(watch.id)).state, JSON.stringify(options)).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
    }
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner');
    await receive(f); await receive(f, { id: 'another-report' }); f.due(); expect((await f.service.check(watch.id)).state).toBe('needs_attention');
  });

  it('requires review when another retained sent record reuses the same original Message-ID', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner');
    f.tables.get('work')!.upsert({ ...f.seed, record_id: 'duplicate-sent', source_id: 'duplicate-source', hot_fields: { ...f.seed.hot_fields, thread_id: 'another-conversation' } });
    await receive(f); f.due(); expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
  });

  it('treats simultaneous reply and failure evidence as a conflict requiring review', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner'); await receive(f); f.add(); f.due();
    expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
  });

  it('fences draft creation when a report arrives during encryption', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner'); f.due();
    f.beforeDraft(async () => { f.beforeDraft(); await receive(f); });
    expect((await f.service.check(watch.id)).state).toBe('delivery_failed'); expect(f.draftCount()).toBe(0);
  });

  it('keeps an already saved draft and owner edits, but blocks task continuation from that failed delivery', async () => {
    const f = await createMailFollowUpTaskFixture(); fixtures.push(f);
    let watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner');
    watch = await f.service.setTask({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), task_id: f.task.id }, () => {}); f.due();
    watch = await f.service.check(watch.id);
    watch = await f.service.reschedule({ id: watch.id, expected_revision: watch.revision, request_id: randomUUID(), check_at: f.now() + 3600000 });
    f.due(watch.check_at); watch = await f.service.check(watch.id);
    const saved = await f.drafts.get({ draft_id: watch.draft_id! }, f.principal);
    await f.drafts.update({ draft_id: saved.draft_id, expected_revision: saved.revision, content: { ...saved.content, body: 'Keep owner edits after delivery failure.' } }, f.principal);
    const before = await f.drafts.get({ draft_id: watch.draft_id! }, f.principal);
    const context = await f.service.taskContext({ watch_id: watch.id, draft_id: watch.draft_id! }); expect(context.selection).not.toBeNull();
    const guard = await f.service.validateContinuation(context.selection!, (await f.store.get(watch.id))!.draft_content);
    const report = await receive(f); const failed = await f.service.check(watch.id);
    expect(failed).toMatchObject({ state: 'delivery_failed', draft_id: watch.draft_id, task_ref: watch.task_ref, schedule_version: 1 });
    expect(mailFollowUpAlertMessage(failed, 'https://owner.example').link_url).toBe(`https://owner.example/#mail/reply-watch/${watch.id}`);
    expect(await f.drafts.get({ draft_id: watch.draft_id! }, f.principal)).toEqual(before); expect(f.draftCount()).toBe(1);
    await expect(f.service.validateContinuation(context.selection!, (await f.store.get(watch.id))!.draft_content)).rejects.toMatchObject({ code: 'resource_changed' });
    f.tables.get('work')!.delete(report.record_id); await f.service.check(watch.id); expect(() => guard()).toThrow();
    expect(f.currentTask()!.done).toBe(false);
  });

  it('rechecks report identity and status after encrypted writes and when a report link is opened', async () => {
    const f = fixture(), watch = await f.service.start({ ...f.request(), waiting_for }, 'paired-owner'); const row = await receive(f);
    f.beforeWatch(async raw => { if ((raw as { watch: MailFollowUp }).watch.state === 'delivery_failed') {
      f.beforeWatch(); f.tables.get('work')!.upsert({ ...row, source_id: 'replacement' });
    } });
    expect((await f.service.check(watch.id)).state).toBe('needs_attention');
    f.tables.get('work')!.upsert(row); const failed = await f.service.check(watch.id); expect(failed.state).toBe('delivery_failed');
    await receive(f, { action: 'delayed', status: '4.2.2' });
    await expect(f.service.getDeliveryReport({ id: watch.id })).rejects.toMatchObject({ code: 'resource_changed' });
    expect((await f.service.check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
    f.tables.get('work')!.delete(row.record_id); f.due();
    expect((await f.service.check(watch.id)).state).toBe('needs_attention');
    expect((await f.makeService().check(watch.id)).state).toBe('needs_attention'); expect(f.draftCount()).toBe(0);
  });
});
