import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePreapprovalJson, type MailDraftContent } from '@recued/contracts';
import { createMailScheduledFollowUpFixture, prepareLinkedFollowUpDraft } from './fixtures/mail-scheduled-follow-up-fixture.js';

const fixtures: Awaited<ReturnType<typeof createMailScheduledFollowUpFixture>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = async (tasks = false) => { const f = await createMailScheduledFollowUpFixture({ tasks }); fixtures.push(f); return f; };
const content = (): MailDraftContent => ({ sender_mail_instance: 'work', to: ['alex@example.test'], cc: ['copy@example.test'],
  subject: 'Scheduled renewal', body: 'Please confirm the revised renewal.', body_format: 'text', follow_up: { after_ms: 2 * 86400000, notify_on_reply: true } });

describe('reply watches from reviewed scheduled email', () => {
  it('reviews the interval, keeps the accepted copy after draft edits/deletion, and measures from a delayed actual send across restart', async () => {
    const f = await fixture(), plannedAt = f.now() + 86400000;
    const { draft, prepared } = await f.prepare(content(), plannedAt);
    const review = await f.storage.repository.review(prepared.proposal_id, { channel: 'webclient', key: f.token.token_id });
    expect(review.interaction_notes.join(' ')).toContain('48 hours after this email is actually sent');
    expect(review.interaction_notes.join(' ')).toContain('Notify you when a recipient replies');
    expect(f.deliveries).toEqual([]); expect(f.sendStore.activeIds()).toEqual([]);
    await f.decide(prepared.proposal_id);
    const updated = await f.drafts.update({ draft_id: draft.draft_id, expected_revision: draft.revision,
      content: { ...content(), body: 'New unapproved body', follow_up: { after_ms: 3600000 } } }, f.principal);
    f.drafts.delete({ draft_id: updated.draft_id, expected_revision: updated.revision }, f.principal);
    f.time(plannedAt - 1); expect(await f.tick()).toEqual([]);
    f.time(plannedAt + 5 * 60000); await f.tick();
    expect(f.deliveries).toHaveLength(1); expect(f.deliveries[0]!.message.body_text).toBe(content().body);
    const [id] = f.sendStore.activeIds(); expect(id).toBeDefined();
    expect(await f.send().get(id)).toMatchObject({ state: 'awaiting_sync', future_execution_ref: prepared.future_execution_ref, scheduled_for: plannedAt, after_ms: 2 * 86400000 });
    expect((await f.service.list()).watches).toEqual([]);
    f.restartSend(); f.syncSent(); await f.send().sweep(); await f.send().sweep(); await f.tick();
    const watches = (await f.service.list()).watches; expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ id, check_at: f.deliveries[0]!.result.sent_at + 2 * 86400000, notify_on_reply: true });
    expect(watches[0]!.check_at).not.toBe(plannedAt + 2 * 86400000);
    const replay = f.attempts[0]!; expect((await f.send().beforeSend(replay.input, replay.scheduled))?.cached?.source_id).toBe(f.deliveries[0]!.result.source_id);
    expect(f.deliveries).toHaveLength(1);
  });

  it.each(['deny', 'cancel', 'expire'] as const)('leaves no watch or send when a scheduled execution is %s', async action => {
    const f = await fixture(), plannedAt = f.now() + 86400000, { prepared } = await f.prepare(content(), plannedAt);
    await f.decide(prepared.proposal_id, action === 'expire' ? 'approve' : action);
    f.time(action === 'expire' ? plannedAt + 900001 : plannedAt); await f.tick();
    expect(f.deliveries).toEqual([]); expect(f.attempts).toEqual([]); expect(f.sendStore.activeIds()).toEqual([]);
    expect((await f.service.list()).watches).toEqual([]);
  });

  it.each(['fail', 'uncertain'] as const)('keeps an unconfirmed provider outcome from activating or dispatching again: %s', async outcome => {
    const f = await fixture(), plannedAt = f.now() + 86400000, { prepared } = await f.prepare(content(), plannedAt);
    await f.decide(prepared.proposal_id); f.behavior[outcome] = true; f.time(plannedAt); await f.tick();
    const [id] = f.sendStore.activeIds(); expect(id).toBeDefined();
    if (outcome === 'uncertain') f.syncSent();
    f.restartSend(); await f.send().sweep(); await f.tick();
    expect((await f.send().get(id))!.state).toBe('needs_attention'); expect((await f.service.list()).watches).toEqual([]);
    expect(f.deliveries).toHaveLength(outcome === 'uncertain' ? 1 : 0);
    const replay = f.attempts[0]!; await expect(f.send().beforeSend(replay.input, replay.scheduled)).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('invalidates a pending review when only its follow-up preference changes', async () => {
    const f = await fixture(), { prepared, draft } = await f.prepare(content());
    await f.drafts.update({ draft_id: draft.draft_id, expected_revision: draft.revision, content: { ...content(), follow_up: { after_ms: 3600000 } } }, f.principal);
    await expect(f.decide(prepared.proposal_id)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(f.sendStore.activeIds()).toEqual([]); expect(f.deliveries).toEqual([]);
  });

  it('rechecks a scheduled approval revoked while encrypting its watch request before calling the provider', async () => {
    const f = await fixture(), plannedAt = f.now() + 86400000, { prepared } = await f.prepare(content(), plannedAt);
    await f.decide(prepared.proposal_id);
    const grant = (await f.storage.repository.inspect(prepared.proposal_id)).grant!;
    f.beforeIntent(async () => { await f.storage.repository.revoke({ grant_id: grant.grant_id, expected_revision: grant.revision, request_id: 'revoke-during-watch-save' }, { channel: 'webclient', key: f.token.token_id }); });
    f.time(plannedAt); await f.tick();
    expect(f.attempts).toHaveLength(1); expect(f.deliveries).toEqual([]); expect((await f.service.list()).watches).toEqual([]);
    expect((await f.storage.repository.inspect(prepared.proposal_id)).grant?.status).toBe('revoked');
  });

  it('keeps cancellation when an interrupted pre-dispatch save follows a replacement run after restart', async () => {
    const f = await fixture(), plannedAt = f.now() + 86400000, { prepared } = await f.prepare(content(), plannedAt);
    await f.decide(prepared.proposal_id);
    f.beforeIntent(async () => { f.beforeIntent(async () => { throw new Error('Interrupted before recording dispatch'); }); });
    f.time(plannedAt); await f.tick(); expect(f.deliveries).toEqual([]);
    const [id] = f.sendStore.activeIds(), current = (await f.send().get(id))!;
    await f.send().cancel({ id, expected_revision: current.revision }, () => {}); f.restartSend();
    const attempt = f.attempts[0]!, input = { ...(attempt.input as object), run_id: 'replacement-reviewed-run' };
    expect(await f.send().beforeSend(input, attempt.scheduled)).toEqual({ id });
    expect(await f.sendStore.byRun('replacement-reviewed-run')).toMatchObject({ intent: { id, state: 'cancelled' }, dispatch_started: true });
    expect((await f.service.list()).watches).toEqual([]);
    await expect(f.send().beforeSend(input, attempt.scheduled)).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('rejects unavailable scheduled watch support and oversized recipient sets before storing a proposal', async () => {
    const f = await fixture(), send = f.execution.mailFollowUpSend; f.execution.mailFollowUpSend = undefined;
    await expect(f.prepare(content())).rejects.toMatchObject({ code: 'preapproval_unsupported' }); f.execution.mailFollowUpSend = send;
    await expect(f.prepare({ ...content(), to: Array.from({ length: 21 }, (_, n) => `person${n}@example.test`) })).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.db.prepare('SELECT count(*) AS n FROM preapproval_proposals').get()).toEqual({ n: 0 }); expect(f.deliveries).toEqual([]);
  });
});

describe('scheduled follow-up task continuation', () => {
  const linked = async () => {
    const f = await fixture(true), { watch, draft: saved } = await prepareLinkedFollowUpDraft(f);
    const { selection } = await f.service.taskContext({ watch_id: watch.id, draft_id: saved.draft_id });
    if (!selection || !f.taskFixture) throw new Error('Missing ordinary follow-up task consent.');
    const draft = await f.drafts.update({
      draft_id: saved.draft_id, expected_revision: saved.revision,
      content: { ...saved.content, follow_up: parsePreapprovalJson({ after_ms: 3600000, continue_task: selection }) },
    }, f.principal);
    const plannedAt = f.now() + 86400000;
    const prepare = (next = draft) => f.composed.service.prepare(f.request(next, plannedAt), f.origin);
    return { ...f, watch, draft, plannedAt, prepareLinked: prepare, taskFixture: f.taskFixture };
  };

  it('rejects task consent copied into another draft or carrying a changed reply target before review', async () => {
    const f = await linked();
    const copy = await f.drafts.create({ idempotency_key: randomUUID(), content: f.draft.content }, f.principal);
    await expect(f.prepareLinked(copy)).rejects.toMatchObject({ code: 'resource_changed' });
    const changed = await f.drafts.update({
      draft_id: f.draft.draft_id, expected_revision: f.draft.revision,
      content: { ...f.draft.content, in_reply_to: '<other@example.test>' },
    }, f.principal);
    await expect(f.prepareLinked(changed)).rejects.toMatchObject({ code: 'resource_changed' });
    expect(f.db.prepare('SELECT count(*) AS n FROM preapproval_proposals').get()).toEqual({ n: 0 });
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
  });

  it('holds changed task consent for review after the independently approved follow-up sends', async () => {
    const f = await linked(), { proposal_id } = await f.prepareLinked();
    await f.decide(proposal_id);
    const task = f.taskFixture.currentTask()!;
    f.taskFixture.taskStore.writeTask({ ...task, title: 'Revised task after scheduling' }, f.now());

    f.time(f.plannedAt);
    await f.tick();
    expect(f.deliveries).toHaveLength(1);
    const [id] = f.sendStore.activeIds();
    f.syncSent(0, String(f.seed.hot_fields.thread_id));
    expect(await f.send().get(id)).toMatchObject({
      state: 'needs_attention', detail: expect.stringContaining('task tracking changed'),
    });
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    expect((await f.sendStore.get(id))?.task_continuation_blocked).toBe(true);

    f.taskFixture.taskStore.writeTask(task, f.now());
    f.restartSend();
    await f.send().sweep();
    expect((await f.send().get(id))?.state).toBe('needs_attention');
    expect((await f.service.list()).watches).toMatchObject([{ id: f.watch.id, task_ref: f.watch.task_ref }]);
    expect(f.deliveries).toHaveLength(1);
  });

  it('keeps the original task linked if its pending watch is cancelled before Sent sync', async () => {
    const f = await linked(), { proposal_id } = await f.prepareLinked();
    await f.decide(proposal_id);
    f.time(f.plannedAt);
    await f.tick();
    const [id] = f.sendStore.activeIds();
    const pending = (await f.send().get(id))!;
    expect(pending.state).toBe('awaiting_sync');
    await f.send().cancel({ id, expected_revision: pending.revision }, f.principal.validate);
    f.syncSent(0, String(f.seed.hot_fields.thread_id));
    f.restartSend();
    await f.send().sweep();
    expect((await f.send().get(id))?.state).toBe('cancelled');
    expect((await f.service.list()).watches).toMatchObject([{ id: f.watch.id, task_ref: f.watch.task_ref }]);
    expect(f.deliveries).toHaveLength(1);
  });
});
