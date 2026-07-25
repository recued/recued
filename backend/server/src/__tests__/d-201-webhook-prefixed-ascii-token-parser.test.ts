import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookPrefixedAsciiTokenParser,
} from '../webhook-prefixed-ascii-token-parser.js';
import {
  webhookTimestampedHmacDeliveryProfilePreset,
} from '../webhook-delivery-engine-presets.js';
import {
  WEBHOOK_PREFIXED_ASCII_CREDENTIAL_PROFILE_PRESETS,
  webhookPrefixedAsciiCredentialProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'prefixed_ascii_token.v1',
  prefix: 'whsec_',
  max_bytes: 4_096,
} as const;

describe('D-201 Slice 9AT prefixed ASCII-token parser', () => {
  it('accepts the bounded prefixed ASCII-token grammar', () => {
    const parser = createWebhookPrefixedAsciiTokenParser(PRESET);
    for (const value of [
      'whsec_a',
      'whsec_AZaz09_-',
      `whsec_${'x'.repeat(4_090)}`,
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects missing suffixes, wrong alphabets, bounds, and coercion', () => {
    const parser = createWebhookPrefixedAsciiTokenParser(PRESET);
    for (const value of [
      '',
      'whsec_',
      'other_secret',
      'whsec_with.dot',
      'whsec_with space',
      'whsec_with\nnewline',
      'whsec_with\rreturn',
      'whsec_with\u0000nul',
      'whsec_é',
      `whsec_${'x'.repeat(4_091)}`,
      null,
      1,
      new String('whsec_boxed'),
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the D-201 Stripe primitive-string grammar exactly', () => {
    const parser = createWebhookPrefixedAsciiTokenParser(PRESET);
    const legacy = (value: unknown): string | null => typeof value === 'string'
      && value.length > 0
      && Buffer.byteLength(value, 'utf8') <= 4_096
      && /^whsec_[A-Za-z0-9_-]+$/.test(value)
      ? value
      : null;
    const alphabet = 'aAzZ019_-+. *\n\r\u0000é';
    let state = 0x9a5401;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const candidates: unknown[] = [
      '',
      'whsec_',
      'whsec_a',
      'whsec_AZaz09_-',
      `whsec_${'x'.repeat(4_090)}`,
      `whsec_${'x'.repeat(4_091)}`,
      null,
      1,
      new String('whsec_boxed'),
    ];
    while (candidates.length < 20_009) {
      const length = next() % 140;
      let suffix = '';
      for (let index = 0; index < length; index += 1) {
        suffix += alphabet[next() % alphabet.length];
      }
      candidates.push(`${next() % 3 === 0 ? 'other_' : 'whsec_'}${suffix}`);
    }

    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(legacy(candidate));
    }
  });

  it('accepts only exact own-data bounded presets without accessors', () => {
    expect(() => createWebhookPrefixedAsciiTokenParser(PRESET)).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_regex.v1' },
      { ...PRESET, prefix: '' },
      { ...PRESET, prefix: 'a'.repeat(65) },
      { ...PRESET, prefix: 'invalid.' },
      { ...PRESET, max_bytes: PRESET.prefix.length },
      { ...PRESET, max_bytes: 65_537 },
      { ...PRESET, max_bytes: 4_096.5 },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile prefixed ASCII-token preset');
        },
      }),
    ]) {
      expect(() => createWebhookPrefixedAsciiTokenParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 'whsec_');
    const accessor = {
      kind: 'prefixed_ascii_token.v1',
      max_bytes: 4_096,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'prefix', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookPrefixedAsciiTokenParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds the Stripe credential grammar across trusted profile data and delivery', () => {
    const selected = webhookPrefixedAsciiCredentialProfilePreset(
      'stripe.event.v1',
    );
    expect(selected).toEqual({
      profile_id: 'stripe.event.v1',
      credential_field: 'endpoint_secret',
      parser: PRESET,
    });
    expect(webhookPrefixedAsciiCredentialProfilePreset(
      'paddle.notification.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_PREFIXED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    ).map((value) => value?.profile_id)).toEqual(['stripe.event.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_PREFIXED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_PREFIXED_ASCII_CREDENTIAL_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();

    const delivery = webhookTimestampedHmacDeliveryProfilePreset(
      'stripe.event.v1',
    );
    expect(delivery?.mechanism.secret_field).toBe(
      selected?.credential_field,
    );
    expect(delivery?.mechanism.secret_shape).toEqual(selected?.parser);
  });
});
