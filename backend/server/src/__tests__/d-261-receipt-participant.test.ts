import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Commit } from '@recued/contracts';
import { createCommitStore } from '@recued/storage';
import {
  GATED_ACTION_TABLE, createGatedActionStore, createSqliteGatedActionChangeClock,
  createSqliteGatedActionCompareAndSet, isGatedActionRecord, projectGatedActionReceipt,
  type GatedActionRecord,
} from '../gated-action-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createSqlitePreapprovalReceiptParticipant } from '../storage/preapproval-receipts.js';
import { createSqlitePreapprovalDispatchParticipant } from '../storage/preapproval-dispatch-participant.js';
import { createPreapprovalStorage } from '../storage/preapproval-storage.js';
import type { PreapprovalWorkerAuthority } from '../storage/preapproval-workers.js';
import { preapprovalHash } from '../preapproval-invocations.js';
import { exportArchive } from '../archive/archive-export.js';
import { applyRestore, stageRestore, commitStagedRestore } from '../archive/archive-restore.js';
import { decisionInput, ownerResponder, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

const harness = (rollback = false, promoteOrigin = false, workers?: PreapprovalWorkerAuthority) => {
  const db = new Database(':memory:');
  const state = { now: 1_000, locked: false };
  const clock = createSqliteGatedActionChangeClock(db);
  const receipts = createSqlitePreapprovalReceiptParticipant(db, clock, () => state.now);
  const commits = createCommitStore(createSQLiteCollection<Commit>(db, 'commits'));
  const store = createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, GATED_ACTION_TABLE), {
    now: () => state.now, compareAndSet: createSqliteGatedActionCompareAndSet(db),
    nextChangeSeq: clock.nextChangeSeq, changeClock: clock.snapshot,
  });
  const dispatch = createSqlitePreapprovalDispatchParticipant(db, clock, {
    now: () => state.now,
    buildPendingCommit: (claim, member, plan) => ({
      commit_id: randomUUID(), kind: member.risk === 'read' ? 'query' : 'action', ingredient: member.ingredient_slug,
      tool: member.op_id, args: member.input,
      source: promoteOrigin ? { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'owner-token' } : plan.origin.source,
      ...(plan.origin.mode === 'contract' ? { contract_snapshot: {
        contract_id: plan.origin.contract_id, contract_version: 'fixture-live-version',
        allowed_tools: [member.ingredient_slug], approval_required: ['write'], scope_restrictions: [], resolved_at: state.now,
      } } : {}),
      channel_session_id: 'test-session', correlation_id: claim.future_execution_ref, request_id: claim.run_id,
      dispatch_depth: 0, idempotency_key: claim.idempotency_key, dispatched_at: state.now,
    }),
  });
  const fixture = repositoryFixture(db, state, {
    ...dispatch,
    createDispatch(claim, member, plan) {
      const created = dispatch.createDispatch(claim, member, plan);
      if (rollback) throw new Error('Later transaction participant failed');
      return created;
    },
  }, workers);
  const prepare = async () => {
    const plan = preparedPlan();
    const proposal = await fixture.repository.prepare(plan, false);
    await fixture.repository.decide(await decisionInput(fixture.repository, proposal.proposal_id), ownerResponder);
    state.now = 10_000;
    const run = await fixture.repository.claimRun({ future_execution_ref: proposal.future_execution_ref,
      run_id: 'run', worker_id: 'worker', occurrence_key: 'due:10000', occurrence_sequence: 0 });
    return { plan, proposal, run };
  };
  return { db, store, receipts, commits, ...fixture, prepare };
};

