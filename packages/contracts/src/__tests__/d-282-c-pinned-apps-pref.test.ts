/** D-282 slice C — `ui.pinned_apps`, the registry's first OPEN-vocabulary pref.
 *
 *  ⛔⛔ THE TYPE CONDITIONAL ENDS IN `: boolean`, SO A NEW SPEC KIND FALLS
 *  THROUGH RATHER THAN FAILING. `InstancePrefValue` typed this key as `boolean`
 *  for one edit and nothing objected — `DEFAULT_INSTANCE_PREFS` casts through
 *  `Record<string, unknown>` on the way in, so the compiler had nowhere to
 *  speak. A trailing `else` over a registry that grows is a default that lies
 *  about its newest member, and only a runtime assertion catches it.
 *
 *  ⛔ AND `typeof []` IS `'object'`, which the shared `typeof value !== spec.type`
 *  line would reject. The list branch is checked BEFORE it; naming the spec kind
 *  `'object'` to reuse that line would have admitted every object shape. */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INSTANCE_PREFS,
  INSTANCE_PREFS,
  applyPrefsPatch,
  getPref,
} from '../prefs.js';

const patched = (value: unknown): readonly string[] =>
  getPref(applyPrefsPatch({}, { 'ui.pinned_apps': value }), 'ui.pinned_apps');

describe('ui.pinned_apps', () => {
  it('is a list, not a boolean — at runtime, where the type could not say so', () => {
    expect(Array.isArray(DEFAULT_INSTANCE_PREFS['ui.pinned_apps'])).toBe(true);
    expect(DEFAULT_INSTANCE_PREFS['ui.pinned_apps']).toEqual([]);
  });

  it('accepts a list of pack slugs, in the order given', () => {
    expect(patched(['rental-book', 'fleet-money']))
      .toEqual(['rental-book', 'fleet-money']);
  });

  /** Each of these falls back to the default, exactly as a bad boolean does —
   *  the blob is not repaired, because a half-repaired list is a state nobody
   *  authored. */
  it.each([
    ['not an array', 'rental-book'],
    ['a non-string item', ['rental-book', 7]],
    ['a slug the rest of the contract would refuse', ['Not A Slug']],
    ['a trailing-hyphen slug', ['rental-']],
    // A repeated entry would draw the same seat twice.
    ['a duplicate', ['rental-book', 'rental-book']],
  ])('refuses %s', (_name, value) => {
    expect(patched(value)).toEqual([]);
  });

  it('refuses a list past its own ceiling', () => {
    const spec = INSTANCE_PREFS['ui.pinned_apps'];
    const max = (spec as { max_items: number }).max_items;
    const atLimit = Array.from({ length: max }, (_, i) => `pack-${String(i)}`);
    expect(patched(atLimit)).toHaveLength(max);
    expect(patched([...atLimit, 'one-too-many'])).toEqual([]);
  });

  /** ⛔ RE-VALIDATED ON READ, not only on write. A value that predates a rule
   *  change — or a corrupted blob — must fall back rather than reach the
   *  drawer, which is the same discipline every other pref here follows. */
  it('falls back when the STORED value is invalid, not just the incoming one', () => {
    const stored = { 'ui.pinned_apps': ['ok', 'ok'] } as never;
    expect(getPref(applyPrefsPatch(stored, {}), 'ui.pinned_apps')).toEqual([]);
  });

  it('leaves every other pref alone', () => {
    const merged = applyPrefsPatch({}, { 'ui.pinned_apps': ['rental-book'] });
    expect(getPref(merged, 'cache.sync_l2')).toBe(true);
    expect(getPref(merged, 'ui.result_display_mode')).toBe(false);
  });
});
