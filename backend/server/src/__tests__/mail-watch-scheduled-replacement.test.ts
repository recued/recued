import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMailFollowUpPreference, parsePreapprovalJson, type MailDraftContent } from '@recued/contracts';
import { createMailScheduledFollowUpFixture } from './fixtures/mail-scheduled-follow-up-fixture.js';
import { canonicalizeGmail } from '../collections/mail/gmail-provider.js';
import { buildRecord } from '../collections/mail/mail-collection.js';
import { deliveryReportMime } from './fixtures/mail-delivery-report-fixture.js';

const fixtures: Array<{ dispose(): void }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const boot = async () => {
  const f = await createMailScheduledFollowUpFixture({ tasks: true }); fixtures.push(f);
  if (!f.taskFixture) throw Error('Missing real task fixture');
  let source = await f.service.start({ ...f.requestMail(), waiting_for: { address: 'alex@example.test', recipients: ['alex@example.test', 'copy@example.test'] } }, f.token.token_id);
  source = await f.service.setTask({ id: source.id, expected_revision: source.revision, request_id: randomUUID(), task_id: f.taskFixture.task.id }, f.principal.validate);
  const msg = await canonicalizeGmail({ id: 'failure', threadId: 'report-thread', labelIds: ['INBOX'], raw: deliveryReportMime({ at: f.now() }).toString('base64url') });
  const { record } = buildRecord(msg, f.now, 'owner@example.test'); f.tables.get('work')!.upsert(record);
  source = await f.service.check(source.id);
  source = await f.service.createReplacement({ id: source.id, expected_revision: source.revision, request_id: randomUUID() }, f.token.token_id, f.principal.validate);
  const copy = await f.drafts.get({ draft_id: source.replacement_draft_id }, f.principal);
  const context = await f.service.taskContext({ watch_id: source.id, draft_id: copy.draft_id }); if (!context.selection) throw Error('Missing consent');
  const content: MailDraftContent = { ...copy.content, to: ['new-alex@example.test'], follow_up: parsePreapprovalJson({ after_ms: 3600000, continue_task: context.selection }) };
  const draft = await f.drafts.update({ draft_id: copy.draft_id, expected_revision: copy.revision, content }, f.principal);
  const plannedAt = f.now() + 86400000;
  const prepare = () => f.composed.service.prepare(f.request(draft, plannedAt), f.origin);
  return { ...f, taskFixture: f.taskFixture, source, report: record, content, draft, plannedAt, prepareReplacement: prepare };
};

