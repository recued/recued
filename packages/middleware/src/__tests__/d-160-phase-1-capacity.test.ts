/** D-160 P1 -- capacity envelope primitive.
 *
 *  Spec: docs/d-160-spec.md sections N.4 / A.1 and Must Hold I-6.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TURNS,
  capacityBreach,
  createCapacity,
  narrowCapacity,
  type Capacity,
} from '@recued/middleware';

describe('D-160 P1 createCapacity', () => {
  it('defaults max_turns to DEFAULT_MAX_TURNS', () => {
    expect(createCapacity()).toEqual({ max_turns: DEFAULT_MAX_TURNS });
  });

  it('keeps explicit positive ceilings and dedupes capability strings', () => {
    expect(
      createCapacity({
        max_turns: 3,
        token_ceiling: 100,
        capabilities: ['mail', 'calendar', 'mail'],
      }),
    ).toEqual({
      max_turns: 3,
      token_ceiling: 100,
      capabilities: ['mail', 'calendar'],
    });
  });

  it('accepts an explicit empty capability set', () => {
    expect(createCapacity({ capabilities: [] })).toEqual({
      max_turns: DEFAULT_MAX_TURNS,
      capabilities: [],
    });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'throws for invalid max_turns %s',
    (max_turns) => {
      expect(() => createCapacity({ max_turns })).toThrow(RangeError);
    },
  );

  it.each([0, -2, 2.25])(
    'throws for invalid token_ceiling %s',
    (token_ceiling) => {
      expect(() => createCapacity({ token_ceiling })).toThrow(RangeError);
    },
  );

  it.each([
    { capabilities: 'mail' as unknown as readonly string[] },
    { capabilities: ['mail', 42] as unknown as readonly string[] },
  ])('throws for non string-array capabilities %#', (partial) => {
    expect(() => createCapacity(partial)).toThrow(TypeError);
  });
});

describe('D-160 P1 narrowCapacity', () => {
  it('uses element-wise minimum for max_turns and token_ceiling', () => {
    expect(
      narrowCapacity(
        createCapacity({ max_turns: 8, token_ceiling: 200 }),
        { max_turns: 3, token_ceiling: 50 },
      ),
    ).toEqual({ max_turns: 3, token_ceiling: 50 });
  });

  it('leaves an absent token_ceiling absent when neither side declares one', () => {
    expect(narrowCapacity(createCapacity({ max_turns: 4 }), {})).toEqual({
      max_turns: 4,
    });
  });

  it('intersects capability sets and preserves base order', () => {
    expect(
      narrowCapacity(
        createCapacity({
          max_turns: 4,
          capabilities: ['mail', 'calendar', 'files', 'mail'],
        }),
        { capabilities: ['calendar', 'mail', 'crm'] },
      ),
    ).toEqual({
      max_turns: 4,
      capabilities: ['mail', 'calendar'],
    });
  });

  it('treats undefined capabilities as no additional restriction', () => {
    expect(
      narrowCapacity(createCapacity({ capabilities: ['mail'] }), {}),
    ).toEqual({
      max_turns: DEFAULT_MAX_TURNS,
      capabilities: ['mail'],
    });
    expect(
      narrowCapacity(createCapacity(), { capabilities: ['mail'] }),
    ).toEqual({
      max_turns: DEFAULT_MAX_TURNS,
      capabilities: ['mail'],
    });
  });

  it('never widens max_turns, token_ceiling, or capabilities', () => {
    const base = createCapacity({
      max_turns: 2,
      token_ceiling: 20,
      capabilities: ['mail'],
    });

    expect(
      narrowCapacity(base, {
        max_turns: 9,
        token_ceiling: 200,
        capabilities: ['mail', 'calendar'],
      }),
    ).toEqual({
      max_turns: 2,
      token_ceiling: 20,
      capabilities: ['mail'],
    });
  });

  it('throws when a contribution narrows max_turns to a non-positive value', () => {
    expect(() =>
      narrowCapacity(createCapacity({ max_turns: 4 }), { max_turns: 0 }),
    ).toThrow(RangeError);
  });

  it('throws when a contribution narrows token_ceiling to a non-positive value', () => {
    expect(() =>
      narrowCapacity(createCapacity({ token_ceiling: 10 }), {
        token_ceiling: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('D-160 P1 capacityBreach', () => {
  const capacity: Capacity = createCapacity({
    max_turns: 2,
    token_ceiling: 10,
  });

  it('returns max_turns once completed turns reach the ceiling', () => {
    expect(capacityBreach({ turns: 2, tokens: 0 }, capacity)).toBe(
      'max_turns',
    );
  });

  it('returns token_ceiling once reported spend reaches the ceiling', () => {
    expect(capacityBreach({ turns: 1, tokens: 10 }, capacity)).toBe(
      'token_ceiling',
    );
  });

  it('returns null while usage is below all declared ceilings', () => {
    expect(capacityBreach({ turns: 1, tokens: 9 }, capacity)).toBeNull();
  });

  it('ignores token_ceiling when token usage is not reported', () => {
    expect(capacityBreach({ turns: 1 }, capacity)).toBeNull();
  });
});
