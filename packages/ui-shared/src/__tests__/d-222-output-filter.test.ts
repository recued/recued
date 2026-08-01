import { describe, expect, it } from 'vitest';
import type { ResolvedFilterDescriptor } from '@recued/contracts';

import {
  dedupeOutputRowsById,
  initialOutputFilterState,
  isResolvedFilterDescriptor,
  outputFilterInvocation,
  outputFilterKey,
  outputFilterPageConfig,
  outputFilterSearchConfig,
  setOutputFilterDraftValue,
  validateOutputFilterDraft,
} from '../output-filter.js';

const descriptor = (): ResolvedFilterDescriptor => ({
  section_index: 2,
  recipe_hash: 'authored-hash',
  fields: ['query'],
  hidden: ['string_value', 'number_value', 'boolean_value', 'array_value', 'null_value', 'future_value', 'absent', 'cursor'],
  submit: 'Search',
  definitions: {
    query: { label: 'Query', type: 'text', default: 'executed' },
    string_value: { label: 'String', type: 'text', default: 'text' },
    number_value: { label: 'Number', type: 'number', default: 25 },
    boolean_value: { label: 'Boolean', type: 'boolean', default: false },
    array_value: { label: 'Array', type: 'array', default: ['a', 'b'] } as never,
    null_value: { label: 'Null', type: 'future_null', default: null } as never,
    future_value: { label: 'Future', type: 'future_widget', default: { exact: true } } as never,
    absent: { label: 'Absent', type: 'future_widget', optional: true } as never,
    cursor: '',
  },
  values: {
    query: 'executed',
    string_value: 'text',
    number_value: 25,
    boolean_value: false,
    array_value: ['a', 'b'],
    null_value: null,
    future_value: { exact: true },
    cursor: 'page-2',
  },
  paging: { next_cursor: 'page-3', prev_cursor: 'page-1' },
});

describe('D-222 typed output-filter state', () => {
  it('keeps hidden JSON values typed and absent values absent', () => {
    const d = descriptor();
    const state = initialOutputFilterState(d);
    const config = outputFilterSearchConfig(d, state);

    expect(config).toMatchObject({
      query: 'executed',
      string_value: 'text',
      number_value: 25,
      boolean_value: false,
      array_value: ['a', 'b'],
      null_value: null,
      future_value: { exact: true },
      cursor: '',
    });
    expect(Object.prototype.hasOwnProperty.call(config, 'absent')).toBe(false);
    expect(typeof config.number_value).toBe('number');
    expect(typeof config.boolean_value).toBe('boolean');
    expect(Array.isArray(config.array_value)).toBe(true);
  });

  it('never validates hidden values the owner cannot edit', () => {
    const d = descriptor();
    d.values.query = '';
    d.values.number_value = 'not-a-number';
    const issues = validateOutputFilterDraft(d, initialOutputFilterState(d));
    expect(issues).toEqual([{ key: 'query', message: 'Required' }]);
    expect(issues.some((issue) => issue.key === 'number_value')).toBe(false);
  });

  it('search resets cursor and paging retains last executed fields', () => {
    const d = descriptor();
    const initial = initialOutputFilterState(d);
    const dirty = setOutputFilterDraftValue(d, initial, 'query', 'edited');

    expect(dirty.dirty).toBe(true);
    expect(outputFilterSearchConfig(d, dirty)).toMatchObject({
      query: 'edited',
      cursor: '',
    });
    expect(() => outputFilterPageConfig(d, dirty, 'page-3')).toThrow(/Run Search/);
    expect(outputFilterPageConfig(d, initial, 'page-3')).toMatchObject({
      query: 'executed',
      cursor: 'page-3',
    });
  });

  it('derives stable stored-snapshot provenance without copying an allowlist', () => {
    const d = descriptor();
    expect(outputFilterKey('jobs', d)).toBe('jobs:authored-hash:2');
    expect(outputFilterInvocation(d)).toEqual({
      kind: 'output.filter',
      recipe_hash: 'authored-hash',
      section_index: 2,
    });
  });

  it('shares one strict transport guard across result consumers', () => {
    const valid = descriptor();
    expect(isResolvedFilterDescriptor(valid)).toBe(true);
    expect(isResolvedFilterDescriptor({ ...valid, section_index: -1 })).toBe(false);
    expect(isResolvedFilterDescriptor({
      ...valid,
      paging: { next_cursor: 42 },
    })).toBe(false);
    expect(isResolvedFilterDescriptor({
      ...valid,
      hidden: [...valid.hidden, 'secret'],
      definitions: {
        ...valid.definitions,
        secret: { label: 'Secret', type: 'secret' },
      },
    })).toBe(false);
  });

  it('deduplicates weakly-consistent page rows by id and preserves unkeyed rows', () => {
    expect(dedupeOutputRowsById([
      { id: 'a', value: 1 },
      { id: 'a', value: 2 },
      { id: 3, value: 3 },
      { id: 3, value: 4 },
      { value: 5 },
      { value: 6 },
    ])).toEqual([
      { id: 'a', value: 1 },
      { id: 3, value: 3 },
      { value: 5 },
      { value: 6 },
    ]);
  });
});
