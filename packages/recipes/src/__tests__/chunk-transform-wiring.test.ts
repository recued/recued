import { describe, expect, it } from 'vitest';

import { validateRecipe } from '../validate.js';

/** ⛔⛔ THE VALIDATOR HALF OF `chunk`'s WIRING. Its own unit test asserts the function is
 *  in the runtime registry and declared in the schema table — but "declared in a table"
 *  and "a recipe using it validates" are different claims, and only the second one is
 *  what an author experiences. A transform present at runtime but rejected at authoring
 *  time is unusable in exactly the same way as one that is missing.
 *
 *  🔑 `chunk` exists to feed the D-226 records `batch` action, whose
 *  `RECORDS_MAX_BATCH_OPS` cap a recipe previously had no way to reach from a larger
 *  array — so the shape probed here (chunk, then iterate the chunks) is the one every
 *  bulk-import recipe will actually write.
 */
const probe = (steps: unknown[]): ReturnType<typeof validateRecipe> =>
  validateRecipe({
    recipe_id: 'chunk-wiring-probe',
    chat_exposed: false,
    version: 1,
    ttl: 0,
    metadata: {
      name: 'Chunk wiring probe',
      description:
        'Use “Chunk wiring probe” in Recued. Probes that the chunk transform is accepted '
        + 'by the recipe validator, not merely present in the registry.',
      author: 'recued-core',
      supported_platforms: [],
      tags: [],
      budget_ms: 1000,
    },
    depends_on: [],
    variables: {},
    requires: [],
    prefetch_steps: [],
    steps,
    output: { render: [] },
  });

describe('chunk — accepted by the recipe validator', () => {
  it('⛔⛔ a recipe that chunks an array and iterates the chunks validates clean', () => {
    const res = probe([
      { id: 'rows', transform: 'to_list', input: [1, 2, 3] },
      { id: 'batches', transform: 'chunk', array: '{{step.rows}}', size: 100 },
      { id: 'n', transform: 'count', input: '{{step.batches}}' },
    ]);
    const errors = res.issues.filter((i) => i.severity === 'error');
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it('⛔ a chunk step missing `size` is REFUSED at authoring time', () => {
    /** The control. Without it the test above passes for a validator that simply does not
     *  know `chunk` and therefore checks nothing about it — the difference between
     *  "accepted" and "ignored" is invisible from a clean result alone. A required
     *  parameter being enforced proves the schema entry is genuinely being read. */
    const res = probe([
      { id: 'rows', transform: 'to_list', input: [1, 2, 3] },
      { id: 'batches', transform: 'chunk', array: '{{step.rows}}' },
    ]);
    const errors = res.issues.filter((i) => i.severity === 'error');
    expect(errors.map((i) => i.code)).toContain('transform_missing_param');
    expect(JSON.stringify(errors)).toContain('size');
  });
});
