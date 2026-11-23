import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { decisionInput, ownerResponder, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

const snapshot = (db: Database.Database, ref: string) => (db.prepare('SELECT snapshot_ciphertext FROM preapproval_executions WHERE future_ref=?')
  .get(ref) as { snapshot_ciphertext: string }).snapshot_ciphertext;
const summaries = (db: Database.Database) => db.prepare('SELECT future_ref FROM preapproval_retired_reviews ORDER BY future_ref').all();
const authority = (db: Database.Database) => ({
  executions: db.prepare(`SELECT future_ref,proposal_id,origin_key,target_kind,target_key,target_incarnation,target_revision,
    selector_sequence,occurrence_key,occurrence_hash,snapshot_hash,state,revision,lineage,not_before,dispatch_deadline,
    root_run_id,worker_id,fence,stop_requested,status_reason,checkpoint_id,created_at,updated_at
    FROM preapproval_executions ORDER BY future_ref`).all(),
  proposals: db.prepare('SELECT * FROM preapproval_proposals ORDER BY proposal_id').all(),
  grants: db.prepare('SELECT * FROM preapproval_grants ORDER BY grant_id').all(),
  decisions: db.prepare('SELECT * FROM preapproval_decisions ORDER BY decision_id').all(),
  mutations: db.prepare('SELECT * FROM preapproval_mutations ORDER BY request_id').all(),
  members: db.prepare('SELECT * FROM preapproval_members ORDER BY grant_id,member_id').all(),
  outbox: db.prepare('SELECT * FROM preapproval_outbox ORDER BY event_id').all(),
});
const fixture = async (tiedTimestamps = false) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-retirement-batch-'));
  const path = join(directory, 'realm.sqlite');
  const clock = { now: 1_000, locked: false };
  const db = new Database(path);
  const f = { db, repository: repositoryFixture(db, clock).repository };
  const attempts: string[] = [];
  const recordAttempts = () => f.db.function('retirement_attempt', ref => { attempts.push(String(ref)); return 0; });
  recordAttempts();
  disposers.push(() => { f.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const repository = f.repository;
  const cases = [];
  for (let index = 0; index < 3; index++) {
    const plan = preparedPlan(); plan.target.key = 'retirement-' + index;
    const created = await repository.prepare(plan, false);
    const input = await decisionInput(repository, created.proposal_id);
    const decision = await repository.decide(input, ownerResponder);
    const grant = (await repository.inspect(created.proposal_id)).grant!;
    const mutation = { grant_id: grant.grant_id, expected_revision: grant.revision, request_id: randomUUID() };
    await repository.revoke(mutation, ownerResponder);
    cases.push({ plan, created, input, decision, mutation, ref: created.future_execution_ref });
    if (!tiedTimestamps) clock.now++;
  }
  for (const event of repository.takeOutbox('worker')) repository.finishOutbox(event.event_id, 'worker');
  clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
  f.db.exec(`CREATE TABLE retirement_faults(future_ref TEXT PRIMARY KEY);
    CREATE TRIGGER fail_one_retirement BEFORE UPDATE OF snapshot_ciphertext ON preapproval_executions
    BEGIN SELECT retirement_attempt(OLD.future_ref);
      SELECT CASE WHEN EXISTS(SELECT 1 FROM retirement_faults WHERE future_ref=OLD.future_ref)
        THEN RAISE(ABORT, 'retirement transaction unavailable') END; END`);
  return { get db() { return f.db; }, get repository() { return f.repository; }, cases, attempts,
    fail(ref: string) { f.db.prepare('INSERT INTO retirement_faults VALUES(?)').run(ref); },
    repair() { f.db.exec('DELETE FROM retirement_faults'); },
    reopen() { f.db.close(); f.db = new Database(path); recordAttempts(); f.repository = repositoryFixture(f.db, clock).repository; },
  };
};

it('retires healthy peers within the batch while rolling back a failed review and preserving receipts across disk reopen', async () => {
  const f = await fixture(); const [failed, healthy, later] = f.cases;
  f.fail(failed!.ref);
  const before = authority(f.db), privateContent = snapshot(f.db, failed!.ref);
  expect(privateContent).not.toBe('');
  await expect(f.repository.retireReviewContent(2)).rejects.toThrow('retirement transaction unavailable');
  expect.soft(f.attempts).toEqual([failed!.ref, healthy!.ref]);
  expect.soft(summaries(f.db)).toEqual([{ future_ref: healthy!.ref }]);
  expect.soft(snapshot(f.db, healthy!.ref)).toBe('');
  expect(snapshot(f.db, failed!.ref)).toBe(privateContent);
  expect(snapshot(f.db, later!.ref)).not.toBe('');
  expect(authority(f.db)).toEqual(before);
  f.reopen();
  expect(snapshot(f.db, failed!.ref)).toBe(privateContent);
  expect.soft((await f.repository.inspect(healthy!.created.proposal_id)).retired_review).toBeDefined();
  expect(await f.repository.prepare(healthy!.plan, false)).toEqual(healthy!.created);
  f.repair(); expect(await f.repository.retireReviewContent(2)).toBe(2);
  f.reopen();
  for (const item of f.cases) {
    expect(snapshot(f.db, item.ref)).toBe('');
    expect(await f.repository.prepare(item.plan, false)).toEqual(item.created);
    expect((await f.repository.inspect(item.created.proposal_id)).grant?.status).toBe('revoked');
    expect(await f.repository.decide(item.input, ownerResponder)).toEqual({ ...item.decision, execution_status: 'cancelled' });
    expect((await f.repository.revoke(item.mutation, ownerResponder)).grant?.status).toBe('revoked');
  }
  expect(authority(f.db)).toEqual(before);
  expect(f.db.prepare('SELECT count(*) AS n FROM d261_test_receipt').get()).toEqual({ n: 0 });
  expect(f.db.prepare('SELECT count(*) AS n FROM preapproval_proposals').get()).toEqual({ n: 3 });
  expect(await f.repository.retireReviewContent()).toBe(0);
});

it('advances size-one batches past a persistent failure with tied timestamps and wraps to retry it', async () => {
  const f = await fixture(true); const [failed, healthy, later] = f.cases;
  f.fail(failed!.ref);
  const before = authority(f.db), privateContent = snapshot(f.db, failed!.ref);
  let failures = 0, retired = 0;
  // Each call attempts one review, including failed attempts. Equal terminal
  // timestamps must not skip a healthy review or pin the first failure forever.
  for (let index = 0; index < 3; index++) {
    const attempted = f.attempts.length;
    const result: unknown = await f.repository.retireReviewContent(1).catch((error: unknown) => error);
    if (typeof result === 'number') { expect(result).toBe(1); retired += result; }
    else { expect(result).toMatchObject({ message: 'retirement transaction unavailable' }); failures++; }
    expect(f.attempts.length - attempted).toBe(1);
  }
  expect.soft({ failures, retired }).toEqual({ failures: 1, retired: 2 });
  expect.soft(summaries(f.db)).toEqual([healthy!.ref, later!.ref].sort().map(future_ref => ({ future_ref })));
  await expect(f.repository.retireReviewContent(1)).rejects.toThrow('retirement transaction unavailable');
  expect(snapshot(f.db, failed!.ref)).toBe(privateContent);
  expect(authority(f.db)).toEqual(before);
  f.repair(); expect(await f.repository.retireReviewContent(1)).toBe(1);
  expect((await f.repository.inspect(failed!.created.proposal_id)).retired_review).toBeDefined();
  expect(authority(f.db)).toEqual(before);
});

it('reports independent read and transaction failures together while retiring a healthy peer', async () => {
  const f = await fixture(); const [unreadable, failed, healthy] = f.cases;
  f.db.prepare('UPDATE preapproval_executions SET snapshot_ciphertext=? WHERE future_ref=?').run('{}', unreadable!.ref);
  f.fail(failed!.ref);
  const before = authority(f.db), privateContent = snapshot(f.db, failed!.ref);
  const error: unknown = await f.repository.retireReviewContent(3).catch((error: unknown) => error);
  expect.soft(summaries(f.db)).toEqual([{ future_ref: healthy!.ref }]);
  expect(snapshot(f.db, unreadable!.ref)).toBe('{}');
  expect(snapshot(f.db, failed!.ref)).toBe(privateContent);
  expect(authority(f.db)).toEqual(before);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected both retirement failures.');
  expect(error.errors).toMatchObject([
    { message: 'Invalid pre-approval ciphertext.' }, { message: 'retirement transaction unavailable' },
  ]);
});
