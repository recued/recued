import Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { PreapprovalInspection } from '@recued/contracts';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { createPreapprovalCodec, type PreapprovalCodec } from '../storage/preapproval-codec.js';
import { PreapprovalRepository } from '../storage/preapproval-repository.js';
import { recordStep, resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });

const codec = () => createPreapprovalCodec(() => new Uint8Array(32).fill(5));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const historyRepository = (db: Database.Database, clock: { now: number }, encryption = codec()) => {
  const forbidden = (): never => { throw new Error('History read invoked execution authority.'); };
  return new PreapprovalRepository(db, { codec: encryption, now: () => clock.now,
    hooks: { validateLive: forbidden, validateResponder: forbidden, activate: forbidden,
      selectOccurrence: forbidden, stop: forbidden, createDispatch: forbidden, settleDispatch: forbidden },
    workers: { assertCurrent: forbidden, status: forbidden } });
};

const completed = async () => {
  const f = await resourceFixture();
  f.save([recordStep('a')]);
  const prepared = await f.service.prepare(f.request(), f.origin);
  const input = await f.decision(prepared.proposal_id);
  const decision = await f.storage.repository.decide(input, f.responder);
  expect(await f.run(prepared.future_execution_ref)).toMatchObject({ success: true });
  const before = await f.storage.repository.inspect(prepared.proposal_id);
  expect(before.reviewed).toBeDefined();
  expect(JSON.stringify(before.reviewed)).toContain('Reviewed a');
  expect(before.members).toHaveLength(1);
  expect(before.members[0]).toMatchObject({ status: 'succeeded', action_ref: expect.any(String),
    commit_id: expect.any(String), local_receipt: { receipt_id: expect.any(String) } });
  await f.composed.outbox.drain();
  f.clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
  return { f, prepared, input, decision, before };
};

const authority = (db: Database.Database) => ({
  proposals: db.prepare('SELECT * FROM preapproval_proposals ORDER BY proposal_id').all(),
  decisions: db.prepare('SELECT * FROM preapproval_decisions ORDER BY decision_id').all(),
  grants: db.prepare('SELECT * FROM preapproval_grants ORDER BY grant_id').all(),
  members: db.prepare(`SELECT grant_id, member_id, future_ref, state, attempt_id, idempotency_key,
    parent_attempt_id, action_ref, commit_id, actual_run_id, revision, updated_at
    FROM preapproval_members ORDER BY grant_id, member_id`).all(),
});

const retained = (value: PreapprovalInspection, before: PreapprovalInspection) => {
  expect(value).toMatchObject({ proposal_id: before.proposal_id, future_execution_ref: before.future_execution_ref,
    status: before.status, execution_status: before.execution_status, grant: before.grant, decision: before.decision });
  expect(value.members).toEqual(before.members.map(member => ({ ...member, status_message: null })));
  expect(value.retired_review).toBeDefined();
  expect(value.reviewed).toBeUndefined();
  expect(JSON.stringify(value)).not.toContain('Reviewed a');
};

