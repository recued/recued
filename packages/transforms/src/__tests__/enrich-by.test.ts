import { describe, expect, it } from 'vitest';
import { enrich_by } from '../collection.js';

const ctx = {} as never;
const run = (p: Record<string, unknown>): Record<string, unknown>[] =>
  enrich_by(p, ctx) as Record<string, unknown>[];

const ROWS = [
  { order: 'A', ref: 'sub_1' },
  { order: 'B', ref: 'sub_2' },
  { order: 'C', ref: 'sub_missing' },
];
const RESPONSES = [
  { id: 'sub_1', values: { description: 'Rear wheel buckled.' } },
  { id: 'sub_2', values: { description: 'Full service.' } },
];

describe('enrich_by', () => {
  it('attaches a field from the second array, matched on a key', () => {
    const out = run({
      array: ROWS, with: RESPONSES, key: 'ref', with_key: 'id',
      fields: { description: 'values.description' },
    });
    expect(out.map((r) => r.description)).toEqual([
      'Rear wheel buckled.', 'Full service.', null,
    ]);
    // The left item's own fields survive untouched.
    expect(out[0]).toMatchObject({ order: 'A', ref: 'sub_1' });
  });

  it('⛔ an unmatched item gets NULL, never a missing key', () => {
    // A renderer reading `row.description` must not see `undefined` for "no
    // match" and for a genuinely absent field identically — one is a join miss,
    // the other is bad data, and they need to look different.
    const [row] = run({
      array: [{ ref: 'nope' }], with: RESPONSES, key: 'ref',
      with_key: 'id', fields: { description: 'values.description' },
    });
    expect('description' in row!).toBe(true);
    expect(row!.description).toBeNull();
  });

  it('compares keys as STRINGS, so a numeric id matches its string form', () => {
    const out = run({
      array: [{ ref: 7 }], with: [{ id: '7', label: 'seven' }],
      key: 'ref', with_key: 'id', fields: { label: 'label' },
    });
    expect(out[0]!.label).toBe('seven');
  });

  it('⛔ FIRST match wins, so a duplicate key is deterministic', () => {
    // Last-one-seen would make the output depend on the right-hand array's
    // order, which a provider list does not promise.
    const out = run({
      array: [{ ref: 'x' }],
      with: [{ id: 'x', label: 'first' }, { id: 'x', label: 'second' }],
      key: 'ref', with_key: 'id', fields: { label: 'label' },
    });
    expect(out[0]!.label).toBe('first');
  });

  it('defaults with_key to key', () => {
    const out = run({
      array: [{ id: 'a' }], with: [{ id: 'a', label: 'A' }],
      key: 'id', fields: { label: 'label' },
    });
    expect(out[0]!.label).toBe('A');
  });

  it('skips right-hand rows whose key is null or absent', () => {
    const out = run({
      array: [{ ref: 'a' }],
      with: [{ id: null, label: 'bad' }, {}, { id: 'a', label: 'good' }],
      key: 'ref', with_key: 'id', fields: { label: 'label' },
    });
    expect(out[0]!.label).toBe('good');
  });

  it('⛔ cannot be used to pollute the prototype', () => {
    const out = run({
      array: [{ ref: 'a' }], with: [{ id: 'a', evil: 'boom' }],
      key: 'ref', with_key: 'id', fields: { __proto__: 'evil', polluted: 'evil' },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('evil');
    // The legitimate field still lands.
    expect(out[0]!.polluted).toBe('boom');
  });

  it('returns [] for a non-array left side, and passes items through with no `with`', () => {
    expect(run({ array: 'nope', with: [], key: 'k', fields: {} })).toEqual([]);
    const out = run({ array: ROWS, with: undefined, key: 'ref', fields: { d: 'x' } });
    expect(out).toHaveLength(3);
    expect(out.every((r) => r.d === null)).toBe(true);
  });
});
