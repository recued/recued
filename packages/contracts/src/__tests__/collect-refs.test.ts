/** Direct unit tests for `collectRefs`.
 *
 *  The L2 step-cache seed parser leans heavily on this — any regression
 *  in ref extraction silently corrupts cache keys. Covers edge cases
 *  not exercised through `analyzeStep`: non-string primitive values,
 *  null / undefined inside structures, very deep nesting at the depth
 *  cap, empty inputs, hint-stripping nuances.
 */

import { describe, it, expect } from 'vitest';
import { collectRefs } from '../resolve.js';

const pathsOf = (refs: Array<{ ns: string; path: string }>) =>
  refs.map((r) => `${r.ns}.${r.path}`);

describe('collectRefs — primitives', () => {
  it('empty string returns no refs', () => {
    expect(collectRefs('')).toEqual([]);
  });

  it('non-ref string returns no refs', () => {
    expect(collectRefs('just plain text')).toEqual([]);
  });

  it('string with bare braces but no namespace returns no refs', () => {
    // "{{...}}" with unknown namespaces should be skipped
    expect(collectRefs('{{unknown.x}}')).toEqual([]);
    expect(collectRefs('{{just_text}}')).toEqual([]);
  });

  it('number / boolean / null at the top level return no refs', () => {
    expect(collectRefs(42)).toEqual([]);
    expect(collectRefs(true)).toEqual([]);
    expect(collectRefs(null)).toEqual([]);
    expect(collectRefs(undefined)).toEqual([]);
  });
});

describe('collectRefs — nested structures', () => {
  it('walks through null / undefined values without crashing', () => {
    const refs = collectRefs({
      x: null,
      y: undefined,
      z: '{{config.n}}',
    });
    expect(pathsOf(refs)).toEqual(['config.n']);
  });

  it('mixes string refs with non-string siblings', () => {
    const refs = collectRefs({
      count: 10,
      flag: true,
      ref: '{{config.x}}',
      nested: { inner: '{{step.load.id}}' },
      list: [5, '{{context.url}}', false],
    });
    expect(pathsOf(refs).sort()).toEqual(
      ['config.x', 'context.url', 'step.load.id'].sort(),
    );
  });

  it('deep nesting within the depth cap is fully walked', () => {
    // 10 levels deep — well inside the 50-level cap.
    let nested: unknown = '{{config.deep}}';
    for (let i = 0; i < 10; i++) nested = { wrap: nested };
    const refs = collectRefs(nested);
    expect(pathsOf(refs)).toEqual(['config.deep']);
  });

  it('respects the depth cap — refs beyond 50 levels are silently dropped', () => {
    let nested: unknown = '{{config.too_deep}}';
    for (let i = 0; i < 60; i++) nested = { wrap: nested };
    const refs = collectRefs(nested);
    // Past the cap → not walked. Empty result, no throw.
    expect(refs).toEqual([]);
  });
});

describe('collectRefs — format hints + edge forms', () => {
  it('strips format hints — same underlying dep as without', () => {
    expect(pathsOf(collectRefs('{{config.x:currency}}'))).toEqual(['config.x']);
    expect(pathsOf(collectRefs('{{config.x:percent}}'))).toEqual(['config.x']);
    expect(pathsOf(collectRefs('{{config.x:date}}'))).toEqual(['config.x']);
    // Unknown hint stays in the path — parseRef only strips recognized
    // FORMAT_HINTS, and an unknown suffix like ":nothint" isn't part of
    // that set. This is conservative: we'd rather treat an unknown hint
    // as a distinct ref than accidentally coalesce two different ones.
    expect(pathsOf(collectRefs('{{config.x:nothint}}'))).toEqual(['config.x:nothint']);
  });

  it('handles whitespace inside ref braces', () => {
    expect(pathsOf(collectRefs('{{  config.x  }}'))).toEqual(['config.x']);
  });

  it('collects refs from inside condition strings', () => {
    // A condition is a string — collectRefs walks it the same as any text.
    const condRefs = collectRefs({
      conditions: [{
        field: '{{step.deal.status}}',
        operator: 'equal',
        value: 'closed_won',
      }],
    });
    expect(pathsOf(condRefs)).toEqual(['step.deal.status']);
  });

  it('orders results by first occurrence across object keys', () => {
    // JavaScript object iteration preserves insertion order; collectRefs
    // must too.
    const refs = collectRefs({
      b: '{{context.later}}',
      a: '{{config.first}}',
      c: '{{step.middle}}',
    });
    expect(pathsOf(refs)).toEqual(['context.later', 'config.first', 'step.middle']);
  });
});

describe('collectRefs — dedup', () => {
  it('returns each unique ns.path exactly once', () => {
    const refs = collectRefs({
      a: '{{config.x}} {{config.x}}',
      b: '{{config.x:currency}}',
      c: ['{{config.x}}', { d: '{{config.x}}' }],
    });
    expect(pathsOf(refs)).toEqual(['config.x']);
    expect(refs).toHaveLength(1);
  });

  it('treats ns+path as the identity (different ns → different entries)', () => {
    const refs = collectRefs('{{config.x}} and {{context.x}} and {{step.x}}');
    expect(pathsOf(refs).sort()).toEqual(['config.x', 'context.x', 'step.x'].sort());
  });
});
