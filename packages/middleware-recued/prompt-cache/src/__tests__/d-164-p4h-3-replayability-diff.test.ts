import { describe, expect, it } from 'vitest';

import {
  classifyReplayDiff,
  DEFAULT_NOVEL_TOKEN_MIN_LENGTH,
} from '../templates/audit-grow/replayability/diff';
import {
  classifyReplayDiff as classifyReplayDiffFromAuditGrowBarrel,
  DEFAULT_NOVEL_TOKEN_MIN_LENGTH as DEFAULT_NOVEL_TOKEN_MIN_LENGTH_FROM_AUDIT_GROW_BARREL,
} from '../templates/audit-grow/index';
import {
  classifyReplayDiff as classifyReplayDiffFromPublicBarrel,
  DEFAULT_NOVEL_TOKEN_MIN_LENGTH as DEFAULT_NOVEL_TOKEN_MIN_LENGTH_FROM_PUBLIC_BARREL,
} from '../templates/index';
import type { DiffClassification } from '../templates/index';

const classify = (
  input: unknown,
  output: unknown,
  novel_token_min_length?: number,
): DiffClassification =>
  classifyReplayDiff({
    input,
    output,
    ...(novel_token_min_length === undefined
      ? {}
      : { novel_token_min_length }),
  });

describe('D-164 P4h-3 DEFAULT_NOVEL_TOKEN_MIN_LENGTH', () => {
  it('is 3', () => {
    expect(DEFAULT_NOVEL_TOKEN_MIN_LENGTH).toBe(3);
  });
});

describe('D-164 P4h-3 classifyReplayDiff - stable_replay basics', () => {
  it('classifies output whose tokens all appear in input as stable_replay', () => {
    expect(
      classify(
        { name: 'ada', status: 'open', source: 'crm' },
        { name: 'ada', status: 'open' },
      ),
    ).toEqual({
      kind: 'stable_replay',
      novel_tokens: [],
    });
  });

  it('shares the empty novel_tokens singleton across stable_replay calls', () => {
    const a = classify(
      { name: 'ada', status: 'open' },
      { name: 'ada' },
    );
    const b = classify(
      { name: 'grace', status: 'open' },
      { status: 'open' },
    );

    expect(a.novel_tokens).toBe(b.novel_tokens);
  });

  it('returns a frozen stable_replay classification end-to-end', () => {
    const result = classify(
      { name: 'ada', status: 'open' },
      { status: 'open' },
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.novel_tokens)).toBe(true);
  });
});

describe('D-164 P4h-3 classifyReplayDiff - freeform_hole basics', () => {
  it('classifies a token absent from input as freeform_hole', () => {
    expect(
      classify({ answer: 'known' }, { answer: 'zulip' }),
    ).toEqual({
      kind: 'freeform_hole',
      novel_tokens: ['"zulip"'],
    });
  });

  it('returns a frozen freeform_hole classification end-to-end', () => {
    const result = classify({ answer: 'known' }, { answer: 'zulip' });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.novel_tokens)).toBe(true);
  });

  it('reports multiple distinct novel tokens in first-seen order', () => {
    const result = classify(
      { first: 'known', second: 'known', third: 'known' },
      { first: 'delta', second: 'echo', third: 'foxtrot' },
    );

    expect(result.kind).toBe('freeform_hole');
    expect(result.novel_tokens).toEqual([
      '"delta"',
      '"echo"',
      '"foxtrot"',
    ]);
  });

  it('deduplicates duplicate novel tokens in first-seen order', () => {
    const result = classify(
      { values: ['known'] },
      { values: ['repeat', 'repeat', 'fresh', 'repeat'] },
    );

    expect(result.kind).toBe('freeform_hole');
    expect(result.novel_tokens).toEqual(['"repeat"', '"fresh"']);
  });
});

describe('D-164 P4h-3 classifyReplayDiff - token filtering by length', () => {
  it('ignores tokens shorter than the supplied minimum length', () => {
    expect(classify({ value: 0 }, { value: 12 }, 3)).toEqual({
      kind: 'stable_replay',
      novel_tokens: [],
    });
  });

  it('uses the default min length of 3', () => {
    expect(classify({ value: 0 }, { value: 12 }).kind).toBe(
      'stable_replay',
    );

    expect(classify({ value: 0 }, { value: 123 })).toEqual({
      kind: 'freeform_hole',
      novel_tokens: ['123'],
    });
  });

  it('supports a custom minimum length', () => {
    expect(classify({ value: 0 }, { value: 1234 }, 5).kind).toBe(
      'stable_replay',
    );

    expect(classify({ value: 0 }, { value: 12345 }, 5)).toEqual({
      kind: 'freeform_hole',
      novel_tokens: ['12345'],
    });
  });
});

