import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PREAPPROVAL_LIMITS } from '@recued/contracts';
import { canonicalJSONStringifyStrict, sha256Hex } from '@recued/crypto';
import { preparedMember, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });
const legacyHash = (value: unknown) => 'sha256:' + sha256Hex(canonicalJSONStringifyStrict(value));
const fixture = async (path = ':memory:', plan = preparedPlan()) => {
  const db = new Database(path);
  disposers.push(() => { if (db.open) db.close(); });
  const state = { now: 1000, locked: false };
  const f = repositoryFixture(db, state);
  const created = await f.repository.prepare(plan, false);
  return { db, plan, created, ...f };
};
const execution = (db: Database.Database) => db.prepare('SELECT * FROM preapproval_executions').all();

it('loads persisted snapshots with the existing canonical digest across reopen and preserves their data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'preapproval-snapshot-validation-'));
  disposers.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'realm.sqlite');
  const plan = preparedPlan([preparedMember({ input: { to: ['alex@example.com'],
    body: 'Private \u0000 café e\u0301 文 🧭 \ud800', extra: { decimal: 1.25, nil: null, list: [true, false, '𐀀'] } } })]);
  const f = await fixture(path, plan);
  const expectedHash = legacyHash(plan);
  expect((execution(f.db)[0] as { snapshot_hash: string }).snapshot_hash).toBe(expectedHash);
  const before = execution(f.db);
  f.db.close();
  const reopened = new Database(path); disposers.push(() => reopened.close());
  const repository = repositoryFixture(reopened, f.state).repository;
  expect(canonicalJSONStringifyStrict(await repository.loadExecution(f.created.future_execution_ref)))
    .toBe(canonicalJSONStringifyStrict(plan));
  expect(execution(reopened)).toEqual(before);
});

it('rejects a correctly hashed oversized persisted snapshot without changing its execution', async () => {
  const f = await fixture();
  const oversized = { ...f.plan, members: [preparedMember({ member_id: f.plan.members[0]!.member_id,
    input: { to: ['alex@example.com'], body: 'x'.repeat(PREAPPROVAL_LIMITS.plan_bytes) } })] };
  f.db.prepare('UPDATE preapproval_executions SET snapshot_ciphertext=?,snapshot_hash=? WHERE future_ref=?')
    .run(await f.codec.seal(oversized), legacyHash(oversized), f.created.future_execution_ref);
  const before = execution(f.db);
  await expect(f.repository.loadExecution(f.created.future_execution_ref))
    .rejects.toMatchObject({ code: 'preapproval_limit_exceeded', status: 400 });
  expect(execution(f.db)).toEqual(before);
});

it('keeps snapshot-identity refusal ahead of graph validation and still validates a matching snapshot', async () => {
  const f = await fixture();
  const invalid = { ...f.plan, schema_version: 0 };
  f.db.prepare('UPDATE preapproval_executions SET snapshot_ciphertext=?,snapshot_hash=? WHERE future_ref=?')
    .run(await f.codec.seal(invalid), 'sha256:' + '0'.repeat(64), f.created.future_execution_ref);
  await expect(f.repository.loadExecution(f.created.future_execution_ref))
    .rejects.toMatchObject({ code: 'preapproval_stale', status: 409 });
  f.db.prepare('UPDATE preapproval_executions SET snapshot_hash=? WHERE future_ref=?')
    .run(legacyHash(invalid), f.created.future_execution_ref);
  const before = execution(f.db);
  await expect(f.repository.loadExecution(f.created.future_execution_ref))
    .rejects.toMatchObject({ code: 'preapproval_unresolved', status: 400 });
  expect(execution(f.db)).toEqual(before);
});
