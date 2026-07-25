import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookAsciiEventTypeParser,
} from '../webhook-ascii-event-type-parser.js';
import {
  WEBHOOK_ASCII_EVENT_TYPE_PROFILE_PRESETS,
  webhookAsciiEventTypeProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
  max_bytes: 128,
} as const;

describe('D-201 Slice 9AS ASCII event-type parser', () => {
  it('accepts the bounded ASCII event-type grammar', () => {
    const parser = createWebhookAsciiEventTypeParser(PRESET);
    for (const value of [
      'A',
      '9',
      'invoice.paid',
      'resource_name:updated/v2-final',
      `E${'v'.repeat(127)}`,
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects wrong alphabets, bounds, controls, and coercion', () => {
    const parser = createWebhookAsciiEventTypeParser(PRESET);
    for (const value of [
      '',
      '.invoice',
      '_invoice',
      ':invoice',
      '/invoice',
      '-invoice',
      'invoice+paid',
      'invoice paid',
      `E${'v'.repeat(128)}`,
      'invoice\n',
      'invoice\r',
      'invoice\u0000',
      'invoice\u2028',
      'événement',
      null,
      1,
      new String('invoice.paid'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the retired Stripe primitive-string grammar exactly', () => {
    const parser = createWebhookAsciiEventTypeParser(PRESET);
    const legacy = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
    const alphabet = 'aAzZ019_.:/-+ *\n\r\u0000é';
    let state = 0x9a5201;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const candidates = [
      '',
      'A',
      '9',
      'invoice.paid',
      'resource_name:updated/v2-final',
      `E${'v'.repeat(127)}`,
      `E${'v'.repeat(128)}`,
    ];
    while (candidates.length < 20_007) {
      const length = next() % 140;
      let candidate = '';
      for (let index = 0; index < length; index += 1) {
        candidate += alphabet[next() % alphabet.length];
      }
      candidates.push(candidate);
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(
        legacy.test(candidate) ? candidate : null,
      );
    }
  });

  it('accepts only exact own-data bounded presets without accessors', () => {
    expect(() => createWebhookAsciiEventTypeParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, max_bytes: 0 },
      { ...PRESET, max_bytes: 129 },
      { ...PRESET, max_bytes: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile ASCII event-type preset');
        },
      }),
    ]) {
      expect(() => createWebhookAsciiEventTypeParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 128);
    const accessor = {
      kind: 'ascii_alphanumeric_dot_colon_slash_dash.v1',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_bytes', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookAsciiEventTypeParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds Stripe event types through trusted profile data', () => {
    const selected = webhookAsciiEventTypeProfilePreset('stripe.event.v1');
    expect(selected).toEqual({
      profile_id: 'stripe.event.v1',
      parser: PRESET,
    });
    expect(webhookAsciiEventTypeProfilePreset(
      'paddle.notification.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_ASCII_EVENT_TYPE_PROFILE_PRESETS,
    ).map((value) => value?.profile_id))
      .toEqual(['stripe.event.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_ASCII_EVENT_TYPE_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_ASCII_EVENT_TYPE_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
