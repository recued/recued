import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePreapprovalJson } from '@recued/contracts';
import { createMailScheduledFollowUpFixture, prepareLinkedFollowUpDraft } from './fixtures/mail-scheduled-follow-up-fixture.js';

const fixtures: Awaited<ReturnType<typeof createMailScheduledFollowUpFixture>>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

const setup = async (trackTask = false) => {
  const f = await createMailScheduledFollowUpFixture({ tasks: true });
  fixtures.push(f);
  const { watch, draft: original } = await prepareLinkedFollowUpDraft(f);
  let draft = original;
  if (trackTask) {
    const { selection } = await f.service.taskContext({ watch_id: watch.id, draft_id: draft.draft_id });
    if (!selection) throw new Error('Missing linked task for the ordinary follow-up.');
    draft = await f.drafts.update({ draft_id: draft.draft_id, expected_revision: draft.revision, content: {
      ...draft.content, follow_up: parsePreapprovalJson({ after_ms: 3600000, continue_task: selection }),
    } }, f.principal);
  }
  const at = f.now() + 86400000;
  const prepare = (chosen = draft, conditional = true) => f.composed.service.prepare({
    ...f.request(chosen, at),
    subject: { kind: 'mail_draft', draft_id: chosen.draft_id, draft_revision: chosen.revision,
      ...(conditional ? { send_if_no_reply: true } : {}) },
  }, f.origin);
  const approve = async (conditional = true) => {
    const approved = await prepare(draft, conditional);
    await f.decide(approved.proposal_id);
    return approved.proposal_id;
  };
  const inspect = async (proposalId: string) => (await f.storage.repository.inspect(proposalId)).members.find(member => member.op_id === 'core.mail.send');
  return { ...f, watch, draft, at, prepareConditional: prepare, approve, inspect };
};

describe('scheduled send only if there is still no reply', () => {
  it('skips without a new reply watch, records the exact reply, and cannot send later after that evidence disappears', async () => {
    const f = await setup(), proposal = await f.approve();
    f.time(f.at - 1000);
    const reply = f.add();
    const ref = f.reference('work', reply.record_id);
    f.time(f.at);
    await f.tick();
    expect(f.deliveries).toEqual([]);
    expect(f.sendStore.activeIds()).toEqual([]);
    expect(await f.inspect(proposal)).toMatchObject({
      mail_follow_up_stop: { kind: 'reply', reply_ref: ref }, status_message: expect.stringContaining('Skipped because a recipient replied'),
    });
    f.tables.get('work')!.delete(reply.record_id);
    f.completeInboundSync();
    f.restartSend();
    await f.tick();
    expect(f.deliveries).toEqual([]);
    expect((await f.inspect(proposal))?.mail_follow_up_stop).toEqual({ kind: 'reply', reply_ref: ref });
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
  });

  it('lets a recent complete sync with only an automatic reply send, then keeps the normal Sent task handoff', async () => {
    const f = await setup(true), proposal = await f.approve();
    f.time(f.at);
    f.add({ hot_fields: { reply_automation: 'v1:automatic' } });
    f.completeInboundSync();
    await f.tick();
    expect(f.deliveries).toHaveLength(1);
    expect(await f.inspect(proposal)).toMatchObject({ status: 'succeeded' });
    const [id] = f.sendStore.activeIds();
    expect((await f.send().get(id))?.state).toBe('awaiting_sync');
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    f.syncSent(0, String(f.seed.hot_fields.thread_id));
    expect((await f.send().get(id))?.state).toBe('armed');
    expect((await f.service.taskLinks({ tasks: [f.watch.task_ref!] })).links).toMatchObject([{ watch: { id } }]);
    await f.tick();
    expect(f.deliveries).toHaveLength(1);
  });

  it.each(['stale inbound sync', 'unclear response'] as const)('holds for review with %s', async signal => {
    const f = await setup(), proposal = await f.approve();
    f.time(f.at - 6 * 60000);
    f.completeInboundSync();
    f.time(f.at);
    if (signal === 'unclear response') {
      f.add({ hot_fields: { reply_automation: 'v1:unknown' } });
      f.completeInboundSync();
    } else {
      // A send or mailbox mutation can update this clock without reading inbox replies.
      f.health.last_indexed_at = f.now();
    }
    await f.tick();
    expect(f.deliveries).toEqual([]);
    expect(await f.inspect(proposal)).toMatchObject({
      mail_follow_up_stop: { kind: 'review' }, status_message: expect.stringContaining('held for review'),
    });
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
    expect((await f.drafts.get({ draft_id: f.draft.draft_id }, f.principal)).revision).toBe(f.draft.revision);
    f.completeInboundSync();
    await f.tick();
    expect(f.deliveries).toEqual([]);
  });

  it('checks again after the reviewed provider admission yields and records a confirmed refusal instead of an unknown send', async () => {
    const f = await setup(true), proposal = await f.approve();
    f.time(f.at);
    f.completeInboundSync();
    f.beforeProvider(() => { f.add(); });
    await f.tick();
    expect(f.deliveries).toEqual([]);
    expect((await f.inspect(proposal))?.mail_follow_up_stop).toMatchObject({ kind: 'reply', reply_ref: f.reference('work', 'reply-1') });
    const [id] = f.sendStore.activeIds();
    f.restartSend();
    expect(await f.send().get(id)).toMatchObject({ state: 'not_sent', detail: expect.stringContaining('a recipient replied') });
    expect((await f.service.getTask({ id: f.watch.id })).watch.task_ref).toEqual(f.watch.task_ref);
  });

  it('refuses a copied draft or an edited reply target before owner review', async () => {
    const f = await setup();
    const copy = await f.drafts.create({ idempotency_key: randomUUID(), content: f.draft.content }, f.principal);
    await expect(f.prepareConditional(copy)).rejects.toMatchObject({ code: 'bad_request' });
    const changed = await f.drafts.update({ draft_id: f.draft.draft_id, expected_revision: f.draft.revision,
      content: { ...f.draft.content, in_reply_to: '<different@example.test>' } }, f.principal);
    await expect(f.prepareConditional(changed)).rejects.toMatchObject({ code: 'resource_changed' });
    expect(f.db.prepare('SELECT count(*) AS n FROM preapproval_proposals').get()).toEqual({ n: 0 });
  });

  it('keeps ordinary scheduling independent when the owner leaves the condition off', async () => {
    const f = await setup(), proposal = await f.approve(false);
    f.time(f.at);
    f.add();
    await f.tick();
    expect(f.deliveries).toHaveLength(1);
    expect(await f.inspect(proposal)).toMatchObject({ status: 'succeeded' });
  });
});
