/** A tag tree that survives CREATE, MOVE and DELETE — on r1/r2 and nothing else.
 *
 *  ⛔ NO NEW SUBSTRATE. A "closure table" is not a feature to add; it is an
 *  ordinary pack entity with two ref slots and a number — the same shape
 *  `leg_tag` already has. What follows uses only `create`, `search`, `delete`
 *  and `aggregate`, driven by a recipe's `foreach`.
 *
 *  ⛔⛔ THE ARGUMENT FOR IT IS THE MOVE, AND IT IS ABOUT WHAT THE FACTS POINT AT.
 *  A materialised path has to be denormalised onto the fact rows to make the
 *  rollup one query — so moving one tag rewrites `tag_path` on every tagged
 *  transaction beneath it, which is thousands of rows, not dozens. A closure
 *  table keeps the tag's IDENTITY stable: facts point at `tag/<id>`, that never
 *  changes, and a move touches only closure rows. The cost stops scaling with
 *  how much you have recorded and starts scaling with how big the tree is.
 *
 *  ⚠ The price is the read. `closure -> descendants -> aggregate {in: [...]}`
 *  is bounded by `RECORDS_MAX_IN_ITEMS`, so a subtree wider than that cannot be
 *  rolled up in one exact query. The last case pins that wall rather than
 *  leaving it to be discovered. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORDS_MAX_IN_ITEMS,
  type RecordsExecutionBinding, type RecordsPackRef, type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'tag-tree' };
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
    tag: { kind: 'tag', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'name', slot: 's1', kind: 'string', required: true },
    ] },
    // ⛔ THE WHOLE "CLOSURE TABLE": two refs and a depth. Both refs point at the
    // SAME entity, which is the only thing here worth checking — a ref's target
    // comes from the VALUE's `entity/id` prefix, not from the field declaration,
    // so self-referential edges need nothing special.
    closure: { kind: 'closure', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'ancestor', slot: 'r1', kind: 'ref', required: true },
      { key: 'descendant', slot: 'r2', kind: 'ref', required: true },
      { key: 'depth', slot: 'n1', kind: 'number', required: true },
    ] },
    // The facts. ⚠ They point at a TAG, never at a path — which is exactly why
    // a move never touches them.
    entry: { kind: 'entry', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'tag_ref', slot: 'r1', kind: 'ref', required: true },
      { key: 'amount', slot: 'dec1', kind: 'decimal', required: true },
    ] },
  },
};

const B = {
  tag: bind('create', 'tag'),
  closure: bind('create', 'closure'),
  entry: bind('create', 'entry'),
  closureSearch: bind('search', 'closure', { filter_fields: ['ancestor', 'descendant', 'depth'] }, ':s'),
  closureDelete: bind('delete', 'closure', {}, ':d'),
  roll: bind('aggregate', 'entry', {
    filter_fields: ['tag_ref'],
    select: { total: { fn: 'sum', field: 'amount' }, n: { fn: 'count' } },
  }, ':a'),
};

describe('a tag tree on two ref slots', () => {
  let db: Database.Database;
  let store: RecordsStore;
  let seq = 0;

  const run = (b: RecordsExecutionBinding, args: Record<string, unknown>) =>
    store.execute({ binding: b, principal: 'owner', args }) as unknown;
  const edges = (filters: Record<string, unknown>) =>
    (run(B.closureSearch, { filters, limit: 200 }) as
      { records: { id: string; ancestor: string; descendant: string; depth: number;
                   _record: { revision: number } }[] }).records;

  /** ⛔ CREATE — O(DEPTH), not O(tree). Every ancestor of the parent gains one
   *  edge to the new node, plus the node's own self-edge. The ancestor list is
   *  ONE query; the writes are a `foreach` over it. */
  const createTag = (id: string, name: string, parent?: string) => {
    run(B.tag, { id, values: { name } });
    run(B.closure, { id: `c${seq += 1}`,
      values: { ancestor: `tag/${id}`, descendant: `tag/${id}`, depth: 0 } });
    if (parent === undefined) return;
    for (const edge of edges({ descendant: `tag/${parent}` })) {
      run(B.closure, { id: `c${seq += 1}`, values: {
        ancestor: edge.ancestor, descendant: `tag/${id}`, depth: edge.depth + 1 } });
    }
  };

  const descendantsOf = (id: string) =>
    edges({ ancestor: `tag/${id}` }).map(e => e.descendant.split('/')[1]!).sort();

  /** ⛔ MOVE — the operation every other encoding fails. Detach the subtree from
   *  its old ancestors, reattach to the new ones. Pure delete + insert, so a
   *  partial run leaves the tree INCOMPLETE rather than arithmetically wrong,
   *  and re-running converges. Nothing outside `closure` is touched. */
  const moveTag = (id: string, newParent: string) => {
    const subtree = edges({ ancestor: `tag/${id}` });                 // node + below
    const subtreeIds = subtree.map(e => e.descendant);
    // every edge from an OUTSIDE ancestor into the subtree
    for (const descendant of subtreeIds) {
      for (const edge of edges({ descendant })) {
        if (subtreeIds.includes(edge.ancestor)) continue;             // internal, keep
        run(B.closureDelete, { id: edge.id, expected_version: 1,
                               expected_revision: edge._record.revision });
      }
    }
    for (const above of edges({ descendant: `tag/${newParent}` })) {
      for (const inside of subtree) {
        run(B.closure, { id: `c${seq += 1}`, values: {
          ancestor: above.ancestor, descendant: inside.descendant,
          depth: above.depth + 1 + inside.depth } });
      }
    }
  };

  /** ⛔ DELETE — every edge touching any node of the subtree. Also pure deletes. */
  const deleteSubtree = (id: string) => {
    const ids = edges({ ancestor: `tag/${id}` }).map(e => e.descendant);
    for (const one of ids) {
      for (const edge of [...edges({ descendant: one }), ...edges({ ancestor: one })]) {
        try {
          run(B.closureDelete, { id: edge.id, expected_version: 1,
                                 expected_revision: edge._record.revision });
        } catch { /* already gone via the other direction */ }
      }
    }
  };

  const spentUnder = (id: string) => {
    const refs = edges({ ancestor: `tag/${id}` }).map(e => e.descendant);
    return (run(B.roll, { filters: { tag_ref: { op: 'in', value: refs } } }) as
      { aggregate: Record<string, unknown> }).aggregate;
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    seq = 0;
    store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'tree', schema, bindings: B,
    });
    //  life
    //   ├ home ─ kitchen ─ kettle
    //   └ travel
    createTag('life', 'life');
    createTag('home', 'home', 'life');
    createTag('kitchen', 'kitchen', 'home');
    createTag('kettle', 'kettle', 'kitchen');
    createTag('travel', 'travel', 'life');
  });
  afterEach(() => db.close());

  it('⛔ two refs to the SAME entity need nothing special', () => {
    // The only substrate question in the whole design. A ref names its target
    // in the VALUE (`tag/<id>`), not in the field declaration, so an edge from
    // tag to tag is an ordinary row.
    expect(descendantsOf('life')).toEqual(['home', 'kettle', 'kitchen', 'life', 'travel']);
    expect(descendantsOf('kitchen')).toEqual(['kettle', 'kitchen']);
    expect(descendantsOf('kettle')).toEqual(['kettle']);
  });

  it('⛔ create costs O(DEPTH) writes — not O(tree)', () => {
    // The property that makes this liveable. A nested-set insert renumbers
    // every row to the right of the insertion point; here a node four levels
    // down writes five edges, whatever the tree weighs.
    const before = edges({}).length;
    createTag('deep', 'deep', 'kettle');
    expect(edges({}).length - before).toBe(5);       // 4 ancestors + self
    expect(descendantsOf('life')).toContain('deep');
  });

  it('⛔⛔ MOVE works, and touches nothing but closure rows', () => {
    // The operation a materialised path cannot do and a parent pointer can only
    // do by giving up the subtree read.
    run(B.entry, { id: 'e1', values: { tag_ref: 'tag/kettle', amount: '10.00' } });
    expect(spentUnder('home')).toMatchObject({ total: '10.0000' });

    moveTag('kitchen', 'travel');

    expect(descendantsOf('home')).toEqual(['home']);
    expect(descendantsOf('travel')).toEqual(['kettle', 'kitchen', 'travel']);
    expect(descendantsOf('life')).toEqual(['home', 'kettle', 'kitchen', 'life', 'travel']);
    // ⛔ THE FACT ROW WAS NEVER TOUCHED — it still says `tag/kettle`, and the
    // money followed the tag automatically. Under a denormalised path this is
    // where you rewrite one row per transaction.
    expect(spentUnder('travel')).toMatchObject({ total: '10.0000' });
    expect(spentUnder('home').total).toBe('0.0000');
  });

  it('⚠ depth stays correct after a move — it is recomputed, not shifted', () => {
    moveTag('kitchen', 'life');
    const depthOf = (a: string, d: string) =>
      edges({ ancestor: `tag/${a}`, descendant: `tag/${d}` })[0]?.depth;
    expect(depthOf('life', 'kitchen')).toBe(1);
    expect(depthOf('life', 'kettle')).toBe(2);
    expect(depthOf('kitchen', 'kettle')).toBe(1);
  });

  it('a move is delete + insert, so a HALF-RUN is incomplete, never wrong', () => {
    // The failure-mode argument. Interrupt after the detach: `kitchen` is
    // simply not under anything yet — every edge that remains is TRUE. A
    // half-finished nested-set renumber leaves arithmetic that still validates
    // and answers incorrectly forever.
    const subtree = edges({ ancestor: 'tag/kitchen' }).map(e => e.descendant);
    for (const descendant of subtree) {
      for (const edge of edges({ descendant })) {
        if (subtree.includes(edge.ancestor)) continue;
        run(B.closureDelete, { id: edge.id, expected_version: 1,
                               expected_revision: edge._record.revision });
      }
    }
    expect(descendantsOf('life')).toEqual(['home', 'life', 'travel']);
    expect(descendantsOf('kitchen')).toEqual(['kettle', 'kitchen']);   // still true
  });

  it('⛔ delete removes the subtree and leaves the rest intact', () => {
    deleteSubtree('kitchen');
    expect(descendantsOf('life')).toEqual(['home', 'life', 'travel']);
    expect(descendantsOf('kitchen')).toEqual([]);
    expect(descendantsOf('home')).toEqual(['home']);
  });

  it('⛔⛔ the READ is the price — bounded by the IN cap', () => {
    // `closure -> descendants -> aggregate {in: [...]}` cannot ask about more
    // than RECORDS_MAX_IN_ITEMS descendants at once. Chunking works but the
    // per-chunk decimal totals would then be added in a recipe, as floats — so
    // past this width the rollup stops being exact.
    for (let i = 0; i < RECORDS_MAX_IN_ITEMS; i += 1) {
      createTag(`w${i}`, `w${i}`, 'travel');
    }
    expect(descendantsOf('travel')).toHaveLength(RECORDS_MAX_IN_ITEMS + 1);
    expect(() => spentUnder('travel')).toThrow(/in requires 1\.\.100 items/);
    // ⚠ and the wall is on the SUBTREE's width, not the tree's — a narrow
    // subtree in a huge tree reads fine.
    expect(spentUnder('kitchen')).toMatchObject({ n: 0 });
  });
});