it.each(['get', 'list'] as const)('keeps %s history readable through native SQLite retirement and reopen', async mode => {
  const { f, prepared, input, decision, before } = await completed();
  f.save([recordStep('b')]);
  const live = await f.service.prepare(f.request(), f.origin);
  const ids = [prepared.proposal_id, live.proposal_id].sort();
  const readerDb = new Database(join(f.dir, 'realm.sqlite'));
  const writerDb = new Database(join(f.dir, 'realm.sqlite'));
  const writerCodec: PreapprovalCodec = codec();
  const reader = historyRepository(readerDb, f.clock);
  const writer = historyRepository(writerDb, f.clock, writerCodec);
  const previousAuthority = authority(f.db);
  const sealed = deferred<string>();
  const resume = deferred<string>();
  const encode = writerCodec.seal.bind(writerCodec);
  // Use the public asynchronous codec seam, with real encryption and independent
  // native connections. Neither repository methods nor persisted state are mocked.
  writerCodec.seal = value => {
    void encode(value).then(sealed.resolve, sealed.reject);
    return resume.promise;
  };
  const retiring = writer.retireReviewContent(1);
  let reading: Promise<PreapprovalInspection | { proposals: PreapprovalInspection[]; next_cursor: string | null }> | undefined;
  try {
    const ciphertext = await Promise.race([sealed.promise, retiring.then(() => { throw new Error('No eligible retirement.'); })]);
    expect(writerDb.inTransaction).toBe(false);
    expect(readerDb.prepare('SELECT count(*) AS n FROM preapproval_retired_reviews').get()).toEqual({ n: 0 });
    resume.resolve(ciphertext);
    reading = mode === 'get' ? reader.inspect(prepared.proposal_id) : reader.list('', 2);
    const [count, result] = await Promise.all([retiring, reading]);
    expect(count).toBe(1);
    if ('proposals' in result) {
      expect(result.proposals.map(value => value.proposal_id)).toEqual(ids);
      expect(result.next_cursor).toBeNull();
      retained(result.proposals.find(value => value.proposal_id === prepared.proposal_id)!, before);
      expect(result.proposals.find(value => value.proposal_id === live.proposal_id)?.status).toBe('awaiting_owner');
    } else retained(result, before);
    expect(authority(f.db)).toEqual(previousAuthority);
    expect(f.db.prepare('SELECT snapshot_ciphertext FROM preapproval_executions WHERE future_ref=?')
      .get(prepared.future_execution_ref)).toEqual({ snapshot_ciphertext: '' });
  } finally {
    resume.resolve('');
    await Promise.allSettled([retiring, ...(reading ? [reading] : [])]);
    readerDb.close(); writerDb.close();
  }

  const reopened = await f.reopen();
  retained(await reopened.storage.repository.inspect(prepared.proposal_id), before);
  const first = await reopened.storage.repository.list('', 1);
  expect(first.proposals.map(value => value.proposal_id)).toEqual(ids.slice(0, 1));
  expect(first.next_cursor).toBe(ids[0]);
  const second = await reopened.storage.repository.list(first.next_cursor!, 1);
  expect(second.proposals.map(value => value.proposal_id)).toEqual(ids.slice(1));
  expect(second.next_cursor).toBeNull();
  retained([...first.proposals, ...second.proposals].find(value => value.proposal_id === prepared.proposal_id)!, before);
  expect((await reopened.storage.repository.inspect(live.proposal_id)).reviewed).toBeDefined();
  expect(await reopened.storage.repository.decide(input, reopened.responder))
    .toEqual({ ...decision, execution_status: before.execution_status });
  await expect(reopened.run(prepared.future_execution_ref)).rejects.toMatchObject({ code: 'preapproval_expired' });
  expect(reopened.row('a')).toMatchObject({ title: 'Reviewed a', _record: { revision: 1 } });
  expect(reopened.row('b')).toMatchObject({ title: 'b', _record: { revision: 0 } });
  expect(authority(reopened.db)).toEqual(previousAuthority);
});

it('preserves expiry errors when private content is absent without a retained outcome', async () => {
  const { f, prepared } = await completed();
  // Deliberately incomplete storage is a refusal control, not a valid retirement.
  f.db.prepare("UPDATE preapproval_executions SET snapshot_ciphertext='' WHERE future_ref=?")
    .run(prepared.future_execution_ref);
  const previousAuthority = authority(f.db);
  await expect(f.storage.repository.inspect(prepared.proposal_id)).rejects.toMatchObject({ code: 'preapproval_expired' });
  await expect(f.storage.repository.list('', 2)).rejects.toMatchObject({ code: 'preapproval_expired' });
  expect(f.db.prepare('SELECT count(*) AS n FROM preapproval_retired_reviews').get()).toEqual({ n: 0 });
  expect(authority(f.db)).toEqual(previousAuthority);
});

it('rejects an invalid retained outcome instead of returning or omitting it', async () => {
  const { f, prepared } = await completed();
  expect(await f.storage.repository.retireReviewContent()).toBe(1);
  f.db.prepare('UPDATE preapproval_retired_reviews SET summary_hash=? WHERE future_ref=?')
    .run('invalid', prepared.future_execution_ref);
  const previousAuthority = authority(f.db);
  await expect(f.storage.repository.inspect(prepared.proposal_id)).rejects.toMatchObject({ code: 'preapproval_stale' });
  await expect(f.storage.repository.list('', 2)).rejects.toMatchObject({ code: 'preapproval_stale' });
  expect(authority(f.db)).toEqual(previousAuthority);
});