describe('D-261 real gated-action receipt transaction participant', () => {
  it.each(['cancel_first', 'dispatch_first'] as const)('closes only the exact waiting receipt across real SQLite connections: %s', async order => {
    const directory = mkdtempSync(join(tmpdir(), 'd261-cancel-receipt-'));
    const path = join(directory, 'realm.sqlite');
    const databases = [new Database(path), new Database(path)];
    try {
      const stores = databases.map(db => {
        const clock = createSqliteGatedActionChangeClock(db);
        return createGatedActionStore(createSQLiteCollection<GatedActionRecord>(db, GATED_ACTION_TABLE), {
          compareAndSet: createSqliteGatedActionCompareAndSet(db), nextChangeSeq: clock.nextChangeSeq, changeClock: clock.snapshot,
        });
      });
      const receipt = await stores[0]!.createHeld({ run_id: 'child', gated_step_id: 'send', checkpoint_id: 'held-child' });
      const cancel = () => stores[0]!.finish(receipt.action_ref, { status: 'cancelled', status_message: 'Execution stopped.', result: null,
        awaiting_checkpoint: { run_id: 'child', checkpoint_id: 'held-child' } });
      const dispatch = () => stores[1]!.claimDispatch(receipt.action_ref, { checkpoint_id: 'held-child', attempt_id: 'attempt-one' });
      const results = await Promise.all(order === 'cancel_first' ? [cancel(), dispatch()] : [dispatch(), cancel()]);
      const claim = results.find(result => result && 'kind' in result)!;
      const row = await stores[0]!.get(receipt.action_ref);
      expect(row?.status).toBe('kind' in claim && claim.kind === 'claimed' ? 'dispatching' : 'cancelled');
      await cancel(); expect((await stores[1]!.get(receipt.action_ref))?.status).toBe(row?.status);
      const later = await stores[0]!.createHeld({ run_id: 'other', gated_step_id: 'send', checkpoint_id: 'later' });
      await stores[0]!.finish(later.action_ref, { status: 'cancelled', status_message: '', result: null,
        awaiting_checkpoint: { run_id: 'child', checkpoint_id: 'held-child' } });
      expect((await stores[1]!.get(later.action_ref))?.status).toBe('awaiting_approval');
    } finally { for (const db of databases) db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps the production storage composition unavailable until both the vault and host runtime are ready', async () => {
    const db = new Database(':memory:');
    let key: Uint8Array | null = null;
    try {
      const storage = createPreapprovalStorage(db, createSqliteGatedActionChangeClock(db), () => key);
      await expect(storage.repository.prepare(preparedPlan(), true)).rejects.toMatchObject({ code: 'server_locked' });
      key = new Uint8Array(32).fill(7);
      await expect(storage.repository.prepare(preparedPlan(), true)).rejects.toMatchObject({ code: 'preapproval_unsupported' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM preapproval_proposals').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM commits').get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('creates a receipt at member claim without inventing a held checkpoint or letting ordinary asks rewrite it', async () => {
    const h = harness();
    try {
      const { plan, proposal, run } = await h.prepare();
      const claim = await h.repository.claimMember(run, plan.members[0]!);
      const record = await h.store.get(claim.action_ref);
      expect(record).toMatchObject({ origin: 'preapproval_member', status: 'dispatching',
        dispatch_attempt_id: claim.attempt_id, preapproval: { future_execution_ref: proposal.future_execution_ref,
          proposal_id: proposal.proposal_id, grant_id: claim.grant_id, member_id: claim.member_id } });
      expect(record?.current_checkpoint_id).toBeUndefined();
      const pending = await h.commits.get(claim.commit_id!);
      expect(pending).toMatchObject({ status: 'pending', request_id: claim.run_id, args: {},
        idempotency_key: claim.idempotency_key, source: plan.origin.source,
        preapproval: { action_ref: claim.action_ref, member_id: claim.member_id } });
      expect(await h.commits.sweepPendingToInDoubt()).toEqual([]);
      await expect(h.commits.recordOutcome(claim.commit_id!, { status: 'succeeded', completed_at: 10_001 }))
        .rejects.toThrow(/member transaction/);
      expect(isGatedActionRecord({ ...record, current_checkpoint_id: 'invented-checkpoint' })).toBe(false);
      expect(await h.store.getBySubject('run', 'send')).toBeNull();
      await h.store.markAwaiting(claim.action_ref, 'fake-ask');
      await h.store.linkApproval(claim.action_ref, 'unrelated-approval');
      await h.store.finish(claim.action_ref, { status: 'succeeded', status_message: 'ordinary notification answer', result: {} });
      expect(await h.store.get(claim.action_ref)).toEqual(record);
      const projected = projectGatedActionReceipt(record!);
      expect(projected.preapproval?.future_execution_ref).toBe(proposal.future_execution_ref);
      expect(projected).not.toHaveProperty('dispatch_attempt_id');
      expect(JSON.stringify(projected)).not.toContain('private reviewed content');
    } finally { h.db.close(); }
  });

  it('rolls receipt, member ownership and receipt sequence back if another participant fails', async () => {
    const h = harness(true);
    try {
      const { plan, run } = await h.prepare();
      const before = h.db.prepare('SELECT value FROM gated_action_change_sequence WHERE singleton = 1').get();
      await expect(h.repository.claimMember(run, plan.members[0]!)).rejects.toThrow('Later transaction participant failed');
      expect(await h.store.list()).toEqual([]);
      expect(await h.commits.size()).toBe(0);
      expect(h.db.prepare('SELECT state, attempt_id FROM preapproval_members').get()).toEqual({ state: 'available', attempt_id: null });
      expect(h.db.prepare('SELECT value FROM gated_action_change_sequence WHERE singleton = 1').get()).toEqual(before);
    } finally { h.db.close(); }
  });

  it('settles the real receipt with the member and keeps uncertainty immutable', async () => {
    const h = harness();
    try {
      const { plan, run } = await h.prepare();
      const claim = await h.repository.claimMember(run, plan.members[0]!);
      await h.repository.settleMember(claim, { status: 'in_doubt', message: 'Private upstream response', result: { private: 'result' } });
      const uncertain = await h.store.get(claim.action_ref);
      expect(uncertain?.status).toBe('in_doubt');
      expect((await h.commits.get(claim.commit_id!))?.status).toBe('in_doubt');
      await h.repository.settleMember(claim, { status: 'succeeded', message: 'Late answer', result: {} });
      expect(await h.store.get(claim.action_ref)).toEqual(uncertain);
      expect(JSON.stringify(uncertain)).not.toContain('Private upstream');
      expect(JSON.stringify(uncertain)).not.toContain('"private"');
      expect(JSON.stringify(await h.commits.get(claim.commit_id!))).not.toContain('"private"');
      expect(() => h.receipts.settle(claim, 'failed')).toThrow(/realm authority transaction/);
    } finally { h.db.close(); }
  });

  it('refuses a pending commit that promotes the original contract into the owner', async () => {
    const h = harness(false, true);
    try {
      const { plan, run } = await h.prepare();
      await expect(h.repository.claimMember(run, plan.members[0]!)).rejects.toThrow(/preserve.*origin/);
      expect(await h.store.list()).toEqual([]);
      expect(await h.commits.size()).toBe(0);
      expect(h.db.prepare('SELECT state FROM preapproval_members').get()).toEqual({ state: 'available' });
    } finally { h.db.close(); }
  });

  it('recovers a dead worker atomically and never turns a lost provider outcome into another dispatch', async () => {
    let ownerStatus: 'live' | 'gone' | 'unknown' = 'live';
    const h = harness(false, false, {
      assertCurrent(id) { if (!['worker', 'replacement'].includes(id)) throw new Error('Not a test worker'); },
      status: () => ownerStatus,
    });
    try {
      const { plan, proposal, run } = await h.prepare();
      const claim = await h.repository.claimMember(run, plan.members[0]!);
      // Time alone, including expiration of the dispatch window, never proves
      // that an external request has stopped in another process.
      h.state.now = 90_000;
      expect(await h.repository.recoverInterruptedExecution(proposal.future_execution_ref, 'replacement'))
        .toMatchObject({ status: 'worker_live', execution_status: 'running' });
      ownerStatus = 'unknown';
      expect(await h.repository.recoverInterruptedExecution(proposal.future_execution_ref, 'replacement'))
        .toMatchObject({ status: 'worker_unknown' });
      expect((await h.store.get(claim.action_ref))?.status).toBe('dispatching');
      ownerStatus = 'gone';
      expect(await h.repository.recoverInterruptedExecution(proposal.future_execution_ref, 'replacement'))
        .toMatchObject({ status: 'stopped', execution_status: 'in_doubt' });
      expect((await h.store.get(claim.action_ref))?.status).toBe('in_doubt');
      expect((await h.commits.get(claim.commit_id!))?.status).toBe('in_doubt');
      expect(h.db.prepare('SELECT state FROM preapproval_members').get()).toEqual({ state: 'in_doubt' });
      await expect(h.repository.settleMember(claim, { status: 'succeeded', message: '', result: null }))
        .rejects.toMatchObject({ code: 'preapproval_already_claimed' });
      await expect(h.repository.claimMember({ ...run, worker_id: 'replacement', fence: run.fence + 1 }, plan.members[0]!))
        .rejects.toMatchObject({ code: 'preapproval_cancelled' });
      expect(await h.repository.recoverInterruptedExecution(proposal.future_execution_ref, 'replacement'))
        .toMatchObject({ status: 'unchanged', execution_status: 'in_doubt' });
      expect(await h.commits.size()).toBe(1);
    } finally { h.db.close(); }
  });

  it('stops a claimed run without a durable checkpoint and retains prior successful effects', async () => {
    const h = harness(false, false, { assertCurrent() {}, status: () => 'gone' });
    try {
      const { plan, proposal, run } = await h.prepare();
      const claim = await h.repository.claimMember(run, plan.members[0]!);
      await h.repository.settleMember(claim, { status: 'succeeded', message: '', result: { sent: true } });
      expect(await h.repository.recoverInterruptedExecution(proposal.future_execution_ref, 'replacement'))
        .toMatchObject({ status: 'stopped', execution_status: 'partial' });
      expect((await h.store.get(claim.action_ref))?.status).toBe('succeeded');
      expect((await h.commits.get(claim.commit_id!))?.status).toBe('succeeded');
      await expect(h.repository.claimRun({ future_execution_ref: proposal.future_execution_ref, run_id: 'new-run',
        worker_id: 'replacement', occurrence_key: 'due:10000', occurrence_sequence: 0 }))
        .rejects.toMatchObject({ code: 'preapproval_cancelled' });
    } finally { h.db.close(); }
  });

  it('appends definite provider evidence without rewriting uncertain receipts or allowing a resend', async () => {
    const h = harness();
    try {
      const { plan, proposal, run } = await h.prepare();
      const claim = await h.repository.claimMember(run, plan.members[0]!);
      await h.repository.settleMember(claim, { status: 'in_doubt', message: '', result: null });
      const original = await h.store.get(claim.action_ref);
      const input = { future_execution_ref: proposal.future_execution_ref, member_id: claim.member_id,
        attempt_id: claim.attempt_id, action_ref: claim.action_ref, adapter: 'fixture-mail-outcome-v1',
        evidence_digest: preapprovalHash({ provider_message_id: 'definite-message' }),
        outcome: 'succeeded' as const, observed_at: h.state.now };
      const evidence = await h.repository.recordReconciliation(input);
      expect(await h.repository.recordReconciliation(input)).toEqual(evidence);
      expect(await h.store.get(claim.action_ref)).toEqual(original);
      expect((await h.commits.get(claim.commit_id!))?.status).toBe('in_doubt');
      const inspection = await h.repository.inspect(proposal.proposal_id);
      expect(inspection.members[0]).toMatchObject({ status: 'in_doubt', reconciled_outcome: 'succeeded' });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM preapproval_reconciliations').get()).toEqual({ n: 1 });
      await expect(h.repository.recordReconciliation({ ...input, action_ref: 'unrelated' }))
        .rejects.toMatchObject({ code: 'preapproval_in_doubt' });
      await expect(h.repository.recordReconciliation({ ...input, outcome: 'failed', evidence_digest: preapprovalHash('contradiction') }))
        .rejects.toMatchObject({ code: 'preapproval_in_doubt' });
      h.db.prepare('UPDATE d261_test_authority SET allowed = 0').run();
      await expect(h.repository.recordReconciliation({ ...input, evidence_digest: preapprovalHash('new-read') }))
        .rejects.toMatchObject({ code: 'preapproval_authority_changed' });
      expect((await h.store.get(claim.action_ref))?.status).toBe('in_doubt');
    } finally { h.db.close(); }
  });

  it.each(['offline', 'online'] as const)('invalidates unused approvals and preserves uncertainty in the real %s archive restore path', async mode => {
    const h = harness();
    const dir = mkdtempSync(join(tmpdir(), 'd261-restore-'));
    try {
      const { plan, proposal, run } = await h.prepare();
      const claim = await h.repository.claimMember(run, plan.members[0]!);
      h.state.now = 1_000;
      const unusedPlan = preparedPlan();
      unusedPlan.target.key = 'second-schedule';
      const unused = await h.repository.prepare(unusedPlan, true);
      const awaiting = await decisionInput(h.repository, unused.proposal_id);
      const lineage = h.db.prepare('SELECT lineage FROM preapproval_state').get();
      const archivePath = join(dir, 'backup.recued.archive');
      const recoveryKey = Buffer.alloc(32, 9);
      await exportArchive({ destPath: archivePath, recoveryKey, db: h.db, producerVersion: '0.2.0' });
      const target = { dbPath: join(dir, 'restored.db'), dataPath: dir, configPath: null };
      const imported = { archivePath, recoveryKey, consumerVersion: '0.2.0' };
      if (mode === 'offline') await applyRestore(target, imported);
      else await commitStagedRestore(target, await stageRestore(target, imported));
      const restored = new Database(target.dbPath);
      try {
        expect(restored.prepare('SELECT lineage FROM preapproval_state').get()).not.toEqual(lineage);
        expect(restored.prepare('SELECT state, stop_requested FROM preapproval_executions WHERE future_ref = ?')
          .get(proposal.future_execution_ref)).toEqual({ state: 'in_doubt', stop_requested: 1 });
        expect(restored.prepare('SELECT state FROM preapproval_executions WHERE future_ref = ?')
          .get(unused.future_execution_ref)).toEqual({ state: 'invalidated' });
        expect(restored.prepare("SELECT json_extract(data, '$.status') AS status FROM commits WHERE key = ?")
          .get(claim.commit_id)).toEqual({ status: 'in_doubt' });
        expect(restored.prepare("SELECT json_extract(data, '$.status') AS status FROM gated_action_receipts WHERE key = ?")
          .get(claim.action_ref)).toEqual({ status: 'in_doubt' });
        expect(restored.prepare('SELECT COUNT(*) AS n FROM preapproval_challenges WHERE consumed_decision_id IS NULL').get()).toEqual({ n: 0 });
        const afterRestore = repositoryFixture(restored, { now: 2_000, locked: false });
        await expect(afterRestore.repository.decide(awaiting, ownerResponder)).rejects.toMatchObject({ code: 'preapproval_stale' });
        expect(await afterRestore.repository.recoverInterruptedRuns('new-boot')).toEqual([]);
      } finally { restored.close(); }
    } finally { h.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
