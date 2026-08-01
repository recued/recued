/** D-226 — `core.records.batch`: N declared writes, ONE transaction, all or none.
 *
 *  ⛔⛔ THE ONLY PROPERTY THAT MATTERS IS ALL-OR-NONE. Everything else here is
 *  scaffolding around it. A batch that half-applies is worse than no batch,
 *  because the caller now believes a multi-row invariant was enforced when it
 *  was not — a half-posted double entry is an unbalanced ledger that looks
 *  posted, and a half-run tree rewrite is a tree that answers wrongly forever.
 *
 *  ⛔ The second property is that a batch is NOT A SECOND WRITE PATH. It
 *  re-enters `execute`, so every rule a single write obeys holds inside one by
 *  construction rather than by being re-implemented. The cases below prove that
 *  where it is cheapest to get wrong: CAS staleness, unknown fields, and the
 *  natural-key upsert refusal. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORDS_BATCH_ACTIONS,
  RECORDS_MAX_BATCH_OPS,
  validateRecordsBatchAllow,
  type RecordsExecutionBinding, type RecordsPackRef, type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'ledger' };
const SH = 'a'.repeat(64), DH = 'b'.repeat(64);

const bind = (
  action: string, entity: string, extra: Partial<RecordsExecutionBinding> = {}, tag = '',
): RecordsExecutionBinding => ({
  kind: 'core.records', action: action as never, entity, owner: OWNER, pack_version: 1,
  storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:${action}:${entity}${tag}`, ...extra,
});

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    batch: { kind: 'batch', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'ref', slot: 's1', kind: 'string', required: true },
      { key: 'net', slot: 'dec1', kind: 'decimal', required: false },
    ] },
    leg: { kind: 'leg', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'batch_ref', slot: 'r1', kind: 'ref', required: true },
      { key: 'amount', slot: 'dec1', kind: 'decimal', required: true },
      { key: 'memo', slot: 's1', kind: 'string', required: false },
    ] },
  },
};

const ALLOW = [
  { entity: 'batch', action: 'create' as const },
  { entity: 'leg', action: 'create' as const },
  { entity: 'leg', action: 'update' as const },
];

const B = {
  post: bind('batch', 'batch', { allow: ALLOW }),
  postWithDelete: bind('batch', 'batch',
    { allow: [...ALLOW, { entity: 'leg', action: 'delete' as const }] }, ':del'),
  noAllow: bind('batch', 'batch', {}, ':noallow'),
  createBatch: bind('create', 'batch', {}, ':cb'),
  createLeg: bind('create', 'leg', {}, ':cl'),
  searchLeg: bind('search', 'leg', { filter_fields: ['batch_ref'] }, ':sl'),
  getLeg: bind('get', 'leg', {}, ':gl'),
};

const leg = (id: string, amount: string) =>
  ({ entity: 'leg', action: 'create', args: { id, values: {
    batch_ref: 'batch/b1', amount, memo: `leg ${id}` } } });

describe('core.records.batch', () => {
  let db: Database.Database;
  let store: RecordsStore;

  const run = (b: RecordsExecutionBinding, args: Record<string, unknown>) =>
    store.execute({ binding: b, principal: 'owner', args }) as unknown;
  const post = (ops: unknown[]) => run(B.post, { ops });
  const legs = () => (run(B.searchLeg, { filters: { batch_ref: 'batch/b1' }, limit: 100 }) as
    { records: { id: string; amount: string }[] }).records;
  const batchRows = () =>
    db.prepare('SELECT count(*) AS n FROM core_records').get() as { n: number };
  const outbox = () =>
    (db.prepare('SELECT count(*) AS n FROM core_record_outbox').get() as { n: number }).n;

  const OPENING = [
    { entity: 'batch', action: 'create', args: { id: 'b1', values: { ref: 'B-1', net: '0' } } },
    leg('l1', '-42.50'), leg('l2', '42.50'),
  ];

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema, bindings: B,
    });
  });
  afterEach(() => db.close());

  describe('⛔⛔ all or none', () => {
    it('a whole entry lands in one call', () => {
      const out = post(OPENING) as { batch: true; count: number; results: unknown[] };
      expect(out.batch).toBe(true);
      expect(out.count).toBe(3);
      expect(legs().map(l => l.amount).sort()).toEqual(['-42.5000', '42.5000']);
    });

    it('⛔⛔ one bad op and NOTHING is written — not the two before it', () => {
      // The property. `l2` reuses `l1`'s id, so the third op fails on the
      // primary key AFTER the batch row and the first leg have been inserted.
      const before = batchRows().n;
      expect(() => post([OPENING[0]!, leg('l1', '-42.50'), leg('l1', '42.50')]))
        .toThrow();
      expect(batchRows().n, 'a half-applied batch is the whole failure mode').toBe(before);
      expect(legs()).toEqual([]);
    });

    it('⛔ the CHANGE EVENTS roll back too', () => {
      // They are ordinary rows in the same transaction, so a rolled-back batch
      // also un-emits. Without this a subscriber would act on a write that
      // never happened, which is worse than the write being lost.
      const before = outbox();
      expect(() => post([OPENING[0]!, leg('l1', '-42.50'), leg('l1', '42.50')])).toThrow();
      expect(outbox()).toBe(before);
      post(OPENING);
      expect(outbox()).toBeGreaterThan(before);
    });

    it('⚠ a FAILING op late in a long batch still undoes everything', () => {
      const ops = [OPENING[0]!, ...Array.from({ length: 30 }, (_, i) => leg(`x${i}`, '1.00'))];
      post(ops);
      expect(legs()).toHaveLength(30);
      // ⚠ The duplicate must carry a DIFFERENT value. `create` is replay-safe —
      // an identical row on an existing id returns `replayed` rather than
      // conflicting — so `leg('y0','1.00')` twice is a legitimate no-op, not the
      // failure this case needs. My first draft used it and the batch correctly
      // did not throw, which read as a broken rollback and was not.
      expect(() => post([...Array.from({ length: 30 }, (_, i) => leg(`y${i}`, '1.00')),
                         leg('y0', '9.99')])).toThrow();
      expect(legs(), 'the 30 new legs must be gone, the 30 old ones kept').toHaveLength(30);
    });
  });

  it('⛔ a re-sent batch is a NO-OP, not a duplicate', () => {
    // `create` is replay-safe per row, and a batch inherits it — which is what
    // makes a retry after a lost response safe. Worth pinning at this layer
    // because a batch is exactly what a caller retries.
    post(OPENING);
    const first = legs().length;
    post(OPENING);
    expect(legs()).toHaveLength(first);
  });

  describe('⛔ the allow-list is declared; the rows are not', () => {
    it('refuses a pair the bind never declared', () => {
      expect(() => post([{ entity: 'leg', action: 'delete',
                           args: { id: 'l1', expected_version: 1, expected_revision: 1 } }]))
        .toThrow(/not in this batch's allow list/);
    });

    it('⛔ refuses BEFORE anything runs, not part-way through', () => {
      // Admission is checked for every op up front. Rolling back would be
      // correct too, but a refusal that never started cannot be observed
      // half-done and does not enqueue-then-discard a pile of events.
      const before = outbox();
      expect(() => post([...OPENING, { entity: 'leg', action: 'delete',
        args: { id: 'l1', expected_version: 1, expected_revision: 1 } }]))
        .toThrow(/not in this batch's allow list/);
      expect(batchRows().n).toBe(0);
      expect(outbox()).toBe(before);
    });

    it('⛔ the guard PERMITS what it declares — including a delete when declared', () => {
      // The half that separates an allow-list from a blanket refusal.
      run(B.postWithDelete, { ops: OPENING });
      const one = legs()[0]!;
      const row = (run(B.getLeg, { id: one.id }) as
        { record: { _record: { revision: number } } }).record;
      run(B.postWithDelete, { ops: [{ entity: 'leg', action: 'delete', args: {
        id: one.id, expected_version: 1, expected_revision: row._record.revision } }] });
      expect(legs()).toHaveLength(1);
    });

    it('refuses an unknown key on an op, and a non-object op', () => {
      expect(() => post([{ entity: 'leg', action: 'create', args: {}, extra: 1 }]))
        .toThrow(/unknown key 'extra'/);
      expect(() => post(['nope'])).toThrow(/must be an object/);
    });

    it('refuses an empty batch and one past the cap', () => {
      expect(() => post([])).toThrow(/non-empty/);
      expect(() => post(Array.from({ length: RECORDS_MAX_BATCH_OPS + 1 }, (_, i) => leg(`z${i}`, '1'))))
        .toThrow(new RegExp(`at most ${RECORDS_MAX_BATCH_OPS}`));
    });
  });

  describe('⛔ not a second write path — it re-enters `execute`', () => {
    it('CAS staleness still refuses inside a batch', () => {
      post(OPENING);
      const one = legs()[0]!;
      expect(() => post([{ entity: 'leg', action: 'update', args: {
        id: one.id, expected_version: 1, expected_revision: 99, set: { memo: 'x' } } }]))
        .toThrow(/stale/);
    });

    it('an unknown field still refuses inside a batch', () => {
      expect(() => post([OPENING[0]!,
        { entity: 'leg', action: 'create', args: { id: 'l9', values: {
          batch_ref: 'batch/b1', amount: '1.00', nonsense: 'x' } } }]))
        .toThrow(/unknown/);
      expect(batchRows().n).toBe(0);
    });

    it('⛔ a ref that points at nothing still refuses — inside a batch too', () => {
      // The within-pack existence check. If a batch could bypass it, an author
      // could seat a dangling ref simply by wrapping the write.
      expect(() => post([leg('l1', '1.00')])).toThrow();
    });

    it('a decimal still has to be a fixed-point string', () => {
      expect(() => post([OPENING[0]!,
        { entity: 'leg', action: 'create',
          args: { id: 'l9', values: { batch_ref: 'batch/b1', amount: 1.5 } } }]))
        .toThrow();
    });
  });

  describe("⛔⛔ the batch's inner binding is admitted NARROWLY, not waved through", () => {
    /** A batch re-enters `execute` with the entity and action swapped, and that
     *  binding was never installed — so `requireState` admits one specific
     *  divergence from an exact match. These are the cases that keep it
     *  specific. A survived mutant found them missing: widening the check to
     *  "any binding whose digest matches a batch" passed every test in this
     *  file, because nothing here ever constructed one that should be refused. */
    const smuggle = (over: Partial<RecordsExecutionBinding>) =>
      run({ ...B.post, entity: 'leg', action: 'create', ...over } as RecordsExecutionBinding,
        { id: 'x1', values: { batch_ref: 'batch/b1', amount: '1.00' } });

    it('the SHAPE it exists for is admitted — entity + action swapped, nothing else', () => {
      // Guards the probe: if this were refused too, every case below would pass
      // for the wrong reason.
      run(B.createBatch, { id: 'b1', values: { ref: 'B-1' } });
      expect(() => smuggle({})).not.toThrow();
    });

    it('⛔ a smuggled `natural_key` is refused — the rest must be byte-identical', () => {
      expect(() => smuggle({ natural_key: ['amount'] })).toThrow(/not installed/);
    });

    it('⛔ a smuggled wider `allow` is refused — a caller cannot grant itself more', () => {
      expect(() => smuggle({
        allow: [...ALLOW, { entity: 'leg', action: 'delete' as const }],
      })).toThrow(/not installed/);
    });

    it('⛔ a smuggled `filter_fields` is refused', () => {
      expect(() => smuggle({ filter_fields: ['amount'] })).toThrow(/not installed/);
    });

    it('⛔ an entity/action pair OUTSIDE the allow-list is refused at this layer too', () => {
      // Belt and braces: `batchWrite` refuses it first, but a binding reaching
      // `execute` by any other route must not be admitted either.
      expect(() => run({ ...B.post, entity: 'leg', action: 'delete' } as RecordsExecutionBinding,
        { id: 'x1', expected_version: 1, expected_revision: 0 })).toThrow(/not installed/);
    });
  });

  describe('the declared vocabulary', () => {
    it('⛔ admits WRITES only — no reads, and no nested batch', () => {
      // A read inside a write transaction is the first half of a
      // read-modify-write loop, and CAS exists so that loop cannot be written.
      expect(RECORDS_BATCH_ACTIONS).toEqual(['create', 'update', 'upsert', 'delete']);
      for (const action of ['get', 'search', 'count', 'aggregate', 'get_many', 'batch']) {
        expect(validateRecordsBatchAllow([{ entity: 'leg', action }], ['leg']),
          action).toEqual([expect.stringContaining('not a batchable action')]);
      }
    });

    it('the guard PERMITS every action it names', () => {
      for (const action of RECORDS_BATCH_ACTIONS) {
        expect(validateRecordsBatchAllow([{ entity: 'leg', action }], ['leg']), action).toEqual([]);
      }
    });

    it('refuses an unknown entity, a duplicate pair and an empty list', () => {
      expect(validateRecordsBatchAllow([{ entity: 'ghost', action: 'create' }], ['leg']))
        .toEqual([expect.stringContaining("unknown entity 'ghost'")]);
      expect(validateRecordsBatchAllow(
        [{ entity: 'leg', action: 'create' }, { entity: 'leg', action: 'create' }], ['leg']))
        .toEqual([expect.stringContaining('duplicate pair')]);
      expect(validateRecordsBatchAllow([], ['leg'])).toEqual([expect.stringContaining('non-empty')]);
    });

    it('a batch with no allow list at all is refused at CALL time too', () => {
      // Authoring refuses it; the store re-checks, because a binding can be
      // stamped by some other path and an empty allow-list would otherwise mean
      // "anything goes" rather than "nothing does".
      expect(() => run(B.noAllow, { ops: OPENING }))
        .toThrow(/declares no allow list/);
    });
  });
});
