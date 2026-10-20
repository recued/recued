import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { opGrantEntry, collectionGrantEntry, READABLE_COLLECTIONS, type LocalChangeSetInspection, type RecipeDefinition } from '@recued/contracts';
import type { PreapprovalOrigin } from '../preapproval-model.js';
import { resourceFixture, resourceFixtureDisposers, recordStep, calendarStep, recordsManifest } from './preapproval-resources-fixture.js';
import { createLocalCalendarProvider } from '../collections/calendar/local-provider.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { parseLocalChangeSetPrepare, parseLocalChangeSetDecision, parseLocalChangeSetLocator, parseLocalChangeSetList, parseLocalChangeSetUndo } from '../local-change-sets.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
const sets = (f: Fixture) => f.composed.handlers.localChanges!;
const approve = (value: LocalChangeSetInspection) => ({ change_set_id: value.change_set_id,
  review_hash: value.review!.review_hash, decision: 'approve' as const });
const prepare = async (f: Fixture, steps?: RecipeDefinition['steps'], requester: PreapprovalOrigin = f.origin) => {
  if (steps) f.save(steps);
  const source = await f.service.prepare(f.request(),requester);
  const request = { proposal_id: source.proposal_id, request_id: randomUUID() };
  const view = await sets(f).prepare(request,f.origin);
  return { source, request, view, decision: approve(view) };
};
const contracted = (f: Fixture, uses: number) => {
  const operations = ['core.preapproval.request','core.schedule.recipe','fixture.note.update','core.data.calendar.update'];
  const contract = f.definitions.mint({ minted_by: 'owner',display_name: 'Atomic assistant',door_types: ['mcp'],max_uses: uses,
    scope: { channels: ['mcp'],actors: ['contracted_user'],operation_ids: operations } });
  for (const operation of operations) f.grants.set(contract.contract_id,opGrantEntry(operation),true,f.clock.now);
  for (const collection of READABLE_COLLECTIONS) f.grants.set(contract.contract_id,collectionGrantEntry(collection),true,f.clock.now);
  const issued = f.inbound.issueToken({ value: { label: 'Atomic assistant',grants: { ['core/' + f.recipe.recipe_id]: true },
    concurrency_tier: 3,chat_mode: null,contract_id: contract.contract_id },now: f.clock.now });
  const origin: PreapprovalOrigin = { mode: 'contract',contract_id: contract.contract_id,entry: 'kernel',credential_id: issued.record.token_id,
    credential_label: 'Atomic assistant',entry_tool_grants: [],entry_raw_op_id: 'core.preapproval.request',recipe_grant_key: null,
    display_name: contract.contract_id,source: { channel: 'mcp',actor: 'contracted_user',agent_id: 'assistant',tool_call_id: 'request',
      mcp_token_id: issued.record.token_id,contract_id: contract.contract_id } };
  return { contract,origin };
};
const unchanged = (f: Fixture) => {
  expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: 0 } });
  expect(f.row('b')).toMatchObject({ title: 'b', _record: { revision: 0 } });
  expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
};

