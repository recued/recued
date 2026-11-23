import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createLocalMutationReceipts, type LocalMutationReceiptBinding } from '../storage/local-mutation-receipts.js';
import { preapprovalHash } from '../preapproval-invocations.js';
import { decisionInput, ownerResponder, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });
const databasePair = () => {
  const dir = mkdtempSync(join(tmpdir(), 'preapproval-read-freshness-'));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'realm.sqlite');
  const open = () => { const db = new Database(path); disposers.push(() => { if (db.open) db.close(); }); return db; };
  const reader = open(); reader.pragma('journal_mode=WAL');
  return { reader, writer: open(), open };
};
const prepared = async () => {
  const f = databasePair(); const state = { now: 1000, locked: false };
  const repository = repositoryFixture(f.reader, state).repository;
  const plan = preparedPlan(); const proposal = await repository.prepare(plan, false);
  await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
  state.now = 10000;
  const runInput = { future_execution_ref: proposal.future_execution_ref, run_id: 'read-freshness-run',
    worker_id: 'read-freshness-worker', occurrence_key: 'due:10000', occurrence_sequence: 0 };
  return { ...f, state, repository, plan, proposal, runInput };
};

it('uses the current realm lineage after another connection commits a change', async () => {
  const f = await prepared();
  f.writer.prepare('UPDATE preapproval_state SET lineage=? WHERE singleton=1').run('restored-realm');
  await expect(f.repository.claimRun(f.runInput)).rejects.toMatchObject({ code: 'preapproval_stale' });
  expect(f.reader.prepare('SELECT state FROM preapproval_executions').get()).toEqual({ state: 'invalidated' });
  expect(f.reader.prepare('SELECT attempt_id,action_ref FROM preapproval_members').all())
    .toEqual([{ attempt_id: null, action_ref: null }]);
  expect(f.reader.prepare('SELECT count(*) FROM d261_test_receipt').pluck().get()).toBe(0);
});

it('reads newly committed reconciliation evidence in the existing time and identity order after prior inspections', async () => {
  const f = await prepared(); const run = await f.repository.claimRun(f.runInput);
  const claim = await f.repository.claimMember(run, f.plan.members[0]!);
  await f.repository.settleMember(claim, { status: 'in_doubt', message: '', result: null });
  const inspect = () => f.repository.inspect(f.proposal.proposal_id, false);
  expect((await inspect()).members[0]!.reconciled_outcome).toBeNull();
  const executionBefore = f.reader.prepare('SELECT * FROM preapproval_executions').all();
  const insert = f.writer.prepare(`INSERT INTO preapproval_reconciliations
    (evidence_id,future_ref,member_id,attempt_id,action_ref,adapter,evidence_digest,outcome,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const evidence = (id: string, outcome: string, at: number) => insert.run(id, f.proposal.future_execution_ref,
    claim.member_id, claim.attempt_id, claim.action_ref, 'read-freshness-fixture', preapprovalHash(id), outcome, at);
  evidence('evidence_a', 'succeeded', 10000);
  expect((await inspect()).members[0]!.reconciled_outcome).toBe('succeeded');
  evidence('evidence_z', 'failed', 10000);
  expect((await inspect()).members[0]!.reconciled_outcome).toBe('failed');
  evidence('evidence_zz', 'succeeded', 9999);
  expect((await inspect()).members[0]!.reconciled_outcome).toBe('failed');
  expect(f.reader.prepare('SELECT * FROM preapproval_executions').all()).toEqual(executionBefore);
  f.reader.close();
  const reopened = repositoryFixture(f.open(), f.state).repository;
  expect((await reopened.inspect(f.proposal.proposal_id, false)).members[0]!.reconciled_outcome).toBe('failed');
});

it('observes receipt creation, corruption, repair and deletion across connections and a reader reopen', () => {
  const f = databasePair(); const receipts = createLocalMutationReceipts(f.reader, () => 10000);
  const writer = createLocalMutationReceipts(f.writer, () => 10000);
  const binding: LocalMutationReceiptBinding = { owner: 'test', owner_ref: 'action', attempt_id: 'attempt',
    operation: 'example.update', kind: 'records', identity_hash: 'sha256:' + 'a'.repeat(64), review_hash: 'sha256:' + 'b'.repeat(64) };
  expect(receipts.find(binding)).toBeNull();
  const receipt = f.writer.transaction(() => writer.record(binding)).immediate();
  expect(receipts.find(binding)).toEqual(receipt);
  f.writer.prepare('UPDATE local_mutation_receipts SET data=? WHERE attempt_id=?')
    .run(JSON.stringify({ ...receipt, committed_at: 9999 }), binding.attempt_id);
  expect(receipts.find(binding)).toBeNull();
  f.writer.prepare('UPDATE local_mutation_receipts SET data=? WHERE attempt_id=?').run(JSON.stringify(receipt), binding.attempt_id);
  expect(receipts.find(binding)).toEqual(receipt);
  f.reader.close();
  const reopened = createLocalMutationReceipts(f.open(), () => 10000);
  expect(reopened.find(binding)).toEqual(receipt);
  f.writer.prepare('DELETE FROM local_mutation_receipts WHERE attempt_id=?').run(binding.attempt_id);
  expect(reopened.find(binding)).toBeNull();
});
