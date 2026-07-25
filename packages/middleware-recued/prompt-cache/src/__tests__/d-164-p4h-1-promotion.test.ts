import { describe, expect, it } from 'vitest';

import {
  composePromotionKey,
  createPromotionTracker,
  DEFAULT_PROMOTION_THRESHOLD,
} from '../templates/audit-grow/promotion';
import {
  composePromotionKey as composePromotionKeyFromPublicBarrel,
  createPromotionTracker as createPromotionTrackerFromPublicBarrel,
  DEFAULT_PROMOTION_THRESHOLD as DEFAULT_PROMOTION_THRESHOLD_FROM_PUBLIC_BARREL,
} from '../templates/index';
import type {
  CreatePromotionTrackerOptions,
  PromotionKeyInput,
  PromotionTracker,
} from '../templates/index';
import type { SlotName } from '../types';

const keyFor = (
  slot_grammar: ReadonlyArray<SlotName> = ['entity.name'],
  locale = 'en',
): string => composePromotionKey({ slot_grammar, locale });

const expectBadThreshold = (threshold: unknown): void => {
  const makeTracker = () => createPromotionTracker({ threshold: threshold as number });
  expect(makeTracker).toThrow(RangeError);
  expect(makeTracker).toThrow('positive integer');
  expect(makeTracker).toThrow(String(JSON.stringify(threshold)));
};

describe('D-164 P4h-1 composePromotionKey', () => {
  it('returns a string key', () => {
    expect(typeof keyFor(['entity.name'], 'en')).toBe('string');
  });

  it('is deterministic for the same input', () => {
    const input = {
      locale: 'en',
      slot_grammar: ['entity.name', 'entity.email'] as const,
    };

    expect(composePromotionKey(input)).toBe(composePromotionKey(input));
  });

  it('produces different keys for different locales', () => {
    const grammar = ['entity.name'] as const;

    expect(composePromotionKey({ locale: 'en', slot_grammar: grammar }))
      .not.toBe(composePromotionKey({ locale: 'fr', slot_grammar: grammar }));
  });

  it('sorts slot_grammar before composing the key', () => {
    expect(keyFor(['entity.name', 'entity.email']))
      .toBe(keyFor(['entity.email', 'entity.name']));
  });

  it('preserves duplicate slot_grammar entries as a multiset', () => {
    expect(keyFor(['entity.name']))
      .not.toBe(keyFor(['entity.name', 'entity.name']));
  });

  it('produces a stable key for empty slot_grammar', () => {
    const first = keyFor([], 'en');
    const second = keyFor([], 'en');

    expect(first).toBe(second);
    expect(first).not.toBe('');
    expect(first).not.toBeNull();
    expect(first).not.toBeUndefined();
  });

  it('does not collide when locale contains the legacy pipe separator', () => {
    const pipeLocaleKey = keyFor(['entity.name'], 'en|entity.email');
    const differentBucketKey = keyFor(['entity.email', 'entity.name'], 'en');

    expect(pipeLocaleKey).not.toBe(differentBucketKey);
  });

  it('keeps different locale and slot-kind combinations distinct', () => {
    const keys = new Set([
      keyFor([], 'en'),
      keyFor(['entity.name'], 'en'),
      keyFor(['entity.email'], 'en'),
      keyFor(['entity.name', 'entity.email'], 'en'),
      keyFor(['entity.name'], 'fr'),
      keyFor(['entity.email'], 'fr'),
    ]);

    expect(keys.size).toBe(6);
  });
});

describe('D-164 P4h-1 DEFAULT_PROMOTION_THRESHOLD', () => {
  it('locks the default threshold at design O-6 value 3', () => {
    expect(DEFAULT_PROMOTION_THRESHOLD).toBe(3);
  });
});

describe('D-164 P4h-1 createPromotionTracker threshold validation', () => {
  it('uses the default threshold when threshold is omitted', () => {
    const tracker = createPromotionTracker();
    const key = 'default-threshold';

    tracker.record(key);
    tracker.record(key);
    expect(tracker.shouldSuggest(key)).toBe(false);

    tracker.record(key);
    expect(tracker.shouldSuggest(key)).toBe(true);
  });

  it('accepts threshold=1', () => {
    const tracker = createPromotionTracker({ threshold: 1 });
    const key = 'threshold-one';

    expect(tracker.shouldSuggest(key)).toBe(false);
    tracker.record(key);
    expect(tracker.shouldSuggest(key)).toBe(true);
  });

  it('accepts threshold=5', () => {
    const tracker = createPromotionTracker({ threshold: 5 });
    const key = 'threshold-five';

    for (let i = 0; i < 4; i += 1) tracker.record(key);
    expect(tracker.shouldSuggest(key)).toBe(false);

    tracker.record(key);
    expect(tracker.shouldSuggest(key)).toBe(true);
  });

  it('throws RangeError for threshold=0', () => {
    expectBadThreshold(0);
  });

  it('throws RangeError for threshold=-1', () => {
    expectBadThreshold(-1);
  });

  it('throws RangeError for threshold=NaN', () => {
    expectBadThreshold(Number.NaN);
  });

  it('throws RangeError for threshold=Infinity', () => {
    expectBadThreshold(Number.POSITIVE_INFINITY);
  });

  it('throws RangeError for threshold=1.5', () => {
    expectBadThreshold(1.5);
  });

  it('throws RangeError for threshold=-0', () => {
    expectBadThreshold(-0);
  });

  it('throws RangeError for threshold=null', () => {
    expectBadThreshold(null);
  });
});

