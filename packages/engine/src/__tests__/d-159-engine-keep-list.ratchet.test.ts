/** D-159 N.3 / I-5 -- packages/engine/src/ is exactly the keep-list.
 *
 *  After D-159 P0-P2 the deterministic recipe-plan executor is all
 *  that remains in `packages/engine/src/`: the N.3 keep-list of source
 *  files + the `index.ts` barrel, the `adapters/` directory
 *  (one file, `registry.ts`), and the `__tests__/` directory. Any
 *  other entry means non-engine code crept back into the engine
 *  package -- the I-5 failure mode.
 *
 *  `.ts` sources are asserted exactly; build artifacts (a stale
 *  `.js` / `.d.ts` next to its source, which the repo's vitest
 *  config explicitly tolerates) are not engine code and do not fail
 *  the ratchet.
 *
 *  Spec: docs/d-159-spec.md section N.3 + I-5 + A.3. */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '..'); // packages/engine/src

// D-159 N.3 -- the deterministic recipe-plan executor: 15 source
// files + the index.ts barrel. (D-159 P2 retired step-cache.ts --
// the dead withStepCache wrapper, superseded by execute.ts's inlined
// buildCachedStepRunner. D-165 P0 added catalog-gateway.ts -- the
// catalog-form gateway-routing branch that `runIngredient` dispatches
// to when a manifest carries an `operations` map. D-181 slice 2 added
// lane.ts -- the long-op governor's engine-side `invokeGoverned`
// wrapper, on the same deterministic step/prefetch dispatch path.
// D-182 step 7 added require-recipe.ts -- the `ExecutionContext.recipe`
// optional-narrowing guard the recipe-run path asserts now that a raw
// op can form a recipe-less context.)
const KEEP_FILES = [
  'catalog-gateway.ts',
  'condition.ts',
  'context-recipe.ts',
  'context.ts',
  'dry-run.ts',
  'execute.ts',
  'index.ts',
  'lane.ts',
  'prefetch.ts',
  'preflight.ts',
  'require-recipe.ts',
  'run-mode.ts',
  'shared-prefetch.ts',
  'step-runner.ts',
  'step-seed.ts',
  'store-safety.ts',
  'types.ts',
];

// adapters/ + __tests__/ are the only directories the engine keeps.
const KEEP_DIRS = ['__tests__', 'adapters'];

const sorted = (xs: string[]): string[] => [...xs].sort();

/** A first-party source file -- a `.ts` that is not a `.d.ts`
 *  declaration build artifact. */
const isSource = (name: string): boolean =>
  name.endsWith('.ts') && !name.endsWith('.d.ts');

describe('D-159 N.3 / I-5 -- packages/engine/src is exactly the keep-list', () => {
  const entries = readdirSync(SRC, { withFileTypes: true });

  it('engine/src .ts sources are exactly the N.3 keep-list', () => {
    const tsFiles = entries
      .filter((e) => e.isFile() && isSource(e.name))
      .map((e) => e.name);
    expect(sorted(tsFiles)).toEqual(sorted(KEEP_FILES));
  });

  it('engine/src has no directories beyond adapters/ + __tests__/', () => {
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(sorted(dirs)).toEqual(sorted(KEEP_DIRS));
  });

  it('adapters/ holds only registry.ts (N.3: adapters/registry.ts)', () => {
    const adapterTs = readdirSync(resolve(SRC, 'adapters')).filter(isSource);
    expect(sorted(adapterTs)).toEqual(['registry.ts']);
  });
});
