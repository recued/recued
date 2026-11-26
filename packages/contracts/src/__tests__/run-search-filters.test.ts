import { describe, expect, it } from 'vitest';
import { parseRunSearchFilters, parseRunSearchScope, resolveRunSearchScope } from '../run-search-filters.js';
import { parseSavedDataViewDefinition, sameSavedDataViewDefinition } from '../saved-data-views.js';

describe('run search settings and fixed windows', () => {
  it('saves only supported relative choices, canonicalizes All and rejects filters that could widen a view', () => {
    const view = { tab: 'search' as const, query: 'invoice', result_type: 'run' as const,
      run_filters: { outcome: 'partial' as const, time_range: '7d' as const } };
    expect(parseSavedDataViewDefinition(view)).toEqual(view);
    expect(sameSavedDataViewDefinition(view, { ...view, run_filters: { ...view.run_filters, outcome: 'failed' } })).toBe(false);
    expect(sameSavedDataViewDefinition(view, { ...view, run_filters: { ...view.run_filters, time_range: '30d' } })).toBe(false);
    const legacy = { tab: 'search' as const, query: 'invoice', result_type: 'run' as const };
    expect(parseSavedDataViewDefinition({ ...legacy, run_filters: { outcome: 'all', time_range: 'all' } })).toEqual(legacy);
    expect(sameSavedDataViewDefinition(legacy, { ...legacy, run_filters: {} })).toBe(true);
    for (const run_filters of [null, [], { outcome: 'succeeded' }, { time_range: 'week' }, { started_from: 1 }, { rows: [] }, { outcome: undefined }]) {
      expect(parseRunSearchFilters(run_filters)).toBeNull();
      expect(parseSavedDataViewDefinition({ ...legacy, run_filters })).toBeNull();
    }
    expect(parseSavedDataViewDefinition({ tab: 'contact', query: '', run_filters: { outcome: 'failed' } })).toBeNull();
  });
  it('resolves rolling durations anew while leaving the saved settings unchanged and validates wire bounds', () => {
    const now = Date.UTC(2026, 10, 23, 12);
    for (const [time_range, days] of [['24h', 1], ['7d', 7], ['30d', 30]] as const) {
      const filters = { outcome: 'failed' as const, time_range };
      expect(resolveRunSearchScope(filters, now)).toEqual({ outcome: 'failed', started_from: now - days * 86400000, started_before: now + 1 });
      expect(resolveRunSearchScope(filters, now + 1000).started_from).toBe(now + 1000 - days * 86400000);
      expect(filters).toEqual({ outcome: 'failed', time_range });
    }
    expect(resolveRunSearchScope({}, now)).toEqual({});
    for (const scope of [{ outcome: 'all' }, { started_from: NaN }, { started_before: Infinity },
      { started_from: 10, started_before: 10 }, { started_from: 10, started_before: 9 }, { time_range: '7d' }])
      expect(parseRunSearchScope(scope)).toBeNull();
    expect(parseRunSearchScope({ outcome: 'unknown', started_from: 0, started_before: 1 })).toEqual({ outcome: 'unknown', started_from: 0, started_before: 1 });
  });
});
