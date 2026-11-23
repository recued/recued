import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RpcError, type PreapprovalInspection, type PreapprovalResult } from '@recued/contracts';
import { GATED_ACTION_TERMINAL_RETENTION_MS } from '../gated-action-store.js';
import { preapprovalHash } from '../preapproval-invocations.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { recordStep, resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';
import { compoundPlan, memberPath, ownerResponder, preparedMember, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

afterEach(async () => { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); });
type Fixture = Awaited<ReturnType<typeof resourceFixture>>;
type Summary = { schema_version: number; inspection: PreapprovalInspection; creation_receipt?: unknown };
const metadata = ({ revision, status, coverage, eligible_members, uncovered_calls }: PreapprovalResult) =>
  ({ revision, status, coverage, eligible_members, uncovered_calls });
const authority = (db: Database.Database) => ({
  proposals: db.prepare('SELECT * FROM preapproval_proposals ORDER BY proposal_id').all(),
  executions: db.prepare('SELECT * FROM preapproval_executions ORDER BY future_ref').all(),
  grants: db.prepare('SELECT * FROM preapproval_grants ORDER BY grant_id').all(),
  decisions: db.prepare('SELECT * FROM preapproval_decisions ORDER BY decision_id').all(),
  mutations: db.prepare('SELECT * FROM preapproval_mutations ORDER BY request_id').all(),
  members: db.prepare('SELECT * FROM preapproval_members ORDER BY grant_id, member_id').all(),
  outbox: db.prepare('SELECT * FROM preapproval_outbox ORDER BY event_id').all(),
});
const noEffects = (f: Fixture) => {
  expect(f.db.prepare('SELECT count(*) AS n FROM gated_action_receipts').get()).toEqual({ n: 0 });
  expect(f.db.prepare('SELECT count(*) AS n FROM commits').get()).toEqual({ n: 0 });
  for (const id of ['a', 'b']) expect(f.row(id)).toMatchObject({ title: id, _record: { revision: 0 } });
};
const selectFirst = async (f: Fixture, created: PreapprovalResult) => {
  const review = await f.storage.repository.review(created.proposal_id, f.responder);
  return f.storage.repository.select({ proposal_id: created.proposal_id, expected_revision: review.revision,
    member_ids: [review.members[0]!.member_id] }, f.responder);
};
const revoke = async (f: Fixture, created: PreapprovalResult) => {
  const input = await f.decision(created.proposal_id);
  const decision = await f.storage.repository.decide(input, f.responder);
  const approved = await f.storage.repository.inspect(created.proposal_id);
  const mutation = { grant_id: approved.grant!.grant_id, expected_revision: approved.grant!.revision, request_id: randomUUID() };
  await f.storage.repository.revoke(mutation, f.responder);
  return { input, decision, mutation };
};
const eligible = async () => {
  const f = await resourceFixture(); f.save([recordStep('a'), recordStep('b')]);
  const request = f.request(), created = await f.service.prepare(request, f.origin);
  await selectFirst(f, created); const stopped = await revoke(f, created);
  await f.composed.outbox.drain(); f.clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
  return { f, request, created, ...stopped };
};
const summary = async (f: Fixture, created: PreapprovalResult): Promise<Summary> => {
  const row = f.db.prepare('SELECT summary_ciphertext FROM preapproval_retired_reviews WHERE future_ref=?')
    .get(created.future_execution_ref) as { summary_ciphertext: string };
  return await createPreapprovalCodec(() => new Uint8Array(32).fill(5)).open(row.summary_ciphertext) as Summary;
};
const replaceSummary = async (f: Fixture, created: PreapprovalResult, change: (value: Summary) => void) => {
  const value = await summary(f, created); change(value);
  expect(f.db.inTransaction).toBe(false);
  const ciphertext = await createPreapprovalCodec(() => new Uint8Array(32).fill(5)).seal(value);
  f.db.prepare('UPDATE preapproval_retired_reviews SET summary_ciphertext=?,summary_hash=? WHERE future_ref=?')
    .run(ciphertext, preapprovalHash(value), created.future_execution_ref);
};

