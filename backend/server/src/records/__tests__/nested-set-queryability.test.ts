/** ⛔⛔ CAN core.records QUERY A NESTED SET? YES — the READ was never the wall.
 *
 *  This file exists because I said otherwise. Porting `accpal-web` I replaced
 *  its nested-set tag tree with a materialised path and framed that as "the one
 *  structure we cannot hold", which reads as though a tree cannot be queried
 *  here. It can. Only the MAINTENANCE is blocked.
 *
 *  The confusion is that nested-set containment has two equivalent forms and
 *  the FAMILIAR one is the blocked one:
 *
 *    node.lft BETWEEN parent.lft AND parent.rgt     ⛔ two predicates on `lft`
 *    node.lft >= parent.lft AND node.rgt <= parent.rgt   ✅ one on each of two
 *
 *  `filterList` reads `Object.entries(filters)`, so a field carries exactly one
 *  predicate — and the BETWEEN form needs two on `lft`. The interval-containment
 *  form asks the same question across two fields and goes straight through, for
 *  `search` and for `aggregate` alike. A subtree rollup at any depth is one
 *  query, no recursion.
 *
 *  ⚠ The two forms are equivalent only while the intervals are WELL-FORMED
 *  (properly nested, never partially overlapping). Nothing in Records enforces
 *  that — it is the writer's invariant, and it is exactly the invariant a bulk
 *  renumber maintains.
 *
 *  ⛔ WHAT IS ACTUALLY BLOCKED IS THE WRITE. Inserting a node runs
 *  `UPDATE ... SET rgt = rgt + 2 WHERE rgt >= n` over every row to its right.
 *  `RECORDS_ACTIONS` has no bulk update by filter — only `update` by id with its
 *  own CAS — so a insert is O(n) individual writes, each of which can lose a
 *  race. THAT is why `ledger-book` uses a materialised path: not because the
 *  tree could not be read, but because it could not be maintained. */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { RecordsExecutionBinding, RecordsPackRef, RecordsSchemaSnapshot } from '@recued/contracts';
import { createRecordsStore } from '../store.js';

const O: RecordsPackRef = { publisher: 'p', pack_slug: 'nested' };
const SH = 'a'.repeat(64), DH = 'b'.repeat(64);
const b = (action: string, extra: Partial<RecordsExecutionBinding> = {}, tag = ''): RecordsExecutionBinding => ({
  kind: 'core.records', action: action as never, entity: 'tag', owner: O, pack_version: 1,
  storage_schema_hash: SH, declaration_hash: DH, operation_digest: `d:${action}${tag}`, ...extra,
});
const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: { tag: { kind: 'tag', fields: [
    { key: 'id', slot: 'pk', kind: 'id', required: true },
    { key: 'name', slot: 's1', kind: 'string', required: true },
    { key: 'lft', slot: 'n1', kind: 'number', required: true },
    { key: 'rgt', slot: 'n2', kind: 'number', required: true },
    { key: 'amount', slot: 'dec1', kind: 'decimal', required: false },
  ] } },
};
const B = {
  create: b('create'),
  search: b('search', { filter_fields: ['lft', 'rgt'] }, ':s'),
  roll: b('aggregate', { filter_fields: ['lft', 'rgt'],
    select: { total: { fn: 'sum', field: 'amount' }, n: { fn: 'count' } } }, ':a'),
};

describe('a nested set, queried through the exposed predicates', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
  store.installNamespace({ owner: O, version: 1, storage_schema_hash: SH, declaration_hash: DH,
    artifact_digest: 'x', schema, bindings: B });
  //            root(1,12)
  //      food(2,7)          travel(8,11)
  //  grocery(3,4) snack(5,6)   taxi(9,10)
  const rows: [string, number, number, string][] = [
    ['root', 1, 12, '0'], ['food', 2, 7, '0'], ['grocery', 3, 4, '10.50'],
    ['snack', 5, 6, '4.25'], ['travel', 8, 11, '0'], ['taxi', 9, 10, '7.30'],
  ];
  for (const [name, lft, rgt, amount] of rows) {
    store.execute({ binding: B.create, principal: 'owner',
      args: { id: name, values: { name, lft, rgt, amount } } });
  }

  it('⛔ the BETWEEN form is blocked, and blocked SILENTLY', () => {
    // Not a refusal — an object literal cannot hold `lft` twice, so the second
    // predicate REPLACES the first and the query runs as a half-open range.
    // `root` (lft 1) comes back as a descendant of `food` (lft 2..7). No error,
    // a plausible-looking answer, and a subtree total inflated by its ancestors.
    const filters: Record<string, unknown> = { lft: { op: 'gte', value: 2 } };
    filters.lft = { op: 'lte', value: 7 };
    const out = store.execute({ binding: B.search, principal: 'owner', args: { filters } }) as
      unknown as { records: { name: string }[] };
    expect(out.records.map(r => r.name)).toContain('root');
  });

  it('✅ the INTERVAL-CONTAINMENT form works — one predicate on each of TWO fields', () => {
    const under = (lft: number, rgt: number) =>
      (store.execute({ binding: B.search, principal: 'owner',
        args: { filters: { lft: { op: 'gte', value: lft }, rgt: { op: 'lte', value: rgt } } } }) as
        unknown as { records: { name: string }[] }).records.map(r => r.name).sort();
    expect(under(2, 7)).toEqual(['food', 'grocery', 'snack']);
    expect(under(1, 12)).toEqual(['food', 'grocery', 'root', 'snack', 'taxi', 'travel']);
    expect(under(8, 11)).toEqual(['taxi', 'travel']);
    expect(under(3, 4)).toEqual(['grocery']);
  });

  it('✅ and it aggregates — a subtree rollup in ONE query', () => {
    const roll = (lft: number, rgt: number) =>
      (store.execute({ binding: B.roll, principal: 'owner',
        args: { filters: { lft: { op: 'gte', value: lft }, rgt: { op: 'lte', value: rgt } } } }) as
        unknown as { aggregate: Record<string, unknown> }).aggregate;
    expect(roll(2, 7)).toMatchObject({ total: '14.7500', n: 3 });
    expect(roll(1, 12)).toMatchObject({ total: '22.0500', n: 6 });
  });
});
