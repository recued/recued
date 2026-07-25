import { describe, it, expect, beforeEach } from 'vitest';
import { createTrustStateStore } from '../trust-store.js';
import { createInMemoryCollection } from '@recued/storage';
import type { RecipeTrustState } from '@recued/contracts';
import type { TrustStateStore } from '../types.js';

let store: TrustStateStore;

beforeEach(() => {
  store = createTrustStateStore(createInMemoryCollection<RecipeTrustState>());
});

describe('createTrustStateStore', () => {
  it('returns null for unknown recipe', async () => {
    expect(await store.get('r1')).toBeNull();
  });

  it('set + get round trip', async () => {
    const state: RecipeTrustState = {
      recipe_id: 'r1',
      recipe_version: 1,
      approval_counts: { write: 5, admin: 0 },
      trust_levels: { write: 'prompt', admin: 'prompt' },
    };
    await store.set(state);
    expect(await store.get('r1')).toEqual(state);
  });

  describe('increment', () => {
    it('creates a new state when none exists', async () => {
      const state = await store.increment('r1', 1, 'write');
      expect(state.approval_counts.write).toBe(1);
      expect(state.approval_counts.admin).toBe(0);
      expect(state.trust_levels.write).toBe('prompt');
    });

    it('increments existing state', async () => {
      await store.increment('r1', 1, 'write');
      await store.increment('r1', 1, 'write');
      const state = await store.get('r1');
      expect(state?.approval_counts.write).toBe(2);
    });

    it('tracks write and admin separately', async () => {
      await store.increment('r1', 1, 'write');
      await store.increment('r1', 1, 'admin');
      await store.increment('r1', 1, 'admin');
      const state = await store.get('r1');
      expect(state?.approval_counts.write).toBe(1);
      expect(state?.approval_counts.admin).toBe(2);
    });

    it('resets state on version change', async () => {
      await store.increment('r1', 1, 'write');
      await store.increment('r1', 1, 'write');
      // Recipe upgraded → version 2 → counters reset
      const state = await store.increment('r1', 2, 'write');
      expect(state.recipe_version).toBe(2);
      expect(state.approval_counts.write).toBe(1);
    });
  });

  describe('setAuto', () => {
    it('marks tier as auto', async () => {
      await store.increment('r1', 1, 'write');
      const state = await store.setAuto('r1', 1, 'write');
      expect(state.trust_levels.write).toBe('auto');
      expect(state.unlocked_at?.write).toBeDefined();
    });

    it('preserves the other tier level', async () => {
      const state = await store.setAuto('r1', 1, 'write');
      expect(state.trust_levels.admin).toBe('prompt');
    });

    it('preserves approval counts', async () => {
      await store.increment('r1', 1, 'write');
      await store.increment('r1', 1, 'write');
      const state = await store.setAuto('r1', 1, 'write');
      expect(state.approval_counts.write).toBe(2);
    });

    it('creates state if none exists', async () => {
      const state = await store.setAuto('r1', 1, 'write');
      expect(state.trust_levels.write).toBe('auto');
      expect(state.approval_counts.write).toBe(0);
    });
  });
});