it('keeps the complete creation receipt stable through selection, revocation, retirement and native reopen', async () => {
  let f = await resourceFixture(); f.save([recordStep('a'), recordStep('b')]);
  const request = f.request(), created = await f.service.prepare(request, f.origin);
  expect(metadata(created)).toEqual({ revision: 1, status: 'awaiting_owner', coverage: 'complete', eligible_members: 2, uncovered_calls: 0 });
  const check = async () => {
    const before = authority(f.db);
    expect.soft(await f.service.prepare(request, f.origin)).toEqual(created);
    expect(authority(f.db)).toEqual(before);
  };
  await selectFirst(f, created);
  expect(await f.storage.repository.inspect(created.proposal_id))
    .toMatchObject({ revision: 2, coverage: 'partial', eligible_members: 1, uncovered_calls: 1 });
  await check();
  const stopped = await revoke(f, created); await check();
  await f.composed.outbox.drain(); f.clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
  expect(await f.storage.repository.retireReviewContent()).toBe(1);
  expect((await summary(f, created)).creation_receipt).toEqual({ schema_version: 1, result: created });
  await check(); f = await f.reopen(); await check();
  const history = await f.storage.repository.inspect(created.proposal_id);
  expect(history).toMatchObject({ revision: 2, execution_status: 'cancelled', grant: { status: 'revoked' },
    decision: { decision_id: stopped.decision.decision_id }, eligible_members: 1, uncovered_calls: 1 });
  expect(history.reviewed).toBeUndefined(); expect(history.retired_review).toBeDefined();
  expect((await f.storage.repository.decide(stopped.input, f.responder)).decision_id).toBe(stopped.decision.decision_id);
  expect((await f.storage.repository.revoke(stopped.mutation, f.responder)).grant?.status).toBe('revoked');
  await expect(f.service.prepare({ ...request, dispatch_deadline: request.dispatch_deadline + 1 }, f.origin))
    .rejects.toMatchObject({ code: 'preapproval_idempotency_conflict' });
  noEffects(f);
});

it('preserves distinct original scopes whose retained owner counts are identical', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-creation-scopes-'));
  resourceFixtureDisposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [];
  for (const count of [1, 3]) {
    const path = join(dir, count + '.sqlite'); let db = new Database(path);
    const clock = { now: 1000, locked: false };
    try {
      const first = repositoryFixture(db, clock);
      const members = [...compoundPlan().members, preparedMember({ invocation_path: memberPath('other') })];
      // A required child that cannot be approved excludes its parent as well.
      if (count === 1) { members[1]!.review.eligible = false; members[1]!.review.reason = 'Not eligible in this fixture.'; }
      const plan = preparedPlan(members), created = await first.repository.prepare(plan, false);
      expect(created.eligible_members).toBe(count);
      await first.repository.select({ proposal_id: created.proposal_id, expected_revision: 1, member_ids: [members[2]!.member_id] }, ownerResponder);
      expect(await first.repository.prepare(plan, false)).toEqual(created);
      clock.now = 10_000; expect(first.repository.expire()).toBe(1);
      for (const event of first.repository.takeOutbox('receipt')) first.repository.finishOutbox(event.event_id, 'receipt');
      clock.now += GATED_ACTION_TERMINAL_RETENTION_MS + 1;
      expect(await first.repository.retireReviewContent()).toBe(1);
      db.close(); db = new Database(path);
      const reopened = repositoryFixture(db, clock).repository;
      const replay = await reopened.prepare(plan, false);
      expect(replay).toEqual(created);
      const history = await reopened.inspect(created.proposal_id);
      expect(history.reviewed).toBeUndefined(); expect(history.members).toHaveLength(1);
      cases.push({ receipt: metadata(replay), owner: metadata(history) });
    } finally { if (db.open) db.close(); }
  }
  expect(cases[0]!.receipt).not.toEqual(cases[1]!.receipt);
  expect(cases[0]!.owner).toEqual(cases[1]!.owner);
});

