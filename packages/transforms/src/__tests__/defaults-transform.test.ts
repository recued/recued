/** `defaults` — N defaults in one step.
 *
 *  ⛔ THE LOAD-BEARING PROPERTY IS EQUIVALENCE WITH `default`, not the new
 *  transform's own behaviour. This exists to fold ~1,276 existing steps across
 *  511 runs; any per-field divergence changes those call sites the moment they
 *  are folded, and the difference would only show on a field that is
 *  legitimately `''` — which reads as a data problem, not a transform problem,
 *  and would be attributed to the recipe.
 *
 *  So the equivalence is asserted as a PROPERTY over a shared table of inputs
 *  rather than case by case: the two transforms must agree on every one.
 */

import { describe, expect, it } from 'vitest';
import { getTransform } from '../index.js';
import { getTransformSchema } from '../schemas.js';

const run = (name: string, params: Record<string, unknown>): unknown =>
  getTransform(name)!(params, undefined as never);

/** Values chosen to straddle every branch of `default`: the nullish trio, the
 *  empty string (treated as missing — the subtle one), and falsy-but-present
 *  values that must survive. */
const CASES: readonly { value: unknown; fallback: unknown }[] = [
  { value: 'x', fallback: 'fb' },
  { value: '', fallback: 'fb' },            // empty string IS missing
  { value: null, fallback: 'fb' },
  { value: undefined, fallback: 'fb' },
  { value: 0, fallback: 'fb' },             // falsy but PRESENT — must survive
  { value: false, fallback: 'fb' },         // ditto
  { value: [], fallback: 'fb' },            // ditto
  { value: 'x', fallback: undefined },
  { value: null, fallback: undefined },     // no fallback → null, never undefined
  { value: null, fallback: 0 },
];

describe('defaults — equivalence with `default`', () => {
  it('agrees with `default` on every field, for every case', () => {
    for (const c of CASES) {
      const single = run('default', { value: c.value, fallback: c.fallback });
      const out = run('defaults', {
        fields: { f: { value: c.value, fallback: c.fallback } },
      }) as Record<string, unknown>;
      expect(out.f, `mismatch for ${JSON.stringify(c)}`).toStrictEqual(single);
    }
  });

  // Guard the guard: if the table ever stops covering the empty-string branch,
  // the equivalence above passes while the one subtle case goes unchecked.
  it('the case table actually exercises the empty-string branch', () => {
    expect(CASES.some((c) => c.value === '')).toBe(true);
    expect(run('default', { value: '', fallback: 'fb' })).toBe('fb');
  });
});

describe('defaults — shape', () => {
  it('yields one key per field, addressable as {{step.<id>.<name>}}', () => {
    expect(run('defaults', {
      fields: {
        vendor: { value: 'Acme', fallback: '' },
        amount: { value: null, fallback: 0 },
        note: { value: '', fallback: 'none' },
      },
    })).toStrictEqual({ vendor: 'Acme', amount: 0, note: 'none' });
  });

  it('a field with no fallback resolves to null, never a missing key', () => {
    // Downstream `is_null` / `coalesce` depend on the key EXISTING; dropping it
    // would turn a resolved-but-empty field into a missing-namespace read.
    const out = run('defaults', { fields: { a: { value: null } } }) as Record<string, unknown>;
    expect('a' in out).toBe(true);
    expect(out.a).toBeNull();
  });

  it('accepts a bare value as shorthand for { value }', () => {
    expect(run('defaults', { fields: { a: 'x', b: null } }))
      .toStrictEqual({ a: 'x', b: null });
  });

  it('non-object / absent `fields` yields {} rather than throwing', () => {
    for (const bad of [undefined, null, 'str', 42, ['a']]) {
      expect(run('defaults', { fields: bad })).toStrictEqual({});
    }
  });

  it('refuses prototype-polluting field names', () => {
    const out = run('defaults', {
      fields: { __proto__: { value: 'no' }, constructor: { value: 'no' }, ok: { value: 'yes' } },
    }) as Record<string, unknown>;
    expect(out.ok).toBe('yes');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe('defaults — registration', () => {
  // Without a TRANSFORM_SCHEMAS entry the recipe validator raises
  // `unknown_transform` (structural.ts reads that table), so a recipe using it
  // would fail validation while the runtime happily ran it.
  it('is registered in BOTH the runtime map and the validator schema table', () => {
    expect(getTransform('defaults')).toBeTypeOf('function');
    expect(getTransformSchema('defaults')).toBeDefined();
    expect(getTransformSchema('defaults')?.fields?.required).toBe(true);
  });
});
