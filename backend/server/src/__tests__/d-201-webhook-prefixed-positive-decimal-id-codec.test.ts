import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookPrefixedPositiveDecimalIdCodec,
} from '../webhook-prefixed-positive-decimal-id-codec.js';
import {
  WEBHOOK_PREFIXED_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
  webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';

const PRESET = {
  kind: 'fixed_prefix_positive_decimal_id.v1',
  prefix: 'telegram_bot_',
  max_digits: 16,
} as const;

describe('D-201 Slice 9AQ prefixed positive-decimal id codec', () => {
  it('parses and formats the exact positive-decimal suffix grammar', () => {
    const codec = createWebhookPrefixedPositiveDecimalIdCodec(PRESET);
    expect(codec.parse('telegram_bot_1')).toBe('telegram_bot_1');
    expect(codec.parse('telegram_bot_9007199254740991'))
      .toBe('telegram_bot_9007199254740991');
    expect(codec.format('1')).toBe('telegram_bot_1');
    expect(codec.format('9007199254740991'))
      .toBe('telegram_bot_9007199254740991');
    expect(Object.isFrozen(codec)).toBe(true);
    expect(Object.isFrozen(codec.preset)).toBe(true);
    expect(() => JSON.stringify(codec.preset)).not.toThrow();
  });

  it('rejects wrong prefixes, decimal shapes, bounds, and coercion', () => {
    const codec = createWebhookPrefixedPositiveDecimalIdCodec(PRESET);
    for (const value of [
      '',
      'telegram_bot_',
      'telegram_bot_0',
      'telegram_bot_01',
      'telegram_bot_+1',
      'telegram_bot_1.0',
      'telegram_bot_12345678901234567',
      'telegram-bot_1',
      'Telegram_bot_1',
      'telegram_bot_1\n',
      'telegram_bot_1\u0000',
      null,
      1,
      new String('telegram_bot_1'),
    ]) {
      expect(codec.parse(value)).toBeNull();
    }
    for (const suffix of [
      '',
      '0',
      '01',
      '+1',
      '1.0',
      '12345678901234567',
      null,
      1,
      new String('1'),
    ]) {
      expect(codec.format(suffix)).toBeNull();
    }
  });

  it('preserves the retired primitive-string grammar exactly', () => {
    const codec = createWebhookPrefixedPositiveDecimalIdCodec(PRESET);
    const legacySuffix = /^[1-9][0-9]{0,15}$/;
    const legacyRemoteId = /^telegram_bot_[1-9][0-9]{0,15}$/;
    const alphabet = '0123456789+-._ A\n\r\u0000é';
    let state = 0x9a201;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const suffixes = [
      '',
      '0',
      '1',
      '9',
      '01',
      '1234567890123456',
      '12345678901234567',
    ];
    while (suffixes.length < 20_007) {
      const length = next() % 20;
      let suffix = '';
      for (let index = 0; index < length; index += 1) {
        suffix += alphabet[next() % alphabet.length];
      }
      suffixes.push(suffix);
    }

    for (let index = 0; index < suffixes.length; index += 1) {
      const suffix = suffixes[index]!;
      const expectedFormatted = legacySuffix.test(suffix)
        ? `telegram_bot_${suffix}`
        : null;
      expect(codec.format(suffix)).toBe(expectedFormatted);
      const candidate = index % 4 === 0
        ? `telegram_bot_${suffix}`
        : index % 4 === 1
          ? `Telegram_bot_${suffix}`
          : index % 4 === 2
            ? `telegram-bot_${suffix}`
            : suffix;
      expect(codec.parse(candidate)).toBe(
        legacyRemoteId.test(candidate) ? candidate : null,
      );
    }
  });

  it('accepts only exact own-data bounded presets without accessors', () => {
    expect(() => createWebhookPrefixedPositiveDecimalIdCodec(PRESET))
      .not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'owner_format.v1' },
      { ...PRESET, prefix: '' },
      { ...PRESET, prefix: '0telegram_' },
      { ...PRESET, prefix: 'Telegram_' },
      { ...PRESET, prefix: 'telegram.' },
      { ...PRESET, prefix: 'telegram_\n' },
      { ...PRESET, prefix: 'a'.repeat(65) },
      { ...PRESET, max_digits: 0 },
      { ...PRESET, max_digits: 129 },
      { ...PRESET, max_digits: 1.5 },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile prefixed-decimal preset');
        },
      }),
    ]) {
      expect(() => createWebhookPrefixedPositiveDecimalIdCodec(
        invalid as never,
      )).toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 16);
    const accessor = {
      kind: 'fixed_prefix_positive_decimal_id.v1',
      prefix: 'telegram_bot_',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_digits', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookPrefixedPositiveDecimalIdCodec(
      accessor as never,
    )).toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('binds Telegram synthetic remote ids through trusted profile data', () => {
    const selected =
      webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset(
        'telegram.bot-webhook.v1',
      );
    expect(selected).toEqual({
      profile_id: 'telegram.bot-webhook.v1',
      codec: PRESET,
    });
    const codec = createWebhookPrefixedPositiveDecimalIdCodec(selected!.codec);
    expect(codec.format('123456')).toBe('telegram_bot_123456');
    expect(webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset(
      'stripe.event.v1',
    )).toBeNull();
    expect(Object.values(
      WEBHOOK_PREFIXED_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    ).map((value) => value?.profile_id))
      .toEqual(['telegram.bot-webhook.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_PREFIXED_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_PREFIXED_POSITIVE_DECIMAL_REGISTRATION_REMOTE_ID_PROFILE_PRESETS,
    )).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.codec)).toBe(true);
    expect(() => JSON.stringify(selected)).not.toThrow();
  });
});
