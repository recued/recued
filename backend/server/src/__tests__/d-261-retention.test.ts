import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { decisionInput, ownerResponder, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

it.each(['succeeded', 'expired', 'in_doubt'] as const)('retains decisions and replay identity across content expiry and disk reopen: %s', async outcome => {
  const directory = mkdtempSync(join(tmpdir(), 'd261-retention-'));
  const path = join(directory, 'realm.sqlite');
  let db = new Database(path);
  const clock = { now: 1000, locked: false };
  try {
    const first = repositoryFixture(db, clock).repository;
    const plan = preparedPlan();
    const proposal = await first.prepare(plan, true);
    const input = await decisionInput(first, proposal.proposal_id);
    const decision = outcome === 'expired' ? null : await first.decide(input, ownerResponder);
    clock.now = 10_000;
    if (outcome !== 'expired') {
      const run = await first.claimRun({ future_execution_ref: proposal.future_execution_ref, run_id: 'actual-root',
        worker_id: 'worker', occurrence_key: 'due:10000', occurrence_sequence: 1 });
      const claim = await first.claimMember(run, plan.members[0]!);
      await first.settleMember(claim, { status: outcome, message: 'Private outcome details', result: { private_content: 'result content' } });
      await first.finishRun(run, outcome);
    } else first.expire();
    for (const event of first.takeOutbox('worker')) first.finishOutbox(event.event_id, 'worker');
    clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
    expect(await first.retireReviewContent()).toBe(outcome === 'in_doubt' ? 0 : 1);
    const stored = db.prepare('SELECT snapshot_ciphertext FROM preapproval_executions WHERE future_ref=?')
      .get(proposal.future_execution_ref) as { snapshot_ciphertext: string };
    expect(stored.snapshot_ciphertext === '').toBe(outcome !== 'in_doubt');
    db.close(); db = new Database(path);
    const reopened = repositoryFixture(db, clock).repository;
    const inspection = await reopened.inspect(proposal.proposal_id);
    expect(inspection.execution_status).toBe(outcome);
    if (outcome !== 'in_doubt') {
      expect(inspection.retired_review).toBeDefined(); expect(inspection.reviewed).toBeUndefined();
      expect(JSON.stringify(inspection)).not.toContain('Private outcome details');
      await expect(reopened.loadExecution(proposal.future_execution_ref)).rejects.toMatchObject({ code: 'preapproval_expired' });
    }
    // The property is IDENTITY: a replay after retention resolves to the same
    // proposal and mints no second one (the count below). It is NOT a status
    // query — a replay reports what creation reported, so a caller that keeps
    // its idempotency key cannot watch the owner's decision land. The terminal
    // state is `inspect`'s to report, asserted above.
    expect(await reopened.prepare(plan, true))
      .toMatchObject({ proposal_id: proposal.proposal_id, status: 'awaiting_owner' });
    expect(inspection.status).not.toBe('awaiting_owner');
    expect(db.prepare('SELECT count(*) AS count FROM preapproval_proposals').get()).toEqual({ count: 1 });
    if (decision) expect(await reopened.decide(input, ownerResponder)).toMatchObject({ decision_id: decision.decision_id });
    else await expect(reopened.decide(input, ownerResponder)).rejects.toMatchObject({ code: 'preapproval_expired' });
    expect(await reopened.retireReviewContent()).toBe(0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('rolls back summary and content changes together when retention storage fails', async () => {
  const db = new Database(':memory:'); const clock = { now: 1000, locked: false };
  try {
    const repository = repositoryFixture(db, clock).repository;
    const plan = preparedPlan(); const proposal = await repository.prepare(plan, false);
    clock.now = 10_000; repository.expire();
    for (const event of repository.takeOutbox('worker')) repository.finishOutbox(event.event_id, 'worker');
    clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
    db.exec("CREATE TRIGGER fail_retention BEFORE UPDATE OF snapshot_ciphertext ON preapproval_executions BEGIN SELECT RAISE(ABORT, 'retention fault'); END");
    await expect(repository.retireReviewContent()).rejects.toThrow('retention fault');
    expect(db.prepare('SELECT count(*) AS count FROM preapproval_retired_reviews').get()).toEqual({ count: 0 });
    expect((await repository.loadExecution(proposal.future_execution_ref)).request).toEqual(plan.request);
    db.exec('DROP TRIGGER fail_retention'); expect(await repository.retireReviewContent()).toBe(1);
  } finally { db.close(); }
});

it('retires only matching run checkpoints and preserves replacement keys', async () => {
  const db = new Database(':memory:'); const clock = { now: 1000, locked: false };
  try {
    const repository = repositoryFixture(db, clock).repository;
    const proposal = await repository.prepare(preparedPlan(), false);
    for (const kind of ['run', 'poll']) for (const replacement of [false, true]) {
      const key = `${kind}-${replacement}`;
      db.prepare('INSERT INTO checkpoints(key,data) VALUES(?,?)').run(key, JSON.stringify({ run_id: replacement ? 'other-run' : key }));
      if (kind === 'run') db.prepare('INSERT INTO preapproval_run_checkpoints VALUES(?,?,?,1,?,?,?,1)')
        .run(key, proposal.future_execution_ref, key, 'checkpoint-hash', 'members-hash', 'completed');
      else db.prepare('INSERT INTO preapproval_polls VALUES(?,?,?, ?,1,?,?,?,1,1)')
        .run(key, proposal.future_execution_ref, key, 'worker', 'finished', key, 'checkpoint-hash');
    }
    clock.now = 10_000; repository.expire();
    for (const event of repository.takeOutbox('worker')) repository.finishOutbox(event.event_id, 'worker');
    clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
    expect(await repository.retireReviewContent()).toBe(1);
    expect(db.prepare('SELECT key FROM checkpoints ORDER BY key').all()).toEqual([{ key: 'poll-true' }, { key: 'run-true' }]);
  } finally { db.close(); }
});