it('returns explicit legacy unavailability with stable IDs while retaining owner history and revocation provenance', async () => {
  const c = await eligible(); expect(await c.f.storage.repository.retireReviewContent()).toBe(1);
  const history = await c.f.storage.repository.inspect(c.created.proposal_id);
  // Re-encrypt the original envelope shape to model a genuine legacy receipt.
  await replaceSummary(c.f, c.created, value => { delete value.creation_receipt; });
  c.f = await c.f.reopen(); const before = authority(c.f.db);
  const error: unknown = await c.f.service.prepare(c.request, c.f.origin).then(() => null, error => error);
  expect(error).toBeInstanceOf(RpcError);
  expect(error).toMatchObject({ code: 'preapproval_expired', details: { reason: 'creation_receipt_metadata_unavailable',
    proposal_id: c.created.proposal_id, future_execution_ref: c.created.future_execution_ref } });
  expect((error as RpcError).details).toEqual({ reason: 'creation_receipt_metadata_unavailable',
    proposal_id: c.created.proposal_id, future_execution_ref: c.created.future_execution_ref });
  expect(await c.f.storage.repository.inspect(c.created.proposal_id)).toEqual(history);
  expect((await c.f.storage.repository.list('', 10)).proposals).toEqual([history]);
  expect((await c.f.storage.repository.decide(c.input, c.f.responder)).decision_id).toBe(c.decision.decision_id);
  expect((await c.f.storage.repository.revoke(c.mutation, c.f.responder)).grant?.status).toBe('revoked');
  await expect(c.f.service.prepare({ ...c.request, dispatch_deadline: c.request.dispatch_deadline + 1 }, c.f.origin))
    .rejects.toMatchObject({ code: 'preapproval_idempotency_conflict' });
  expect(authority(c.f.db)).toEqual(before); noEffects(c.f);
});

it.each(['version', 'identity', 'counts', 'extra field'] as const)('rejects invalid creation receipt %s without disturbing owner history', async fault => {
  const c = await eligible(); expect(await c.f.storage.repository.retireReviewContent()).toBe(1);
  const history = await c.f.storage.repository.inspect(c.created.proposal_id);
  await replaceSummary(c.f, c.created, value => {
    value.creation_receipt = { schema_version: fault === 'version' ? 2 : 1,
      result: { ...c.created, ...(fault === 'identity' ? { proposal_id: 'pap_' + randomUUID() } : {}),
        ...(fault === 'counts' ? { eligible_members: 1.5 } : {}), ...(fault === 'extra field' ? { decision: 'approve' } : {}) } };
  });
  const before = authority(c.f.db);
  await expect(c.f.service.prepare(c.request, c.f.origin)).rejects.toMatchObject({ code: 'preapproval_stale' });
  expect(await c.f.storage.repository.inspect(c.created.proposal_id)).toEqual(history);
  expect(authority(c.f.db)).toEqual(before); noEffects(c.f);
});

it('rolls back creation receipt persistence and private-content removal together across reopen, then permits a safe retry', async () => {
  const c = await eligible(); const before = authority(c.f.db);
  c.f.db.exec("CREATE TRIGGER fail_creation_retention BEFORE UPDATE OF snapshot_ciphertext ON preapproval_executions BEGIN SELECT RAISE(ABORT, 'creation retention fault'); END");
  await expect(c.f.storage.repository.retireReviewContent()).rejects.toThrow('creation retention fault');
  expect(c.f.db.prepare('SELECT count(*) AS n FROM preapproval_retired_reviews').get()).toEqual({ n: 0 });
  expect(authority(c.f.db)).toEqual(before);
  c.f = await c.f.reopen();
  expect(c.f.db.prepare('SELECT count(*) AS n FROM preapproval_retired_reviews').get()).toEqual({ n: 0 });
  expect((await c.f.storage.repository.loadExecution(c.created.future_execution_ref)).members).toHaveLength(2);
  expect(await c.f.service.prepare(c.request, c.f.origin)).toEqual(c.created);
  expect(authority(c.f.db)).toEqual(before);
  c.f.db.exec('DROP TRIGGER fail_creation_retention');
  expect(await c.f.storage.repository.retireReviewContent()).toBe(1);
  expect((await summary(c.f, c.created)).creation_receipt).toEqual({ schema_version: 1, result: c.created });
  expect(await c.f.service.prepare(c.request, c.f.origin)).toEqual(c.created);
  expect((await c.f.storage.repository.inspect(c.created.proposal_id)).grant?.status).toBe('revoked');
  noEffects(c.f);
});
