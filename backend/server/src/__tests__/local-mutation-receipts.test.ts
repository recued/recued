import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMutationReceipts, type LocalMutationReceiptBinding } from '../storage/local-mutation-receipts.js';
import { recordLocalMutation, withLocalMutationScope } from '../local-mutation-context.js';
import type { ResourceReview } from '@recued/contracts';
const resourceReviewFixture: ResourceReview = { schema_version: 1, operation: 'example.update', input_hash: 'a'.repeat(64), captured_at: 1,
  resources: [{ kind: 'records', key: 'row', label: 'Row', binding: 'binding', version: 'v1',
    precondition: { kind: 'records_revision', value: 0, incarnation: 'original' }, before: { title: 'a' }, after: { title: 'b' } }] };

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE effects(id TEXT PRIMARY KEY,value TEXT)');
  const clock = { now: 100 };
  return { db, clock, receipts: createLocalMutationReceipts(db, () => clock.now) };
};
const binding: LocalMutationReceiptBinding = { owner: 'test', owner_ref: 'action', attempt_id: 'attempt',
  operation: 'example.update', kind: 'records', identity_hash: 'sha256:' + 'a'.repeat(64), review_hash: 'sha256:' + 'b'.repeat(64) };

describe('shared local mutation receipts', () => {
  it('commits the effect and its receipt together, with no private content in the receipt', () => {
    const f = fixture();
    expect(() => f.receipts.record(binding)).toThrow(/transaction/);
    const receipt = f.db.transaction(() => {
      f.db.prepare('INSERT INTO effects VALUES(?,?)').run('row', 'private value');
      return f.receipts.record(binding);
    }).immediate();
    expect(f.receipts.find(binding)).toEqual(receipt);
    expect(f.db.prepare('SELECT data FROM local_mutation_receipts').pluck().get()).not.toContain('private value');
    f.clock.now = 10; // Clock corrections do not erase a committed fact.
    expect(f.receipts.find(binding)).toEqual(receipt);
  });

  it('discards extra payload fields from structurally compatible host objects', () => {
    const f = fixture();
    const hostObject = { ...binding, args: { title: 'private content' }, result: { body: 'private result' } };
    f.db.transaction(() => f.receipts.record(hostObject)).immediate();
    const data = f.db.prepare('SELECT data FROM local_mutation_receipts').pluck().get() as string;
    expect(data).not.toMatch(/private content|private result|"args"|"result"/);
    expect(f.receipts.find(binding)).not.toBeNull();
  });

  it('rolls back both rows on a later failure and refuses replaying the same attempt', () => {
    const f = fixture();
    expect(() => f.db.transaction(() => {
      f.db.exec("INSERT INTO effects VALUES('row','first')"); f.receipts.record(binding); throw new Error('rollback');
    }).immediate()).toThrow('rollback');
    expect(f.receipts.find(binding)).toBeNull(); expect(f.db.prepare('SELECT count(*) FROM effects').pluck().get()).toBe(0);
    f.db.transaction(() => f.receipts.record(binding)).immediate();
    expect(() => f.db.transaction(() => {
      f.db.exec("INSERT INTO effects VALUES('row','repeat')"); f.receipts.record(binding);
    }).immediate()).toThrow(/already has a receipt/);
    expect(f.db.prepare('SELECT count(*) FROM effects').pluck().get()).toBe(0);
  });

  it.each(['owner', 'owner_ref', 'attempt_id', 'operation', 'identity_hash', 'review_hash', 'kind'] as const)
    ('never lends a receipt to a different %s', field => {
      const f = fixture(); f.db.transaction(() => f.receipts.record(binding)).immediate();
      expect(f.receipts.find({ ...binding, [field]: field === 'kind' ? 'local_calendar' : 'different' })).toBeNull();
    });

  it('refuses corrupt evidence instead of inferring success from a matching row', () => {
    const f = fixture(); const receipt = f.db.transaction(() => f.receipts.record(binding)).immediate();
    f.db.prepare('UPDATE local_mutation_receipts SET data=?').run(JSON.stringify({ ...receipt, committed_at: 1 }));
    expect(f.receipts.find(binding)).toBeNull();
    f.db.prepare('UPDATE local_mutation_receipts SET data=?').run('{invalid');
    expect(f.receipts.find(binding)).toBeNull();
  });

  it('does not install evidence through ordinary writes or lend a scope to its callback', () => {
    const f = fixture(); let calls = 0;
    recordLocalMutation(f.db, 'records', resourceReviewFixture);
    withLocalMutationScope({ record(db, kind, review) {
      calls++; recordLocalMutation(db, kind, review); f.receipts.record(binding);
    } }, () => f.db.transaction(() => recordLocalMutation(f.db, 'records', resourceReviewFixture)).immediate());
    expect(calls).toBe(1); expect(f.receipts.find(binding)).not.toBeNull();
  });

  it('rolls back an asynchronous participant instead of committing before it finishes', () => {
    const f = fixture();
    expect(() => withLocalMutationScope({ async record() { f.receipts.record(binding); } },
      () => f.db.transaction(() => {
        f.db.exec("INSERT INTO effects VALUES('row','private')");
        recordLocalMutation(f.db, 'records', resourceReviewFixture);
      }).immediate())).toThrow(/synchronously/);
    expect(f.receipts.find(binding)).toBeNull(); expect(f.db.prepare('SELECT count(*) FROM effects').pluck().get()).toBe(0);
  });
});