describe('atomic local change sets', () => {
  it('refuses a private preview when its owner is revoked during decryption',async () => {
    const f = await resourceFixture(), { view } = await prepare(f);
    const codec = f.storage.localUndo!.codec, open = codec.open.bind(codec);
    vi.spyOn(codec,'open').mockImplementationOnce(async encrypted => {
      const material = await open(encrypted);
      f.clients.revoke(f.token.token_id,'Revoked during review decryption');
      return material;
    });
    await expect(sets(f).get(view.change_set_id,f.origin)).rejects.toMatchObject({ code: 'preapproval_authority_changed' });
    unchanged(f);
  });

  it.each(['expired','completed'] as const)('returns the current %s result when a private preview is overtaken during decryption',async status => {
    const f = await resourceFixture(), { view,decision } = await prepare(f);
    const codec = f.storage.localUndo!.codec, open = codec.open.bind(codec);
    vi.spyOn(codec,'open').mockImplementationOnce(async encrypted => {
      const material = await open(encrypted);
      if (status === 'expired') f.clock.now += 31_000;
      else await sets(f).decide(decision,f.origin);
      return material;
    });
    const current = await sets(f).get(view.change_set_id,f.origin);
    expect(current.status).toBe(status); expect(current.review).toBeUndefined();
    if (status === 'expired') unchanged(f); else expect(current.receipts).toHaveLength(3);
  });

  it('reviews once, commits all stores and receipts together, and reopens the result', async () => {
    const first = await resourceFixture(), { view, decision, source } = await prepare(first);
    unchanged(first); expect(view.review!.changes).toHaveLength(3); expect(view.receipts).toEqual([]);
    const f = await first.reopen();
    const result = await sets(f).decide(decision,f.origin);
    expect(result).toMatchObject({ status: 'completed', source_proposal_id: source.proposal_id, undo_available: true });
    expect(result.receipts).toHaveLength(3);
    for (const member of result.receipts) expect(Object.keys(member.local_receipt).sort()).toEqual(['committed_at','kind','receipt_id']);
    expect(f.row('a')!.title).toBe('Reviewed a'); expect(f.row('b')!.title).toBe('Reviewed b');
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
    expect(await f.storage.repository.inspect(source.proposal_id)).toMatchObject({ execution_status: 'cancelled', status_reason: 'applied_as_atomic_change_set' });
    expect(f.changed).toHaveBeenCalledTimes(2);
    const second = await f.reopen();
    expect(await sets(second).get(view.change_set_id,second.origin)).toEqual(result);
    expect(await sets(second).decide(decision,second.origin)).toEqual(result);
    expect(second.changed).not.toHaveBeenCalled(); expect(second.calendarUpdates).not.toHaveBeenCalled();
  });

  it('rolls every write, counter, FTS change, receipt and refresh back when the last receipt fails', async () => {
    const f = await resourceFixture(), { view, decision, source } = await prepare(f);
    const beforeCalendar = f.calendar.table.get('meeting');
    const beforeOutbox = f.db.prepare('SELECT count(*) FROM core_record_outbox').pluck().get();
    const last = view.change_set_id + ':' + view.review!.changes[2]!.member_id;
    f.db.function('reject_last_local_member', (id: string) => id === last ? 1 : 0);
    f.db.exec("CREATE TRIGGER fail_last_local_member BEFORE INSERT ON local_mutation_receipts WHEN reject_last_local_member(NEW.attempt_id)=1 BEGIN SELECT RAISE(ABORT,'last receipt failed'); END");
    await expect(sets(f).decide(decision,f.origin)).rejects.toThrow('last receipt failed');
    unchanged(f); expect(f.calendar.table.get('meeting')).toEqual(beforeCalendar);
    expect(f.db.prepare('SELECT count(*) FROM core_record_outbox').pluck().get()).toBe(beforeOutbox);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
    expect(f.db.prepare('SELECT count(*) FROM local_update_inverses').pluck().get()).toBe(0);
    expect(f.db.prepare('SELECT count(*) FROM local_change_set_members').pluck().get()).toBe(0);
    expect(f.changed).not.toHaveBeenCalled();
    expect(await sets(f).decide(decision,f.origin)).toMatchObject({ status: 'failed', receipts: [] });
    expect(await f.storage.repository.inspect(source.proposal_id)).toMatchObject({ status: 'awaiting_owner' });
  });

  it('does not lend intermediate changes to observers', async () => {
    const f = await resourceFixture(), { decision } = await prepare(f);
    const observed: Array<{ transaction: boolean; a: unknown; b: unknown; calendar: string }> = [];
    f.changed.mockImplementation(() => {
      observed.push({ transaction: f.db.inTransaction, a: f.row('a')!.title, b: f.row('b')!.title,
        calendar: f.calendar.table.get('meeting')!.event.summary });
    });
    expect(await sets(f).decide(decision,f.origin)).toMatchObject({ status: 'completed' });
    expect(f.changed).toHaveBeenCalledTimes(2);
    expect(observed).toEqual(Array.from({ length: 2 }, () => ({ transaction: false, a: 'Reviewed a', b: 'Reviewed b', calendar: 'Reviewed meeting' })));
  });

  it('rolls Calendar accounting, search text and emitted events back with a later failed member', async () => {
    const f = await resourceFixture();
    const calendar = { id: 'described',ingredient: 'calendar-update',input: { slug: 'local',source_id: 'meeting',
      patch: { summary: 'Searchable new subject',description: 'Transactional description marker' } } };
    const { decision,view } = await prepare(f,[recordStep('a'),calendar,recordStep('b')]);
    const used = f.calendarGate.info().used, events: string[] = [];
    f.bus.subscribe('data.calendar.*.*.*',event => { events.push(event.event_kind); });
    const last = view.change_set_id + ':' + view.review!.changes[2]!.member_id;
    f.db.function('reject_calendar_accounting_member',(id: string) => id === last ? 1 : 0);
    f.db.exec("CREATE TRIGGER reject_calendar_accounting BEFORE INSERT ON local_mutation_receipts WHEN reject_calendar_accounting_member(NEW.attempt_id)=1 BEGIN SELECT RAISE(ABORT,'later failure'); END");
    await expect(sets(f).decide(decision,f.origin)).rejects.toThrow('later failure');
    expect(f.calendarGate.info().used).toBe(used); expect(events).toEqual([]);
    expect(f.calendar.table.search({ query: 'Transactional' })).toEqual([]); unchanged(f);
    f.db.exec('DROP TRIGGER reject_calendar_accounting');
    const next = await prepare(f,[recordStep('a'),calendar,recordStep('b')]);
    const observedUsage: number[] = [];
    f.changed.mockImplementation(() => { observedUsage.push(f.calendarGate.info().used); });
    await sets(f).decide(next.decision,f.origin);
    expect(f.calendarGate.info().used).toBeGreaterThan(used); expect(events).toEqual(['updated']);
    expect(observedUsage).toEqual([f.calendarGate.info().used,f.calendarGate.info().used]);
    expect(f.calendar.table.search({ query: 'Transactional' })).toHaveLength(1);
  });

  it('rejects a later version conflict without changing another member', async () => {
    const f = await resourceFixture(), { decision } = await prepare(f);
    f.records.execute({ binding: f.bindings.update, principal: 'owner', args: {
      id: 'b', expected_version: 1, expected_revision: 0, set: { title: 'Later b' } } });
    f.changed.mockClear();
    await expect(sets(f).decide(decision,f.origin)).rejects.toBeDefined();
    expect(f.row('a')!.title).toBe('a'); expect(f.row('b')!.title).toBe('Later b');
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(f.changed).not.toHaveBeenCalled();
  });

  it.each([2,3])('reserves the original contract per member and rolls counters back when %s uses cannot cover the set', async uses => {
    const f = await resourceFixture(), { contract,origin } = contracted(f,uses);
    const { decision } = await prepare(f,undefined,origin);
    expect(f.definitions.get(contract.contract_id)!.uses_remaining).toBe(uses);
    if (uses === 2) {
      await expect(sets(f).decide(decision,f.origin)).rejects.toBeDefined(); unchanged(f);
      expect(f.definitions.get(contract.contract_id)!.uses_remaining).toBe(2);
      expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
    } else {
      expect(await sets(f).decide(decision,f.origin)).toMatchObject({ status: 'completed' });
      expect(f.definitions.get(contract.contract_id)!.uses_remaining).toBe(0);
      expect(f.db.prepare('SELECT updated_by FROM core_records WHERE pk=?').pluck().get('a')).toBe(contract.contract_id);
    }
  });

  it('never replaces a revoked requesting contract with the approving owner', async () => {
    const f = await resourceFixture(), { contract,origin } = contracted(f,3);
    const { decision } = await prepare(f,undefined,origin);
    const update = createLocalCalendarProvider({ slug: 'local',now: () => f.clock.now,
      readEvent: id => f.calendar.table.get(id)?.event ?? null }).updateEvent!;
    f.calendarUpdates.mockImplementation(async input => {
      const payload = await update(input); f.definitions.revoke(contract.contract_id,'Revoked during local preparation'); return payload;
    });
    await expect(sets(f).decide(decision,f.origin)).rejects.toBeDefined(); unchanged(f);
    expect(f.definitions.get(contract.contract_id)!.uses_remaining).toBe(3);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('allows the owner to decline after the original source is revoked',async () => {
    const f = await resourceFixture(), { contract,origin } = contracted(f,3);
    const { decision } = await prepare(f,undefined,origin);
    f.definitions.revoke(contract.contract_id,'Revoked before the owner declines');
    expect(await sets(f).decide({ ...decision,decision: 'deny' },f.origin)).toMatchObject({ status: 'denied' }); unchanged(f);
  });

  it('refuses a Calendar participant on another database before any member writes',async () => {
    const f = await resourceFixture(), { decision } = await prepare(f);
    const other = new Database(':memory:'); resourceFixtureDisposers.push(() => { other.close(); });
    let applied = false;
    f.execution.executorConfig.prepareLocalCalendarUpdate = async () => ({ db: other,apply: () => { applied = true; } });
    await expect(sets(f).decide(decision,f.origin)).rejects.toThrow('same realm database'); unchanged(f);
    expect(applied).toBe(false); expect(f.changed).not.toHaveBeenCalled();
  });

  it('loses to an independently accepted source review without partially applying the set',async () => {
    const f = await resourceFixture(), { decision,source } = await prepare(f);
    const update = createLocalCalendarProvider({ slug: 'local',now: () => f.clock.now,
      readEvent: id => f.calendar.table.get(id)?.event ?? null }).updateEvent!;
    f.calendarUpdates.mockImplementation(async input => {
      const payload = await update(input);
      await f.storage.repository.decide(await f.decision(source.proposal_id),f.responder); return payload;
    });
    await expect(sets(f).decide(decision,f.origin)).rejects.toBeDefined(); unchanged(f);
    expect(await f.storage.repository.inspect(source.proposal_id)).toMatchObject({ execution_status: 'active' });
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(0);
  });

  it('deduplicates concurrent approvals without a second local mutation', async () => {
    const f = await resourceFixture(), { decision,view } = await prepare(f);
    const results = await Promise.all([sets(f).decide(decision,f.origin),sets(f).decide(decision,f.origin)]);
    expect(results.every(result => result.status === 'completed' || result.status === 'unknown')).toBe(true);
    expect(await sets(f).get(view.change_set_id,f.origin)).toMatchObject({ status: 'completed' });
    expect(f.row('a')!._record.revision).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(3);
  });

  it('lets only one of two previews consume the original pending program', async () => {
    const f = await resourceFixture(), { request,view,decision } = await prepare(f);
    const other = await sets(f).prepare({ ...request,request_id: randomUUID() },f.origin);
    const results = await Promise.allSettled([sets(f).decide(decision,f.origin),sets(f).decide(approve(other),f.origin)]);
    expect(results.filter(result => result.status === 'fulfilled' && result.value.status === 'completed')).toHaveLength(1);
    expect(f.row('a')!._record.revision).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM local_mutation_receipts').pluck().get()).toBe(3);
    expect([view.change_set_id,other.change_set_id]).toContain((results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<LocalChangeSetInspection>).value.change_set_id);
  });

  it('refuses a replaced calendar with identical timestamps and settings', async () => {
    const f = await resourceFixture(), { decision } = await prepare(f);
    const instances = createInstanceStore({ db: f.db }); const old = instances.get('calendar','local')!;
    instances.delete('calendar','local'); createInstanceStore({ db: f.db, now: () => old.created_at }).upsert(old);
    await expect(sets(f).decide(decision,f.origin)).rejects.toBeDefined(); unchanged(f);
  });

  it('fences source edits and revocation during asynchronous preparation', async () => {
    const f = await resourceFixture(), { decision } = await prepare(f);
    const update = createLocalCalendarProvider({ slug: 'local', now: () => f.clock.now,
      readEvent: id => f.calendar.table.get(id)?.event ?? null }).updateEvent!;
    f.calendarUpdates.mockImplementation(async input => {
      const value = await update(input); f.clients.revoke(f.token.token_id,'Revoked during preparation'); return value;
    });
    await expect(sets(f).decide(decision,f.origin)).rejects.toMatchObject({ code: 'preapproval_authority_changed' });
    unchanged(f); expect(f.changed).not.toHaveBeenCalled();
  });

  it('requires a new review and explicit decision to undo the entire set', async () => {
    const first = await resourceFixture(), { view, decision } = await prepare(first);
    const result = await sets(first).decide(decision,first.origin);
    const reverse = await sets(first).prepareUndo({ change_set_id: view.change_set_id, request_id: randomUUID() },first.origin);
    expect(reverse.review!.changes).toHaveLength(3); expect(first.row('a')!.title).toBe('Reviewed a');
    const f = await first.reopen();
    const undone = await sets(f).decide(approve(reverse),f.origin);
    expect(undone).toMatchObject({ status: 'completed', undo_of: view.change_set_id, undo_available: false });
    expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: 2 } });
    expect(f.row('b')).toMatchObject({ title: 'b', _record: { revision: 2 } });
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Original meeting');
    expect(undone.receipts).toHaveLength(3);
    expect(f.db.prepare('SELECT count(*) FROM local_update_undo_links').pluck().get()).toBe(3);
    expect(await sets(f).get(view.change_set_id,f.origin)).toMatchObject({ undo_available: false, undo_change_set_id: reverse.change_set_id });
    await expect(sets(f).prepareUndo({ change_set_id: view.change_set_id, request_id: randomUUID() },f.origin)).rejects.toBeDefined();
    await expect(f.composed.handlers.localUndo!.review(result.receipts[0]!.local_receipt.receipt_id,f.origin)).rejects.toBeDefined();
  });

  it('rolls an entire grouped undo back when its last receipt fails', async () => {
    const f = await resourceFixture(), { view, decision } = await prepare(f);
    await sets(f).decide(decision,f.origin);
    const reverse = await sets(f).prepareUndo({ change_set_id: view.change_set_id, request_id: randomUUID() },f.origin);
    const last = reverse.change_set_id + ':' + reverse.review!.changes[2]!.member_id;
    f.db.function('reject_last_reverse', (id: string) => id === last ? 1 : 0);
    f.db.exec("CREATE TRIGGER reject_last_reverse BEFORE INSERT ON local_mutation_receipts WHEN reject_last_reverse(NEW.attempt_id)=1 BEGIN SELECT RAISE(ABORT,'reverse receipt failed'); END");
    f.changed.mockClear();
    await expect(sets(f).decide(approve(reverse),f.origin)).rejects.toThrow('reverse receipt failed');
    expect(f.row('a')!.title).toBe('Reviewed a'); expect(f.row('b')!.title).toBe('Reviewed b');
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
    expect(f.db.prepare('SELECT count(*) FROM local_update_undo_links').pluck().get()).toBe(0);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('preserves ordered repeated updates inside one Records batch', async () => {
    const f = await resourceFixture();
    const batch: RecipeDefinition['steps'][number] = { id: 'batch', ingredient: recordsManifest.slug,
      input: { operation: 'batch', args: { ops: [
        { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 0, set: { title: 'Intermediate' } } },
        { entity: 'note', action: 'update', args: { id: 'a', expected_version: 1, expected_revision: 1, set: { title: 'Final' } } },
      ] } } };
    const { view, decision } = await prepare(f,[batch,calendarStep()]);
    await sets(f).decide(decision,f.origin); expect(f.row('a')!._record.revision).toBe(2);
    const reverse = await sets(f).prepareUndo({ change_set_id: view.change_set_id, request_id: randomUUID() },f.origin);
    await sets(f).decide(approve(reverse),f.origin);
    expect(f.row('a')).toMatchObject({ title: 'a', _record: { revision: 4 } });
  });

  it.each([false,true])('shares one transaction across Records namespaces and Calendar (late failure: %s)',async failure => {
    const f = await resourceFixture(), other = { publisher: 'core',pack_slug: 'other-atomic-notes' };
    const bindings = Object.fromEntries(Object.entries(f.bindings).map(([key,value]) => [key,{ ...value,owner: other }]));
    f.records.installNamespace({ owner: other,version: 1,storage_schema_hash: 'a'.repeat(64),declaration_hash: 'b'.repeat(64),
      artifact_digest: 'other-fixture',schema: f.schema,bindings });
    f.manifests.register({ ...recordsManifest,slug: other.pack_slug,surfaces: { records: { schema: f.schema,executes: bindings } } });
    f.contracts.put('grant',[other.pack_slug,other.pack_slug,other.pack_slug,'notes.write'],{ allowed: true });
    f.records.execute({ binding: bindings.create!,principal: 'owner',args: { id: 'c',values: { title: 'Other original' } } });
    const { view,decision } = await prepare(f,[recordStep('a'),calendarStep(),{ id: 'other',ingredient: other.pack_slug,
      input: { operation: 'update',args: { id: 'c',expected_version: 1,expected_revision: 0,set: { title: 'Other changed' } } } }]);
    f.changed.mockClear();
    if (failure) {
      const last = view.change_set_id + ':' + view.review!.changes[2]!.member_id;
      f.db.function('reject_other_namespace',(id: string) => id === last ? 1 : 0);
      f.db.exec("CREATE TRIGGER reject_other_namespace BEFORE INSERT ON local_mutation_receipts WHEN reject_other_namespace(NEW.attempt_id)=1 BEGIN SELECT RAISE(ABORT,'other namespace failed'); END");
      await expect(sets(f).decide(decision,f.origin)).rejects.toThrow('other namespace failed'); unchanged(f);
      expect(f.changed).not.toHaveBeenCalled();
    } else {
      expect(await sets(f).decide(decision,f.origin)).toMatchObject({ status: 'completed',receipts: [{},{},{}] });
      const reverse = await sets(f).prepareUndo({ change_set_id: view.change_set_id,request_id: randomUUID() },f.origin);
      await sets(f).decide(approve(reverse),f.origin);
    }
    expect(f.records.ownerGet(other,'note','c')).toMatchObject({ title: 'Other original',_record: { revision: failure ? 0 : 2 } });
  });

  it.each(['expiry','realm'] as const)('does not dispatch a pending review after %s changes',async change => {
    const f = await resourceFixture(), { view,decision } = await prepare(f);
    if (change === 'realm') f.storage.localUndo!.clock.rotateEpoch(); else f.clock.now += 31_000;
    expect(await sets(f).get(view.change_set_id,f.origin)).toMatchObject({ status: 'expired' });
    await expect(sets(f).decide(decision,f.origin)).rejects.toBeDefined(); unchanged(f);
    expect(f.calendarUpdates).not.toHaveBeenCalled();
  });

  it('keeps prior values encrypted and rejects swapped review envelopes and proof metadata',async () => {
    const f = await resourceFixture(), { request,view,decision } = await prepare(f);
    const other = await sets(f).prepare({ ...request,request_id: randomUUID() },f.origin);
    const dump = JSON.stringify(f.db.prepare('SELECT * FROM local_change_sets').all());
    expect(dump).not.toContain('Original meeting'); expect(dump).not.toContain('Reviewed a');
    const encrypted = f.db.prepare('SELECT encrypted FROM local_change_sets WHERE change_set_id=?').pluck().get(other.change_set_id);
    f.db.prepare('UPDATE local_change_sets SET encrypted=? WHERE change_set_id=?').run(encrypted,view.change_set_id);
    await expect(sets(f).decide(decision,f.origin)).rejects.toBeDefined(); unchanged(f);
    f.db.prepare("UPDATE local_change_sets SET proof_json='[]' WHERE change_set_id=?").run(other.change_set_id);
    await expect(sets(f).decide(approve(other),f.origin)).rejects.toBeDefined(); unchanged(f);
  });

  it('blocks the whole grouped undo when a member changed later',async () => {
    const f = await resourceFixture(), { view,decision } = await prepare(f);
    await sets(f).decide(decision,f.origin);
    const reverse = await sets(f).prepareUndo({ change_set_id: view.change_set_id,request_id: randomUUID() },f.origin);
    f.records.execute({ binding: f.bindings.update,principal: 'owner',args: { id: 'a',expected_version: 1,expected_revision: 1,set: { title: 'Later a' } } });
    await expect(sets(f).decide(approve(reverse),f.origin)).rejects.toBeDefined();
    expect(f.row('a')!.title).toBe('Later a'); expect(f.row('b')!.title).toBe('Reviewed b');
    expect(f.calendar.table.get('meeting')!.event.summary).toBe('Reviewed meeting');
  });

  it('deduplicates preparation and binds each idempotency key to its exact source', async () => {
    const f = await resourceFixture(), { view, request, decision } = await prepare(f);
    expect(await sets(f).prepare(request,f.origin)).toEqual(view);
    await expect(sets(f).prepare({ ...request, proposal_id: 'pap_' + randomUUID() },f.origin)).rejects.toBeDefined();
    expect(await sets(f).decide({ ...decision, decision: 'deny' },f.origin)).toMatchObject({ status: 'denied' });
    await expect(sets(f).decide(decision,f.origin)).rejects.toBeDefined(); unchanged(f);
  });

  it('recovers one saved review from simultaneous preparation retries',async () => {
    const f = await resourceFixture(), source = await f.service.prepare(f.request(),f.origin);
    const request = { proposal_id: source.proposal_id,request_id: randomUUID() };
    const [first,second] = await Promise.all([sets(f).prepare(request,f.origin),sets(f).prepare(request,f.origin)]);
    expect(first).toEqual(second);
    expect(f.db.prepare('SELECT count(*) FROM local_change_sets').pluck().get()).toBe(1); unchanged(f);
  });

  it('replays an existing request before enforcing the pending-review limit',async () => {
    const f = await resourceFixture(), { view,request } = await prepare(f);
    const columns = (f.db.prepare('PRAGMA table_info(local_change_sets)').all() as { name: string }[]).map(column => column.name);
    const copied = columns.map(column => column === 'change_set_id' || column === 'request_id' ? '?' : column).join(',');
    const seed = f.db.prepare(`INSERT INTO local_change_sets SELECT ${copied} FROM local_change_sets WHERE change_set_id=?`);
    for (let index = 0; index < 99; index++) seed.run('lcs_' + randomUUID(),randomUUID(),view.change_set_id);
    expect(await sets(f).prepare(request,f.origin)).toEqual(view);
    await expect(sets(f).prepare({ ...request,request_id: randomUUID() },f.origin)).rejects.toMatchObject({ code: 'local_changes_limit' });
    unchanged(f);
  });

  it('keeps completion readable after private values expire without another write', async () => {
    const f = await resourceFixture(), { view, decision } = await prepare(f);
    const result = await sets(f).decide(decision,f.origin);
    f.clock.now += 31 * 24 * 60 * 60_000; sets(f).prune();
    expect(f.db.prepare('SELECT encrypted FROM local_change_sets').pluck().get()).toBe('');
    expect(await sets(f).get(view.change_set_id,f.origin)).toEqual({ ...result, undo_available: false });
    expect(await sets(f).decide(decision,f.origin)).toEqual({ ...result, undo_available: false });
    expect(f.row('a')!._record.revision).toBe(1);
  });

  it.each(['receipt','link','proof'] as const)('refuses false completion when %s evidence is missing or corrupt', async kind => {
    const f = await resourceFixture(), { view, decision } = await prepare(f);
    await sets(f).decide(decision,f.origin);
    if (kind === 'receipt') f.db.prepare("DELETE FROM local_mutation_receipts WHERE owner='local_change_set'").run();
    else if (kind === 'link') f.db.prepare('DELETE FROM local_change_set_members').run();
    else f.db.prepare("UPDATE local_change_sets SET proof_json='[]'").run();
    expect(await sets(f).get(view.change_set_id,f.origin)).toMatchObject({ status: 'unknown', receipts: [], undo_available: false });
    expect(f.row('a')!._record.revision).toBe(1);
  });

  it('rejects unsupported creates and mixed batches before any data write', async () => {
    const f = await resourceFixture();
    const remove = { id: 'delete', ingredient: recordsManifest.slug, input: { operation: 'delete', args: {
      id: 'a', expected_version: 1, expected_revision: 0 } } };
    await expect(prepare(f,[remove,calendarStep()])).rejects.toMatchObject({ code: 'local_changes_unsupported' }); unchanged(f);
  });

  it('rejects caller-supplied authority, malformed hashes and unknown fields', () => {
    expect(() => parseLocalChangeSetPrepare({ proposal_id: 'pap_' + randomUUID(), request_id: randomUUID(), origin: {} })).toThrow();
    expect(() => parseLocalChangeSetDecision({ change_set_id: 'lcs_' + randomUUID(), review_hash: 'fake', decision: 'approve' })).toThrow();
    expect(() => parseLocalChangeSetLocator({ change_set_id: 'lcs_' + randomUUID(), approved: true })).toThrow();
    expect(() => parseLocalChangeSetList({ cursor: '', owner_id: 'other' })).toThrow();
    expect(() => parseLocalChangeSetUndo({ change_set_id: 'lcs_' + randomUUID(), request_id: randomUUID(), inverse: {} })).toThrow();
  });
});