describe('D-164 P4h-3 classifyReplayDiff - tokenization does not split double quotes', () => {
  it('keeps quoted string literals intact while splitting on JSON structural chars', () => {
    const result = classify('key value', { key: 'value' }, 1);

    expect(result.kind).toBe('freeform_hole');
    expect(result.novel_tokens).toEqual(['"key"', '"value"']);
    expect(result.novel_tokens).not.toContain('key');
    expect(result.novel_tokens).not.toContain('value');
  });
});

describe('D-164 P4h-3 classifyReplayDiff - canonical JSON key ordering', () => {
  it('classifies objects with reversed top-level key order identically', () => {
    const a = classify({ b: 1, a: 2 }, { a: 2, b: 1 });
    const b = classify({ a: 2, b: 1 }, { b: 1, a: 2 });

    expect(a).toEqual({
      kind: 'stable_replay',
      novel_tokens: [],
    });
    expect(b).toEqual(a);
  });

  it('sorts nested object keys at every level', () => {
    expect(
      classify(
        { outer: { z: 'last', a: 'first' }, marker: 'kept' },
        { marker: 'kept', outer: { a: 'first', z: 'last' } },
      ),
    ).toEqual({
      kind: 'stable_replay',
      novel_tokens: [],
    });
  });
});

describe('D-164 P4h-3 classifyReplayDiff - mixed primitive types', () => {
  it('handles top-level numbers, booleans, and null', () => {
    expect(classify(123, 123).kind).toBe('stable_replay');
    expect(classify(true, true).kind).toBe('stable_replay');
    expect(classify(null, null).kind).toBe('stable_replay');
  });

  it('handles nested primitives and substring number matches', () => {
    expect(
      classify(
        {
          empty: null,
          flag: true,
          id: 912345,
          nested: { ok: false },
        },
        {
          empty: null,
          flag: true,
          id: 123,
          nested: { ok: false },
        },
      ),
    ).toEqual({
      kind: 'stable_replay',
      novel_tokens: [],
    });
  });
});

describe('D-164 P4h-3 classifyReplayDiff - escaped content in strings', () => {
  it('classifies escaped string content as stable when canonical bytes match', () => {
    expect(
      classify(
        { note: 'line\nbreak', path: 'C:\\tmp\\file' },
        { note: 'line\nbreak', path: 'C:\\tmp\\file' },
      ),
    ).toEqual({
      kind: 'stable_replay',
      novel_tokens: [],
    });
  });

  it('reports escaped string content when canonical bytes are absent', () => {
    const result = classify(
      { note: 'line\nbreak' },
      { note: 'line\tbreak' },
    );

    expect(result.kind).toBe('freeform_hole');
    expect(result.novel_tokens).toEqual(['"line\\tbreak"']);
  });
});

describe('D-164 P4h-3 classifyReplayDiff - RangeError on bad novel_token_min_length', () => {
  it('throws RangeError for 0', () => {
    expect(() => classify({ value: 1 }, { value: 1 }, 0)).toThrow(RangeError);
  });

  it('throws RangeError for -1', () => {
    expect(() => classify({ value: 1 }, { value: 1 }, -1)).toThrow(
      RangeError,
    );
  });

  it('throws RangeError for 1.5', () => {
    expect(() => classify({ value: 1 }, { value: 1 }, 1.5)).toThrow(
      RangeError,
    );
  });

  it('does not throw for the boundary value 1', () => {
    expect(() => classify({ value: 1 }, { value: 1 }, 1)).not.toThrow();
  });
});

describe('D-164 P4h-3 classifyReplayDiff - TypeError on non-stringifiable input/output', () => {
  it('throws TypeError when a top-level function input canonicalizes to a non-string', () => {
    expect(() => classify(() => 0, {})).toThrow(TypeError);
  });

  it('throws TypeError when a top-level Symbol output canonicalizes to a non-string', () => {
    expect(() => classify({}, Symbol('output'))).toThrow(TypeError);
  });
});

describe('D-164 P4h-3 export-surface symmetry with replayability structural.ts (P4h-2)', () => {
  it('re-exports classifyReplayDiff via templates/audit-grow/index', () => {
    expect(classifyReplayDiffFromAuditGrowBarrel).toBe(classifyReplayDiff);
  });

  it('re-exports DEFAULT_NOVEL_TOKEN_MIN_LENGTH via templates/audit-grow/index', () => {
    expect(DEFAULT_NOVEL_TOKEN_MIN_LENGTH_FROM_AUDIT_GROW_BARREL).toBe(
      DEFAULT_NOVEL_TOKEN_MIN_LENGTH,
    );
  });

  it('re-exports classifyReplayDiff via templates/index public barrel', () => {
    expect(classifyReplayDiffFromPublicBarrel).toBe(classifyReplayDiff);
  });

  it('re-exports DEFAULT_NOVEL_TOKEN_MIN_LENGTH via templates/index public barrel', () => {
    expect(DEFAULT_NOVEL_TOKEN_MIN_LENGTH_FROM_PUBLIC_BARREL).toBe(
      DEFAULT_NOVEL_TOKEN_MIN_LENGTH,
    );
  });
});
