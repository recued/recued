import { describe, expect, it } from 'vitest';
import { parseSavedDataViewDefinition, sameSavedDataViewDefinition } from '../saved-data-views.js';
import { parseRecordsViewSettings } from '../records-view.js';

const old = { tab: 'records' as const, owner: { publisher: 'vendor', pack_slug: 'shop' }, entity: 'order' };

describe('Records saved browse settings', () => {
  it('preserves older defaults and canonicalizes equivalent filters', () => {
    expect(parseSavedDataViewDefinition(old)).toEqual(old);
    expect(parseSavedDataViewDefinition({ ...old, filters: {}, sort: 'id' })).toEqual(old);
    expect(sameSavedDataViewDefinition(old, { ...old, filters: {}, sort: 'id' })).toBe(true);
    const first = { ...old, filters: { z: { op: 'eq' as const, value: false }, a: { op: 'gte' as const, value: 0 } }, sort: '-a' };
    const second = { ...old, filters: { a: { op: 'gte' as const, value: 0 }, z: { op: 'eq' as const, value: false } }, sort: '-a' };
    expect(sameSavedDataViewDefinition(first, second)).toBe(true);
    expect(sameSavedDataViewDefinition(first, { ...second, sort: 'a' })).toBe(false);
    expect(parseRecordsViewSettings({ filters: { active: false, amount: 0, empty: { op: 'is_null' } } })).toEqual({ filters: {
      active: { op: 'eq', value: false }, amount: { op: 'eq', value: 0 }, empty: { op: 'is_null', value: true },
    } });
  });

  it.each([
    { cursor: 'private-handle' }, { next_cursor: 'next' }, { limit: 100 }, { page: 2 },
    { filters: [] }, { filters: { x: { op: 'sql', value: 'x' } } },
    { filters: { x: null } }, { filters: { x: { op: 'eq', value: null } } },
    { filters: { x: { op: 'ne', value: null } } },
    { filters: { x: { op: 'eq', value: {} } } }, { filters: { x: { op: 'eq' } } },
    { filters: { x: { op: 'eq', value: NaN } } }, { filters: { x: { op: 'eq', value: Infinity } } },
    { filters: { x: { op: 'eq', value: 2 ** 53 } } }, { filters: { x: { op: 'eq', value: 'x'.repeat(2001) } } },
    { filters: { x: { op: 'in', value: [] } } }, { filters: { x: { op: 'in', value: Array(101).fill(1) } } },
    { filters: { x: { op: 'in', value: Array(1) } } },
    { filters: { x: { op: 'is_null', value: 'false' } } }, { filters: { x: { op: 'eq', value: 1, cursor: 'x' } } },
    { filters: { id: 'x' } }, { filters: { 'a.__proto__.b': 'x' } },
    { filters: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`field${i}`, 0])) },
    { sort: '' }, { sort: '--amount' }, { sort: 1 }, { sort: ['amount'] },
  ])('rejects unsupported or transient settings: %j', settings => {
    expect(parseSavedDataViewDefinition({ ...old, ...settings })).toBeNull();
  });

  it('requires a selected kind for query settings but does not depend on a live pack schema', () => {
    expect(parseSavedDataViewDefinition({ ...old, entity: null, sort: '-amount' })).toBeNull();
    expect(parseSavedDataViewDefinition({ ...old, filters: { retired_field: { op: 'prefix', value: '<tag>' } }, sort: '-retired_field' }))
      .toMatchObject({ filters: { retired_field: { op: 'prefix', value: '<tag>' } }, sort: '-retired_field' });
  });
});
