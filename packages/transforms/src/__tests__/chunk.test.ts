import { describe, it, expect } from 'vitest';

import { RECORDS_MAX_BATCH_OPS } from '@recued/contracts';

import { chunk } from '../collection.js';
import { TRANSFORMS } from '../index.js';
import { TRANSFORM_SCHEMAS } from '../schemas.js';
import { ctx } from './helpers.js';

/** `chunk` is the missing half of the D-226 records `batch` action. Batch caps at
 *  `RECORDS_MAX_BATCH_OPS`, and a recipe had no way to feed it from a larger array —
 *  `partition` splits by PREDICATE, `slice` takes ONE window. So a 1000-row import fell
 *  back to `foreach` + one write per row: 1000 gateway dispatches, 1000 transactions and
 *  1000 audit rows, against quota'd audit that evicts oldest-first (D-230).
 */
const run = (params: Record<string, unknown>): unknown => chunk(params, ctx());

describe('chunk', () => {
  it('splits into fixed-size runs, remainder last', () => {
    expect(run({ array: [1, 2, 3, 4, 5], size: 2 })).toEqual([[1, 2], [3, 4], [5]]);
    expect(run({ array: [1, 2, 3, 4], size: 2 })).toEqual([[1, 2], [3, 4]]);
    expect(run({ array: [1], size: 5 })).toEqual([[1]]);
  });

  it('⛔⛔ a NON-POSITIVE size THROWS — it must never silently drop every row', () => {
    /** ⛔⛔ THE FAILURE IS A HANG, NOT A WRONG ANSWER — measured, not assumed. Removing
     *  this guard does not make the suite fail; it makes the worker DIE with `JS heap out
     *  of memory`, because `size: 0` leaves the loop's `i += size` never advancing and it
     *  pushes empty slices forever. So this is a liveness guard first. Worth stating
     *  because a reader would otherwise assume the guard protects against a bad VALUE and
     *  might "simplify" it into a `?? 1` default, which trades a loud stop for a silent
     *  re-batching.
     *  ⚠ Each case is asserted separately rather than in a loop: a loop that threw on the
     *  first entry would report a pass for the rest without ever evaluating them. */
    expect(() => run({ array: [1, 2], size: 0 })).toThrow(/positive integer/u);
    expect(() => run({ array: [1, 2], size: -1 })).toThrow(/positive integer/u);
    expect(() => run({ array: [1, 2], size: undefined })).toThrow(/positive integer/u);
    expect(() => run({ array: [1, 2], size: 'ten' })).toThrow(/positive integer/u);
    /** ⛔ A FRACTIONAL size is refused too. `Array.slice` would happily produce runs of 2
     *  for `size: 2.5`, quietly batching differently than the author declared — and a
     *  batch whose size is not what the recipe says is a batch nobody can reason about. */
    expect(() => run({ array: [1, 2], size: 2.5 })).toThrow(/positive integer/u);
  });

  it('⛔ an empty array yields NO chunks, never one empty chunk', () => {
    /** `[[]]` would become a batch call carrying zero ops: a wasted dispatch and an audit
     *  row recording that nothing happened, on every import that filtered everything out.
     *  ⚠ Pinned as `[]` rather than "falsy" — `[[]]` is truthy AND has length 1, so a
     *  looser assertion passes on exactly the wrong value. */
    expect(run({ array: [], size: 10 })).toEqual([]);
  });

  it('⚠ a non-array degrades to [] like its siblings, rather than throwing', () => {
    /** Deliberately NOT symmetric with the size guard. A bad size is an authoring error
     *  the author can only have written by hand; a non-array is usually an upstream step
     *  that legitimately produced nothing, and `map` / `filter` / `slice` all return `[]`
     *  there. Throwing would make `chunk` the one transform that turns an empty upstream
     *  into a failed run. */
    expect(run({ array: null, size: 2 })).toEqual([]);
    expect(run({ array: 'nope', size: 2 })).toEqual([]);
  });

  it('⛔⛔ it is REACHABLE through the registry and DECLARED in the schema', () => {
    /** THE WIRING CHECK, and the reason this test is worth more than the ones above. A
     *  transform that is correct and unregistered is invisible to every recipe: the step
     *  fails at run time with "unknown transform", and no unit test of the function
     *  itself can see that. The schema entry is the second half — the recipe VALIDATOR
     *  reads it, so an unregistered schema means a valid recipe is rejected at authoring
     *  time instead. Both halves, asserted separately. */
    const registry = TRANSFORMS as unknown as Map<string, unknown>;
    expect(registry.has('chunk'), 'chunk must be in the runtime registry').toBe(true);
    expect(registry.get('chunk')).toBe(chunk);
    expect(
      Object.prototype.hasOwnProperty.call(TRANSFORM_SCHEMAS, 'chunk'),
      'chunk must be declared in the schema table the validator reads',
    ).toBe(true);
    /** And it must run THROUGH the registry, not just be present in it. */
    const viaRegistry = (registry.get('chunk') as typeof chunk)({ array: [1, 2, 3], size: 2 }, ctx());
    expect(viaRegistry).toEqual([[1, 2], [3]]);
  });

  it('⛔ 1000 rows at the batch cap becomes 10 calls — the case it was built for', () => {
    /** The concrete motivating number, pinned against the CONTRACT's cap rather than a
     *  literal 100: if D-226 ever changes `RECORDS_MAX_BATCH_OPS`, this test should follow
     *  it instead of silently asserting a stale batching. */
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    const chunks = run({ array: rows, size: RECORDS_MAX_BATCH_OPS }) as number[][];
    expect(chunks).toHaveLength(Math.ceil(1000 / RECORDS_MAX_BATCH_OPS));
    /** ⛔⛔ NOT ONE ROW LOST OR DUPLICATED. A chunker that dropped or repeated a run
     *  would still produce a plausible chunk COUNT, and for an import of financial
     *  records that is exactly the failure that reads as success. Flatten and compare
     *  identity, not length. */
    expect(chunks.flat()).toEqual(rows);
    expect(chunks.every((c) => c.length <= RECORDS_MAX_BATCH_OPS)).toBe(true);
  });
});
