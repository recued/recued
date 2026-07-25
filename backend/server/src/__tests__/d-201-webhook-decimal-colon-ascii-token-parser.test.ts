import { describe, expect, it, vi } from 'vitest';

import {
  createWebhookDecimalColonAsciiTokenParser,
} from '../webhook-decimal-colon-ascii-token-parser.js';
import {
  WEBHOOK_REGISTRATION_CONNECTION_TOKEN_PROFILE_PRESETS,
  webhookRegistrationConnectionTokenProfilePreset,
} from '../webhook-registration-connection-token-profile-presets.js';

const PRESET = {
  kind: 'decimal_colon_ascii_token.v1',
  max_digits: 32,
  max_suffix_characters: 256,
} as const;

const legacyPrimitiveToken = (value: string): string | null =>
  /^[0-9]{1,32}:[A-Za-z0-9_-]{1,256}$/.test(value)
    && value.length <= 512
    ? value
    : null;

const legacyRuntimeAccepts = (value: unknown): boolean =>
  /^[0-9]{1,32}:[A-Za-z0-9_-]{1,256}$/.test(value as string)
    && (value as { length: number }).length <= 512;

describe('D-201 Slice 9BA decimal-colon ASCII-token parser', () => {
  it('accepts bounded decimal-colon tokens and preserves their exact text', () => {
    const parser = createWebhookDecimalColonAsciiTokenParser(PRESET);
    for (const value of [
      '0:A',
      '000001:MixedCase_0123-token',
      `${'9'.repeat(32)}:${'Z'.repeat(256)}`,
    ]) {
      expect(parser.parse(value)).toBe(value);
    }
    expect(Object.isFrozen(parser)).toBe(true);
    expect(Object.isFrozen(parser.preset)).toBe(true);
    expect(() => JSON.stringify(parser.preset)).not.toThrow();
  });

  it('rejects missing or repeated separators, bounds, and invalid alphabets', () => {
    const parser = createWebhookDecimalColonAsciiTokenParser(PRESET);
    for (const value of [
      '',
      ':A',
      '1:',
      '1',
      '1:A:B',
      `${'1'.repeat(33)}:A`,
      `1:${'A'.repeat(257)}`,
      '-1:A',
      '+1:A',
      '1.0:A',
      '1:A.B',
      '1:A B',
      '1:ü',
      '1:A\0',
      '1:A\r',
      '1:A\n',
      '1:A\r\n',
      '1:A\u2028',
      '1:A\u2029',
    ]) {
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('preserves the legacy Telegram grammar for ordinary primitive strings', () => {
    const parser = createWebhookDecimalColonAsciiTokenParser(PRESET);
    const candidates = [
      '',
      '0:A',
      '000001:MixedCase_0123-token',
      `${'9'.repeat(32)}:${'Z'.repeat(256)}`,
      `${'9'.repeat(33)}:A`,
      `1:${'A'.repeat(257)}`,
      '1:A:B',
      '1:space here',
      '1:punctuation.',
      'abc:A',
      '1:A\r',
      '1:A\n',
      '1:A\u2028',
      '1:A\u2029',
    ];
    for (const candidate of candidates) {
      expect(parser.parse(candidate)).toBe(legacyPrimitiveToken(candidate));
    }
  });

  it('retains terminal-control rejection and closes legacy regex coercion', () => {
    const parser = createWebhookDecimalColonAsciiTokenParser(PRESET);
    expect(legacyPrimitiveToken('1:A\n')).toBeNull();
    expect(parser.parse('1:A\n')).toBeNull();

    for (const value of [null, 1]) {
      expect(parser.parse(value)).toBeNull();
    }
    for (const value of [
      new String('1:Ab_'),
      { length: 5, toString: () => '1:Ab_' },
    ]) {
      expect(legacyRuntimeAccepts(value)).toBe(true);
      expect(parser.parse(value)).toBeNull();
    }
  });

  it('accepts only exact own-data presets without invoking accessors', () => {
    expect(() => createWebhookDecimalColonAsciiTokenParser(PRESET)).not.toThrow();
    expect(() => createWebhookDecimalColonAsciiTokenParser(
      Object.assign(Object.create(null), PRESET),
    )).not.toThrow();
    for (const invalid of [
      { ...PRESET, extra: true },
      { ...PRESET, kind: 'vendor_bot_token.v1' },
      { ...PRESET, max_digits: 0 },
      { ...PRESET, max_digits: 129 },
      { ...PRESET, max_digits: 1.5 },
      { ...PRESET, max_suffix_characters: 0 },
      { ...PRESET, max_suffix_characters: 65_504 },
      { ...PRESET, [Symbol('authority')]: true },
      Object.create(PRESET),
      new Proxy({}, {
        ownKeys() {
          throw new Error('hostile connection-token preset');
        },
      }),
    ]) {
      expect(() => createWebhookDecimalColonAsciiTokenParser(invalid as never))
        .toThrow('invalid trusted preset');
    }

    const getter = vi.fn(() => 32);
    const accessor = {
      kind: 'decimal_colon_ascii_token.v1',
      max_suffix_characters: 256,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'max_digits', {
      enumerable: true,
      get: getter,
    });
    expect(() => createWebhookDecimalColonAsciiTokenParser(accessor as never))
      .toThrow('invalid trusted preset');
    expect(getter).not.toHaveBeenCalled();
  });

  it('copies scalar settings and enforces the total token hard cap', () => {
    const input = {
      kind: 'decimal_colon_ascii_token.v1' as const,
      max_digits: 2,
      max_suffix_characters: 3,
    };
    const parser = createWebhookDecimalColonAsciiTokenParser(input);
    input.max_digits = 1;
    input.max_suffix_characters = 1;
    expect(parser.preset).toEqual({
      kind: 'decimal_colon_ascii_token.v1',
      max_digits: 2,
      max_suffix_characters: 3,
    });
    expect(parser.parse('12:Ab_')).toBe('12:Ab_');
    expect(parser.parse('123:Ab_')).toBeNull();

    expect(() => createWebhookDecimalColonAsciiTokenParser({
      kind: 'decimal_colon_ascii_token.v1',
      max_digits: 128,
      max_suffix_characters: 65_407,
    })).not.toThrow();
    expect(() => createWebhookDecimalColonAsciiTokenParser({
      kind: 'decimal_colon_ascii_token.v1',
      max_digits: 128,
      max_suffix_characters: 65_408,
    })).toThrow('invalid trusted preset');
  });

  it('exposes only the Telegram paired-connection token role', () => {
    const selected = webhookRegistrationConnectionTokenProfilePreset(
      'telegram.bot-webhook.v1',
    );
    expect(selected).toEqual({
      profile_id: 'telegram.bot-webhook.v1',
      parser: PRESET,
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.parser)).toBe(true);
    for (const profileId of [
      'stripe.event.v1',
      'paddle.notification.v1',
      'github.webhook.v1',
    ] as const) {
      expect(webhookRegistrationConnectionTokenProfilePreset(profileId)).toBeNull();
    }
    expect(Object.keys(WEBHOOK_REGISTRATION_CONNECTION_TOKEN_PROFILE_PRESETS))
      .toEqual(['telegram.bot-webhook.v1']);
    expect(Object.getPrototypeOf(
      WEBHOOK_REGISTRATION_CONNECTION_TOKEN_PROFILE_PRESETS,
    )).toBeNull();
    expect(Object.isFrozen(
      WEBHOOK_REGISTRATION_CONNECTION_TOKEN_PROFILE_PRESETS,
    )).toBe(true);
  });
});