describe('D-164 P4h-1 PromotionTracker state transitions', () => {
  it('record returns the new count', () => {
    const tracker = createPromotionTracker();
    const key = 'record-count';

    expect(tracker.record(key)).toBe(1);
    expect(tracker.record(key)).toBe(2);
    expect(tracker.record(key)).toBe(3);
  });

  it('count starts at 0 for an unrecorded key', () => {
    expect(createPromotionTracker().count('unseen')).toBe(0);
  });

  it('count reflects records for a key', () => {
    const tracker = createPromotionTracker();
    const key = 'counted';

    tracker.record(key);
    tracker.record(key);

    expect(tracker.count(key)).toBe(2);
  });

  it('shouldSuggest is false below threshold', () => {
    const tracker = createPromotionTracker({ threshold: 3 });
    const key = 'below-threshold';

    tracker.record(key);
    tracker.record(key);

    expect(tracker.shouldSuggest(key)).toBe(false);
  });

  it('shouldSuggest is true at threshold', () => {
    const tracker = createPromotionTracker({ threshold: 3 });
    const key = 'at-threshold';

    tracker.record(key);
    tracker.record(key);
    tracker.record(key);

    expect(tracker.shouldSuggest(key)).toBe(true);
  });

  it('shouldSuggest remains true at and above threshold until reset', () => {
    const tracker = createPromotionTracker({ threshold: 2 });
    const key = 'level-triggered';

    tracker.record(key);
    tracker.record(key);

    expect(tracker.shouldSuggest(key)).toBe(true);
    expect(tracker.shouldSuggest(key)).toBe(true);

    tracker.record(key);
    expect(tracker.shouldSuggest(key)).toBe(true);
  });

  it('reset zeros the count', () => {
    const tracker = createPromotionTracker();
    const key = 'reset-count';

    tracker.record(key);
    tracker.reset(key);

    expect(tracker.count(key)).toBe(0);
    expect(tracker.shouldSuggest(key)).toBe(false);
  });

  it('reset on an unrecorded key is a no-op', () => {
    const tracker = createPromotionTracker();

    expect(() => tracker.reset('unrecorded')).not.toThrow();
    expect(tracker.count('unrecorded')).toBe(0);
  });

  it('reset on a key already at count 0 is a no-op', () => {
    const tracker = createPromotionTracker();
    const key = 'zero-count';

    tracker.record(key);
    tracker.reset(key);

    expect(() => tracker.reset(key)).not.toThrow();
    expect(tracker.count(key)).toBe(0);
  });

  it('keeps record and reset operations independent per key', () => {
    const tracker = createPromotionTracker({ threshold: 2 });
    const a = 'key-a';
    const b = 'key-b';

    tracker.record(a);
    tracker.record(a);
    tracker.record(b);

    expect(tracker.count(a)).toBe(2);
    expect(tracker.count(b)).toBe(1);

    tracker.reset(a);

    expect(tracker.count(a)).toBe(0);
    expect(tracker.count(b)).toBe(1);
    expect(tracker.shouldSuggest(b)).toBe(false);
  });

  it('counts from 1 again after reset', () => {
    const tracker = createPromotionTracker();
    const key = 'after-reset';

    tracker.record(key);
    tracker.record(key);
    tracker.reset(key);

    expect(tracker.record(key)).toBe(1);
    expect(tracker.count(key)).toBe(1);
  });

  it('fires shouldSuggest after one record with threshold=1', () => {
    const tracker = createPromotionTracker({ threshold: 1 });
    const key = 'one-record';

    expect(tracker.record(key)).toBe(1);
    expect(tracker.shouldSuggest(key)).toBe(true);
  });
});

describe('D-164 P4h-1 PromotionTracker instance independence', () => {
  it('does not share state between two trackers built from the same options', () => {
    const first = createPromotionTracker({ threshold: 2 });
    const second = createPromotionTracker({ threshold: 2 });
    const key = 'same-options';

    first.record(key);
    first.record(key);

    expect(first.shouldSuggest(key)).toBe(true);
    expect(second.count(key)).toBe(0);
    expect(second.shouldSuggest(key)).toBe(false);
  });

  it('does not leak reset or record operations between instances', () => {
    const first = createPromotionTracker({ threshold: 2 });
    const second = createPromotionTracker({ threshold: 2 });
    const key = 'isolated';

    first.record(key);
    first.record(key);
    second.record(key);
    first.reset(key);

    expect(first.count(key)).toBe(0);
    expect(second.count(key)).toBe(1);
    expect(second.shouldSuggest(key)).toBe(false);
  });
});

describe('D-164 P4h-1 public barrel integration', () => {
  it('composes a public-barrel key and suggests after the default threshold', () => {
    const input: PromotionKeyInput = {
      locale: 'en',
      slot_grammar: ['entity.email', 'entity.name'],
    };
    const options: CreatePromotionTrackerOptions = {};
    const key = composePromotionKeyFromPublicBarrel(input);
    const tracker: PromotionTracker = createPromotionTrackerFromPublicBarrel(options);

    for (let i = 0; i < DEFAULT_PROMOTION_THRESHOLD_FROM_PUBLIC_BARREL; i += 1) {
      tracker.record(key);
    }

    expect(tracker.shouldSuggest(key)).toBe(true);
  });
});
