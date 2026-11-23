import { describe, expect, it } from 'vitest';
import { parseSavedDataViewDefinition, sameSavedDataViewDefinition } from '../saved-data-views.js';

describe('saved universal-search result types', () => {
  it('retains reminder status filters and refuses unknown statuses without widening the view', () => {
    const current = { tab: 'search' as const, query: 'clinic', result_type: 'reminder' as const, reminder_state: 'delivered' as const };
    expect(parseSavedDataViewDefinition(current)).toEqual(current);
    expect(sameSavedDataViewDefinition(current, { ...current, reminder_state: 'cancelled' })).toBe(false);
    expect(parseSavedDataViewDefinition({ tab: 'search', query: 'clinic', reminder_state: 'all' })).toEqual({ tab: 'search', query: 'clinic' });
    expect(parseSavedDataViewDefinition({ ...current, reminder_state: 'unknown' })).toBeNull();
    expect(parseSavedDataViewDefinition({ tab: 'contact', query: 'clinic', reminder_state: 'pending' })).toBeNull();
  });
  it('keeps legacy searches on All and treats explicit All as the same definition', () => {
    const legacy = { tab: 'search' as const, query: 'renewal' };
    expect(parseSavedDataViewDefinition(legacy)).toEqual(legacy);
    expect(parseSavedDataViewDefinition({ ...legacy, result_type: 'all' })).toEqual(legacy);
    expect(sameSavedDataViewDefinition(legacy, { ...legacy, result_type: 'all' })).toBe(true);
    expect(sameSavedDataViewDefinition(legacy, { ...legacy, result_type: 'mail' })).toBe(false);
  });
  it('preserves a chosen type and rejects unsupported types or filters on another view', () => {
    expect(parseSavedDataViewDefinition({ tab: 'search', query: 'renewal', result_type: 'chat' }))
      .toEqual({ tab: 'search', query: 'renewal', result_type: 'chat' });
    for (const result_type of ['unknown', '', null, 1, ['mail'], { type: 'mail' }])
      expect(parseSavedDataViewDefinition({ tab: 'search', query: 'renewal', result_type })).toBeNull();
    expect(parseSavedDataViewDefinition({ tab: 'contact', query: 'renewal', result_type: 'mail' })).toBeNull();
    expect(parseSavedDataViewDefinition({ tab: 'search', query: 'renewal', result_type: 'mail', rows: [] })).toBeNull();
  });
});
