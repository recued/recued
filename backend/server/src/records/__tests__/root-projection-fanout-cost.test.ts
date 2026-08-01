/** D-226 — what a root read COSTS, as pack count and row count grow.
 *
 *  ⛔ THE DEPENDENT VARIABLE IS QUERIES ISSUED, NOT WALL-CLOCK. Against an
 *  in-memory SQLite, twenty packs is milliseconds of scheduler noise — a
 *  saturated measure that reads as a clean null and would let a regression
 *  through. A non-functional property has to be tested at the MECHANISM.
 *
 *  ⛔ AND IT ASSERTS A SHAPE, NOT A THRESHOLD. "Under 80 queries" rots the
 *  moment the store adds a lookup; "linear in packs, with the namespace listing
 *  amortised across them" is the property that actually matters and survives
 *  unrelated change. A threshold would also pass a build that got 10× worse
 *  while staying under it.
 *
 *  ⚠ Piloted before it was written, which is the only reason it is right: the
 *  first pilot showed zero-hop and one-hop reads costing IDENTICAL queries,
 *  which is impossible if the walk works. It was not a fixture bug — a zero-hop
 *  projection was issuing its seed query and discarding it, then re-querying
 *  the same entity. Every zero-hop rollup did double the work. Fixed, and the
 *  first case below is what pins it. */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  RecordsExecutionBinding, RecordsPackRef, RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';
import { readRootProjections } from '../root-projection.js';

