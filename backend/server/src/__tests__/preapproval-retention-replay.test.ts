import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { PreparePreapproval } from '@recued/contracts';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { PreapprovalRepository } from '../storage/preapproval-repository.js';
import { recordStep, resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const pausedCodec = () => {
  const codec = createPreapprovalCodec(() => new Uint8Array(32).fill(5));
  const ready = deferred<string>(), resume = deferred<string>();
  const seal = codec.seal.bind(codec);
  codec.seal = value => { void seal(value).then(ready.resolve, ready.reject); return resume.promise; };
  return { codec, ready, resume };
};
const encrypted = (gate: ReturnType<typeof pausedCodec>, work: Promise<unknown>) =>
  Promise.race([gate.ready.promise, work.then(() => { throw new Error('Expected a pending encrypted write.'); })]);

const repository = (db: Database.Database, f: Fixture, codec = createPreapprovalCodec(() => new Uint8Array(32).fill(5))) => {
  const forbidden = (): never => { throw new Error('An existing request attempted to acquire execution authority.'); };
  return new PreapprovalRepository(db, { codec, now: () => f.clock.now,
    hooks: { validateLive: forbidden, validateResponder: forbidden, activate: forbidden,
      selectOccurrence: forbidden, stop: forbidden, createDispatch: forbidden, settleDispatch: forbidden },
    workers: { assertCurrent: forbidden, status: forbidden } });
};
const authority = (db: Database.Database) => ({
  proposals: db.prepare('SELECT * FROM preapproval_proposals ORDER BY proposal_id').all(),
  decisions: db.prepare('SELECT * FROM preapproval_decisions ORDER BY decision_id').all(),
  grants: db.prepare('SELECT * FROM preapproval_grants ORDER BY grant_id').all(),
  mutations: db.prepare('SELECT * FROM preapproval_mutations ORDER BY request_id').all(),
  members: db.prepare('SELECT * FROM preapproval_members ORDER BY grant_id, member_id').all(),
  executions: db.prepare(`SELECT future_ref, state, revision, lineage, stop_requested, status_reason,
    root_run_id, worker_id, fence, updated_at FROM preapproval_executions ORDER BY future_ref`).all(),
  activations: db.prepare('SELECT * FROM preapproval_activations ORDER BY future_ref').all(),
  identities: db.prepare('SELECT * FROM preapproval_resource_identity').all(),
  outbox: db.prepare('SELECT * FROM preapproval_outbox ORDER BY event_id').all(),
  receipts: db.prepare('SELECT count(*) AS n FROM gated_action_receipts').get(),
  commits: db.prepare('SELECT count(*) AS n FROM commits').get(),
});

const revoke = async (f: Fixture, request: PreparePreapproval) => {
  const created = await f.service.prepare(request, f.origin);
  expect(JSON.stringify((await f.storage.repository.inspect(created.proposal_id)).reviewed)).toContain('Reviewed a');
  const input = await f.decision(created.proposal_id);
  const decision = await f.storage.repository.decide(input, f.responder);
  const approved = await f.storage.repository.inspect(created.proposal_id);
  const mutation = { grant_id: approved.grant!.grant_id, expected_revision: approved.grant!.revision, request_id: randomUUID() };
  const stopped = await f.storage.repository.revoke(mutation, f.responder);
  expect(stopped).toMatchObject({ execution_status: 'cancelled', grant: { status: 'revoked' } });
  await f.composed.outbox.drain();
  f.clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
  return { request, created, input, decision, mutation };
};
type Revoked = Awaited<ReturnType<typeof revoke>>;

const afterReopen = async (f: Fixture, stopped: Revoked, before: ReturnType<typeof authority>) => {
  const reopened = await f.reopen();
  expect(await reopened.service.prepare(stopped.request, reopened.origin)).toEqual(stopped.created);
  expect(await reopened.storage.repository.decide(stopped.input, reopened.responder))
    .toEqual({ ...stopped.decision, execution_status: 'cancelled' });
  const history = await reopened.storage.repository.revoke(stopped.mutation, reopened.responder);
  expect(history).toMatchObject({ proposal_id: stopped.created.proposal_id, execution_status: 'cancelled',
    grant: { grant_id: stopped.mutation.grant_id, status: 'revoked' }, decision: { decision_id: stopped.decision.decision_id } });
  expect(history.retired_review).toBeDefined(); expect(history.reviewed).toBeUndefined();
  expect(JSON.stringify(history)).not.toContain('Reviewed a');
  await expect(reopened.run(stopped.created.future_execution_ref)).rejects.toMatchObject({ code: 'preapproval_expired' });
  await expect(reopened.service.prepare({ ...stopped.request, dispatch_deadline: stopped.request.dispatch_deadline + 1 }, reopened.origin))
    .rejects.toMatchObject({ code: 'preapproval_idempotency_conflict' });
  expect(reopened.row('a')).toMatchObject({ title: 'a', _record: { revision: 0 } });
  expect(authority(reopened.db)).toEqual(before);
  expect(before.receipts).toEqual({ n: 0 }); expect(before.commits).toEqual({ n: 0 });
};

it('keeps the public request retry available through retirement without changing revoked authority', async () => {
  const f = await resourceFixture(); f.save([recordStep('a')]);
  const stopped = await revoke(f, f.request());
  const db = new Database(join(f.dir, 'realm.sqlite')), gate = pausedCodec();
  const writer = repository(db, f, gate.codec);
  const before = authority(f.db);
  const retiring = writer.retireReviewContent(1);
  let retry: ReturnType<Fixture['service']['prepare']> | undefined;
  try {
    const ciphertext = await encrypted(gate, retiring);
    expect(db.inTransaction).toBe(false);
    gate.resume.resolve(ciphertext);
    retry = f.service.prepare(stopped.request, f.origin);
    const [count, result] = await Promise.all([retiring, retry]);
    expect(count).toBe(1); expect(result).toEqual(stopped.created);
    expect(authority(f.db)).toEqual(before);
  } finally {
    gate.resume.resolve(''); await Promise.allSettled([retiring, ...(retry ? [retry] : [])]); db.close();
  }
  await afterReopen(f, stopped, before);
});

it.each(['before retirement', 'during retirement', 'after retirement'] as const)('keeps the final preparation response private and stable %s', async phase => {
  const f = await resourceFixture(); f.save([recordStep('a')]);
  // A real prepared plan supplies the immutable production inventory. Each
  // preparer is allowed its own target/member identities for the same request.
  const seed = await f.service.prepare(f.request(), f.origin);
  const plan = structuredClone(await f.storage.repository.loadExecution(seed.future_execution_ref));
  plan.request = f.request();
  const readerDb = new Database(join(f.dir, 'realm.sqlite')), readerGate = pausedCodec();
  const writerDb = new Database(join(f.dir, 'realm.sqlite')), writerGate = pausedCodec();
  const reader = repository(readerDb, f, readerGate.codec), writer = repository(writerDb, f, writerGate.codec);
  const preparing = reader.prepare(plan, false);
  let retiring: Promise<number> | undefined;
  let stopped!: Revoked;
  let before!: ReturnType<typeof authority>;
  try {
    const planCiphertext = await encrypted(readerGate, preparing);
    stopped = await revoke(f, plan.request);
    before = authority(f.db);
    retiring = writer.retireReviewContent(1);
    const summaryCiphertext = await encrypted(writerGate, retiring);
    expect(readerDb.inTransaction).toBe(false); expect(writerDb.inTransaction).toBe(false);
    if (phase === 'before retirement') {
      readerGate.resume.resolve(planCiphertext);
      await preparing;
      writerGate.resume.resolve(summaryCiphertext);
    } else if (phase === 'after retirement') {
      writerGate.resume.resolve(summaryCiphertext);
      expect(await retiring).toBe(1);
      readerGate.resume.resolve(planCiphertext);
    } else {
      readerGate.resume.resolve(planCiphertext);
      writerGate.resume.resolve(summaryCiphertext);
    }
    const [result, count] = await Promise.all([preparing, retiring]);
    expect(count).toBe(1); expect(result).toEqual(stopped.created);
    expect(authority(f.db)).toEqual(before);
  } finally {
    readerGate.resume.resolve(''); writerGate.resume.resolve('');
    await Promise.allSettled([preparing, ...(retiring ? [retiring] : [])]);
    readerDb.close(); writerDb.close();
  }
  await afterReopen(f, stopped, before);
});

it.each(['missing', 'invalid'] as const)('refuses retained outcome fault=%s without granting authority or weakening request-key conflicts', async fault => {
  const f = await resourceFixture(); f.save([recordStep('a')]);
  const stopped = await revoke(f, f.request());
  if (fault === 'missing') f.db.prepare("UPDATE preapproval_executions SET snapshot_ciphertext='' WHERE future_ref=?")
    .run(stopped.created.future_execution_ref);
  else {
    expect(await f.storage.repository.retireReviewContent()).toBe(1);
    f.db.prepare('UPDATE preapproval_retired_reviews SET summary_hash=? WHERE future_ref=?')
      .run('invalid', stopped.created.future_execution_ref);
  }
  const before = authority(f.db);
  await expect(f.service.prepare(stopped.request, f.origin))
    .rejects.toMatchObject({ code: fault === 'missing' ? 'preapproval_expired' : 'preapproval_stale' });
  await expect(f.service.prepare({ ...stopped.request, dispatch_deadline: stopped.request.dispatch_deadline + 1 }, f.origin))
    .rejects.toMatchObject({ code: 'preapproval_idempotency_conflict' });
  expect(authority(f.db)).toEqual(before);
});
