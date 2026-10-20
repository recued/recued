import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CalendarAdapterError, KERNEL_OP_REGISTRY, opGrantEntry, collectionGrantEntry, READABLE_COLLECTIONS, type ExecutionSource } from '@recued/contracts';
import { createSqliteGatedActionChangeClock, GATED_ACTION_TABLE, projectGatedActionReceipt, projectGatedActionApprovalGroup } from '../gated-action-store.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { InFlightRegistry } from '../execution/in-flight-registry.js';
import { LaneSemaphore } from '../execution/lane-semaphore.js';
import { createInMemoryCollection, createCommitStore } from '@recued/storage';
import type { Commit } from '@recued/contracts';
import { ordinaryLocalFixture } from './ordinary-local-mutations-fixture.js';
import { resourceFixtureDisposers, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });

describe('ordinary version-reviewed local mutation receipts', () => {
  it.each(['records', 'calendar'] as const)('confirms an ordinary %s approval through the real resumer', async kind => {
    const f = await ordinaryLocalFixture();
    const held = await f.hold([kind === 'records' ? recordStep('a') : calendarStep()]);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
    await held.resume();
    expect(kind === 'records' ? f.row('a')!.title : f.calendar.table.get('meeting')!.event.summary)
      .toBe(kind === 'records' ? 'Reviewed a' : 'Reviewed meeting');
    expect(await f.execution.gatedActionStore!.get(held.action.action_ref))
      .toMatchObject({ status: 'succeeded', local_receipt: { kind: kind === 'records' ? 'records' : 'local_calendar' } });
    const commits = await f.execution.commitStore!.listByRun(held.action.run_id);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ status: 'succeeded', local_receipt: { kind: kind === 'records' ? 'records' : 'local_calendar' } });
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(1);
  });

  it('gives a consumed Chat action the same local proof without another dispatch', async () => {
    const f = await ordinaryLocalFixture(); const chat = await f.chat();
    expect(await chat.dispatch('execution')).toMatchObject({ ok: true });
    expect((await chat.plans.listForSession!(chat.session_id))[0]!.execution)
      .toMatchObject({ status: 'completed', local_receipt: { kind: 'local_calendar' } });
    expect(chat.events.at(-1)).toMatchObject({ kind: 'chat.tool_call_completed', plan_execution: { local_receipt: { kind: 'local_calendar' } } });
    expect(chat.invoke).toHaveBeenCalledTimes(1);
    const reopened = await f.reopenOrdinary(); await reopened.recover();
    expect(reopened.calendar.table.get('meeting')!.event.summary).toBe('Chat reviewed meeting');
    expect(reopened.calendarUpdates).not.toHaveBeenCalled();
  });

  it.each(['records', 'calendar-update', 'calendar-delete', 'records-batch'] as const)
    ('rolls back %s and its bookkeeping when the journal cannot commit', async kind => {
      const f = await ordinaryLocalFixture();
      const step = kind === 'records' ? recordStep('a') : kind === 'calendar-update' ? calendarStep()
        : kind === 'calendar-delete' ? { id: 'remove', ingredient: 'calendar-delete', input: { slug: 'local', source_id: 'meeting' } }
          : { id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
            { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'First' } } },
            { entity: 'note', action: 'create', args: { values: { title: 'Reserved' } } },
          ] } } };
      const held = await f.hold([step]); const calendar = f.calendar.table.get('meeting');
      const bytes = f.calendar.gate.info().used, namespace = f.records.getNamespace(f.owner); f.changed.mockClear();
      f.db.exec("CREATE TRIGGER refuse_local_receipt BEFORE INSERT ON local_mutation_receipts BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
      await held.resume();
      expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: 0 } });
      expect(f.records.getNamespace(f.owner)).toEqual(namespace);
      expect(f.calendar.table.get('meeting')).toEqual(calendar); expect(f.calendar.gate.info().used).toBe(bytes);
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
      expect((await f.execution.gatedActionStore!.get(held.action.action_ref))!.status).not.toBe('succeeded');
    });

  it.each(['records', 'calendar'] as const)('confirms %s after the committed write throws back to its caller', async kind => {
    const f = await ordinaryLocalFixture();
    const held = await f.hold([kind === 'records' ? recordStep('a') : calendarStep(), recordStep('b')]);
    if (kind === 'records') f.changed.mockImplementation(() => { throw new Error('Notice sink stopped after commit'); });
    else {
      const apply = f.calendar.applyVerifiedUpsert.bind(f.calendar);
      vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockImplementation(async (...args) => { await apply(...args); throw new Error('Caller lost the committed result'); });
    }
    await held.resume();
    expect((await f.execution.gatedActionStore!.get(held.action.action_ref))!).toMatchObject({ status: 'succeeded', local_receipt: {} });
    expect((await f.execution.commitStore!.listByRun(held.action.run_id))[0]).toMatchObject({ status: 'succeeded', local_receipt: {} });
    expect(f.row('b')!.title).toBe('b');
    await held.resume(); expect(kind === 'records' ? f.row('a')!._record.revision : f.calendarUpdates.mock.calls.length).toBe(1);
  });

  it('repairs a pending Commit from its proof after outcome persistence fails, without reading or writing the resource again', async () => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([recordStep('a')]);
    vi.spyOn(f.execution.commitStore!, 'recordOutcome').mockRejectedValueOnce(new Error('Outcome storage unavailable'));
    await held.resume();
    expect((await f.execution.commitStore!.listByRun(held.action.run_id))[0]!.status).toBe('pending');
    f.clients.revoke(f.token.token_id, 'Credential retired after commit', f.clock.now);
    expect(await f.recover()).toEqual([]);
    expect((await f.execution.commitStore!.listByRun(held.action.run_id))[0]).toMatchObject({ status: 'succeeded', local_receipt: {} });
    expect(f.row('a')!._record.revision).toBe(1); await f.recover(); expect(f.row('a')!._record.revision).toBe(1);
  });

  it('refuses an owner credential revoked across Calendar preparation before the local commit', async () => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([calendarStep()]);
    const update = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async input => { const payload = await update(input);
      f.clients.revoke(f.token.token_id, 'Revoked before commit', f.clock.now); return payload; });
    await held.resume();
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it('rolls back a Calendar write when the owner kills its run during preparation', async () => {
    const f = await ordinaryLocalFixture(); const live = new InFlightRegistry(new LaneSemaphore()); f.execution.inFlightRegistry = live;
    const held = await f.hold([calendarStep(), recordStep('b')]);
    const update = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async input => { const payload = await update(input);
      for (const entry of live.snapshot().entries) if (entry.run_id) live.kill(entry.run_id); return payload; });
    await held.resume();
    await vi.waitFor(async () => expect((await f.execution.commitStore!.listByRun(held.action.run_id))[0]!.status).toBe('cancelled'));
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting'); expect(f.row('b')!.title).toBe('b');
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
    expect((await f.execution.auditLog!.get(held.action.run_id))!.commit_status).toBe('killed');
    f.calendarUpdates.mockClear(); await held.resume(); expect(f.calendarUpdates).not.toHaveBeenCalled();
  });

  it('keeps an approved foreach item confirmed without lending its proof to the broader action', async () => {
    const f = await ordinaryLocalFixture(); f.recipe.variables.items = ['first', 'second'];
    const held = await f.hold([{ ...calendarStep(), foreach: '{{config.items}}' }], undefined, { items: ['first', 'second'] });
    await held.resume();
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
    const commits = await f.execution.commitStore!.listByRun(held.action.run_id);
    expect(commits).toHaveLength(1); expect(commits[0]).toMatchObject({ status: 'succeeded', local_receipt: { kind: 'local_calendar' } });
    expect((await f.execution.gatedActionStore!.get(held.action.action_ref))!.local_receipt).toBeUndefined();
    expect(f.db.prepare('SELECT action_ref,action_hash FROM ordinary_local_mutation_attempts').get())
      .toEqual({ action_ref: null, action_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    f.calendarUpdates.mockClear(); await f.recover(); expect(f.calendarUpdates).not.toHaveBeenCalled();
    expect((await f.execution.auditLog!.get(held.action.run_id))!.commit_status).toBe('awaiting_approval');
  });

  it.each(['cancelled', 'replaced'] as const)('refuses a foreach local write when its approval claim is %s during preparation', async change => {
    const f = await ordinaryLocalFixture();
    f.recipe.variables.items = ['first', 'second'];
    const held = await f.hold([{ ...calendarStep(), foreach: '{{config.items}}' }], undefined, { items: ['first', 'second'] });
    const update = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async input => {
      const payload = await update(input);
      if (change === 'cancelled') await f.execution.gatedActionStore!.finish(held.action.action_ref,
        { status: 'cancelled', status_message: 'The original claim was closed.', result: null });
      else f.db.prepare(`UPDATE ${GATED_ACTION_TABLE} SET data=json_set(data,'$.dispatch_attempt_id',?) WHERE key=?`)
        .run(randomUUID(), held.action.action_ref);
      return payload;
    });
    await held.resume();
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it.each(['changed', 'removed'] as const)('refuses a local write when its original stored recipe is %s during preparation', async change => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([calendarStep()]);
    const update = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async input => {
      const payload = await update(input);
      if (change === 'removed') f.sources.recipes.delete(f.recipe.recipe_id);
      else { f.recipe.version += 1; f.save(f.recipe.steps); }
      return payload;
    });
    await held.resume();
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it.each(['records', 'calendar'] as const)('keeps a committed %s action confirmed after its run is killed', async kind => {
    const f = await ordinaryLocalFixture(); const live = new InFlightRegistry(new LaneSemaphore()); f.execution.inFlightRegistry = live;
    const held = await f.hold([kind === 'records' ? recordStep('a') : calendarStep(), recordStep('b')]);
    const kill = () => { for (const entry of live.snapshot().entries) if (entry.run_id) live.kill(entry.run_id); };
    if (kind === 'records') f.changed.mockImplementation(kill);
    else { const apply = f.calendar.applyVerifiedUpsert.bind(f.calendar);
      vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockImplementation(async (...args) => { await apply(...args); kill(); }); }
    await held.resume();
    await vi.waitFor(async () => expect((await f.execution.commitStore!.listByRun(held.action.run_id))[0])
      .toMatchObject({ status: 'succeeded', local_receipt: {} }));
    expect((await f.execution.gatedActionStore!.get(held.action.action_ref))!).toMatchObject({ status: 'succeeded', local_receipt: {} });
    expect(f.row('b')!.title).toBe('b');
    expect((await f.execution.auditLog!.get(held.action.run_id))!.commit_status).toBe('killed');
    await held.resume();
    expect(kind === 'records' ? f.row('a')!._record.revision : f.calendarUpdates.mock.calls.length).toBe(1);
  });

  it.each(['records', 'calendar'] as const)('cannot bind a %s mutation to a Commit in another store', async kind => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([kind === 'records' ? recordStep('a') : calendarStep()]);
    f.execution.commitStore = createCommitStore(createInMemoryCollection<Commit>());
    await held.resume();
    expect(f.row('a')!.title).toBe('a'); expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it('does not create local proof for an uncertain external Calendar provider', async () => {
    const f = await ordinaryLocalFixture();
    Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    f.calendar.table.upsert({ event: f.calendar.table.get('meeting')!.event, size_bytes: 0, etag: '"original"' });
    const held = await f.hold([calendarStep()]); f.calendarUpdates.mockRejectedValueOnce(new CalendarAdapterError('io_error', 'Provider response lost'));
    await held.resume();
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
    expect((await f.execution.gatedActionStore!.get(held.action.action_ref))!.local_receipt).toBeUndefined();
  });

  it.each(['valid', 'corrupt', 'restored'] as const)('projects %s Chat evidence after interrupted bookkeeping without rewriting old history', async variant => {
    const f = await ordinaryLocalFixture(); const chat = await f.chat();
    vi.spyOn(chat.plans, 'recordExecution').mockRejectedValue(new Error('Caller lost receipt persistence'));
    await chat.dispatch('execution');
    const before = f.db.prepare('SELECT execution_status,execution_blob_encrypted FROM chat_plans WHERE plan_id=?').get(chat.proposal.plan_id);
    if (variant === 'corrupt') f.db.exec("UPDATE local_mutation_receipts SET data=json_set(data,'$.review_hash','wrong')");
    if (variant === 'restored') createSqliteGatedActionChangeClock(f.db).rotateEpoch();
    const recovered = createSqliteChatPlanStore(f.db, () => chat.chatKey.value, () => f.clock.now);
    const raw = f.db.prepare('SELECT execution_status,execution_blob_encrypted FROM chat_plans WHERE plan_id=?').get(chat.proposal.plan_id);
    expect(raw).toEqual({ ...(before as { execution_status: string; execution_blob_encrypted: string | null }), execution_status: 'unknown' });
    const result = (await recovered.listForSession!(chat.session_id))[0]!.execution!;
    expect(result.status).toBe(variant === 'valid' ? 'completed' : 'unknown');
    if (variant === 'valid') {
      expect(result).toMatchObject({ local_receipt: { kind: 'local_calendar' }, recovered_from: 'unknown' });
      await expect(recovered.put({ ...chat.proposal, plan_id: randomUUID(), turn_id: 'retry',
        status: 'proposed', retry_of_plan_id: chat.proposal.plan_id })).rejects.toThrow(/invalid retry origin/);
    }
    expect(f.db.prepare('SELECT execution_status,execution_blob_encrypted FROM chat_plans WHERE plan_id=?').get(chat.proposal.plan_id)).toEqual(raw);
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
  });

  it.each(['corrupt', 'restored'] as const)('revalidates saved confirmation summaries against %s evidence without rewriting terminal history', async variant => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([recordStep('a')]);
    await held.resume();
    const commit = (await f.execution.commitStore!.listByRun(held.action.run_id))[0]!;
    const chat = await f.chat(); await chat.dispatch('execution');
    const history = () => ({
      commit: f.db.prepare('SELECT data FROM commits WHERE key=?').pluck().get(commit.commit_id),
      action: f.db.prepare('SELECT data FROM gated_action_receipts WHERE key=?').pluck().get(held.action.action_ref),
      chat: f.db.prepare('SELECT execution_status,execution_blob_encrypted FROM chat_plans WHERE plan_id=?').get(chat.proposal.plan_id),
    });
    const before = history();
    expect(JSON.parse(before.commit as string).local_receipt).toBeDefined();
    expect(JSON.parse(before.action as string).local_receipt).toBeDefined();
    if (variant === 'corrupt') f.db.exec("UPDATE local_mutation_receipts SET data=json_set(data,'$.review_hash','wrong')");
    else createSqliteGatedActionChangeClock(f.db).rotateEpoch();
    expect(await f.execution.commitStore!.get(commit.commit_id)).toMatchObject({ status: 'succeeded' });
    expect((await f.execution.commitStore!.get(commit.commit_id))!.local_receipt).toBeUndefined();
    const action = (await f.execution.gatedActionStore!.get(held.action.action_ref))!;
    expect(action.status).toBe('succeeded'); expect(action.local_receipt).toBeUndefined();
    const recovered = createSqliteChatPlanStore(f.db, () => chat.chatKey.value, () => f.clock.now);
    const execution = (await recovered.listForSession!(chat.session_id))[0]!.execution!;
    expect(execution.status).toBe('completed');
    expect(execution).not.toHaveProperty('local_receipt');
    expect(execution).not.toHaveProperty('recovered_from');
    expect(history()).toEqual(before);
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
  });

  it('rolls back a Chat write when the original authority changes before its transaction', async () => {
    const f = await ordinaryLocalFixture(); const chat = await f.chat();
    const update = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async input => { const payload = await update(input); chat.authority.allowed = false; return payload; });
    await expect(chat.dispatch('execution')).rejects.toThrow(/permission revoked/);
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it('retains one-use Chat approval semantics after a proven completion', async () => {
    const f = await ordinaryLocalFixture(); const chat = await f.chat();
    await chat.dispatch('execution');
    expect(await chat.dispatch('another-turn')).toMatchObject({ ok: false, reason: 'awaiting_approval' });
    expect(chat.invoke).toHaveBeenCalledTimes(1);
    expect((await chat.plans.listPending(chat.session_id))[0]!.plan_id).not.toBe(chat.proposal.plan_id);
  });

  it('preserves a Chat caller failure alongside the confirmed change on live events and reload', async () => {
    const f = await ordinaryLocalFixture(); const chat = await f.chat();
    const apply = f.calendar.applyVerifiedUpsert.bind(f.calendar);
    vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockImplementation(async (...args) => { await apply(...args); throw new Error('Caller stopped after commit'); });
    await expect(chat.dispatch('execution')).rejects.toThrow('Caller stopped after commit');
    const execution = (await chat.plans.listForSession!(chat.session_id))[0]!.execution;
    expect(execution).toMatchObject({ status: 'completed', recovered_from: 'failed', local_receipt: { kind: 'local_calendar' } });
    expect(chat.events.at(-1)).toMatchObject({ kind: 'chat.tool_call_completed', status: 'error', plan_execution: { recovered_from: 'failed', local_receipt: { kind: 'local_calendar' } } });
    const next = createSqliteChatPlanStore(f.db, () => chat.chatKey.value, () => f.clock.now);
    expect((await next.listForSession!(chat.session_id))[0]!.execution).toEqual(execution);
  });

  it('retains a confirmed Chat fact and closes its running flag if the vault locks after commit', async () => {
    const f = await ordinaryLocalFixture(); const chat = await f.chat(); const key = chat.chatKey.value;
    const apply = f.calendar.applyVerifiedUpsert.bind(f.calendar);
    vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockImplementation(async (...args) => { await apply(...args); chat.chatKey.value = null; });
    expect(await chat.dispatch('execution')).toMatchObject({ ok: true });
    expect(f.db.prepare('SELECT execution_status FROM chat_plans WHERE plan_id=?').pluck().get(chat.proposal.plan_id)).toBe('unknown');
    expect(chat.events.at(-1)).toMatchObject({ plan_execution: { recovered_from: 'unknown', local_receipt: { kind: 'local_calendar' } } });
    chat.chatKey.value = key;
    expect((await chat.plans.listForSession!(chat.session_id))[0]!.execution).toMatchObject({ status: 'completed', recovered_from: 'unknown', local_receipt: {} });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM ordinary_local_mutation_attempts').all())).not.toContain('Chat reviewed meeting');
  });

  it('keeps a legacy Records hold readable when its catalog used an empty connection sentinel', async () => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([recordStep('a')]);
    f.db.prepare(`UPDATE ${GATED_ACTION_TABLE} SET data=json_set(data,'$.connection_name','') WHERE key=?`).run(held.action.action_ref);
    const raw = f.db.prepare(`SELECT data FROM ${GATED_ACTION_TABLE} WHERE key=?`).pluck().get(held.action.action_ref);
    expect((await f.execution.gatedActionStore!.get(held.action.action_ref))!.connection_name).toBeUndefined();
    expect(f.db.prepare(`SELECT data FROM ${GATED_ACTION_TABLE} WHERE key=?`).pluck().get(held.action.action_ref)).toBe(raw);
    await held.resume(); expect(f.row('a')!.title).toBe('Reviewed a');
  });

  it('keeps a terminal uncertain Commit immutable while projecting its verified local fact', async () => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([recordStep('a')]);
    f.changed.mockImplementation(() => { f.db.exec("UPDATE commits SET data=json_set(data,'$.status','in_doubt')"); });
    await held.resume();
    const raw = f.db.prepare('SELECT data FROM commits').pluck().get();
    expect((await f.execution.commitStore!.listByRun(held.action.run_id))[0]).toMatchObject({ status: 'in_doubt', local_receipt: { kind: 'records' } });
    await f.recover();
    expect(f.db.prepare('SELECT data FROM commits').pluck().get()).toBe(raw);
    expect(f.row('a')!._record.revision).toBe(1);
  });

  it('shows a saved local confirmation beside an immutable uncertain action receipt', async () => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([recordStep('a')]);
    f.changed.mockImplementation(() => f.db.prepare(`UPDATE ${GATED_ACTION_TABLE}
      SET data=json_set(data,'$.status','in_doubt','$.terminal_at',?,'$.expires_at',?) WHERE key=?`)
      .run(f.clock.now, f.clock.now + 30 * 86400_000, held.action.action_ref));
    await held.resume();
    const raw = f.db.prepare(`SELECT data FROM ${GATED_ACTION_TABLE} WHERE key=?`).pluck().get(held.action.action_ref);
    const action = (await f.execution.gatedActionStore!.get(held.action.action_ref))!;
    expect(projectGatedActionReceipt(action)).toMatchObject({ status: 'in_doubt', local_receipt: { kind: 'records' },
      status_message: expect.stringContaining('saved confirmation') });
    expect(projectGatedActionApprovalGroup([projectGatedActionReceipt(action)])).toMatchObject({ status: 'in_doubt',
      status_message: expect.stringContaining('saved confirmation') });
    await f.recover();
    expect(f.db.prepare(`SELECT data FROM ${GATED_ACTION_TABLE} WHERE key=?`).pluck().get(held.action.action_ref)).toBe(raw);
  });

  it.each(['corrupt', 'restored'] as const)('cannot promote a pending ordinary Commit with %s proof', async variant => {
    const f = await ordinaryLocalFixture(); const held = await f.hold([recordStep('a')]);
    vi.spyOn(f.execution.commitStore!, 'recordOutcome').mockRejectedValueOnce(new Error('Bookkeeping interrupted'));
    await held.resume();
    if (variant === 'corrupt') f.db.exec("UPDATE local_mutation_receipts SET data=json_set(data,'$.identity_hash','wrong')");
    else createSqliteGatedActionChangeClock(f.db).rotateEpoch();
    await f.recover();
    expect((await f.execution.commitStore!.listByRun(held.action.run_id))[0]).toMatchObject({ status: 'in_doubt' });
    expect((await f.execution.commitStore!.listByRun(held.action.run_id))[0]!.local_receipt).toBeUndefined();
    expect(f.row('a')!._record.revision).toBe(1);
  });

  it.each(['last_unit', 'revoked', 'recipe_grant_revoked', 'op_grant_covered_by_recipe'] as const)('rechecks original contract authority without recharging its reservation: %s', async variant => {
    const f = await ordinaryLocalFixture();
    const op = KERNEL_OP_REGISTRY.find(entry => entry.backing_slug === 'calendar-update')!.op;
    const contract = f.definitions.mint({ minted_by: 'owner', display_name: 'Ordinary local writer', door_types: ['mcp'],
      scope: { channels: ['mcp'], actors: ['contracted_user'], operation_ids: [op] }, max_uses: 1 });
    f.grants.set(contract.contract_id, opGrantEntry(op), true, f.clock.now);
    for (const collection of READABLE_COLLECTIONS) f.grants.set(contract.contract_id, collectionGrantEntry(collection), true, f.clock.now);
    const grant = 'core/' + f.recipe.recipe_id;
    const issued = f.inbound.issueToken({ value: { label: 'Original caller', grants: { [grant]: true }, concurrency_tier: 3,
      chat_mode: null, contract_id: contract.contract_id }, now: f.clock.now });
    const source: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'ordinary-test', tool_call_id: randomUUID(),
      mcp_token_id: issued.record.token_id, contract_id: contract.contract_id };
    const authority = f.execution.approvalResumeAuthority!.resolve({ execution_source: source, required_bearer_tool_names: [grant] });
    if (!authority.admitted) throw new Error(authority.detail);
    const held = await f.hold([calendarStep()], { source, grant, contract_snapshot: authority.contract_snapshot });
    const update = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async input => {
      const payload = await update(input);
      if (variant === 'revoked') f.definitions.revoke(contract.contract_id, 'Revoked before local commit');
      if (variant === 'recipe_grant_revoked') f.inbound.updateTokenGrants({ token_id: issued.record.token_id, grants: { [grant]: false }, now: f.clock.now });
      if (variant === 'op_grant_covered_by_recipe') f.grants.set(contract.contract_id, opGrantEntry(op), false, f.clock.now);
      return payload;
    });
    await held.resume();
    const allowed = variant === 'last_unit' || variant === 'op_grant_covered_by_recipe';
    expect(f.calendar.table.get('meeting')!.event.summary).toBe(allowed ? 'Reviewed meeting' : 'Original meeting');
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(allowed ? 1 : 0);
    expect(f.definitions.get(contract.contract_id)!.uses_remaining).toBe(0);
  });
});
