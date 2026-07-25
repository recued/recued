/** D-145 engine-wiring slice 3b.2 - commit-kind derivation tests. */

import { describe, expect, it } from 'vitest';

import type { CommitKind, IngredientCategory } from '@recued/contracts';
import { deriveCommitKind } from '../commit-kind.js';

describe('deriveCommitKind', () => {
  it.each<[IngredientCategory | undefined, CommitKind]>([
    ['action', 'action'],
    ['data', 'query'],
    ['ai', 'query'],
    [undefined, 'action'],
  ])('maps %s to %s', (category, expected) => {
    expect(deriveCommitKind(category)).toBe(expected);
  });
});
