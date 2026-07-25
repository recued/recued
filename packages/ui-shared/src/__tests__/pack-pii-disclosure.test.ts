import { describe, expect, it } from 'vitest';
import type {
  BulkPackInstallResultLike,
  DependencyResolution,
  RecipePiiDisclosureEntry,
  RecipePiiPostureSummary,
  RecipeRunnabilityEntry,
} from '@recued/contracts';

import { installDisclosureBlocks } from '../install/pack-runnability-disclosure.js';

const okInstall = (
  overrides: Partial<BulkPackInstallResultLike> = {},
): BulkPackInstallResultLike => ({
  ok: true,
  installed: [],
  rolled_back: [],
  ...overrides,
});

const dep = (
  overrides: Partial<DependencyResolution> = {},
): DependencyResolution => ({
  capability: 'deal',
  ops: ['search'],
  optional: false,
  satisfied: false,
  providers: [],
  unprovided_ops: ['search'],
  ...overrides,
});

const runnabilityEntry = (
  recipe_id: string,
  dependencies: DependencyResolution[],
): RecipeRunnabilityEntry => ({
  recipe_id,
  status: 'blocked',
  dependencies,
});

const summary = (
  headline: string,
  warnings: string[],
): RecipePiiPostureSummary => ({
  headline,
  auto_protected: [],
  warnings: warnings.map((message, index) => ({
    step_id: `ai_${index + 1}`,
    message,
  })),
  infos: [],
});

const piiEntry = (
  recipe_id: string,
  posture: RecipePiiPostureSummary,
): RecipePiiDisclosureEntry => ({
  recipe_id,
  summary: posture,
});

describe('installDisclosureBlocks pii disclosure', () => {
  it('does not add a pii block when pii_disclosure is omitted', () => {
    expect(installDisclosureBlocks(okInstall()).some((block) => block.kind === 'pii'))
      .toBe(false);
    expect(
      installDisclosureBlocks(okInstall({
        born_blocked: [runnabilityEntry('blocked', [dep()])],
      })).some((block) => block.kind === 'pii'),
    ).toBe(false);
  });

  it('renders one pii block with details in entry order', () => {
    const blocks = installDisclosureBlocks(okInstall({
      pii_disclosure: [
        piiEntry('first-recipe', summary('Headline one.', [
          'First warning.',
          'Second warning.',
        ])),
        piiEntry('second-recipe', summary('', ['Only warning.'])),
      ],
    }));

    expect(blocks).toEqual([
      {
        kind: 'pii',
        headline: "PII handling for this pack's recipes:",
        items: [
          {
            recipe_id: 'first-recipe',
            detail: 'Headline one. First warning. Second warning.',
          },
          {
            recipe_id: 'second-recipe',
            detail: 'Only warning.',
          },
        ],
      },
    ]);
  });

  it('puts the pii block last when born_blocked disclosure is also present', () => {
    const blocks = installDisclosureBlocks(okInstall({
      born_blocked: [runnabilityEntry('blocked', [dep()])],
      pii_disclosure: [
        piiEntry('pii-recipe', summary('Manual headline.', ['Manual warning.'])),
      ],
    }));

    expect(blocks.map((block) => block.kind)).toEqual(['born-blocked', 'pii']);
    expect(blocks.at(-1)).toEqual({
      kind: 'pii',
      headline: "PII handling for this pack's recipes:",
      items: [
        {
          recipe_id: 'pii-recipe',
          detail: 'Manual headline. Manual warning.',
        },
      ],
    });
  });
});
