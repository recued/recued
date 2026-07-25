import { describe, it, expect, beforeEach } from 'vitest';
import { createConfigStore, type ConfigStore } from '../config.js';
import { createInMemoryCollection } from '../in-memory.js';
import type { Collection, ConfigEntry } from '../types.js';

let collection: Collection<ConfigEntry>;
let config: ConfigStore;

beforeEach(() => {
  collection = createInMemoryCollection<ConfigEntry>();
  config = createConfigStore(collection);
});

describe('createConfigStore', () => {
  describe('set/get', () => {
    it('stores and retrieves a value', async () => {
      await config.set('recipe-a', 'lookback_days', 30);
      expect(await config.get('recipe-a', 'lookback_days')).toBe(30);
    });

    it('preserves type for boolean', async () => {
      await config.set('recipe-a', 'verbose', false);
      expect(await config.get('recipe-a', 'verbose')).toBe(false);
    });

    it('preserves type for arrays', async () => {
      await config.set('recipe-a', 'risk_levels', ['high', 'medium']);
      expect(await config.get('recipe-a', 'risk_levels')).toEqual(['high', 'medium']);
    });

    it('preserves type for objects', async () => {
      await config.set('recipe-a', 'thresholds', { low: 10, high: 90 });
      expect(await config.get('recipe-a', 'thresholds')).toEqual({ low: 10, high: 90 });
    });

    it('returns undefined for missing', async () => {
      expect(await config.get('recipe-a', 'missing')).toBeUndefined();
    });

    it('overwrites existing values', async () => {
      await config.set('recipe-a', 'k', 1);
      await config.set('recipe-a', 'k', 2);
      expect(await config.get('recipe-a', 'k')).toBe(2);
    });
  });

  describe('recipe isolation', () => {
    it('different recipes do not share keys', async () => {
      await config.set('recipe-a', 'lookback_days', 30);
      await config.set('recipe-b', 'lookback_days', 90);

      expect(await config.get('recipe-a', 'lookback_days')).toBe(30);
      expect(await config.get('recipe-b', 'lookback_days')).toBe(90);
    });

    it('listByRecipe returns only that recipe entries', async () => {
      await config.set('recipe-a', 'k1', 'a1');
      await config.set('recipe-a', 'k2', 'a2');
      await config.set('recipe-b', 'k1', 'b1');

      const entries = await config.listByRecipe('recipe-a');
      expect(entries).toEqual({ k1: 'a1', k2: 'a2' });
    });

    it('listByRecipe preserves prototype-sensitive override names', async () => {
      await config.set('recipe-a', '__proto__', 'secret');
      await config.set('recipe-a', 'constructor', 'ctor');
      await config.set('recipe-a', 'safe', 'ok');

      const entries = await config.listByRecipe('recipe-a');
      expect(Object.getPrototypeOf(entries)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(entries, '__proto__')).toBe(true);
      expect(entries['__proto__']).toBe('secret');
      expect(entries.constructor).toBe('ctor');
      expect(entries.safe).toBe('ok');
      expect(({} as Record<string, unknown>).secret).toBeUndefined();
    });

    it('listByRecipe returns empty object when nothing stored', async () => {
      expect(await config.listByRecipe('recipe-a')).toEqual({});
    });
  });

  describe('has', () => {
    it('true after set', async () => {
      await config.set('r', 'k', 'v');
      expect(await config.has('r', 'k')).toBe(true);
    });

    it('false for missing', async () => {
      expect(await config.has('r', 'missing')).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes a single entry', async () => {
      await config.set('r', 'k', 'v');
      await config.delete('r', 'k');
      expect(await config.has('r', 'k')).toBe(false);
    });

    it('does not affect other recipes', async () => {
      await config.set('r1', 'k', 'v1');
      await config.set('r2', 'k', 'v2');
      await config.delete('r1', 'k');
      expect(await config.get('r2', 'k')).toBe('v2');
    });
  });

  describe('deleteByRecipe', () => {
    it('removes all entries for a recipe', async () => {
      await config.set('r1', 'k1', 1);
      await config.set('r1', 'k2', 2);
      await config.set('r2', 'k1', 3);

      const count = await config.deleteByRecipe('r1');
      expect(count).toBe(2);
      expect(await config.listByRecipe('r1')).toEqual({});
      expect(await config.listByRecipe('r2')).toEqual({ k1: 3 });
    });
  });

  describe('per D-043 — variable migration on update', () => {
    it('preserves user overrides when recipe variable list grows', async () => {
      // User customized lookback_days
      await config.set('recipe-a', 'lookback_days', 60);

      // Recipe v2 adds a new variable. Engine reads stored override (60) for lookback_days
      // and falls back to the recipe JSON default for new variables.
      const overrides = await config.listByRecipe('recipe-a');
      expect(overrides.lookback_days).toBe(60);
      expect(overrides.new_variable).toBeUndefined(); // not stored, comes from JSON
    });

    it('removes obsolete variables explicitly via delete', async () => {
      await config.set('recipe-a', 'old_threshold', 5);
      await config.set('recipe-a', 'lookback_days', 30);

      // Migration: recipe v2 removes old_threshold
      await config.delete('recipe-a', 'old_threshold');

      const overrides = await config.listByRecipe('recipe-a');
      expect(overrides.old_threshold).toBeUndefined();
      expect(overrides.lookback_days).toBe(30);
    });
  });
});
