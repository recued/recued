/** R2 step 6 - checkpoint saga field shape guards. */

import { describe, expect, it } from 'vitest';

import type { Checkpoint } from '../checkpoint.js';
import { isCheckpoint } from '../checkpoint.js';

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  gated_step_id: 'gated_step',
  step_state: {},
  created_at: 1_700_000_000_000,
  ...overrides,
});

describe('Checkpoint saga fields', () => {
  it('rejects non-object recipe_snapshot values', () => {
    const candidates: unknown[] = [
      { ...checkpoint(), recipe_snapshot: 'recipe-json' },
      { ...checkpoint(), recipe_snapshot: 42 },
      { ...checkpoint(), recipe_snapshot: null },
      { ...checkpoint(), recipe_snapshot: [] },
      { ...checkpoint(), recipe_snapshot: true },
    ];

    for (const candidate of candidates) {
      expect(isCheckpoint(candidate)).toBe(false);
    }
  });

  it('rejects an empty predecessor_commit_id', () => {
    expect(isCheckpoint({
      ...checkpoint(),
      predecessor_commit_id: '',
    })).toBe(false);
  });

  it('accepts checkpoints with both saga fields absent', () => {
    const candidate = checkpoint();

    expect(candidate).not.toHaveProperty('recipe_snapshot');
    expect(candidate).not.toHaveProperty('predecessor_commit_id');
    expect(isCheckpoint(candidate)).toBe(true);
  });
});
