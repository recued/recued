import { describe, it, expect, beforeEach } from 'vitest';
import { createPendingQueue } from '../pending-queue.js';
import { createInMemoryCollection } from '@recued/storage';
import type { PendingAction } from '@recued/contracts';
import type { PendingQueue } from '../types.js';

let queue: PendingQueue;

beforeEach(() => {
  queue = createPendingQueue(createInMemoryCollection<PendingAction>());
});

const action = (overrides: Partial<PendingAction> = {}): PendingAction => ({
  pending_id: 'p1',
  recipe_id: 'r1',
  step_id: 's1',
  ingredient_slug: 'deal-update-hubspot',
  risk_tier: 'write',
  description: 'Update deal',
  resolved_input: {},
  queued_at: new Date().toISOString(),
  reason: 'no_background_consent',
  ...overrides,
});

describe('createPendingQueue', () => {
  it('add + list', async () => {
    await queue.add(action({ pending_id: 'p1' }));
    await queue.add(action({ pending_id: 'p2', recipe_id: 'r2' }));
    const list = await queue.list();
    expect(list).toHaveLength(2);
  });

  it('remove by id', async () => {
    await queue.add(action({ pending_id: 'p1' }));
    await queue.add(action({ pending_id: 'p2' }));
    await queue.remove('p1');
    const list = await queue.list();
    expect(list).toHaveLength(1);
    expect(list[0].pending_id).toBe('p2');
  });

  it('removeByRecipe drops all entries for a recipe', async () => {
    await queue.add(action({ pending_id: 'p1', recipe_id: 'r1' }));
    await queue.add(action({ pending_id: 'p2', recipe_id: 'r1' }));
    await queue.add(action({ pending_id: 'p3', recipe_id: 'r2' }));

    const count = await queue.removeByRecipe('r1');
    expect(count).toBe(2);

    const list = await queue.list();
    expect(list).toHaveLength(1);
    expect(list[0].recipe_id).toBe('r2');
  });

  it('removeByRecipe returns 0 when nothing matches', async () => {
    await queue.add(action({ pending_id: 'p1', recipe_id: 'r1' }));
    expect(await queue.removeByRecipe('r2')).toBe(0);
  });
});
