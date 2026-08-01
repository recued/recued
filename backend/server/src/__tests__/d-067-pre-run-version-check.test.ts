/** D-067 — pre-run ingredient compatibility check.
 *
 *  D-067 was declared in the decisions log and never implemented: it named a
 *  `runRecipe` that does not exist and a `validateIngredientRefs` that has no
 *  production caller. The only version check shipped in the STEP RUNNER and
 *  fired mid-run, after earlier steps had already executed — precisely the
 *  partial-execution failure the decision claimed to have removed.
 *
 *  These pin the finder's behaviour. The load-bearing cases are the two that
 *  ADMIT: every refusal below is equally satisfied by a finder that flags
 *  everything, which would reject working recipes on every dispatch. */

import { describe, expect, it } from 'vitest';
import type { IngredientManifest, RecipeDefinition } from '@recued/contracts';

import {
  describeBreakingIngredientPin,
  findBreakingIngredientPins,
} from '../pre-run-version-check.js';

const manifest = (over: Partial<IngredientManifest> = {}): IngredientManifest =>
  ({ slug: 'reader', name: 'Reader', version: 3, ...over }) as unknown as IngredientManifest;

/** `version: 3`, and anything pinned below 2 is broken. */
const registry = (
  entries: Record<string, IngredientManifest>,
) => (slug: string): IngredientManifest | undefined => entries[slug];

const recipe = (steps: unknown[], prefetch: unknown[] = []): RecipeDefinition =>
  ({ recipe_id: 'r', steps, prefetch_steps: prefetch }) as unknown as RecipeDefinition;

const BREAKING = { reader: manifest({ version: 3, min_version: 2 }) };

describe('findBreakingIngredientPins', () => {
  it('flags a pin BELOW the manifest min_version', () => {
    const found = findBreakingIngredientPins(
      recipe([{ id: 's1', ingredient: 'reader', ingredient_version: 1 }]),
      registry(BREAKING),
    );
    expect(found).toEqual([{
      step_id: 's1',
      ingredient: 'reader',
      pinned_version: 1,
      current_version: 3,
      min_version: 2,
    }]);
  });

  it('ADMITS a pin at or above min_version, even when behind current', () => {
    // The positive case. A pin of 2 against current 3 is `version_behind` —
    // informational, not a break. Rejecting it would refuse most installed
    // recipes the moment any ingredient shipped a non-breaking update.
    expect(findBreakingIngredientPins(
      recipe([{ id: 's1', ingredient: 'reader', ingredient_version: 2 }]),
      registry(BREAKING),
    )).toEqual([]);
    expect(findBreakingIngredientPins(
      recipe([{ id: 's1', ingredient: 'reader', ingredient_version: 3 }]),
      registry(BREAKING),
    )).toEqual([]);
  });

  it('ADMITS when the manifest declares no min_version', () => {
    // No declared floor means the author never claimed a breaking boundary.
    expect(findBreakingIngredientPins(
      recipe([{ id: 's1', ingredient: 'reader', ingredient_version: 1 }]),
      registry({ reader: manifest({ version: 9 }) }),
    )).toEqual([]);
  });

  it('ADMITS an unpinned step', () => {
    // Unpinned floats with whatever is installed — there is no stale pin to be
    // incompatible with.
    expect(findBreakingIngredientPins(
      recipe([{ id: 's1', ingredient: 'reader' }]),
      registry(BREAKING),
    )).toEqual([]);
  });

  it('ADMITS a MISSING manifest rather than rejecting the run', () => {
    // Deliberate scope line. The ingredient may not be installed yet and the
    // step may never run (conditional / skipped). Rejecting here would refuse
    // recipes that work today, which is beyond what D-067 asked for — the
    // runtime still surfaces it at the step.
    expect(findBreakingIngredientPins(
      recipe([{ id: 's1', ingredient: 'not-installed', ingredient_version: 1 }]),
      registry(BREAKING),
    )).toEqual([]);
  });

  it('SKIPS a {{ref}} slug — it cannot be resolved before dispatch', () => {
    // The kernel `run-ingredient` recipe pins its real ingredient via config.
    expect(findBreakingIngredientPins(
      recipe([{ id: 's1', ingredient: '{{config.ingredient_slug}}', ingredient_version: 1 }]),
      registry(BREAKING),
    )).toEqual([]);
  });

  it('checks PREFETCH steps too, and reports prefetch before sequential', () => {
    // Prefetch runs first, so the first reported break is the first a run would
    // actually have hit.
    const found = findBreakingIngredientPins(
      recipe(
        [{ id: 'seq', ingredient: 'reader', ingredient_version: 1 }],
        [{ id: 'pre', ingredient: 'reader', ingredient_version: 1 }],
      ),
      registry(BREAKING),
    );
    expect(found.map((f) => f.step_id)).toEqual(['pre', 'seq']);
  });

  it('reports EVERY break, not just the first', () => {
    // An author fixing a stale recipe wants the whole list rather than one
    // re-run per broken step.
    const found = findBreakingIngredientPins(
      recipe([
        { id: 's1', ingredient: 'reader', ingredient_version: 1 },
        { id: 's2', ingredient: 'writer', ingredient_version: 1 },
      ]),
      registry({
        reader: manifest({ version: 3, min_version: 2 }),
        writer: manifest({ slug: 'writer', version: 5, min_version: 4 }),
      }),
    );
    expect(found.map((f) => f.ingredient)).toEqual(['reader', 'writer']);
  });

  it('resolves each unique slug ONCE', () => {
    // The check runs on every dispatch including reactive and housekeeping
    // fires; a per-step lookup would multiply that by the step count.
    const calls: string[] = [];
    findBreakingIngredientPins(
      recipe([
        { id: 's1', ingredient: 'reader', ingredient_version: 5 },
        { id: 's2', ingredient: 'reader', ingredient_version: 5 },
        { id: 's3', ingredient: 'reader', ingredient_version: 5 },
      ]),
      (slug) => { calls.push(slug); return BREAKING[slug as 'reader']; },
    );
    expect(calls).toEqual(['reader']);
  });
});

describe('describeBreakingIngredientPin', () => {
  it('names the step, both versions, and what to do', () => {
    const msg = describeBreakingIngredientPin({
      step_id: 's1',
      ingredient: 'reader',
      pinned_version: 1,
      current_version: 3,
      min_version: 2,
    });
    expect(msg).toContain("'reader'");
    expect(msg).toContain("step 's1'");
    expect(msg).toContain('v1');
    expect(msg).toContain('v3');
    expect(msg).toContain('min compatible: v2');
    // An operator-facing message that states the problem without an action is
    // half a message.
    expect(msg).toMatch(/re-pin|reinstall/);
  });
});
