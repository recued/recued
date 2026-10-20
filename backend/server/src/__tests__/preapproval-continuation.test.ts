import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { CalendarAdapterError, opGrantEntry, READABLE_COLLECTIONS, collectionGrantEntry,
  type PreapprovalContinuationRequest } from '@recued/contracts';
import type { PreapprovalOrigin } from '../preapproval-model.js';
import { startServer } from '../server.js';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { resourceFixture, resourceFixtureDisposers, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
const request = (f: Fixture, proposalId: string): PreapprovalContinuationRequest => ({
  proposal_id: proposalId, idempotency_key: randomUUID(),
  activation: { kind: 'one_shot', run_at: f.clock.now + 60_000, time_zone: 'UTC' },
  decision_deadline: f.clock.now + 30_000, dispatch_deadline: f.clock.now + 120_000,
});
const conflict = async () => {
  const f = await resourceFixture(); f.save([recordStep('a'), recordStep('b'), calendarStep()]);
  const prepared = await f.service.prepare(f.request(), f.origin);
  await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
  f.records.execute({ binding: f.bindings.update, principal: 'other',
    args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Concurrent b' } } });
  expect(await f.run(prepared.future_execution_ref)).toMatchObject({ success: false });
  return { f, prepared, before: await f.storage.repository.inspect(prepared.proposal_id) };
};

describe('new owner review for unfinished resource changes', () => {
  it('refreshes only unfinished intent and keeps original successes and receipts across reopening', async () => {
    const { f, prepared, before } = await conflict();
    expect(before).toMatchObject({ execution_status: 'partial', recovery: { eligible: true } });
    const next = await f.service.continuePlan(request(f, prepared.proposal_id), f.responder);
    const review = await f.storage.repository.review(next.proposal_id, f.responder);
    expect(review.members).toHaveLength(2);
    expect(review.continuation).toMatchObject({ proposal_id: prepared.proposal_id,
      completed: [{ member_id: before.members[0]!.member_id, action_ref: before.members[0]!.action_ref }] });
    expect(review.members[0]).toMatchObject({ arguments: { id: 'b', expected_revision: 1 },
      resource_review: { resources: [{ before: { title: 'Concurrent b' }, after: { title: 'Reviewed b' } }] } });
    expect(f.row('b')!.title).toBe('Concurrent b'); expect(f.calendarUpdates).not.toHaveBeenCalled();
    expect(await f.storage.repository.inspect(next.proposal_id)).toMatchObject({ execution_status: 'prepared', decision: null });
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    const reopened = await f.reopen();
    expect(await reopened.run(next.future_execution_ref)).toMatchObject({ success: true });
    expect(reopened.row('a')!._record.revision).toBe(1);
    expect(reopened.row('b')).toMatchObject({ title: 'Reviewed b', _record: { revision: 2 } });
    expect(reopened.calendarUpdates).toHaveBeenCalledTimes(1);
    const original = await reopened.storage.repository.inspect(prepared.proposal_id);
    expect(original.members).toEqual(before.members);
    expect(original.execution_status).toBe('partial');
    expect(original.recovery?.successor_proposal_id).toBe(next.proposal_id);
    expect(await reopened.storage.repository.inspect(next.proposal_id)).toMatchObject({ execution_status: 'succeeded' });
    await expect(reopened.run(next.future_execution_ref)).rejects.toBeDefined();
  });

  it('refreshes Calendar evidence without changing the requested patch or applying it before another decision', async () => {
    const f = await resourceFixture(); f.save([recordStep('a'), calendarStep()]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    f.calendar.table.upsert({ event: { ...f.calendar.table.get('meeting')!.event, summary: 'Concurrent meeting' }, size_bytes: 0 });
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    const next = await f.service.continuePlan(request(f, original.proposal_id), f.responder);
    const review = await f.storage.repository.review(next.proposal_id, f.responder);
    expect(review.members).toHaveLength(1);
    expect(review.members[0]!.resource_review!.resources[0]).toMatchObject({
      before: { summary: 'Concurrent meeting' }, after: { summary: 'Reviewed meeting' },
    });
    expect(f.calendarUpdates).not.toHaveBeenCalled();
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    expect(await f.run(next.future_execution_ref)).toMatchObject({ success: true });
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
    expect(f.row('a')!._record.revision).toBe(1);
  });

  it('replays one preparation after response loss and refuses a second live branch', async () => {
    const { f, prepared } = await conflict(); const args = request(f, prepared.proposal_id);
    const [first, replay] = await Promise.all([f.service.continuePlan(args, f.responder), f.service.continuePlan(args, f.responder)]);
    expect(replay).toEqual(first);
    await expect(f.service.continuePlan(request(f, prepared.proposal_id), f.responder))
      .rejects.toMatchObject({ code: 'preapproval_already_claimed' });
    const reopened = await f.reopen();
    expect(await reopened.service.continuePlan(args, reopened.responder)).toEqual(first);
    expect(reopened.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(1);
  });

  it('never uses inspection or preparation to clear an uncertain provider attempt', async () => {
    const f = await resourceFixture(); f.save([calendarStep(), recordStep('b')]);
    Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    f.calendar.table.upsert({ event: f.calendar.table.get('meeting')!.event, size_bytes: 0, etag: '"original"' });
    f.calendarUpdates.mockRejectedValueOnce(new CalendarAdapterError('io_error', 'Response lost'));
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    expect(await f.storage.repository.inspect(original.proposal_id)).toMatchObject({
      execution_status: 'in_doubt', recovery: { eligible: false, reason: expect.stringMatching(/reconciliation/) },
    });
    await expect(f.service.continuePlan(request(f, original.proposal_id), f.responder)).rejects.toMatchObject({ code: 'preapproval_in_doubt' });
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
    expect(f.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(0);
    expect(f.row('b')!.title).toBe('b');
  });

  it('requires all unfinished members in the new decision and rechecks drift before acceptance', async () => {
    const { f, prepared } = await conflict();
    const next = await f.service.continuePlan(request(f, prepared.proposal_id), f.responder);
    const review = await f.storage.repository.review(next.proposal_id, f.responder);
    await expect(f.storage.repository.select({ proposal_id: next.proposal_id, expected_revision: review.revision,
      member_ids: [review.members[0]!.member_id] }, f.responder)).rejects.toMatchObject({ code: 'preapproval_unsupported' });
    const decision = await f.decision(next.proposal_id);
    f.records.execute({ binding: f.bindings.update, principal: 'other', args: {
      id: 'b', expected_version: 1, expected_revision: 1, set: { title: 'Changed again' },
    } });
    await expect(f.storage.repository.decide(decision, f.responder)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(f.row('a')!._record.revision).toBe(1); expect(f.row('b')!.title).toBe('Changed again');
    expect(f.calendarUpdates).not.toHaveBeenCalled();
  });

  it('makes a chain of fresh reviews without repeating any ancestor success', async () => {
    const { f, prepared, before } = await conflict();
    const next = await f.service.continuePlan(request(f, prepared.proposal_id), f.responder);
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    f.calendar.table.upsert({ event: { ...f.calendar.table.get('meeting')!.event, summary: 'Changed after second review' }, size_bytes: 0 });
    expect((await f.run(next.future_execution_ref)).success).toBe(false);
    const second = await f.storage.repository.inspect(next.proposal_id);
    expect(second.execution_status).toBe('partial'); expect(second.members[0]!.status).toBe('succeeded');
    const final = await f.service.continuePlan(request(f, next.proposal_id), f.responder);
    const review = await f.storage.repository.review(final.proposal_id, f.responder);
    expect(review.members).toHaveLength(1);
    expect(review.continuation!.completed.map(item => item.action_ref)).toEqual([before.members[0]!.action_ref, second.members[0]!.action_ref]);
    await expect(f.service.continuePlan(request(f, prepared.proposal_id), f.responder)).rejects.toMatchObject({ code: 'preapproval_already_claimed' });
    await f.storage.repository.decide(await f.decision(final.proposal_id), f.responder);
    const reopened = await f.reopen();
    expect(await reopened.run(final.future_execution_ref)).toMatchObject({ success: true });
    expect(reopened.row('a')!._record.revision).toBe(1); expect(reopened.row('b')!._record.revision).toBe(2);
    expect(reopened.calendarUpdates).toHaveBeenCalledTimes(1);
  });

  it('can replace a declined unused continuation without allowing two live branches', async () => {
    const { f, prepared } = await conflict();
    const declined = await f.service.continuePlan(request(f, prepared.proposal_id), f.responder);
    await f.storage.repository.decide({ ...await f.decision(declined.proposal_id), decision: 'deny' }, f.responder);
    const next = await f.service.continuePlan(request(f, prepared.proposal_id), f.responder);
    expect(next.proposal_id).not.toBe(declined.proposal_id);
    expect(await f.storage.repository.inspect(prepared.proposal_id)).toMatchObject({ recovery: {
      eligible: false, successor_proposal_id: next.proposal_id,
    } });
    expect(f.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(2);
    expect(f.row('a')!._record.revision).toBe(1); expect(f.row('b')!.title).toBe('Concurrent b');
  });

  it('keeps a claimed branch reserved if it fails before its first mutation', async () => {
    const { f, prepared } = await conflict();
    const next = await f.service.continuePlan(request(f, prepared.proposal_id), f.responder);
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(next.future_execution_ref);
    f.clock.now = plan.target.due_at!;
    const claimed = await f.runtime.claim({ future_execution_ref: next.future_execution_ref,
      occurrence_key: 'due:' + f.clock.now, occurrence_sequence: 1 });
    // The production driver also finishes this way if entry fails before any
    // member can dispatch. No provider outcome needs to be guessed here.
    await f.runtime.finish(claimed.handle, 'failed');
    expect(f.db.prepare('SELECT count(*) FROM preapproval_members WHERE future_ref=? AND attempt_id IS NOT NULL')
      .pluck().get(next.future_execution_ref)).toBe(0);
    const final = await f.service.continuePlan(request(f, next.proposal_id), f.responder);
    await expect(f.service.continuePlan(request(f, prepared.proposal_id), f.responder))
      .rejects.toMatchObject({ code: 'preapproval_already_claimed' });
    expect((await f.storage.repository.inspect(prepared.proposal_id)).recovery).toMatchObject({
      eligible: false, successor_proposal_id: next.proposal_id,
    });
    await f.storage.repository.decide(await f.decision(final.proposal_id), f.responder);
    expect(await f.run(final.future_execution_ref)).toMatchObject({ success: true });
    expect(f.row('a')!._record.revision).toBe(1); expect(f.row('b')!._record.revision).toBe(2);
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
  });

  it('serializes competing continuation requests with different keys', async () => {
    const { f, prepared } = await conflict();
    const results = await Promise.allSettled([f.service.continuePlan(request(f, prepared.proposal_id), f.responder),
      f.service.continuePlan(request(f, prepared.proposal_id), f.responder)]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(item => item.status === 'rejected')).toMatchObject([{ reason: { code: 'preapproval_already_claimed' } }]);
    expect(f.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(1);
  });

  it.each(['keep', 'revoke_before_prepare', 'revoke_before_dispatch'] as const)('retains the original contract and its grants (%s)', async scenario => {
    const f = await resourceFixture(); f.save([recordStep('a'), recordStep('b')]);
    const operations = ['core.preapproval.request', 'core.schedule.recipe', 'fixture.note.update'];
    const contract = f.definitions.mint({ minted_by: 'owner', display_name: 'Original assistant', door_types: ['mcp'],
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: operations } });
    for (const op of operations) f.grants.set(contract.contract_id, opGrantEntry(op), true, f.clock.now);
    for (const collection of READABLE_COLLECTIONS) f.grants.set(contract.contract_id, collectionGrantEntry(collection), true, f.clock.now);
    const issued = f.inbound.issueToken({ value: { label: 'Original credential', concurrency_tier: 3, chat_mode: null,
      contract_id: contract.contract_id, grants: { ['core/' + f.recipe.recipe_id]: true } }, now: f.clock.now });
    const token = issued.record;
    const origin: PreapprovalOrigin = { mode: 'contract', contract_id: contract.contract_id, entry: 'kernel',
      credential_id: token.token_id, credential_label: 'Original credential', entry_tool_grants: [],
      entry_raw_op_id: 'core.preapproval.request', recipe_grant_key: null, display_name: 'Original assistant',
      source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'assistant', tool_call_id: 'request',
        mcp_token_id: token.token_id, contract_id: contract.contract_id } };
    const original = await f.service.prepare(f.request(), origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.update, principal: 'other',
      args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Concurrent b' } } });
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    if (scenario === 'revoke_before_prepare') {
      f.inbound.revokeToken({ token_id: token.token_id, now: f.clock.now });
      await expect(f.service.continuePlan(request(f, original.proposal_id), f.responder)).rejects.toBeDefined();
      expect(f.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(0);
      return;
    }
    const next = await f.service.continuePlan(request(f, original.proposal_id), f.responder);
    const plan = await f.storage.repository.loadExecution(next.future_execution_ref);
    expect(plan.origin).toEqual((await f.storage.repository.loadExecution(original.future_execution_ref)).origin);
    expect((await f.storage.repository.review(next.proposal_id, f.responder)).requested_through.contract_id).toBe(contract.contract_id);
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    if (scenario === 'revoke_before_dispatch') {
      f.grants.set(contract.contract_id, opGrantEntry('fixture.note.update'), false, f.clock.now);
      await expect(f.run(next.future_execution_ref)).rejects.toBeDefined();
      expect(f.row('b')!.title).toBe('Concurrent b'); return;
    }
    expect(await f.run(next.future_execution_ref)).toMatchObject({ success: true });
    expect(f.db.prepare("SELECT updated_by FROM core_records WHERE pk='b'").pluck().get()).toBe(contract.contract_id);
    const state = await f.storage.repository.inspect(next.proposal_id);
    expect((await f.execution.commitStore!.get(state.members[0]!.commit_id!))!.source).toEqual(origin.source);
  });

  it.each(['succeeded', 'failed'] as const)('requires verified evidence to continue an uncertain attempt reconciled as %s', async outcome => {
    const f = await resourceFixture(); f.save([calendarStep(), recordStep('b')]);
    Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    f.calendar.table.upsert({ event: f.calendar.table.get('meeting')!.event, size_bytes: 0, etag: '"original"' });
    f.calendarUpdates.mockRejectedValueOnce(new CalendarAdapterError('io_error', 'Response lost'));
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    await f.run(original.future_execution_ref);
    const state = await f.storage.repository.inspect(original.proposal_id);
    const member = state.members[0]!;
    const attempt = f.db.prepare('SELECT attempt_id FROM preapproval_members WHERE member_id=?').pluck().get(member.member_id) as string;
    await f.storage.repository.recordReconciliation({ future_execution_ref: original.future_execution_ref,
      member_id: member.member_id, action_ref: member.action_ref!, attempt_id: attempt,
      adapter: 'verified-fixture-provider', evidence_digest: 'sha256:' + 'a'.repeat(64), outcome, observed_at: f.clock.now });
    const next = await f.service.continuePlan(request(f, original.proposal_id), f.responder);
    const review = await f.storage.repository.review(next.proposal_id, f.responder);
    expect(review.members).toHaveLength(outcome === 'succeeded' ? 1 : 2);
    expect(review.continuation!.completed).toHaveLength(outcome === 'succeeded' ? 1 : 0);
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    expect(await f.run(next.future_execution_ref)).toMatchObject({ success: true });
    expect(f.calendarUpdates).toHaveBeenCalledTimes(outcome === 'succeeded' ? 1 : 2);
    expect((await f.storage.repository.inspect(original.proposal_id)).members[0]!.status).toBe('in_doubt');
  });

  it('rehearses ordered Records edits and reserved inserts without publishing writes or notices', async () => {
    const f = await resourceFixture(); f.save([recordStep('a'), { id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'update', args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'First b' } } },
      { entity: 'note', action: 'upsert', args: { id: 'b', expected_version: 1, expected_revision: 1, values: { title: 'Second b' } } },
      { entity: 'note', action: 'create', args: { values: { title: 'Reserved row' } } },
    ] } } }]);
    const original = await f.service.prepare(f.request(), f.origin);
    const old = await f.storage.repository.review(original.proposal_id, f.responder);
    const reserved = String(old.members[1]!.resource_review!.resources[1]!.after!.id);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.update, principal: 'other',
      args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Concurrent b' } } });
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    f.changed.mockClear();
    const next = await f.service.continuePlan(request(f, original.proposal_id), f.responder);
    const review = await f.storage.repository.review(next.proposal_id, f.responder);
    expect(review.members).toHaveLength(1);
    expect(review.members[0]!.arguments.ops).toMatchObject([
      { args: { expected_revision: 1 } }, { args: { expected_revision: 2 } }, { args: { id: reserved } },
    ]);
    expect(f.row(reserved)).toBeNull(); expect(f.row('b')!.title).toBe('Concurrent b'); expect(f.changed).not.toHaveBeenCalled();
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    const reopened = await f.reopen();
    expect(await reopened.run(next.future_execution_ref)).toMatchObject({ success: true });
    expect(reopened.row(reserved)!.title).toBe('Reserved row');
    expect(reopened.row('b')).toMatchObject({ title: 'Second b', _record: { revision: 3 } });
    expect(reopened.row('a')!._record.revision).toBe(1);
  });

  it('rolls back a rebased batch if its reserved insert ID is now occupied', async () => {
    const f = await resourceFixture();
    f.save([recordStep('a'), { id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'update', args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Reviewed b' } } },
      { entity: 'note', action: 'create', args: { values: { title: 'Reserved row' } } },
    ] } } }]);
    const original = await f.service.prepare(f.request(), f.origin);
    const plan = await f.storage.repository.loadExecution(original.future_execution_ref);
    const reserved = String(plan.members[1]!.resource_review!.resources[1]!.after!.id);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.update, principal: 'other',
      args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Concurrent b' } } });
    await f.run(original.future_execution_ref);
    f.records.execute({ binding: f.bindings.create, principal: 'other', args: { id: reserved, values: { title: 'Occupied row' } } });
    const namespace = f.records.getNamespace(f.owner); f.changed.mockClear();
    await expect(f.service.continuePlan(request(f, original.proposal_id), f.responder))
      .rejects.toMatchObject({ code: 'records_conflict' });
    expect(f.row('b')).toMatchObject({ title: 'Concurrent b', _record: { revision: 1 } });
    expect(f.row(reserved)!.title).toBe('Occupied row'); expect(f.changed).not.toHaveBeenCalled();
    expect(f.records.getNamespace(f.owner)).toEqual(namespace);
    expect((await f.storage.repository.loadExecution(original.future_execution_ref)).members).toEqual(plan.members);
    expect(f.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(0);
  });

  it('refuses an update whose original target was deleted instead of creating a replacement', async () => {
    const { f, prepared } = await conflict();
    f.records.execute({ binding: f.bindings.delete, principal: 'other', args: { id: 'b', expected_version: 1, expected_revision: 1 } });
    await expect(f.service.continuePlan(request(f, prepared.proposal_id), f.responder))
      .rejects.toMatchObject({ code: 'records_not_found' });
    expect(f.row('b')).toBeNull(); expect(f.row('a')!._record.revision).toBe(1);
    expect(f.calendarUpdates).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(0);
  });

  it.each(['changed', 'deleted'] as const)('keeps frozen settings after the original main dish is %s', async change => {
    const f = await resourceFixture();
    f.recipe.variables = { proposed_title: '' };
    f.save([recordStep('a'), { id: 'b', ingredient: recordsManifest.slug, input: { operation: 'update', args: {
      id: 'b', expected_version: 1, expected_revision: 0, set: { title: '{{config.proposed_title}}' },
    } } }]);
    const dish = { dish_id: 'dsh_continuation', recipe_id: f.recipe.recipe_id, publisher_id: 'core', name: '', is_default: true,
      config_overlay: { proposed_title: 'Frozen b' }, enabled: true, created_at: f.clock.now };
    f.sources.dishes.set(dish);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.update, principal: 'other',
      args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Concurrent b' } } });
    await f.run(original.future_execution_ref);
    if (change === 'deleted') f.sources.dishes.delete(dish.dish_id);
    else f.sources.dishes.set({ ...dish, config_overlay: { proposed_title: 'Replacement intent', added_setting: 'new' } });
    const next = await f.service.continuePlan(request(f, original.proposal_id), f.responder);
    const review = await f.storage.repository.review(next.proposal_id, f.responder);
    expect(review.members[0]!.arguments.set).toEqual({ title: 'Frozen b' });
    expect((await f.storage.repository.loadExecution(next.future_execution_ref)).recipe_snapshots[0]!.effective_config)
      .toEqual({ proposed_title: 'Frozen b' });
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    expect(await f.run(next.future_execution_ref)).toMatchObject({ success: true });
    expect(f.row('b')!.title).toBe('Frozen b'); expect(f.row('a')!._record.revision).toBe(1);
  });

  it.each(['recipe', 'manifest', 'namespace', 'calendar_account'] as const)('refuses retargeting after the original %s changes', async changed => {
    const { f, prepared } = await conflict();
    if (changed === 'recipe') f.save([recordStep('a')]);
    else if (changed === 'manifest') f.manifests.register({ ...recordsManifest, description: 'Changed operation definition' });
    else if (changed === 'namespace') f.db.prepare('UPDATE core_record_namespaces SET activation_generation=activation_generation+1').run();
    else Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    await expect(f.service.continuePlan(request(f, prepared.proposal_id), f.responder)).rejects.toBeDefined();
    expect(f.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(0);
    expect(f.row('b')!.title).toBe('Concurrent b'); expect(f.calendarUpdates).not.toHaveBeenCalled();
  });

  it('still enforces the refreshed version at dispatch after the new owner decision', async () => {
    const { f, prepared } = await conflict();
    const next = await f.service.continuePlan(request(f, prepared.proposal_id), f.responder);
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.update, principal: 'other',
      args: { id: 'b', expected_version: 1, expected_revision: 1, set: { title: 'Later concurrent edit' } } });
    expect((await f.run(next.future_execution_ref)).success).toBe(false);
    expect(f.row('a')!._record.revision).toBe(1);
    expect(f.row('b')!.title).toBe('Later concurrent edit'); expect(f.calendarUpdates).not.toHaveBeenCalled();
    expect((await f.storage.repository.inspect(next.proposal_id)).members[0]!.status).toBe('failed');
  });

  it('does not lose its ancestor receipt proof when old private review content expires', async () => {
    const { f, prepared } = await conflict();
    const args = request(f, prepared.proposal_id);
    args.activation.run_at = f.clock.now + GATED_ACTION_TERMINAL_RETENTION_MS + 120_000;
    args.dispatch_deadline = args.activation.run_at + 60_000;
    const next = await f.service.continuePlan(args, f.responder);
    await f.storage.repository.decide(await f.decision(next.proposal_id), f.responder);
    f.clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
    await f.composed.outbox.drain();
    await f.storage.repository.retireReviewContent();
    const retired = await f.storage.repository.inspect(prepared.proposal_id);
    expect(retired.retired_review).toBeDefined(); expect(retired.recovery?.eligible).toBe(false);
    expect(await f.run(next.future_execution_ref)).toMatchObject({ success: true });
    expect(f.row('a')!._record.revision).toBe(1); expect(f.row('b')!.title).toBe('Reviewed b');
  });

  it('refuses an unselected call because its effects are outside the durable member outcomes', async () => {
    const f = await resourceFixture(); f.save([recordStep('a'), calendarStep(), recordStep('b')]);
    const original = await f.service.prepare(f.request(), f.origin);
    const plan = await f.storage.repository.loadExecution(original.future_execution_ref);
    await f.storage.repository.select({ proposal_id: original.proposal_id, expected_revision: original.revision,
      member_ids: plan.members.slice(0, 2).map(member => member.member_id) }, f.responder);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    f.calendar.table.upsert({ event: { ...f.calendar.table.get('meeting')!.event, summary: 'Concurrent meeting' }, size_bytes: 0 });
    await f.run(original.future_execution_ref);
    expect(await f.storage.repository.inspect(original.proposal_id)).toMatchObject({
      execution_status: 'partial', recovery: { eligible: false, reason: expect.stringMatching(/Uncovered or unselected/) },
    });
    await expect(f.service.continuePlan(request(f, original.proposal_id), f.responder)).rejects.toMatchObject({ code: 'preapproval_unsupported' });
  });

  it('refuses branching or hidden work that cannot be represented by a resource receipt', async () => {
    const f = await resourceFixture(); f.save([recordStep('a'), recordStep('b'),
      { id: 'not_a_resource', transform: 'json_stringify', input: { value: 'hidden result' } }]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.update, principal: 'other',
      args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Concurrent b' } } });
    await f.run(original.future_execution_ref);
    await expect(f.service.continuePlan(request(f, original.proposal_id), f.responder)).rejects.toMatchObject({
      code: 'preapproval_unsupported', message: expect.stringMatching(/sequential Calendar, Records and plain mail/),
    });
  });

  it.each(['stop_when', 'optional'] as const)('refuses a %s step instead of dropping its execution rule', async rule => {
    const f = await resourceFixture();
    const stopped = { ...recordStep('b'), ...(rule === 'stop_when'
      ? { stop_when: { field: 'stop', operator: 'equal' as const, value: 'stop' } }
      : { optional: true }) };
    f.save([recordStep('a'), stopped, calendarStep()]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.update, principal: 'other',
      args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Concurrent b' } } });
    await f.run(original.future_execution_ref);
    expect((await f.storage.repository.inspect(original.proposal_id)).recovery).toMatchObject({
      eligible: false, reason: expect.stringMatching(/sequential Calendar, Records and plain mail/),
    });
    await expect(f.service.continuePlan(request(f, original.proposal_id), f.responder))
      .rejects.toMatchObject({ code: 'preapproval_unsupported' });
    expect(f.db.prepare('SELECT count(*) FROM preapproval_continuations').pluck().get()).toBe(0);
    expect(f.row('b')!.title).toBe('Concurrent b');
  });

  it('keeps the continuation RPC behind the real paired webclient gate and rejects supplied authority', async () => {
    const { f, prepared } = await conflict();
    const server = await startServer(0, { clientTokens: f.clients, preapprovalDeps: f.composed.handlers });
    const sockets: WebSocket[] = [];
    const connect = (token: Fixture['token']) => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token.token_id + '.' + token.bearer)}`);
      sockets.push(ws); ws.once('open', () => resolve(ws)); ws.once('error', reject);
    });
    const rpc = (ws: WebSocket, method: string, args: unknown): Promise<{ result?: unknown; error?: { code: string } }> =>
      new Promise((resolve, reject) => {
        const request_id = randomUUID();
        const receive = (data: WebSocket.RawData) => {
          const reply = JSON.parse(data.toString()) as { request_id: string; result?: unknown; error?: { code: string } };
          if (reply.request_id !== request_id) return;
          clearTimeout(timer); ws.off('message', receive); resolve(reply);
        };
        const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('Continuation RPC timed out')); }, 5000);
        ws.on('message', receive); ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
      });
    try {
      const owner = await connect(f.token);
      const cli = await connect(await f.clients.issue({ client_kind: 'cli', metadata: { instance_id: 'assistant' } }));
      const unpaired = await connect(await f.clients.issue({ client_kind: 'webclient' }));
      const args = request(f, prepared.proposal_id);
      for (const client of [cli, unpaired]) {
        expect(await rpc(client, 'preapproval.continue', args)).toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
      }
      expect(await rpc(owner, 'preapproval.continue', { ...args, origin: f.origin }))
        .toMatchObject({ error: { code: 'bad_request' } });
      const reply = await rpc(owner, 'preapproval.continue', args);
      expect(reply.error).toBeUndefined();
      expect(reply.result).toMatchObject({ status: 'awaiting_owner', eligible_members: 2 });
      expect(f.row('b')!.title).toBe('Concurrent b'); expect(f.calendarUpdates).not.toHaveBeenCalled();
    } finally { for (const ws of sockets) ws.terminate(); await server.close(); }
  });
});
