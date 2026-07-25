import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_DOT_SEGMENT_EVENT_TYPE_PROFILE_PRESETS,
  webhookDotSegmentEventTypeProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';
import {
  createWebhookDotSegmentEventTypeParser,
} from '../webhook-dot-segment-event-type-parser.js';

const PRESET = {
  kind: 'lowercase_dot_segment_event_type.v1',
  segment_count: 2,
  max_segment_characters: 63,
} as const;

describe('D-201 Slice 9I dot-segment event-type parser', () => {
  it('accepts exact lowercase identifier segments at bounded lengths', () => {
    const parser = createWebhookDotSegmentEventTypeParser(PRESET);
    for (const value of [
      'a.b',
      'subscription.updated',
      'transaction.payment_failed',
      `${'a'.repeat(63)}.${'b'.repeat(63)}`,
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(createWebhookDotSegmentEventTypeParser({
      ...PRESET,
      segment_count: 1,
      max_segment_characters: 128,
    }).parse(`a${'0'.repeat(127)}`)).toBe(`a${'0'.repeat(127)}`);
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong segment counts, alphabets, bounds, controls, and coercion', () => {
    const parser = createWebhookDotSegmentEventTypeParser(PRESET);
    for (const value of [
      '',
      'subscription',
      'subscription.updated.extra',
      '.updated',
      'subscription.',
      'subscription..updated',
      'Subscription.updated',
      'subscription.Updated',
      '1subscription.updated',
      'subscription.1updated',
      'subscription.update-d',
      'subscription/update',
      `${'a'.repeat(64)}.b`,
      `a.${'b'.repeat(64)}`,
      `a.${'b'.repeat(61)}\n`,
      `a.${'b'.repeat(61)}\r`,
      `a.${'b'.repeat(60)}\r\n`,
      `a.${'b'.repeat(61)}\u2028`,
      `a.${'b'.repeat(61)}\u2029`,
      `a.${'b'.repeat(61)}\u0000`,
      null,
      1,
      new String('subscription.updated'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('accepts only exact own-data bounded presets without executing accessors', () => {
    expect(() => createWebhookDotSegmentEventTypeParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, segment_count: 0 },
      { ...PRESET, segment_count: 17 },
      { ...PRESET, segment_count: 1.5 },
      { ...PRESET, max_segment_characters: 0 },
      { ...PRESET, max_segment_characters: 1.5 },
      { ...PRESET, max_segment_characters: 64 },
      Object.create(PRESET),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error('hostile event-type preset');
        },
      }),
    ]) {
      expect(() => createWebhookDotSegmentEventTypeParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = {
      kind: 'lowercase_dot_segment_event_type.v1',
      segment_count: 2,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_segment_characters', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 63;
      },
    });
    expect(() => createWebhookDotSegmentEventTypeParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });

  it('binds only Paddle to the grammar through trusted profile data', () => {
    const selected = webhookDotSegmentEventTypeProfilePreset(
      'paddle.notification.v1',
    );
    expect(selected).toEqual({
      profile_id: 'paddle.notification.v1',
      parser: PRESET,
    });
    expect(webhookDotSegmentEventTypeProfilePreset('stripe.event.v1')).toBeNull();
    expect(Object.values(WEBHOOK_DOT_SEGMENT_EVENT_TYPE_PROFILE_PRESETS)
      .map((value) => value?.profile_id)).toEqual(['paddle.notification.v1']);
    expect(Object.isFrozen(WEBHOOK_DOT_SEGMENT_EVENT_TYPE_PROFILE_PRESETS))
      .toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
