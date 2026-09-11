import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { PREAPPROVAL_LIMITS } from '@recued/contracts';
import { createPreapprovalLimits, preapprovalLimitsFromEnvironment } from '../preapproval-limits.js';
import { memberPath, preparedMember, preparedPlan, repositoryFixture } from './d-261-fixtures.js';

it('shares owner request limits across actual connections and reopen, with replay outside the quota', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'd261-limits-'));
  const path = join(directory, 'realm.sqlite');
  const db = new Database(path), other = new Database(path);
  try {
    createPreapprovalLimits(db, preapprovalLimitsFromEnvironment({ RECUED_PREAPPROVAL_PENDING_PER_REALM: '1' }));
    const clock = { now: 1000, locked: false };
    const first = repositoryFixture(db, clock), second = repositoryFixture(other, clock);
    expect(second.repository.limits().pending_per_realm).toBe(1);
    const plan = preparedPlan(); const created = await first.repository.prepare(plan, true);
    await expect(second.repository.prepare(preparedPlan(), true)).rejects.toMatchObject({ code: 'preapproval_limit_exceeded' });
    expect(await second.repository.prepare(plan, true)).toEqual(created);
    expect(db.prepare('SELECT count(*) AS count FROM preapproval_proposals').get()).toEqual({ count: 1 });
    other.close();
    const reopened = new Database(path);
    try { expect(createPreapprovalLimits(reopened)().pending_per_realm).toBe(1); } finally { reopened.close(); }
  } finally { if (other.open) other.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('refuses excess member/byte plans before proposal, notification or activation writes', async () => {
  const db = new Database(':memory:');
  try {
    const fixture = repositoryFixture(db, { now: 1000, locked: false });
    for (const limits of [{ candidate_calls: 1 }, { candidate_calls: 100, plan_bytes: 1 }]) {
      createPreapprovalLimits(db, limits);
      const plan = preparedPlan(['first', 'second'].map(step => preparedMember({ invocation_path: memberPath(step) })));
      await expect(fixture.repository.prepare(plan, true)).rejects.toMatchObject({ code: 'preapproval_limit_exceeded' });
    }
    expect(db.prepare('SELECT count(*) AS count FROM preapproval_proposals').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM preapproval_outbox').get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

it('accepts only named positive integer owner settings within the protocol ceilings', () => {
  expect(preapprovalLimitsFromEnvironment({ UNRELATED: 'opaque' })).toEqual({});
  for (const value of ['0', '-1', '1.5', '1e2', ' 10 ', String(PREAPPROVAL_LIMITS.candidate_calls + 1)]) {
    expect(() => preapprovalLimitsFromEnvironment({ RECUED_PREAPPROVAL_CANDIDATE_CALLS: value })).toThrow('RECUED_PREAPPROVAL_CANDIDATE_CALLS');
  }
});
