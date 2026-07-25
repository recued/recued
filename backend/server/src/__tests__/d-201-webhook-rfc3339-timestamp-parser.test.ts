import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_RFC3339_TIMESTAMP_PROFILE_PRESETS,
  webhookRfc3339TimestampProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import {
  createWebhookRfc3339TimestampParser,
} from '../webhook-rfc3339-timestamp-parser.js';

const PRESET = {
  kind: 'strict_rfc3339_milliseconds.v1',
  max_bytes: 64,
} as const;

describe('D-201 Slice 9G strict RFC3339 timestamp parser', () => {
  it('normalizes exact calendar, fractional-second, and offset forms', () => {
    const parser = createWebhookRfc3339TimestampParser(PRESET);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
    expect(webhookRfc3339TimestampProfilePreset('paddle.notification.v1'))
      .toEqual({
        profile_id: 'paddle.notification.v1',
        parser: PRESET,
      });
    expect(Object.values(WEBHOOK_RFC3339_TIMESTAMP_PROFILE_PRESETS)
      .map((value) => value?.profile_id)).toEqual(['paddle.notification.v1']);
    const minimum = createWebhookRfc3339TimestampParser({
      ...PRESET,
      max_bytes: 20,
    });
    expect(minimum.parse('1970-01-01T00:00:00Z')).toBe(0);
    expect(minimum.parse('1970-01-01T00:00:00.0Z')).toBeNull();

    for (const [value, expected] of [
      ['1970-01-01T00:00:00Z', 0],
      ['2024-02-29T12:34:56Z', Date.parse('2024-02-29T12:34:56Z')],
      ['2026-07-12T20:00:00.1Z', Date.parse('2026-07-12T20:00:00.100Z')],
      ['2026-07-12T20:00:00.123456789Z',
        Date.parse('2026-07-12T20:00:00.123Z')],
      ['2026-07-12T13:00:00.125-07:00',
        Date.parse('2026-07-12T20:00:00.125Z')],
      ['2026-07-13T03:30:00+07:30',
        Date.parse('2026-07-12T20:00:00.000Z')],
    ] as const) {
      expect(parser.parse(value)).toBe(expected);
    }
  });

  it('rejects malformed, impossible, pre-epoch, oversized, and coerced inputs', () => {
    const parser = createWebhookRfc3339TimestampParser(PRESET);
    for (const value of [
      '',
      '1969-12-31T23:59:59Z',
      '2026-00-01T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2024-02-30T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:60:00Z',
      '2026-01-01T00:00:60Z',
      '2026-01-01T00:00:00.1234567890Z',
      '2026-01-01T00:00:00z',
      '2026-01-01 00:00:00Z',
      '2026-01-01T00:00:00',
      '2026-01-01T00:00:00+24:00',
      '2026-01-01T00:00:00+00:60',
      `2026-01-01T00:00:00Z${'x'.repeat(64)}`,
      null,
      0,
      new String('2026-01-01T00:00:00Z'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('accepts only exact own-data bounded presets without executing accessors', () => {
    expect(() => createWebhookRfc3339TimestampParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'date_parse.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 19 },
      { ...PRESET, max_bytes: 65 },
      { ...PRESET, max_bytes: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        getPrototypeOf() {
          throw new Error('hostile parser preset');
        },
      }),
    ]) {
      expect(() => createWebhookRfc3339TimestampParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    let accessorReads = 0;
    const accessor = {
      kind: 'strict_rfc3339_milliseconds.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_bytes', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 64;
      },
    });
    expect(() => createWebhookRfc3339TimestampParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(accessorReads).toBe(0);
  });
});
