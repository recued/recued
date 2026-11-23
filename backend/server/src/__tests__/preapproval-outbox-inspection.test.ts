import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { decisionInput, ownerResponder, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const completed = async () => {
  const db = new Database(':memory:'); databases.push(db);
  const state = { now: 1000, locked: false };
  const { repository } = repositoryFixture(db, state);
  const plan = preparedPlan();
  const created = await repository.prepare(plan, true);
  await repository.decide(await decisionInput(repository, created.proposal_id), ownerResponder);
  state.now = 10000;
  const run = await repository.claimRun({ future_execution_ref: created.future_execution_ref,
    run_id: 'completed-run', worker_id: 'worker', occurrence_key: 'due:10000', occurrence_sequence: 1 });
  const claim = await repository.claimMember(run, plan.members[0]!);
  await repository.settleMember(claim, { status: 'succeeded', message: 'Retained outcome detail', result: { private: true } });
  await repository.finishRun(run, 'succeeded');
  return { db, repository, state, created };
};
const authority = (db: Database.Database) => ['preapproval_executions', 'preapproval_proposals',
  'preapproval_grants', 'preapproval_members', 'preapproval_decisions', 'preapproval_mutations']
  .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());

it('omits review presentation when requested while retaining full default reviews, outcomes and durable authority', async () => {
  const f = await completed(); const before = authority(f.db);
  const full = await f.repository.inspectExecution(f.created.future_execution_ref);
  expect(full.reviewed?.members).toHaveLength(1);
  expect(full.members).toMatchObject([{ status: 'succeeded', status_message: 'Retained outcome detail' }]);
  expect(full.grant?.status).toBe('exhausted');
  const { reviewed, ...outcome } = full;
  expect(reviewed).toBeDefined();
  expect(await f.repository.inspectExecution(f.created.future_execution_ref, false)).toEqual(outcome);
  expect(authority(f.db)).toEqual(before);
});

it('retains lock, snapshot-integrity and member-ciphertext refusals when review presentation is omitted', async () => {
  const f = await completed();
  f.state.locked = true;
  await expect(f.repository.inspectExecution(f.created.future_execution_ref, false)).rejects.toMatchObject({ code: 'server_locked' });
  f.state.locked = false;
  const original = f.db.prepare('SELECT snapshot_hash FROM preapproval_executions WHERE future_ref=?')
    .get(f.created.future_execution_ref) as { snapshot_hash: string };
  f.db.prepare("UPDATE preapproval_executions SET snapshot_hash='tampered' WHERE future_ref=?").run(f.created.future_execution_ref);
  await expect(f.repository.inspectExecution(f.created.future_execution_ref, false)).rejects.toMatchObject({ code: 'preapproval_stale' });
  f.db.prepare('UPDATE preapproval_executions SET snapshot_hash=? WHERE future_ref=?').run(original.snapshot_hash, f.created.future_execution_ref);
  f.db.prepare("UPDATE preapproval_members SET result_ciphertext='invalid encrypted envelope' WHERE future_ref=?")
    .run(f.created.future_execution_ref);
  const before = authority(f.db);
  await expect(f.repository.inspectExecution(f.created.future_execution_ref)).rejects.toBeInstanceOf(SyntaxError);
  await expect(f.repository.inspectExecution(f.created.future_execution_ref, false)).rejects.toBeInstanceOf(SyntaxError);
  expect(authority(f.db)).toEqual(before);
});