describe('scheduled replacement task tracking', () => {
  it('reviews exact task consent and transfers only after the delayed approved send and exact Sent sync, across edits, deletion, restart and replay', async () => {
    const f = await boot(), before = f.taskFixture.currentTask(), prepared = await f.prepareReplacement();
    const review = await f.storage.repository.review(prepared.proposal_id, { channel: 'webclient', key: f.token.token_id });
    expect(review.interaction_notes.join(' ')).toContain('Get revised estimate');
    expect(review.interaction_notes.join(' ')).toContain('approved email still follows this schedule');
    expect(f.sendStore.activeIds()).toEqual([]); await f.decide(prepared.proposal_id);
    const changed = await f.drafts.update({ draft_id: f.draft.draft_id, expected_revision: f.draft.revision,
      content: { ...f.content, body: 'Later unapproved edit', follow_up: { after_ms: 7200000 } } }, f.principal);
    f.drafts.delete({ draft_id: changed.draft_id, expected_revision: changed.revision }, f.principal);
    f.time(f.plannedAt - 1); await f.tick(); expect(f.deliveries).toEqual([]);
    f.time(f.plannedAt + 300000); await f.tick(); expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]!.message.to).toEqual(['new-alex@example.test']); expect(f.deliveries[0]!.message.body_text).toBe('Can you confirm the renewal?');
    const [id] = f.sendStore.activeIds(); const pending = (await f.send().get(id))!;
    expect(pending).toMatchObject({ state: 'awaiting_sync', future_execution_ref: prepared.future_execution_ref, scheduled_for: f.plannedAt });
    expect(pending).not.toHaveProperty('continue_task'); expect((await f.sendStore.get(id))!.continue_task).toEqual(parseMailFollowUpPreference(f.content.follow_up).continue_task);
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    f.restartSend(); f.syncSent(); await f.send().sweep();
    expect((await f.send().get(id))!.state).toBe('armed'); const next = (await f.service.getTask({ id })).watch;
    expect(next).toMatchObject({ task_ref: f.source.task_ref, check_at: f.deliveries[0]!.result.sent_at + 3600000, state: 'waiting' });
    const old = (await f.service.getTask({ id: f.source.id })).watch; expect(old.state).toBe('delivery_failed'); expect(old.task_ref).toBeUndefined();
    expect(f.taskFixture.currentTask()).toEqual(before); expect((await f.service.getDeliveryReport({ id: f.source.id })).mail_ref.record_id).toBe(f.report.record_id);
    await f.tick(); f.restartSend(); await f.send().sweep();
    const attempt = f.attempts[0]!; expect((await f.send().beforeSend(attempt.input, attempt.scheduled))?.cached?.source_id).toBe(f.deliveries[0]!.result.source_id);
    expect(f.deliveries).toHaveLength(1); expect((await f.service.taskLinks({ tasks: [f.source.task_ref!] })).links[0]!.watch.id).toBe(id);
  });

  it.each(['deny', 'cancel'] as const)('leaves the task and failure intact when scheduling is %s', async decision => {
    const f = await boot(), prepared = await f.prepareReplacement(); await f.decide(prepared.proposal_id, decision);
    f.time(f.plannedAt); await f.tick(); expect(f.deliveries).toEqual([]); expect(f.sendStore.activeIds()).toEqual([]);
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref); expect(f.taskFixture.currentTask()!.done).toBe(false);
  });

  it('honors taking back approval before dispatch and cancelling a reply-watch request before Sent sync', async () => {
    for (const beforeSend of [true, false]) {
      const f = await boot(), prepared = await f.prepareReplacement(); await f.decide(prepared.proposal_id);
      if (beforeSend) {
        const grant = (await f.storage.repository.inspect(prepared.proposal_id)).grant!;
        await f.storage.repository.revoke({ grant_id: grant.grant_id, expected_revision: grant.revision, request_id: randomUUID() }, { channel: 'webclient', key: f.token.token_id });
      }
      f.time(f.plannedAt); await f.tick();
      if (!beforeSend) {
        const [id] = f.sendStore.activeIds(), pending = (await f.send().get(id))!;
        await f.send().cancel({ id, expected_revision: pending.revision }, f.principal.validate); f.syncSent(); f.restartSend(); await f.send().sweep();
        expect((await f.send().get(id))!.state).toBe('cancelled');
      }
      expect(f.deliveries).toHaveLength(beforeSend ? 0 : 1); expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
      expect((await f.service.list()).watches).toHaveLength(1); expect(f.taskFixture.currentTask()!.done).toBe(false);
    }
  });

  it.each(['task-edit', 'task-complete', 'report-change'] as const)('keeps stale consent held for review after %s, even if evidence is later restored', async change => {
    const f = await boot(), prepared = await f.prepareReplacement(); await f.decide(prepared.proposal_id);
    if (change === 'task-edit') f.taskFixture.taskStore.writeTask({ ...f.taskFixture.currentTask()!, title: 'New task instructions' }, f.now());
    else if (change === 'task-complete') await f.taskFixture.complete();
    else f.tables.get('work')!.delete(f.report.record_id);
    f.time(f.plannedAt); await f.tick(); f.syncSent(); const [id] = f.sendStore.activeIds();
    expect(await f.send().get(id)).toMatchObject({ state: 'needs_attention', detail: expect.stringContaining('task tracking changed') });
    expect((await f.sendStore.get(id))!.task_continuation_blocked).toBe(true);
    expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
    if (change === 'report-change') f.tables.get('work')!.upsert(f.report);
    else if (change === 'task-edit') f.taskFixture.taskStore.writeTask(f.taskFixture.task, f.now());
    f.restartSend(); await f.send().sweep(); expect((await f.send().get(id))!.state).toBe('needs_attention');
    expect((await f.service.list()).watches).toHaveLength(1); expect(f.deliveries).toHaveLength(1);
  });

  it('rejects an unchanged failed address, extra recipients, a copied draft identity and stale task evidence before storing a proposal', async () => {
    for (const change of ['address', 'cc', 'copy', 'task'] as const) {
      const f = await boot(); let draft = f.draft;
      if (change === 'address' || change === 'cc') draft = await f.drafts.update({ draft_id: draft.draft_id, expected_revision: draft.revision,
        content: { ...f.content, ...(change === 'address' ? { to: ['alex@example.test'] } : { cc: ['copy@example.test'] }) } }, f.principal);
      else if (change === 'copy') draft = await f.drafts.create({ idempotency_key: randomUUID(), content: f.content }, f.principal);
      else f.taskFixture.taskStore.writeTask({ ...f.taskFixture.currentTask()!, title: 'Changed before review' }, f.now());
      await expect(f.composed.service.prepare(f.request(draft, f.plannedAt), f.origin), change).rejects.toMatchObject({ code: 'resource_changed' });
      expect(f.db.prepare('SELECT count(*) AS n FROM preapproval_proposals').get()).toEqual({ n: 0 }); expect(f.deliveries).toEqual([]);
    }
  });

  it('invalidates an unaccepted review if only its task continuation changes', async () => {
    const f = await boot(), prepared = await f.prepareReplacement(), preference = parseMailFollowUpPreference(f.content.follow_up);
    await f.drafts.update({ draft_id: f.draft.draft_id, expected_revision: f.draft.revision,
      content: { ...f.content, follow_up: { ...preference, continue_task: { ...preference.continue_task!, link_version: preference.continue_task!.link_version + 1 } } } }, f.principal);
    await expect(f.decide(prepared.proposal_id)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(f.deliveries).toEqual([]); expect((await f.service.getTask({ id: f.source.id })).watch.task_ref).toEqual(f.source.task_ref);
  });
});
