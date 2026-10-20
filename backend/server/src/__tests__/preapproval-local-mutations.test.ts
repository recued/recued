import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { CalendarAdapterError } from '@recued/contracts';
import { createSqlitePreapprovalSettlementParticipant } from '../storage/preapproval-dispatch-participant.js';
import { GATED_ACTION_TABLE, createSqliteGatedActionChangeClock } from '../gated-action-store.js';
import { resourceFixture, resourceFixtureDisposers, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });

describe('local mutation evidence in real reviewed executions', () => {
  it('records only actual mutations, with a separate receipt for each Records and local Calendar operation', async () => {
    const f = await resourceFixture();
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
    expect(await f.run(original.future_execution_ref)).toMatchObject({ success: true });
    const state = await f.storage.repository.inspect(original.proposal_id);
    expect(state.members.map(member => member.local_receipt?.kind)).toEqual(['records', 'local_calendar', 'records']);
    expect(state.members.every(member => member.status === 'succeeded')).toBe(true);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(3);
    const data = f.db.prepare('SELECT data FROM local_mutation_receipts').pluck().all() as string[];
    expect(data.join('')).not.toMatch(/Reviewed meeting|Reviewed a|Reviewed b/);
    const reopened = await f.reopen();
    expect((await reopened.storage.repository.inspect(original.proposal_id)).members).toEqual(state.members);
    expect(reopened.calendarUpdates).not.toHaveBeenCalled();
  });

  it('uses one atomic receipt for an ordered Records batch', async () => {
    const f = await resourceFixture();
    f.save([{ id: 'batch', ingredient: recordsManifest.slug, input: { operation: 'batch', args: { ops: [
      { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'First' } } },
      { entity: 'note', action: 'upsert', args: { id: 'a', expected_version: 1, expected_revision: 1, values: { title: 'Second' } } },
      { entity: 'note', action: 'create', args: { values: { title: 'New row' } } },
    ] } } }]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    expect(await f.run(original.future_execution_ref)).toMatchObject({ success: true });
    expect(f.row('a')).toMatchObject({ title: 'Second', _record: { revision: 2 } });
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(1);
  });

  it.each(['records', 'calendar-update', 'calendar-delete'] as const)('rolls back a %s write if its receipt cannot commit', async kind => {
    const f = await resourceFixture();
    f.save([kind === 'records' ? recordStep('a') : kind === 'calendar-update' ? calendarStep()
      : { id: 'remove', ingredient: 'calendar-delete', input: { slug: 'local', source_id: 'meeting' } }]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    const event = f.calendar.table.get('meeting'); const namespace = f.records.getNamespace(f.owner);
    const used = f.calendar.gate.info().used; f.changed.mockClear();
    f.db.exec("CREATE TRIGGER refuse_local_receipt BEFORE INSERT ON local_mutation_receipts BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: 0 } });
    expect(f.calendar.table.get('meeting')).toEqual(event); expect(f.calendar.gate.info().used).toBe(used);
    expect(f.records.getNamespace(f.owner)).toEqual(namespace); expect(f.changed).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it('keeps a committed Calendar change successful when returning to its caller fails', async () => {
    const f = await resourceFixture(); f.save([calendarStep(), recordStep('b')]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    const apply = f.calendar.applyVerifiedUpsert.bind(f.calendar);
    vi.spyOn(f.calendar, 'applyVerifiedUpsert').mockImplementation(async (...args) => {
      await apply(...args); throw new Error('Caller failed after local commit');
    });
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    const state = await f.storage.repository.inspect(original.proposal_id);
    expect(state).toMatchObject({ execution_status: 'partial', recovery: { eligible: true } });
    expect(state.members[0]).toMatchObject({ status: 'succeeded', local_receipt: { kind: 'local_calendar' } });
    expect(f.row('b')!.title).toBe('b'); expect(f.calendarUpdates).toHaveBeenCalledTimes(1);
  });

  it.each(['credential', 'recipe'] as const)('settles a proven local write after a transient receipt failure despite a changed %s', async changed => {
    const f = await resourceFixture(); f.save([recordStep('a'), recordStep('b')]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    vi.spyOn(f.storage.repository, 'settleMember').mockRejectedValueOnce(new Error('Receipt settlement failed'));
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    expect((await f.storage.repository.inspect(original.proposal_id)).members[0]!.status).toBe('dispatching');
    if (changed === 'credential') f.clients.revoke(f.token.token_id, 'Original credential retired', f.clock.now);
    else f.save([recordStep('b')]);
    await f.runtime.maintain();
    const state = await f.storage.repository.inspect(original.proposal_id);
    expect(state.execution_status).toBe('partial');
    expect(state.members[0]).toMatchObject({ status: 'succeeded', local_receipt: { kind: 'records' } });
    expect(f.row('a')!._record.revision).toBe(1); expect(f.row('b')!.title).toBe('b');
    const oldReceipt = f.db.prepare(`SELECT data FROM ${GATED_ACTION_TABLE} WHERE key=?`).pluck().get(state.members[0]!.action_ref) as string;
    expect(JSON.parse(oldReceipt).status).toBe('succeeded');
    await f.runtime.maintain(); expect(f.row('a')!._record.revision).toBe(1);
  });

  it.each(['valid', 'corrupt'] as const)('projects %s evidence without rewriting an already uncertain receipt', async variant => {
    const f = await resourceFixture(); f.save([calendarStep(), recordStep('b')]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    const settle = createSqlitePreapprovalSettlementParticipant(f.db, createSqliteGatedActionChangeClock(f.db), () => f.clock.now);
    // Model a reader that settled uncertainty before it could consult the new
    // local proof. Use the real existing receipt/commit participant.
    vi.spyOn(f.storage.repository, 'settleMember').mockImplementationOnce(async claim => {
      f.db.transaction(() => {
        settle(claim, { status: 'in_doubt', message: 'Caller stopped', result: null });
        f.db.prepare("UPDATE preapproval_members SET state='in_doubt',revision=revision+1 WHERE member_id=?").run(claim.member_id);
      }).immediate();
      throw new Error('Caller stopped before reading the local evidence');
    });
    await f.run(original.future_execution_ref);
    const before = await f.storage.repository.inspect(original.proposal_id);
    const member = before.members[0]!;
    const receiptBefore = f.db.prepare(`SELECT data FROM ${GATED_ACTION_TABLE} WHERE key=?`).pluck().get(member.action_ref);
    const commitBefore = f.db.prepare('SELECT data FROM commits WHERE key=?').pluck().get(member.commit_id);
    if (variant === 'corrupt') f.db.prepare("UPDATE local_mutation_receipts SET data=json_set(data,'$.identity_hash','wrong')").run();
    await f.runtime.maintain(); await f.runtime.maintain();
    const state = await f.storage.repository.inspect(original.proposal_id);
    expect(state.members[0]!.status).toBe('in_doubt');
    expect(state.members[0]!.reconciled_outcome).toBe(variant === 'valid' ? 'succeeded' : null);
    expect(state.recovery?.eligible).toBe(variant === 'valid');
    expect(f.db.prepare(`SELECT data FROM ${GATED_ACTION_TABLE} WHERE key=?`).pluck().get(member.action_ref)).toBe(receiptBefore);
    expect(f.db.prepare('SELECT data FROM commits WHERE key=?').pluck().get(member.commit_id)).toBe(commitBefore);
    expect(f.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(variant === 'valid' ? 1 : 0);
    expect(f.calendarUpdates).toHaveBeenCalledTimes(1); expect(f.row('b')!.title).toBe('b');
    if (variant === 'valid') {
      const next = await f.service.continuePlan({ proposal_id: original.proposal_id, idempotency_key: randomUUID(),
        activation: { kind: 'one_shot', run_at: f.clock.now + 60_000, time_zone: 'UTC' },
        decision_deadline: f.clock.now + 30_000, dispatch_deadline: f.clock.now + 120_000 }, f.responder);
      expect((await f.storage.repository.review(next.proposal_id, f.responder)).members).toHaveLength(1);
      expect((await f.storage.repository.inspect(next.proposal_id)).decision).toBeNull();
      expect(f.calendarUpdates).toHaveBeenCalledTimes(1); expect(f.row('b')!.title).toBe('b');
    }
  });

  it('cannot attach evidence through a different SQLite connection', async () => {
    const f = await resourceFixture(); f.save([recordStep('a')]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    const scope = f.storage.repository.localMutationScope.bind(f.storage.repository);
    const other = new Database(':memory:');
    vi.spyOn(f.storage.repository, 'localMutationScope').mockImplementation(async claim => {
      const originalScope = (await scope(claim))!;
      return { record(_db, kind, review) { originalScope.record(other, kind, review); } };
    });
    try {
      expect((await f.run(original.future_execution_ref)).success).toBe(false);
      expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: 0 } });
      expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
    } finally { other.close(); }
  });

  it('rechecks the original permission after asynchronous Calendar preparation before committing locally', async () => {
    const f = await resourceFixture(); f.save([calendarStep()]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    const update = f.calendar.provider.updateEvent.bind(f.calendar.provider);
    f.calendarUpdates.mockImplementationOnce(async input => {
      const payload = await update(input);
      f.clients.revoke(f.token.token_id, 'Revoked before local commit', f.clock.now);
      return payload;
    });
    expect((await f.run(original.future_execution_ref)).success).toBe(false);
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it('does not treat an external Calendar reflection as proof of a provider outcome', async () => {
    const f = await resourceFixture(); f.save([calendarStep()]);
    Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    f.calendar.table.upsert({ event: f.calendar.table.get('meeting')!.event, size_bytes: 0, etag: '"original"' });
    f.calendarUpdates.mockRejectedValueOnce(new CalendarAdapterError('io_error', 'Provider response lost'));
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    await f.run(original.future_execution_ref); await f.runtime.maintain();
    const state = await f.storage.repository.inspect(original.proposal_id);
    expect(state.members[0]).toMatchObject({ status: 'in_doubt', reconciled_outcome: null });
    expect(state.members[0]!.local_receipt).toBeUndefined(); expect(state.recovery?.eligible).toBe(false);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it('keeps an external attempt uncertain even when an earlier local mutation has proof', async () => {
    const f = await resourceFixture(); f.save([recordStep('a'), calendarStep(), recordStep('b')]);
    Object.defineProperty(f.calendar.provider, 'kind', { value: 'gcal', configurable: true });
    f.calendar.table.upsert({ event: f.calendar.table.get('meeting')!.event, size_bytes: 0, etag: '"original"' });
    f.calendarUpdates.mockRejectedValueOnce(new CalendarAdapterError('io_error', 'Provider response lost'));
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    await f.run(original.future_execution_ref); await f.runtime.maintain();
    const state = await f.storage.repository.inspect(original.proposal_id);
    expect(state.execution_status).toBe('in_doubt'); expect(state.recovery?.eligible).toBe(false);
    expect(state.members[0]).toMatchObject({ status: 'succeeded', local_receipt: { kind: 'records' } });
    expect(state.members[1]).toMatchObject({ status: 'in_doubt', reconciled_outcome: null });
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(1);
    expect(f.row('a')!._record.revision).toBe(1); expect(f.row('b')!.title).toBe('b');
  });

  it('does not promote copied evidence after the realm restore cutoff', async () => {
    const f = await resourceFixture(); f.save([recordStep('a'), recordStep('b')]);
    const original = await f.service.prepare(f.request(), f.origin);
    await f.storage.repository.decide(await f.decision(original.proposal_id), f.responder);
    vi.spyOn(f.storage.repository, 'settleMember').mockRejectedValueOnce(new Error('Receipt settlement failed'));
    await f.run(original.future_execution_ref);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(1);
    f.storage.repository.invalidateRestoredLineage();
    const reopened = await f.reopen(); await reopened.runtime.maintain();
    expect(reopened.storage.isReady()).toBe(true);
    const state = await reopened.storage.repository.inspect(original.proposal_id);
    expect(state.members[0]).toMatchObject({ status: 'in_doubt', reconciled_outcome: null });
    expect(state.members[0]!.local_receipt).toBeUndefined();
    expect(reopened.db.prepare('SELECT count(*) FROM preapproval_reconciliations').pluck().get()).toBe(0);
    expect(reopened.row('a')!._record.revision).toBe(1); expect(reopened.row('b')!.title).toBe('b');
    await expect(reopened.run(original.future_execution_ref)).rejects.toBeDefined();
  });
});
