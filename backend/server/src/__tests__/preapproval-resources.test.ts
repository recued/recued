import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CalendarAdapterError, opGrantEntry, READABLE_COLLECTIONS, collectionGrantEntry } from '@recued/contracts';
import { formatPreapprovalTelegramReview } from '../preapproval-telegram-delivery.js';
import { preapprovalHash, validatePreparedFutureExecution } from '../preapproval-invocations.js';
import { withResourceReview } from '../resource-review.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import type { PreapprovalOrigin } from '../preapproval-model.js';
import { resourceFixture, resourceFixtureDisposers, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });

describe('durable preapproval of concrete Calendar and Records mutations', () => {
  it('reviews three exact changes once, retains encrypted evidence across reopening, and produces one outcome per operation', async () => {
    const first = await resourceFixture();
    const prepared = await first.service.prepare(first.request(), first.origin);
    expect(prepared).toMatchObject({ coverage: 'complete', eligible_members: 3 });
    const review = await first.storage.repository.review(prepared.proposal_id, first.responder);
    expect(review.members.map(member => member.resource_review?.resources[0]?.kind)).toEqual(['records', 'calendar', 'records']);
    expect(review.members[0]!.resource_review?.resources[0]).toMatchObject({ before: { title: 'a' }, after: { title: 'Reviewed a' } });
    expect(first.row('a')!.title).toBe('a'); expect(first.calendarUpdates).not.toHaveBeenCalled(); expect(first.changed).not.toHaveBeenCalled();
    expect(formatPreapprovalTelegramReview(review)).toBeNull();
    await first.storage.repository.decide(await first.decision(prepared.proposal_id), first.responder);
    const plan = await first.storage.repository.loadExecution(prepared.future_execution_ref);
    const second = await first.reopen();
    expect(preapprovalHash(await second.storage.repository.loadExecution(prepared.future_execution_ref))).toBe(preapprovalHash(plan));
    const result = await second.run(prepared.future_execution_ref);
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    expect(second.row('a')!.title).toBe('Reviewed a'); expect(second.row('b')!.title).toBe('Reviewed b');
    expect(second.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
    expect(second.calendarUpdates).toHaveBeenCalledTimes(1);
    const state = await second.storage.repository.inspect(prepared.proposal_id);
    expect(state).toMatchObject({ execution_status: 'succeeded' });
    expect(state.members.map(member => member.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(state.members.every(member => member.action_ref && member.commit_id)).toBe(true);
    expect(state.reviewed?.members.map(member => member.resource_review)).toEqual(review.members.map(member => member.resource_review));
    await expect(second.run(prepared.future_execution_ref)).rejects.toBeDefined();
    expect(second.calendarUpdates).toHaveBeenCalledTimes(1);
    const sealed = second.db.prepare('SELECT snapshot_ciphertext FROM preapproval_executions').pluck().get() as string;
    expect(sealed).not.toContain('Original meeting'); expect(sealed).not.toContain('Reviewed a');
  });

  it.each(['records', 'calendar'] as const)('invalidates a proposal whose %s changed before the owner decision', async kind => {
    const f = await resourceFixture(); const prepared = await f.service.prepare(f.request(), f.origin);
    if (kind === 'records') f.records.execute({ binding: f.bindings.update, principal: 'owner',
      args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'Other writer' } } });
    else {
      const row = f.calendar.table.get('meeting')!;
      f.calendar.table.upsert({ event: { ...row.event, summary: 'Other writer' }, size_bytes: 0 });
    }
    await expect(f.storage.repository.review(prepared.proposal_id, f.responder)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(f.calendarUpdates).not.toHaveBeenCalled();
    expect(await f.storage.repository.inspect(prepared.proposal_id)).toMatchObject({ status: 'invalidated' });
  });

  it('retains completed outcomes when a later reviewed row conflicts and never runs remaining operations', async () => {
    const f = await resourceFixture(); f.save([recordStep('a'), recordStep('b'), calendarStep()]);
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.update, principal: 'owner',
      args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Concurrent b' } } });
    const result = await f.run(prepared.future_execution_ref);
    expect(result.success).toBe(false);
    expect(f.row('a')!.title).toBe('Reviewed a'); expect(f.row('b')!.title).toBe('Concurrent b');
    expect(f.calendarUpdates).not.toHaveBeenCalled();
    const state = await f.storage.repository.inspect(prepared.proposal_id);
    expect(state.execution_status).toBe('partial');
    expect(state.members[0]!.status).toBe('succeeded'); expect(state.members[1]!.status).toBe('failed');
    expect(state.members[2]!.status).not.toBe('succeeded');
  });

  it('freezes generated IDs in a reviewed Records batch and applies an absent upsert after restart', async () => {
    const first = await resourceFixture(); first.save([{ id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'create', args: { values: { title: 'Generated row' } } },
      { entity: 'note', action: 'upsert', args: { id: 'new', expected_version: 1, values: { title: 'Inserted row' } } },
    ] } } }]);
    const prepared = await first.service.prepare(first.request(), first.origin);
    const review = await first.storage.repository.review(prepared.proposal_id, first.responder);
    const id = String(review.members[0]!.resource_review!.resources[0]!.after!.id);
    await first.storage.repository.decide(await first.decision(prepared.proposal_id), first.responder);
    const second = await first.reopen();
    expect(await second.run(prepared.future_execution_ref)).toMatchObject({ success: true });
    expect(second.row(id)!.title).toBe('Generated row'); expect(second.row('new')!.title).toBe('Inserted row');
  });

  it('reviews intermediate edits and recreation of one Records row as one atomic durable member', async () => {
    const f = await resourceFixture(); f.save([{ id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'Intermediate' } } },
      { entity: 'note', action: 'upsert', args: { id: 'a', expected_version: 1, expected_revision: 1, values: { title: 'Second edit' } } },
      { entity: 'note', action: 'delete', args: { id: 'a', expected_version: 1, expected_revision: 2 } },
      { entity: 'note', action: 'create', args: { id: 'a', values: { title: 'Recreated' } } },
    ] } } }]);
    const prepared = await f.service.prepare(f.request(), f.origin);
    const review = await f.storage.repository.review(prepared.proposal_id, f.responder);
    expect(review).toMatchObject({ coverage: 'complete', eligible_members: 1 });
    expect(review.members[0]!.resource_review!.resources).toHaveLength(1);
    expect(review.members[0]!.resource_review!.resources[0]!.changes?.map(change => change.action))
      .toEqual(['update', 'upsert', 'delete', 'create']);
    expect(f.row('a')!.title).toBe('a'); expect(f.changed).not.toHaveBeenCalled();
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    const reopened = await f.reopen();
    expect(await reopened.run(prepared.future_execution_ref)).toMatchObject({ success: true });
    expect(reopened.row('a')).toMatchObject({ title: 'Recreated', _record: { revision: 0 } });
    const state = await reopened.storage.repository.inspect(prepared.proposal_id);
    expect(state.members.map(member => member.status)).toEqual(['succeeded']);
  });

  it('keeps repeated changes to one resource out of blanket coverage', async () => {
    const f = await resourceFixture(); f.save([recordStep('first', 'a'), recordStep('second', 'a')]);
    const prepared = await f.service.prepare(f.request(), f.origin);
    const review = await f.storage.repository.review(prepared.proposal_id, f.responder);
    expect(review.coverage).toBe('partial'); expect(review.members[1]).toMatchObject({ eligible: false, reason: expect.stringMatching(/same resource/) });
    expect(review.selected_member_ids).toEqual([review.members[0]!.member_id]);
  });

  it('preserves an older partial plan whose Records call was explicitly left to ordinary approval', async () => {
    const f = await resourceFixture(); const seed = await f.service.prepare(f.request(), f.origin);
    const oldPlan = await f.storage.repository.loadExecution(seed.future_execution_ref);
    const ordinary = oldPlan.members.shift()!;
    oldPlan.uncovered.push({ invocation_path: ordinary.invocation_path, op_id: ordinary.op_id,
      reason: 'The kernel dispatcher has not supplied a frozen invocation identity.', subtree: true });
    oldPlan.request.idempotency_key = randomUUID();
    const prepared = await f.storage.repository.prepare(oldPlan, false);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    const result = await f.run(prepared.future_execution_ref);
    expect(result, JSON.stringify(result)).toMatchObject({ success: false, awaiting_approval: true });
    expect(f.row('a')!.title).toBe('a'); expect(f.calendarUpdates).not.toHaveBeenCalled();
    expect(await f.storage.repository.inspect(prepared.proposal_id)).toMatchObject({ execution_status: 'held' });
  });

  it('resumes an unselected Calendar hold after reopening without repeating an earlier completed Records mutation', async () => {
    const first = await resourceFixture();
    first.contracts.put('owner_operation', ['calendar-update', 'calendar-update'], { approval: 'always', op_hash: 'fixture-review' });
    const prepared = await first.service.prepare(first.request(), first.origin);
    const plan = await first.storage.repository.loadExecution(prepared.future_execution_ref);
    await first.storage.repository.select({ proposal_id: prepared.proposal_id, expected_revision: prepared.revision,
      member_ids: [plan.members[0]!.member_id, plan.members[2]!.member_id] }, first.responder);
    await first.storage.repository.decide(await first.decision(prepared.proposal_id), first.responder);
    expect(await first.run(prepared.future_execution_ref)).toMatchObject({ awaiting_approval: true });
    expect(first.row('a')!.title).toBe('Reviewed a'); expect(first.row('b')!.title).toBe('b');
    const second = await first.reopen();
    const checkpoint = (await second.execution.checkpointStore!.listByRun(
      (await second.storage.repository.inspect(prepared.proposal_id)).members[0]!.run_id!))[0]!;
    expect(checkpoint.resource_review?.resources[0]!.kind).toBe('calendar');
    await createPreflightResumer({ getExecuteDeps: () => second.execution, auditLog: second.execution.auditLog!,
      gatedActionStore: second.execution.gatedActionStore }).resumeRun(checkpoint,
    { recipe_id: checkpoint.recipe_id, gated_step_id: checkpoint.gated_step_id });
    expect(await second.storage.repository.inspect(prepared.proposal_id)).toMatchObject({ execution_status: 'succeeded' });
    expect(second.row('a')!._record.revision).toBe(1); expect(second.row('b')!.title).toBe('Reviewed b');
    expect(second.calendarUpdates).toHaveBeenCalledTimes(1);
  });

  it.each(['keep', 'revoke', 'narrow'] as const)('retains the requesting contract at the Records mutation boundary (%s)', async source => {
    const f = await resourceFixture(); f.save([recordStep('a')]);
    const operations = ['core.preapproval.request', 'core.schedule.recipe', 'fixture.note.update'];
    const contract = f.definitions.mint({ minted_by: 'owner', display_name: 'Resource assistant', door_types: ['mcp'],
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: operations } });
    for (const op of operations) f.grants.set(contract.contract_id, opGrantEntry(op), true, f.clock.now);
    // A custom storage namespace still faces the existing data-scope fence.
    // Explicit access, rather than the later owner decision, must admit it.
    if (source !== 'narrow') for (const collection of READABLE_COLLECTIONS) {
      f.grants.set(contract.contract_id, collectionGrantEntry(collection), true, f.clock.now);
    }
    const issued = f.inbound.issueToken({ value: { label: 'Resource assistant', grants: { ['core/' + f.recipe.recipe_id]: true }, concurrency_tier: 3,
      chat_mode: null, contract_id: contract.contract_id }, now: f.clock.now });
    const origin: PreapprovalOrigin = { mode: 'contract', contract_id: contract.contract_id, entry: 'kernel',
      credential_id: issued.record.token_id, credential_label: 'Resource assistant', entry_tool_grants: [],
      entry_raw_op_id: 'core.preapproval.request', recipe_grant_key: null, display_name: contract.contract_id,
      source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'assistant', tool_call_id: 'request',
        mcp_token_id: issued.record.token_id, contract_id: contract.contract_id } };
    if (source === 'narrow') {
      await expect(f.service.prepare(f.request(), origin)).rejects.toMatchObject({ code: 'preapproval_no_eligible_members' });
      expect(f.row('a')!.title).toBe('a'); return;
    }
    const prepared = await f.service.prepare(f.request(), origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    if (source === 'revoke') {
      f.definitions.revoke(contract.contract_id, 'Owner revoked the source');
      await expect(f.run(prepared.future_execution_ref)).rejects.toBeDefined();
      expect(f.row('a')!.title).toBe('a');
    } else {
      expect(await f.run(prepared.future_execution_ref)).toMatchObject({ success: true });
      expect(f.db.prepare('SELECT updated_by FROM core_records WHERE pk=?').pluck().get('a')).toContain(contract.contract_id);
      const commits = f.db.prepare('SELECT data FROM commits').pluck().all() as string[];
      expect(commits.map(data => JSON.parse(data).source)).toEqual([origin.source]);
    }
  });

  it.each(['delete', 'upsert'] as const)('applies a concrete single-row Records %s under the existing owner decision', async action => {
    const f = await resourceFixture(); f.save([{ id: 'write', ingredient: recordsManifest.slug, input: { operation: action,
      args: { id: 'a', expected_version: 1, expected_revision: 0, ...(action === 'upsert' ? { values: { title: 'Replacement a' } } : {}) } } }]);
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    expect(await f.run(prepared.future_execution_ref)).toMatchObject({ success: true });
    expect(f.row('a')?.title).toBe(action === 'delete' ? undefined : 'Replacement a');
  });

  it('applies a Calendar deletion with the same retained version review', async () => {
    const f = await resourceFixture(); f.save([{ id: 'remove', ingredient: 'calendar-delete', input: { slug: 'local', source_id: 'meeting' } }]);
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    expect(await f.run(prepared.future_execution_ref)).toMatchObject({ success: true });
    expect(f.calendar.table.get('meeting')).toBeNull(); expect(f.calendarDeletes).toHaveBeenCalledTimes(1);
  });

  it('fails the final atomic batch guard when a row changes after the gateway capture', async () => {
    const f = await resourceFixture(); f.save([{ id: 'batch', ingredient: recordsManifest.slug,
      input: { operation: 'batch', args: { ops: ['a', 'b'].map(id => ({ entity: 'note', action: 'update',
        args: { id, expected_version: 1, expected_revision: 0, set: { title: 'Reviewed ' + id } } })) } } }]);
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    const execute = f.records.execute;
    vi.spyOn(f.records, 'execute').mockImplementationOnce(call => {
      withResourceReview(undefined, () => execute({ binding: f.bindings.update, principal: 'competitor',
        args: { id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Raced b' } } }));
      f.changed.mockClear();
      return execute(call);
    });
    expect((await f.run(prepared.future_execution_ref)).success).toBe(false);
    expect(f.row('a')!.title).toBe('a'); expect(f.row('b')!.title).toBe('Raced b');
    expect(f.changed).not.toHaveBeenCalled();
    expect((await f.storage.repository.inspect(prepared.proposal_id)).members[0]!.status).toBe('failed');
  });

  it('checks Calendar again at the local compare-and-set boundary after gateway validation', async () => {
    const f = await resourceFixture(); f.save([calendarStep(), recordStep('b')]);
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    const original = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async args => {
      const result = await original(args);
      f.calendar.table.upsert({ event: { ...f.calendar.table.get('meeting')!.event, summary: 'Raced meeting' }, size_bytes: 0 });
      return result;
    });
    expect((await f.run(prepared.future_execution_ref)).success).toBe(false);
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Raced meeting');
    expect(f.row('b')!.title).toBe('b');
    expect((await f.storage.repository.inspect(prepared.proposal_id)).members[0]!.status).toBe('failed');
  });

  it.each(['pack_grant', 'integration', 'recipe'] as const)('refuses execution when its %s is removed after approval', async removed => {
    const f = await resourceFixture(); const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    if (removed === 'pack_grant') f.contracts.put('grant', [recordsManifest.slug, recordsManifest.slug, recordsManifest.slug, 'notes.write'], { allowed: false });
    else if (removed === 'integration') f.execution.executorConfig.resourceReview = undefined;
    else f.save([recordStep('different')]);
    await expect(f.run(prepared.future_execution_ref)).rejects.toBeDefined();
    expect(f.row('a')!.title).toBe('a'); expect(f.row('b')!.title).toBe('b'); expect(f.calendarUpdates).not.toHaveBeenCalled();
  });

  it('refuses insert review drift without applying the other operations in its Records batch', async () => {
    const f = await resourceFixture(); f.save([{ id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'Reviewed a' } } },
      { entity: 'note', action: 'create', args: { values: { title: 'Generated row' } } },
    ] } } }]);
    const prepared = await f.service.prepare(f.request(), f.origin);
    const review = await f.storage.repository.review(prepared.proposal_id, f.responder);
    const id = String(review.members[0]!.resource_review!.resources[1]!.after!.id);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    f.records.execute({ binding: f.bindings.create, principal: 'other', args: { id, values: { title: 'Generated row' } } });
    f.changed.mockClear();
    expect((await f.run(prepared.future_execution_ref)).success).toBe(false);
    expect(f.row('a')!.title).toBe('a'); expect(f.changed).not.toHaveBeenCalled();
  });

  it('binds owner display evidence to the sealed invocation and refuses unsupported Calendar scopes', async () => {
    const f = await resourceFixture(); const prepared = await f.service.prepare(f.request(), f.origin);
    const plan = await f.storage.repository.loadExecution(prepared.future_execution_ref);
    plan.members[0]!.review.resource_review!.resources[0]!.after!.title = 'Display tampering';
    expect(() => validatePreparedFutureExecution(plan)).toThrow(/valid bounded invocation graph/);
    f.save([{ id: 'series', ingredient: 'calendar-update', input: { slug: 'local', source_id: 'meeting',
      patch: { summary: 'Series change' }, scope: 'this_and_future' } }]);
    await expect(f.service.prepare(f.request(), f.origin)).rejects.toMatchObject({ code: 'resource_review_unsupported' });
    expect(f.calendarUpdates).not.toHaveBeenCalled();
  });

  it.each(['records', 'calendar'] as const)('does not report a committed %s mutation as a confirmed failure when its run is killed', async kind => {
    const f = await resourceFixture(); f.save([kind === 'records' ? recordStep('a') : calendarStep(), recordStep('b')]);
    const live = new InFlightRegistry(new LaneSemaphore()); f.execution.inFlightRegistry = live;
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    const kill = () => { for (const entry of live.snapshot().entries) if (entry.run_id) live.kill(entry.run_id); };
    if (kind === 'records') f.changed.mockImplementation(kill);
    else {
      const apply = f.calendar.applyVerifiedUpsert.bind(f.calendar);
      vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockImplementation(async (...args) => { await apply(...args); kill(); });
    }
    expect((await f.run(prepared.future_execution_ref)).success).toBe(false);
    if (kind === 'records') expect(f.row('a')!.title).toBe('Reviewed a');
    else expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
    expect(f.row('b')!.title).toBe('b');
    const state = await f.storage.repository.inspect(prepared.proposal_id);
    expect(state.members[0]).toMatchObject({ status: 'succeeded', local_receipt: { kind: kind === 'records' ? 'records' : 'local_calendar' } });
    expect(state.execution_status).toBe('partial');
    await expect(f.run(prepared.future_execution_ref)).rejects.toBeDefined();
    if (kind === 'records') expect(f.row('a')!._record.revision).toBe(1);
    else expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmed remote write uncertain if reflecting it into the local warehouse fails', async () => {
    const f = await resourceFixture(); f.save([calendarStep()]);
    Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    f.calendar.table.upsert({ event: f.calendar.table.get('meeting')!.event, size_bytes: 0, etag: '"reviewed-etag"' });
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockRejectedValueOnce(new Error('Warehouse reflection failed'));
    expect((await f.run(prepared.future_execution_ref)).success).toBe(false);
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
    const state = await f.storage.repository.inspect(prepared.proposal_id);
    expect(state.execution_status).toBe('in_doubt'); expect(state.members[0]!.status).toBe('in_doubt');
    await expect(f.run(prepared.future_execution_ref)).rejects.toBeDefined();
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
  });

  it.each(['update', 'delete'] as const)('retains an unclassified Calendar %s transport failure as uncertain across reopening', async action => {
    const f = await resourceFixture();
    f.save([action === 'update' ? calendarStep() : { id: 'delete_meeting', ingredient: 'calendar-delete',
      input: { slug: 'local', source_id: 'meeting' } }]);
    Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    f.calendar.table.upsert({ event: f.calendar.table.get('meeting')!.event, size_bytes: 0, etag: '"reviewed-etag"' });
    const mutation = action === 'update' ? f.calendarUpdates : f.calendarDeletes;
    mutation.mockRejectedValueOnce(action === 'update'
      ? Object.assign(new Error('Connection lost after dispatch'), { code: 'ECONNRESET' })
      : new DOMException('Response was aborted after dispatch', 'AbortError'));
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    expect((await f.run(prepared.future_execution_ref)).success).toBe(false);
    expect(mutation).toHaveBeenCalledTimes(1);
    const reopened = await f.reopen();
    const state = await reopened.storage.repository.inspect(prepared.proposal_id);
    expect(state.execution_status).toBe('in_doubt'); expect(state.members[0]!.status).toBe('in_doubt');
    await expect(reopened.run(prepared.future_execution_ref)).rejects.toBeDefined();
    expect(reopened.calendarUpdates).not.toHaveBeenCalled(); expect(reopened.calendarDeletes).not.toHaveBeenCalled();
  });

  it.each(['io_error', 'version_conflict', 'auth_expired', 'quota_exceeded'] as const)('keeps a provider %s outcome honest without retrying', async code => {
    const f = await resourceFixture(); f.save([calendarStep()]);
    Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    f.calendar.table.upsert({ event: f.calendar.table.get('meeting')!.event, size_bytes: 0, etag: '"reviewed-etag"' });
    f.calendarUpdates.mockImplementation(async () => { throw new CalendarAdapterError(code, 'Synthetic provider refusal'); });
    const prepared = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(prepared.proposal_id), f.responder);
    expect((await f.run(prepared.future_execution_ref)).success).toBe(false);
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
    expect(f.calendarUpdates.mock.calls[0]![0]).toMatchObject({ expected_etag: '"reviewed-etag"' });
    const state = await f.storage.repository.inspect(prepared.proposal_id);
    expect(state.members[0]!.status).toBe(code === 'io_error' ? 'in_doubt' : 'failed');
    expect(state.execution_status).toBe(code === 'io_error' ? 'in_doubt' : 'failed');
    await expect(f.run(prepared.future_execution_ref)).rejects.toBeDefined();
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
  });
});
