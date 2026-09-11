import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compoundPlan, decisionInput, memberPath, ownerResponder, preparedMember, preparedPlan, repositoryFixture } from './d-261-fixtures.js';
import { preapprovalHash } from '../preapproval-invocations.js';
import type { Checkpoint } from '@recued/contracts';

const databases: Database.Database[] = [];
const directories: string[] = [];
const memory = () => { const db = new Database(':memory:'); databases.push(db); return db; };
const diskPair = () => {
  const dir = mkdtempSync(join(tmpdir(), 'd261-race-')); directories.push(dir);
  const path = join(dir, 'realm.db');
  const first = new Database(path); const second = new Database(path);
  first.pragma('journal_mode = WAL'); second.pragma('busy_timeout = 5000');
  databases.push(first, second); return [first, second] as const;
};
const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('D-261 durable decisions and invocation claims', () => {
  it('atomically checkpoints completed effects, transfers one surrendered fence across SQLite connections, and rejects replay', async () => {
    const [db1, db2] = diskPair(); const state = { now: 1_000, locked: false };
    const first = repositoryFixture(db1, state); const second = repositoryFixture(db2, state);
    const plan = preparedPlan([preparedMember(), preparedMember({ invocation_path: memberPath('after') })]);
    const proposal = await first.repository.prepare(plan, false);
    await first.repository.decide(await decisionInput(first.repository, proposal.proposal_id), ownerResponder);
    state.now = 10_000;
    const run = await first.repository.claimRun({ future_execution_ref: proposal.future_execution_ref,
      run_id: 'root', worker_id: 'original', occurrence_key: 'due:10000', occurrence_sequence: 1 });
    const done = await first.repository.claimMember(run, plan.members[0]!);
    await first.repository.settleMember(done, { status: 'succeeded', message: 'Sent once', result: { vendor_id: 'first' } });
    const checkpoint: Checkpoint = { checkpoint_id: 'checkpoint-a', run_id: 'root', recipe_id: plan.recipe.recipe_id,
      gated_step_id: 'uncovered', step_state: { send: { vendor_id: 'first' } }, created_at: state.now,
      preapproval_execution_ref: proposal.future_execution_ref };
    db1.exec("CREATE TRIGGER checkpoint_fault BEFORE INSERT ON preapproval_run_checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint fault'); END");
    await expect(first.repository.holdRun(run, checkpoint)).rejects.toThrow('checkpoint fault');
    expect(count(db1, 'checkpoints')).toBe(0);
    expect((await first.repository.inspect(proposal.proposal_id)).execution_status).toBe('running');
    db1.exec('DROP TRIGGER checkpoint_fault');
    await first.repository.holdRun(run, checkpoint);
    const races = await Promise.allSettled([first.repository.resumeRun(checkpoint, 'new-a'), second.repository.resumeRun(checkpoint, 'new-b')]);
    expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = races.find(result => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled' || !winner.value) throw new Error('Missing checkpoint winner');
    expect(winner.value).toMatchObject({ root_run_id: run.root_run_id, fence: run.fence + 1 });
    await expect(first.repository.claimMember(run, plan.members[1]!)).rejects.toMatchObject({ code: 'preapproval_already_claimed' });
    await expect(first.repository.claimMember(winner.value, plan.members[0]!)).rejects.toMatchObject({ code: 'preapproval_already_claimed' });
    const next = await first.repository.claimMember(winner.value, plan.members[1]!);
    await first.repository.settleMember(next, { status: 'succeeded', message: 'Second effect', result: {} });
    await first.repository.finishRun(winner.value, 'succeeded');
    await expect(second.repository.resumeRun(checkpoint, 'new-b')).rejects.toMatchObject({ code: 'preapproval_already_claimed' });
    expect(count(db1, 'd261_test_receipt')).toBe(2);
  });

  it.each(['cancel', 'expire', 'splice'] as const)('does not release a held group after %s', async action => {
    const db = memory(); const { repository, state } = repositoryFixture(db);
    const plan = preparedPlan(); const proposal = await repository.prepare(plan, false);
    await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
    state.now = 10_000;
    const run = await repository.claimRun({ future_execution_ref: proposal.future_execution_ref,
      run_id: 'root', worker_id: 'original', occurrence_key: 'due:10000', occurrence_sequence: 1 });
    const checkpoint: Checkpoint = { checkpoint_id: 'checkpoint-a', run_id: 'root', recipe_id: plan.recipe.recipe_id,
      gated_step_id: 'uncovered', step_state: {}, created_at: state.now, preapproval_execution_ref: proposal.future_execution_ref };
    await repository.holdRun(run, checkpoint);
    if (action === 'cancel') repository.cancelCheckpoint(checkpoint, 'owner_denied');
    else if (action === 'expire') { state.now = plan.request.dispatch_deadline; repository.expire(); }
    else {
      checkpoint.step_state = { substituted: true };
      db.prepare('UPDATE checkpoints SET data=? WHERE key=?').run(JSON.stringify(checkpoint), checkpoint.checkpoint_id);
    }
    await expect(repository.resumeRun(checkpoint, 'new')).rejects.toBeDefined();
    expect((await repository.inspect(proposal.proposal_id)).execution_status).toBe(
      action === 'cancel' ? 'cancelled' : action === 'expire' ? 'expired' : 'invalidated');
    expect(count(db, 'd261_test_receipt')).toBe(0);
  });
  it('seals a pending proposal when owner review detects target drift, without revoking an already decided action on reopen', async () => {
    const db = memory(); const { repository } = repositoryFixture(db);
    const first = await repository.prepare(preparedPlan(), false);
    db.prepare('UPDATE d261_test_authority SET revision = 2').run();
    await expect(repository.review(first.proposal_id, ownerResponder)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect((await repository.inspect(first.proposal_id)).status).toBe('invalidated');
    db.prepare('UPDATE d261_test_authority SET revision = 1').run();
    const second = await repository.prepare(preparedPlan(), false);
    await repository.decide(await decisionInput(repository, second.proposal_id), ownerResponder);
    await expect(repository.review(second.proposal_id, ownerResponder)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect((await repository.inspect(second.proposal_id)).execution_status).toBe('active');
  });
  it('persists an inert encrypted proposal and shares a decision with every required child', async () => {
    const db = memory(); const { repository } = repositoryFixture(db);
    const plan = compoundPlan();
    const proposal = await repository.prepare(plan, true);
    expect(proposal).toMatchObject({ status: 'awaiting_owner', coverage: 'complete', eligible_members: 2 });
    expect(count(db, 'preapproval_grants')).toBe(0);
    expect(count(db, 'd261_test_activation')).toBe(0);
    expect(JSON.stringify(db.prepare('SELECT * FROM preapproval_executions').all())).not.toContain('private reviewed content');
    const decision = await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
    expect(decision.execution_status).toBe('active');
    expect(count(db, 'preapproval_grants')).toBe(1);
    expect(count(db, 'preapproval_members')).toBe(2);
    expect(count(db, 'd261_test_activation')).toBe(1);
    expect(count(db, 'd261_test_receipt')).toBe(0);
  });
  it('converges concurrent request retries and owner responses across real SQLite connections', async () => {
    const [db1, db2] = diskPair();
    const first = repositoryFixture(db1); const second = repositoryFixture(db2);
    const plan = preparedPlan();
    const [a, b] = await Promise.all([first.repository.prepare(plan, true), second.repository.prepare(plan, true)]);
    expect(a).toEqual(b);
    expect(count(db1, 'preapproval_proposals')).toBe(1);
    expect(count(db1, 'preapproval_outbox')).toBe(1);
    const request = await decisionInput(first.repository, a.proposal_id);
    const replies = await Promise.all([first.repository.decide(request, ownerResponder), second.repository.decide(request, ownerResponder)]);
    expect(replies[0]).toEqual(replies[1]);
    expect(count(db1, 'preapproval_grants')).toBe(1);
    expect(count(db1, 'd261_test_activation')).toBe(1);
    // ⛔ A REPLAY AFTER THE DECISION MUST NOT REPORT IT. Convergence is proven by
    // the counts above and the idempotency conflict below; the replay's own job
    // is to say "you already asked", not to hand the caller a per-request signal
    // that the owner approved. `core.preapproval.request` is grantable to
    // contracts, so that signal would land in exactly the wrong hands.
    expect(await second.repository.prepare(plan, true)).toMatchObject({ status: 'awaiting_owner' });
    expect(replies[0]).toMatchObject({ decision: 'approve' });
    await expect(first.repository.prepare({ ...plan, request: { ...plan.request, dispatch_deadline: 16_000 } }, true))
      .rejects.toMatchObject({ code: 'preapproval_idempotency_conflict' });
  });
  it('rejects a foreign responder and stale selection challenge without minting authority', async () => {
    const db = memory(); const { repository } = repositoryFixture(db);
    const plan = preparedPlan([preparedMember(), preparedMember({ invocation_path: memberPath('other') })]);
    const proposal = await repository.prepare(plan, false);
    const request = await decisionInput(repository, proposal.proposal_id);
    await expect(repository.decide(request, { channel: 'webclient', key: 'model-token' })).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
    await repository.select({ proposal_id: proposal.proposal_id, expected_revision: 1, member_ids: [plan.members[0]!.member_id] }, ownerResponder);
    await expect(repository.decide(request, ownerResponder)).rejects.toMatchObject({ code: 'preapproval_invalid_proof' });
    expect(count(db, 'preapproval_decisions')).toBe(0);
    expect(count(db, 'preapproval_grants')).toBe(0);
  });
  it('rolls back decision, consumed challenge and grant if activation fails', async () => {
    const db = memory(); const fixture = repositoryFixture(db);
    const proposal = await fixture.repository.prepare(preparedPlan(), false);
    const request = await decisionInput(fixture.repository, proposal.proposal_id);
    const failing = repositoryFixture(db, fixture.state, {
      activate(_plan, activation) {
        db.prepare('INSERT INTO d261_test_activation VALUES(?)').run(activation.future_execution_ref);
        throw new Error('activation write failed');
      },
    });
    await expect(failing.repository.decide(request, ownerResponder)).rejects.toThrow('activation write failed');
    expect(count(db, 'preapproval_decisions')).toBe(0);
    expect(count(db, 'preapproval_grants')).toBe(0);
    expect(count(db, 'd261_test_activation')).toBe(0);
    expect(await fixture.repository.decide(request, ownerResponder)).toMatchObject({ decision: 'approve' });
  });
  it('chooses one scheduler worker and one dispatch claim even when policy now admits', async () => {
    const [db1, db2] = diskPair();
    const state = { now: 1_000, locked: false };
    const first = repositoryFixture(db1, state); const second = repositoryFixture(db2, state);
    const plan = preparedPlan();
    const proposal = await first.repository.prepare(plan, false);
    await first.repository.decide(await decisionInput(first.repository, proposal.proposal_id), ownerResponder);
    state.now = 10_000;
    const runs = await Promise.allSettled([first, second].map((fixture, i) => fixture.repository.claimRun({
      future_execution_ref: proposal.future_execution_ref, run_id: `run-${i}`, worker_id: `worker-${i}`,
      occurrence_key: 'due:10000', occurrence_sequence: 1,
    })));
    expect(runs.filter(run => run.status === 'fulfilled')).toHaveLength(1);
    const winning = runs.find(run => run.status === 'fulfilled');
    if (!winning || winning.status !== 'fulfilled') throw new Error('Expected one winning run');
    const actual = { ...plan.members[0]!, pre_lift_approval: 'never' as const };
    const claims = await Promise.allSettled([first.repository.claimMember(winning.value, actual), second.repository.claimMember(winning.value, actual)]);
    expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1);
    expect(count(db1, 'd261_test_receipt')).toBe(1);
  });
  it('checks and consumes the parent and exact attachment read separately under one decision', async () => {
    const db = memory(); const { repository, state } = repositoryFixture(db);
    const plan = compoundPlan(); const proposal = await repository.prepare(plan, false);
    await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
    state.now = 10_000;
    const binding = await repository.claimRun({ future_execution_ref: proposal.future_execution_ref,
      run_id: 'run-1', worker_id: 'worker-1', occurrence_key: 'due:10000', occurrence_sequence: 1 });
    const parent = await repository.claimMember(binding, plan.members[0]!);
    const child = await repository.claimMember(binding, plan.members[1]!, parent.attempt_id);
    await repository.settleMember(child, { status: 'succeeded', message: 'Read exact bytes', result: { hash: 'same-content' } });
    await repository.validateClaim(parent, true);
    await repository.settleMember(parent, { status: 'succeeded', message: 'Sent', result: { provider_id: 'message-1' } });
    expect(await repository.finishRun(binding, 'succeeded')).toBe('succeeded');
    expect(await repository.finishRun(binding, 'failed')).toBe('succeeded');
    const inspection = await repository.inspect(proposal.proposal_id);
    expect(inspection.members.map(member => member.status)).toEqual(['succeeded', 'succeeded']);
    expect(count(db, 'preapproval_decisions')).toBe(1);
    expect(count(db, 'd261_test_receipt')).toBe(2);
  });
  it('rejects a borrowed child proof and stops the parent before byte egress', async () => {
    const db = memory(); const { repository, state } = repositoryFixture(db);
    const plan = compoundPlan(); const proposal = await repository.prepare(plan, false);
    await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
    state.now = 10_000;
    const binding = await repository.claimRun({ future_execution_ref: proposal.future_execution_ref,
      run_id: 'run-1', worker_id: 'worker-1', occurrence_key: 'due:10000', occurrence_sequence: 1 });
    const parent = await repository.claimMember(binding, plan.members[0]!);
    await expect(repository.claimMember(binding, plan.members[1]!, 'another-parent')).rejects.toMatchObject({ code: 'preapproval_stale' });
    await expect(repository.validateClaim(parent, true)).rejects.toMatchObject({ code: 'preapproval_cancelled' });
    expect(count(db, 'd261_test_receipt')).toBe(1);
  });
  it('does not use an approval after target deletion or live contract revocation', async () => {
    const db = memory(); const { repository, state } = repositoryFixture(db);
    const plan = preparedPlan(); const proposal = await repository.prepare(plan, false);
    await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
    db.transaction(() => {
      db.prepare('UPDATE d261_test_authority SET allowed = 0').run();
      repository.invalidateDependency('one_shot', plan.target.key, plan.target.incarnation);
    })();
    state.now = 10_000;
    await expect(repository.claimRun({ future_execution_ref: proposal.future_execution_ref,
      run_id: 'run-1', worker_id: 'worker-1', occurrence_key: 'due:10000', occurrence_sequence: 1 }))
      .rejects.toMatchObject({ code: 'preapproval_cancelled' });
    expect((await repository.inspect(proposal.proposal_id)).grant?.status).toBe('invalidated');
    expect(count(db, 'd261_test_receipt')).toBe(0);
  });
  it('keeps uncertainty terminal and cannot claim the same invocation again', async () => {
    const db = memory(); const { repository, state } = repositoryFixture(db);
    const plan = preparedPlan(); const proposal = await repository.prepare(plan, false);
    await repository.decide(await decisionInput(repository, proposal.proposal_id), ownerResponder);
    state.now = 10_000;
    const binding = await repository.claimRun({ future_execution_ref: proposal.future_execution_ref,
      run_id: 'run-1', worker_id: 'worker-1', occurrence_key: 'due:10000', occurrence_sequence: 1 });
    const claim = await repository.claimMember(binding, plan.members[0]!);
    await repository.settleMember(claim, { status: 'in_doubt', message: 'Provider timeout', result: null });
    await repository.settleMember(claim, { status: 'succeeded', message: 'Late unverified response', result: {} });
    expect(await repository.finishRun(binding, 'failed')).toBe('in_doubt');
    expect((await repository.inspect(proposal.proposal_id)).members[0]!.status).toBe('in_doubt');
    await expect(repository.claimMember(binding, plan.members[0]!)).rejects.toMatchObject({ code: 'preapproval_cancelled' });
    expect(count(db, 'd261_test_receipt')).toBe(1);
  });
  it('refuses claims when the vault is locked and invalidates restored approval lineage', async () => {
    const db = memory(); const { repository, state } = repositoryFixture(db);
    const proposal = await repository.prepare(preparedPlan(), false);
    const request = await decisionInput(repository, proposal.proposal_id);
    state.locked = true;
    await expect(repository.decide(request, ownerResponder)).rejects.toMatchObject({ code: 'server_locked' });
    state.locked = false;
    repository.invalidateRestoredLineage();
    await expect(repository.decide(request, ownerResponder)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(count(db, 'preapproval_grants')).toBe(0);
  });

  it('invalidates a pending proposal when its source is destroyed but keeps an accepted independent copy', async () => {
    const db = memory(); const { repository } = repositoryFixture(db);
    const plan = compoundPlan();
    plan.dependencies = [
      { kind: 'file_source', key: 'original', incarnation: 'source-1', revision: 1,
        content_hash: preapprovalHash('bytes'), until_phase: 'decision' },
      { kind: 'snapshot_file', key: 'owned-copy', incarnation: 'copy-1', revision: 1,
        content_hash: preapprovalHash('bytes'), until_phase: 'terminal' },
    ];
    const pending = await repository.prepare(plan, false);
    expect(repository.invalidateDependency('file_source', 'original', 'source-1')).toBe(1);
    expect((await repository.inspect(pending.proposal_id)).status).toBe('invalidated');
    const acceptedPlan = compoundPlan(); acceptedPlan.dependencies = plan.dependencies;
    const accepted = await repository.prepare(acceptedPlan, false);
    await repository.decide(await decisionInput(repository, accepted.proposal_id), ownerResponder);
    expect(repository.invalidateDependency('file_source', 'original', 'source-1')).toBe(0);
    expect((await repository.inspect(accepted.proposal_id)).execution_status).toBe('active');
    expect(repository.invalidateDependency('snapshot_file', 'owned-copy', 'copy-1')).toBe(1);
    expect((await repository.inspect(accepted.proposal_id)).execution_status).toBe('invalidated');
  });

  it('seals an approval whose live target changed, while still allowing an owner denial after revocation', async () => {
    const db = memory(); const { repository } = repositoryFixture(db);
    const proposal = await repository.prepare(preparedPlan(), false);
    const approval = await decisionInput(repository, proposal.proposal_id);
    db.prepare('UPDATE d261_test_authority SET revision = 2').run();
    await expect(repository.decide(approval, ownerResponder)).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect((await repository.inspect(proposal.proposal_id)).status).toBe('invalidated');
    expect(count(db, 'preapproval_grants')).toBe(0);
    db.prepare('UPDATE d261_test_authority SET revision = 1').run();
    const second = await repository.prepare(preparedPlan(), false);
    const denial = { ...await decisionInput(repository, second.proposal_id), decision: 'deny' as const };
    db.prepare('UPDATE d261_test_authority SET allowed = 0').run();
    expect((await repository.decide(denial, ownerResponder)).decision).toBe('deny');
    expect(count(db, 'preapproval_grants')).toBe(0);
  });
});