const SH = 'a'.repeat(64);
const DH = 'b'.repeat(64);
const bind = (owner: RecordsPackRef, entity: string): RecordsExecutionBinding => ({
  kind: 'core.records', action: 'create', entity, owner, pack_version: 1,
  storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:${owner.pack_slug}:${entity}`,
});

const ZERO_HOP: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    thing: {
      kind: 'thing',
      roots: [{ root: 'contact', via: [], key_field: 'email', select: { n: { fn: 'count' } } }],
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'email', slot: 's1', kind: 'string', required: false },
      ],
    },
  },
};

const ONE_HOP: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    parent: {
      kind: 'parent',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'email', slot: 's1', kind: 'string', required: false },
      ],
    },
    thing: {
      kind: 'thing',
      roots: [{
        root: 'contact', via: [{ field: 'p', entity: 'parent' }], key_field: 'email',
        select: { n: { fn: 'count' } },
      }],
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'p', slot: 'r1', kind: 'ref', required: true },
      ],
    },
  },
};

interface Harness { store: RecordsStore; close(): void; count(fn: () => void): number }

const build = (
  packs: number, schema: RecordsSchemaSnapshot, rowsPerPack: number,
  emailFor: (row: number) => string = () => 'bob@x.test',
): Harness => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  let counting = false;
  let queries = 0;
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const st = realPrepare(sql);
    const rAll = st.all.bind(st), rIter = st.iterate.bind(st);
    // Both doors are instrumented: wrapping only `.all()` would go blind the
    // moment a scan switched to `iterate`, which is exactly what the walk uses.
    (st as unknown as { all: unknown }).all = (...a: unknown[]) => {
      if (counting) queries += 1;
      return rAll(...a as []);
    };
    (st as unknown as { iterate: unknown }).iterate = function* (...a: unknown[]) {
      if (counting) queries += 1;
      for (const row of rIter(...a as []) as IterableIterator<unknown>) yield row;
    };
    return st;
  };
  const store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
  const oneHop = 'parent' in schema.entities;
  for (let p = 0; p < packs; p += 1) {
    const owner: RecordsPackRef = { publisher: 'p', pack_slug: `pack-${String(p).padStart(3, '0')}` };
    store.installNamespace({
      owner, version: 1, storage_schema_hash: SH, declaration_hash: DH, artifact_digest: `a${p}`,
      schema,
      bindings: Object.fromEntries(Object.keys(schema.entities).map(e => [e, bind(owner, e)])),
    });
    for (let i = 0; i < rowsPerPack; i += 1) {
      if (oneHop) {
        store.execute({ binding: bind(owner, 'parent'), principal: 'owner',
          args: { id: `par${i}`, values: { email: emailFor(i) } } });
        store.execute({ binding: bind(owner, 'thing'), principal: 'owner',
          args: { id: `t${i}`, values: { p: `parent/par${i}` } } });
      } else {
        store.execute({ binding: bind(owner, 'thing'), principal: 'owner',
          args: { id: `t${i}`, values: { email: emailFor(i) } } });
      }
    }
  }
  return {
    store,
    close: () => db.close(),
    count: (fn) => { queries = 0; counting = true; fn(); counting = false; return queries; },
  };
};

const readCost = (packs: number, schema: RecordsSchemaSnapshot, rows = 5) => {
  const h = build(packs, schema, rows);
  const q = h.count(() => { readRootProjections(h.store, 'contact', 'bob@x.test'); });
  h.close();
  return q;
};

describe('one root read', () => {
  it('⛔ a ZERO-hop projection queries ONCE per level — not twice', () => {
    // The regression this file exists for. Before the fix a zero-hop read
    // issued its seed scan, discarded it, and scanned again: 5 queries where 3
    // do the job. The one-hop read is the control — it legitimately costs one
    // level more, and if the two are ever EQUAL again something is wrong.
    const zero = readCost(1, ZERO_HOP);
    const one = readCost(1, ONE_HOP);
    expect(zero).toBe(3);          // namespaces + scan + hydrate
    expect(one).toBe(5);           // + a second scan + hydrate for the hop
    expect(one, 'zero-hop and one-hop must not cost the same').toBeGreaterThan(zero);
    // ⚠ COST ALONE CANNOT POLICE THIS. Deleting the short-circuit makes the
    // zero-hop path fall through and return an EMPTY rollup — which costs the
    // same 3 queries, so this file stays green. The mutant is caught, but by
    // the CORRECTNESS tests (5 of them, in root-projection / fanout), not here.
    // A cost measure is blind to an answer that is cheap and wrong; it is only
    // ever half the guard.
  });

  it('⛔ is LINEAR in installed packs — each pack adds a constant', () => {
    const costs = [1, 2, 4, 8, 16].map(p => readCost(p, ZERO_HOP));
    const deltas = costs.slice(1).map((c, i) => (c - costs[i]!) / [1, 2, 4, 8][i]!);
    // every pack costs the same, whatever else is installed
    expect(new Set(deltas).size, `per-pack cost drifted: ${deltas.join(', ')}`).toBe(1);
    expect(deltas[0]).toBe(2);
  });

  it('⚠ the namespace listing is amortised — ONCE per read, not once per pack', () => {
    // If this ever became per-pack the cost would still look linear, just with
    // a worse constant. Pinning the intercept is what catches that.
    const [one, sixteen] = [readCost(1, ZERO_HOP), readCost(16, ZERO_HOP)];
    const perPack = (sixteen - one) / 15;
    expect(one - perPack, 'the fixed cost of a read').toBe(1);
  });

  it('does not grow with rows until a PAGE boundary is crossed', () => {
    // 200 is the page size; below it the row count is free.
    expect(readCost(1, ZERO_HOP, 5)).toBe(readCost(1, ZERO_HOP, 150));
    expect(readCost(1, ZERO_HOP, 500)).toBeGreaterThan(readCost(1, ZERO_HOP, 5));
  });
});

describe('⛔⛔ the case that actually threatens a UI: N contacts × M packs', () => {
  /** A list view calling the root read per row. This is the N+1, and it is the
   *  only version of this measurement where the number changes a decision. */
  /** `hit` seeds a row for every contact the loop asks about, so the list is
   *  the realistic case rather than 50 misses in a row. */
  const listCost = (packs: number, contacts: number, hit = true) => {
    const h = build(packs, ZERO_HOP, contacts, (i) => `c${i}@x.test`);
    const q = h.count(() => {
      for (let c = 0; c < contacts; c += 1) {
        readRootProjections(h.store, 'contact', hit ? `c${c}@x.test` : `absent${c}@x.test`);
      }
    });
    h.close();
    return q;
  };

  it('multiplies — nothing amortises across rows', () => {
    const one = listCost(4, 1);
    expect(listCost(4, 10)).toBe(one * 10);
    expect(listCost(4, 50)).toBe(one * 50);
  });

  it('quantifies the wall a naive list hits', () => {
    // 50 rows × 20 packs, every row matching. Not a threshold to tune — a
    // number to look at before wiring this into anything that renders a list.
    const cost = listCost(20, 50);
    expect(cost).toBe(2_050);        // 50 × (1 namespace + 20 packs × 2)

    // ⚠ THE FIX IS BATCHING, NOT LAZINESS, and D-226 already specifies it:
    // `group_by` is excluded as an AUTHORED output but "returns as the
    // evaluator's internal batching strategy" — one `key_field IN (…)` scan per
    // pack, partitioned by identity in memory. MEASURED against this same
    // fixture: 2,050 -> 41 queries, 50x fewer, and O(packs) rather than
    // O(packs × contacts).
    //
    // 41 rather than 21 because the store's search is scan-then-hydrate; that
    // split is below this layer and not something a projection can collapse.
    //
    // ✅ NOW BUILT — `readRootProjectionsBatch`, once the contact list became a
    // real caller. This number is what it was built against, and
    // `root-projection-batch.test.ts` holds the property that matters: the
    // batched answer EQUALS the per-identity answer, key for key. A faster read
    // that disagrees with this one would be worse than no batch at all.
    //
    // ⚠ The per-contact path below is still the right call for ONE identity
    // (the detail view, the timeline, recipe prefetch) — same answer, shorter
    // path. This case remains here as the cost of doing it the wrong way.
  });

  it('⚠ a MISS is cheaper than a hit — but still one query per pack', () => {
    // The hydrate is skipped when the scan returns nothing, so an empty row
    // costs 1 per pack rather than 2. It is NOT free, and the tempting
    // optimisation ("skip packs with nothing to say") cannot exist: a pack has
    // to be asked before anyone knows it has nothing to say.
    const h = build(8, ZERO_HOP, 5);
    const hit = h.count(() => { readRootProjections(h.store, 'contact', 'bob@x.test'); });
    const miss = h.count(() => { readRootProjections(h.store, 'contact', 'nobody@x.test'); });
    h.close();
    expect(hit).toBe(17);            // 1 + 8 × 2
    expect(miss).toBe(9);            // 1 + 8 × 1
    expect(miss).toBeGreaterThan(1); // asking is never free
  });
});
