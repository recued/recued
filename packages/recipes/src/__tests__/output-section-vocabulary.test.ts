/** The output-section vocabulary is ONE closed list.
 *
 *  `validate/constants.ts` DERIVES its admission Set from the contract's
 *  `OUTPUT_TYPES` rather than re-typing it, because a hand-written
 *  `Set<OutputType>` missing a member TYPECHECKS PERFECTLY — the drift surfaces
 *  only as a recipe rejected for no legible reason (the `door_types` failure,
 *  D-207 slice 1c). Derivation is a claim about behaviour, so prove it as one:
 *  assert the VALIDATOR admits every kind the CONTRACT declares.
 *
 *  This is the sibling of the renderer's ratchet (`packages/renderer`
 *  `d-207-slice2-link-button-and-audience.test.ts`), which asserts the same
 *  property from the other end — that no declared kind falls through to
 *  `unsupported section type`. Together they close the loop: a kind added to
 *  `OUTPUT_TYPES` must both validate and render, or one of the two fails.
 */

import { describe, expect, it } from 'vitest';
import { OUTPUT_TYPES } from '@recued/contracts';
import type { RecipeDefinition } from '@recued/contracts';

import { validateRecipe } from '../validate.js';

const recipeWith = (type: string): RecipeDefinition =>
  ({
    recipe_id: 'output-section-vocabulary',
    version: 1,
    ttl: 60,
    metadata: {
      name: 'Output section vocabulary',
      description: 'Recipe under test for the output-section admission set.',
      author: 'recued',
      supported_platforms: ['gmail'],
      tags: ['test'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'noop', transform: 'concat', values: ['ok'] }],
    output: { render: [{ type, source: 'step.noop' }] },
  }) as unknown as RecipeDefinition;

const codes = (result: { issues: Array<{ code: string }> }): string[] =>
  result.issues.map((i) => i.code);

describe('the validator admits exactly the kinds the contract declares', () => {
  it('admits every OUTPUT_TYPES member — including `json`', () => {
    expect(OUTPUT_TYPES).toContain('json');
    for (const kind of OUTPUT_TYPES) {
      expect(
        codes(validateRecipe(recipeWith(kind))),
        `${kind} is in OUTPUT_TYPES but the validator rejected it`,
      ).not.toContain('output_section_type_invalid');
    }
  });

  it('still rejects a kind the contract does NOT declare', () => {
    // `markdown` specifically: 24 shipped recipes authored it inside the dead
    // `output.content` block, and it was deliberately NOT added to the
    // vocabulary — every one of those sections is `core.ai.summarize` output,
    // which the existing `ai_analysis` kind already renders. Adding a markdown
    // kind would have meant a parser dependency and HTML emission, breaking the
    // renderer's escape-everything invariant for 24 sections. If this ever goes
    // green, that decision was reversed without this comment being read.
    expect(codes(validateRecipe(recipeWith('markdown')))).toContain(
      'output_section_type_invalid',
    );
  });
});
